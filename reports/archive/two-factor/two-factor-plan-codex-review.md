## 1. Critical — a challenge does not bind the factors that were offered

lib/auth/two-factor-challenge.ts:208 computes the allowed methods, but lines 248-256 persist only the user ID and an attempt count. The method set and the first-factor contact kind are not part of the challenge. On every later request, resolveTwoFactorChallenge recomputes the methods at lines 367-379 without the original excludeContactKind.

This breaks two security boundaries:

- The Better Auth TOTP and backup-code verifiers consume the challenge and validate their credential, but never consult two_factor_methods or the methods originally offered. The installed 1.7.2 implementations are at node_modules/better-auth/dist/plugins/two-factor/totp/index.mjs:172-224 and node_modules/better-auth/dist/plugins/two-factor/backup-codes/index.mjs:187-233. A removed, unacknowledged, or otherwise unoffered TOTP/backup factor can therefore complete a live challenge.
- A passwordless email first factor initially excludes email OTP, but the exclusion disappears when the custom OTP endpoint resolves the challenge. The same mailbox can then supply both OTPs, even when the sign-in response offered only TOTP.

Both paths were reproduced with temporary regression tests and then removed:

- bun tests/helpers/run.ts integration two-factor-totp — 6 pass, 0 fail, including a correct TOTP completing a challenge whose advertised set contained only backup_code.
- bun tests/helpers/run.ts integration two-factor-otp — 6 pass, 0 fail, including passwordless email advertising only TOTP and the custom resolver reintroducing email OTP, which then issued a session.

Persist purpose-bound immutable companion state containing the exact permitted method/channel pairs, first-factor context, and remember-me choice. Every custom and Better Auth-backed verifier must reject a requested method that was not issued for that purpose. Current enrollment/capability state may narrow that set after issuance, but must never widen it. Because Better Auth expects the primary sign-in challenge value to remain the user ID, use a companion verification record or replace the TOTP and backup verifiers with application-owned endpoints. Add direct endpoint tests for every unoffered method, same-contact passwordless fallback, and cross-purpose challenge use.

## 2. Critical — password recovery plus same-contact 2FA OTP still permits account takeover

recoveryDefeatsTwoFactor in lib/auth/two-factor-challenge.ts:491-500 allows a reset whenever any factor survives exclusion of the recovery contact. It does not require the caller to prove that surviving factor. With email OTP plus TOTP enrolled, an attacker controlling the mailbox can:

1. redeem an email password-reset code because TOTP exists;
2. set a new password;
3. sign in with that password;
4. select email OTP as the challenge fallback; and
5. receive the session using the same mailbox that authorized the reset.

Purpose-bound database lookups are insufficient factor separation when both flows prove possession of the same mailbox. The takeover does not cross-redeem one code between purposes; it requests a fresh forgot_password code and a fresh two_factor code from the same compromised contact. The existing tests cover only same-contact OTP by itself and a wholly disjoint factor; they omit the dangerous coexistence case.

This takeover was reproduced with a temporary test in tests/integration/two-factor-management.test.ts and then removed. Command: bun tests/helpers/run.ts integration two-factor-management. Result: 6 pass, 0 fail, including the reset, new-password sign-in, email 2FA OTP, and issued session.

The recovery flow must either refuse recovery whenever the recovery contact is an enabled second-factor destination, or require a recovery-scoped proof from a disjoint factor before writing the password. The latter proof must be one-use and bound to that reset. If no disjoint factor remains, route to the privileged administrative recovery path.

The ordinary sign-in challenge cannot be reused unchanged for that proof. Better Auth's successful TOTP path consumes the challenge and creates an authenticated session, while backup-code disableSession skips the completion function and therefore does not consume the challenge. The custom completeTwoFactorChallenge at lib/auth/two-factor-challenge.ts:448-480 also always creates a normal session. This behavior is explicit in the [official Better Auth 1.7.2 verifier](https://github.com/better-auth/better-auth/blob/v1.7.2/packages/better-auth/src/plugins/two-factor/verify-two-factor.ts). Recovery needs a purpose-bound state machine whose successful verifier consumes the recovery challenge into a short-lived, single-use password-reset grant and never creates a login session.

The claimed transaction boundary is also false. app/api/auth/forgot-password/reset/handler.ts:113-120 calls recoveryDefeatsTwoFactor inside the OTP callback, but that helper reads through global db rather than the supplied transaction and does not lock the enrollment rows. A concurrent method change can separate the decision from the password write. Pass the transaction into the policy read and lock the user/method state in canonical order.

## 3. Critical — an empty offered set silently downgrades 2FA to one factor

lib/auth/two-factor-challenge.ts:189-223 deliberately returns null and keeps the first-factor session when users.twoFactorEnabled is true but no method survives the intent/capability/environment intersection. tests/integration/two-factor-passkey.test.ts explicitly asserts this behavior for a user with 2FA enabled and no usable enrollment.

Configuration removal, loss of the last passkey, stale enrollment data, an unacknowledged recovery-code set, or a passwordless first factor that excludes the only same-contact OTP can therefore turn 2FA into password-only or single-OTP authentication. An audit event does not restore the security boundary.

Fail closed: withdraw the first-factor session and return a recoverable “no available factor” state. Prevent lockout through enrollment invariants and an administrative recovery path, not through successful authentication. A passwordless flow whose only remaining factor reaches the same contact must refuse that first-factor route and require a different first factor.

There is also no pre-deployment discovery for configuration changes. twoFactorDowngraded is emitted only after an affected user signs in, and no script or administrative query simulates a proposed method/channel set against current enrollment and capability rows. Add a read-only preflight command that accepts the proposed configuration, reports affected user counts and identifiers by reason, and blocks rollout when any 2FA-enabled user would have no independent usable method. Post-login audit rows are not an operational migration control.

## 4. Critical — registering a passkey never enrolls it as a second factor

The passkey plugin is installed at lib/auth/two-factor.ts:166-173, but no registration hook records passkey intent, sets users.twoFactorEnabled, or revokes prior sessions/trusted devices. The only recordMethodIntent calls are TOTP confirmation at lib/auth/two-factor.ts:126, OTP confirmation at lib/auth/two-factor-otp.ts:351, and backup-code acknowledgement at lib/auth/two-factor-otp.ts:499.

Consequences:

- A passkey-only deployment has no user journey that turns 2FA on.
- Adding a passkey to an existing account does not make passkey appear in the challenge.
- Removing and later wanting to re-enable passkey intent has no supported transition.
- tests/integration/two-factor-passkey.test.ts:76-87 manually inserts the passkey, intent row, and enabled flag, so it bypasses the missing enrollment behavior instead of testing it.

Attach policy to successful passkey registration at a shared server-side boundary. When the first eligible passkey is registered as a 2FA method, atomically record intent, enable 2FA, and revoke sessions/trusted devices according to the enrollment policy. Test the actual registration endpoints rather than seeding final database state.

Registration authorization is also too weak for adding an authenticator. Better Auth 1.7.2 protects both registration steps only with freshSessionMiddleware, as shown in the [official passkey routes](https://github.com/better-auth/better-auth/blob/v1.7.2/packages/passkey/src/routes.ts), while lib/auth.ts:451-454 defines “fresh” as ten hours. A stolen session can therefore register a credential for most of a working day without password or existing-factor step-up. Require a one-use password/current-factor proof bound to passkey registration, on both option generation and verification; freshness alone is insufficient.

## 5. High — passkey verification does not require user verification

The second-factor ceremony requests userVerification: preferred at lib/auth/two-factor-passkey.ts:120-130 and verifies with requireUserVerification: false at lines 238-258. Passkey registration also inherits the plugin defaults: preferred registration selection and requireUserVerification: false in node_modules/@better-auth/passkey/dist/index.mjs:166-180 and 349-356.

This permits authenticators that prove only user presence, not local user verification. It does not meet the requested biometric/PIN second-factor property. WebAuthn can require user verification, but it cannot promise specifically biometric verification; a platform PIN is also a valid user-verification mechanism.

Set userVerification to required for authentication, requireUserVerification to true during assertion verification, and configure registration consistently. Existing credentials that cannot satisfy required user verification need an explicit migration/fallback path. The relevant option semantics are documented by [Better Auth's passkey plugin](https://better-auth.com/docs/plugins/passkey).

## 6. High — any authenticated session can mint a trusted-device bypass

POST /two-factor/trust-device uses only sessionMiddleware at lib/auth/trusted-device.ts:214-235. It has no proof that the session just completed 2FA, that 2FA is enabled, or that the caller selected “remember this device” during a challenge. tests/integration/two-factor-trusted-device.test.ts exercises the unsafe contract by signing in a non-2FA user and creating trust.

An attacker with a session can preplant a trusted-device row and cookie before the victim enables 2FA. TOTP/OTP enrollment revokes sessions but does not delete those rows. On the attacker's next password sign-in, consumeDeviceTrust skips the challenge.

Mint trust only from a one-use receipt created by successful second-factor completion, or as part of the successful verifier itself. Bind the receipt to user, challenge, device cookie, and a short expiry, then consume it atomically. Enabling or materially changing 2FA must revoke existing trusted devices.

grantDeviceTrust also swallows its database failure at lib/auth/trusted-device.ts:135-152 while the endpoint returns trusted: true. Return an error or report trusted: false when no durable bypass record and cookie were created.

## 7. High — self-service 2FA disable leaves custom security state active and reusable

The reachable POST /two-factor/disable endpoint is Better Auth's implementation. In installed version 1.7.2, node_modules/better-auth/dist/plugins/two-factor/index.mjs:206-239 only clears users.twoFactorEnabled, deletes the Better Auth TOTP/backup credential row, rotates the current session, and expires the caller's trust cookie. It does not delete:

- two_factor_methods intent;
- passkeys;
- trusted_devices rows on other devices;
- custom OTP/passkey challenges and their counters; or
- other sessions.

resolveTwoFactorChallenge at lib/auth/two-factor-challenge.ts:367-379 does not check EnrollmentState.enabled. A custom OTP or passkey challenge issued before disable can therefore still complete after disable. Stale intents and trusted-device rows can reactivate when 2FA is enabled again.

Replace or wrap self-disable with one atomic application-owned cleanup under a user-row lock. Extract a shared cleanup routine used by both self-service disable and app/api/dash/users/[id]/two-factor/handler.ts so the two paths cannot drift. Invalidate all challenges/counters, trust rows/cookies, intent, method capabilities, and relevant sessions. Challenge resolution must independently reject disabled accounts.

## 8. High — method removal is non-atomic and does not remove the method's capability

POST /two-factor/methods/disable reads the enrolled list outside its transaction at lib/auth/two-factor-otp.ts:455-469. Two concurrent requests can each observe two methods, both pass the last-method check, and then delete both rows. Passkey deletion is delegated to the generic passkey endpoint and has no last-method rule or update when the final credential disappears.

The generic method endpoint deletes only intent. TOTP secrets, backup codes, passkey credentials, and acknowledgement state remain. Until issue 1 is fixed, a removed TOTP or backup code still verifies directly. Even after challenge binding is fixed, stale capability can be resurrected by inserting intent later.

Lock the user row, count eligible methods, and perform the last-method check plus removal in one transaction. Route last-passkey deletion through the same lifecycle. Define method-specific cleanup: clear/rotate the TOTP capability, invalidate backup codes and acknowledgement, and decide explicitly whether disabling passkey-as-2FA preserves credentials for another use. Require recent password or a recent current-factor proof for factor removal; a live session alone is insufficient for weakening authentication.

## 9. High — TOTP and backup-code rotation bypass confirmation state

Better Auth 1.7.2 replaces the TOTP secret and backup-code set on every POST /two-factor/enable. For an existing credential it preserves verified: true while writing the new secret at node_modules/better-auth/dist/plugins/two-factor/index.mjs:125-165. The application does not reject re-enrollment or stage the new secret until confirmation. A session holder who can satisfy the password field can replace an already verified second factor without proving the old factor or the new one.

Backup-code acknowledgement is also not tied to a particular generated set. POST /two-factor/generate-backup-codes updates only backupCodes at node_modules/better-auth/dist/plugins/two-factor/backup-codes/index.mjs:276-303. backupCodesAcknowledgedAt and the intent row remain, so regenerated codes become an offered fallback immediately even if the user never saved the replacement set. Exhausting all codes likewise leaves the method advertised because capability checks only the timestamp at lib/auth/two-factor-challenge.ts:121-124.

Initial TOTP setup always generates backup codes, but TOTP can be confirmed and activated without acknowledging or retaining them. Once recovery is corrected to require an independent factor, a user who discards those codes and later loses TOTP has no self-service recovery. Finalization must require acknowledgement of the exact generated set or another independently verified recovery method; the current optional later action leaves TOTP-only users exposed to administrative lockout recovery.

Reject duplicate enable or implement an explicit rotation ceremony requiring password plus a current factor, with a staged new secret that becomes active only after verification. Clear acknowledgement and disable backup intent whenever a set is generated/replaced; acknowledgement must identify the exact set/version. Stage initial TOTP activation until a required recovery set is acknowledged or another recovery method is proven. Stop offering backup_code when no unused codes remain.

## 10. High — enrollment session revocation can preserve the attacker's session

newestSessionId chooses the most recently created session at lib/auth/rotation.ts:75-85. TOTP enrollment uses that inferred ID at lib/auth/two-factor.ts:124-135; OTP enrollment uses it at lib/auth/two-factor-otp.ts:366-371. A concurrent attacker session created after the victim's rotated session can be selected as the one to keep, logging out the victim while preserving the attacker.

OTP enrollment commits the enabled state before a separate revocation transaction and swallows revocation errors at lib/auth/two-factor-otp.ts:366-376. TOTP combines application intent/revocation only in an after-hook transaction, after Better Auth has already changed its own credential and session state. These split commits can leave 2FA enabled while old sessions survive.

Carry the exact caller/new-session identifier through the enrollment operation; never infer ownership from recency. If the library cannot expose it reliably, revoke every session and require the enrolling user to sign in again. A revocation failure must not be converted into a successful enrollment response.

## 11. High — supported configuration includes method combinations users cannot enroll

utils/validation/two-factor.ts accepts passkey and backup_code as deployment methods, but Better Auth's enable API accepts only otp or totp, as documented in the [Better Auth 2FA API](https://better-auth.com/docs/plugins/2fa) and enforced by the installed source. The resulting route surface is inconsistent:

- backup_code without TOTP has no initial credential or code-generation path;
- passkey-only cannot enable 2FA because issue 4 has no registration policy hook;
- /two-factor/enable is served whenever any method is enabled, even if neither accepted branch is usable;
- /two-factor/backup-codes/acknowledge is always served when any 2FA method is enabled, even if backup_code is disabled; and
- enabling TOTP generates and returns backup codes even when backup_code is disabled.

Add startup invariants for at least one enrollable primary method, gate every management route by the method it changes, and implement application-owned backup/passkey enrollment where Better Auth has no matching method. A disabled method must not create intent, credentials, or user-visible recovery material.

## 12. High — the custom challenge attempt counter can be bypassed with concurrent requests

spendChallengeAttempt consumes the counter and immediately recreates the same count before cryptographic verification at lib/auth/two-factor-challenge.ts:387-423. Concurrent requests can repeatedly consume the rearmed value while earlier checks are still running. Their failures then all write the same increment, so multiple guesses can cost one attempt.

Better Auth's own counter avoids this pattern: node_modules/better-auth/dist/plugins/two-factor/verify-two-factor.mjs:70-97 leaves the counter absent while verification is in flight, recreating it only on a known failure or internal-error restore. The adapter selects the latest record and deletes all duplicates for an identifier at node_modules/better-auth/dist/db/internal-adapter.mjs:818-850, which makes duplicate same-count rearming especially unsafe.

Use the consume/recordFailure/restore protocol without pre-rearming. While one verification owns the counter, competing verification requests must fail. Add a parallel passkey test that submits more than the allowed number of wrong assertions and proves no more than the configured budget reaches verification.

## 13. Medium — caller-controlled disableSession burns a backup code and strands the challenge

The request policy in lib/auth.ts:84-105 forces trustDevice to false on Better Auth verifiers but leaves disableSession untouched. The backup-code body explicitly accepts disableSession in node_modules/better-auth/dist/plugins/two-factor/backup-codes/index.mjs:52-57. On a correct code, lines 215-233 consume and rewrite the backup set but skip valid(ctx) when disableSession is true.

For a sign-in challenge, skipping valid(ctx) means no session is issued and the challenge is not completed. Its attempt counter has already been consumed and is not restored. A caller can therefore destroy a one-use recovery code and leave the challenge unusable.

Force disableSession to false for interactive sign-in verification, just as trustDevice is forced off, or remove that field from the served contract. Add a test for a hostile body containing both trustDevice and disableSession.

## 14. Medium — dual-mode verifier endpoints bypass live-session checks in authenticated mode

/two-factor/otp/send and /two-factor/otp/verify are omitted from LIVE_SESSION_PATHS because they also serve anonymous challenge mode. In enrollment mode, sessionUser at lib/auth/two-factor-otp.ts:108-115 resolves a session token directly, and enrolmentTarget at lines 74-105 excludes soft-deleted users but not users.isActive = false.

The Better Auth /two-factor/verify-totp and /two-factor/verify-backup-code endpoints have the same split. They are omitted from LIVE_SESSION_PATHS because challenge mode is unauthenticated; the before hook only strips trustDevice. verifyTwoFactor then accepts any resolved session without the application's active/non-deleted check. TOTP's session branch can finalize enrollment, and backup verification can consume a recovery credential, for a suspended account.

A suspended user whose session still resolves can therefore send and verify OTP enrollment, set users.twoFactorEnabled, create method intent, or use the authenticated branches of the library verifiers. Split enrollment and sign-in endpoints or apply assertLiveSession only when a real session—not a challenge cookie—selected authenticated mode. Enrollment lookup must require an active, non-deleted user. Add suspended and soft-deleted session tests for custom OTP, TOTP, and backup-code endpoints.

## 15. Medium — default method, deterministic priority, automatic routing, and preference are absent

ChallengeIssued contains only twoFactorMethods at lib/auth/two-factor-challenge.ts:184-187. The enrollment select at lines 83-91 has no ORDER BY, so the returned list is not a stable priority contract. No default method is selected, no OTP is dispatched as part of initial routing, and no user preference is stored or exposed by /two-factor/methods.

Required challenge contract:

- Compute a stable system priority independent of database or environment-list order. Recommended order after issue 5 is fixed: passkey, TOTP, OTP, then backup code. Backup codes should be presented as recovery fallback, not selected automatically unless nothing else exists.
- Let a user's preferred method override that order only when it belongs to the immutable issued set and is currently usable. An unavailable preference falls back to system priority; it must never turn into the empty-set downgrade.
- Return defaultMethod plus ordered availableMethods. The client should start the default immediately and show “Try another method” from the same immutable challenge.
- For an OTP default, send at most once per challenge. Reloads/renders must not send again; resend remains explicit and reports nextAllowedIn.
- Changing the preference must use a live session and validate an enrolled method. A practical schema is is_default on two_factor_methods with a partial unique index per user, updated transactionally. Removal of that row naturally falls back to system priority.

Fallback selection must not call the current recomputing resolver in a way that widens the issued method set.

## 16. Medium — public OTP verification can deny the 2FA OTP destination quota

enforceOtpVerifyQuota at lib/rate-limit/api.ts:221-236 gives recovery a separate key but places every other surface, including verify_contact, passwordless, and two_factor, under otp.verify.dest.{kind}. An unauthenticated caller can submit ten junk /api/auth/otp/verify requests for a victim's address and spend the destination quota before the victim submits a correct 2FA OTP.

The per-proof database counter does not prevent this targeted denial because the shared limiter rejects before the proof lookup. Give two_factor a reserved scope, as recovery already has, while retaining its challenge-level and proof-level attempt budgets. Add a cross-surface test that exhausts public verification and then submits a valid 2FA code.

## 17. Medium — recovery and 2FA messages are indistinguishable on the shared delivery channel

The send layer does not receive purpose when formatting messages. utils/otp.ts:179-210 sends the same generic Arabic text for SMS/WhatsApp, and lines 308-321 use the same email subject/body for every purpose. Simultaneous password-reset and 2FA codes to one mailbox or number are therefore visually interchangeable.

This produces wrong-screen failures and makes it easier to socially engineer a user into relaying a login code as though it were a recovery code. Pass purpose/template context into delivery and label password reset, login second factor, contact verification, and passwordless sign-in distinctly. Include a “do not share” warning and enough context to identify the attempted action without exposing account state.

## 18. Medium — generated OpenAPI request and error contracts do not match runtime behavior

Several custom endpoints declare z.record(z.string(), z.unknown()) and then manually parse a narrower schema:

- lib/auth/two-factor-otp.ts:146-218;
- lib/auth/two-factor-otp.ts:434-469;
- lib/auth/two-factor-passkey.ts:155-174; and
- lib/auth/trusted-device.ts:269-273.

lib/http/openapi.ts:320-323 overrides bodies only for sign-in/passwordless, so generated documentation advertises arbitrary objects instead of required code, channel, method, response, or device-id fields. BETTER_AUTH_LOCAL_THROTTLE_PATHS at lib/http/openapi.ts:1253 contains only passwordless verification, although custom OTP send/verify can return local 429/503 responses.

Declare the real exported Zod schemas on the endpoints or add exact OpenAPI overrides sourced from those schemas. Document limiter and breaker responses for every locally throttled path. Add contract assertions for required fields and 429/503 status coverage.

## 19. Medium — authentication audit records lose or misstate the factor chain

SESSION_METHOD_BY_PATH at lib/auth.ts:202-207 recognizes password, passwordless, TOTP, and backup-code paths only. Sessions created by custom OTP and passkey verification are logged as unknown. A TOTP or backup completion after passwordless is labeled password+totp or password+backup_code even though the first factor was a contact OTP. Management endpoints that rotate sessions can also be recorded as login successes without a distinct event type.

Persist the first-factor kind in the challenge and emit one explicit completion audit containing first factor, second factor, challenge ID/reference, and whether trusted-device bypass was consumed. Separate credential-management session rotation from interactive login issuance. Add audit assertions for password+OTP, password+passkey, passwordless+TOTP, passwordless+backup, trust bypass, and enrollment/disable rotations.

## 20. Low — trusted-device retention query lacks the index the code claims

db/maintenance.ts:79-88 states that trusted_devices has a leading expires_at index and says this was verified with EXPLAIN. The schema and migration create only idx_trusted_devices_user on (user_id, expires_at) at db/schema.ts:611-614. sweepTrustedDevices filters only expires_at at db/maintenance.ts:286-299, so that composite B-tree does not provide the claimed leading key.

Add an expires_at-leading index and verify the generated migration/plan, or explicitly accept the sequential scan and remove the false claim. Do not retain an EXPLAIN assertion that the schema cannot satisfy.

## 21. AGENTS.md violation — new comments contain prohibited banners, history, restatements, and false invariants

The changed code adds many comments that AGENTS.md explicitly forbids:

- section banners throughout db/schema.ts, including lines 573-575 and 617-619;
- change-history narratives such as lib/auth/rotation.ts:13-26;
- comments restating signatures, endpoint paths, schemas, and obvious control flow throughout lib/auth/allowed-paths.ts and the new tests; and
- false invariants, including the atomic recovery claim at app/api/auth/forgot-password/reset/handler.ts:113-117, the leading-index claim at db/maintenance.ts:79-88, and “keep backup_code enabled in every deployment” at utils/validation/two-factor.ts:23-26 even though the environment list can omit it.

Sweep all newly changed code, not only these examples. Retain only non-local constraints or traps that code/types cannot express, and correct or remove every comment whose claimed invariant is not enforced.

## 22. High — administrative 2FA reset does not reauthenticate the acting administrator

app/api/dash/users/[id]/two-factor/handler.ts:41-62 requires the resetTwoFactor permission and a database-backed permission read, but accepts no password/current-factor proof. The route's OpenAPI body is NULL_SCHEMA, and the handler never calls verifyLoginAttempt despite reauth_two_factor already existing as a login-guard purpose.

A stolen administrator session carrying this permission can remove another user's factors and revoke their sessions without step-up. Permission freshness answers whether the actor is authorized; it does not prove the human is still controlling the administrator's credential.

Require a recent, one-use password or current-factor proof bound to the resetTwoFactor action and target user immediately before mutation. Keep the database-backed permission check and rate limit, but do not treat either as reauthentication. Add tests for session-only refusal, wrong proof, target-bound proof, successful one-use consumption, and replay refusal.

## 23. Medium — composing twoFactor without its hooks has no dependency-contract test

twoFactorAuth at lib/auth/two-factor.ts:61-76 removes the entire hooks object from Better Auth's plugin and substitutes local hooks. This relies on two private source properties:

- auth context getPlugin resolves the retained plugin by id, so Better Auth's verifier can still read accountLockout and trust options; and
- the removed hooks object contains no present or future behavior except the sign-in hook being replaced.

The current trusted-device/challenge integration tests exercise login behavior, but do not assert either property. trustDevice is forced to false, so its getPlugin option lookup is not reached; account-lockout lookup silently falls back to defaults if plugin resolution fails. Destructuring hooks into an underscore binding also does not fail if a later Better Auth release adds a security-relevant hook.

Add a version-coupling contract test that instantiates Better Auth's twoFactor plugin and asserts the expected id, retained options/schema/endpoints, and exact upstream hook shape before composing it. Add a runtime test with a non-default account-lockout threshold to prove getPlugin("two-factor") resolves the composed plugin rather than silently using defaults. The private lookup and verifier dependency are visible in the [official Better Auth 1.7.2 context](https://github.com/better-auth/better-auth/blob/v1.7.2/packages/better-auth/src/context/create-context.ts) and [verifier](https://github.com/better-auth/better-auth/blob/v1.7.2/packages/better-auth/src/plugins/two-factor/verify-two-factor.ts).

## 24. Medium — custom OTP/passkey completion does not preserve “do not remember me”

Better Auth's verifier reads the signed dont_remember marker and passes it into createSession, producing a one-day server session for rememberMe: false. completeTwoFactorChallenge at lib/auth/two-factor-challenge.ts:448-475 calls createSession(userId) without that flag. setSessionCookie can still make the browser cookie session-only by reading the marker, but the database session remains valid for the configured 28 days and the marker is not cleared as Better Auth's verifier clears it.

This affects custom OTP and passkey completion while TOTP/backup completion follows a different lifetime contract. It also leaves the marker able to influence a later flow in the same browser session.

Store the remember-me choice in the immutable challenge state, pass its inverse to createSession, and expire the marker after every successful or cancelled completion. Add parity tests for rememberMe false and true across TOTP, backup code, OTP, and passkey, asserting both cookie attributes and database expiry.

## 25. Medium — passkey counter persistence can regress under concurrent challenges

lib/auth/two-factor-passkey.ts:278-284 does persist authenticationInfo.newCounter, but updates by passkey ID alone. Two live sign-in challenges can read the same stored counter, both pass SimpleWebAuthn's comparison, and finish out of order; the lower response counter can overwrite the higher one. That weakens the counter's cloned-authenticator signal.

For authenticators with a nonzero counter, update with compare-and-swap on both credential ID and the counter value read for verification, check the affected row, and reject or explicitly reconcile a lost race. Authenticators that always return zero need the existing zero-counter compatibility path. Add a two-challenge concurrency test proving the stored counter cannot decrease and a stale assertion cannot silently win.

## Changed-file comparison evidence

Comparison baseline: commit 25c7d4f6bb7a26703c3a514383bf9912d27cdd64, message “updates”. Each tracked path below existed at that commit and its prior content was retrieved with git show HEAD:{path} for comparison. There are no tracked deletions.

Tracked modifications with retrieved previous versions:

- app/api/auth/forgot-password/reset/handler.ts
- app/api/auth/otp/messages.ts
- bun.lock
- db/drizzle/meta/_journal.json
- db/maintenance.ts
- db/schema.ts
- lib/auth.ts
- lib/auth/allowed-paths.ts
- lib/auth/login-guard.ts
- lib/auth/passwordless.ts
- lib/auth/rotation.ts
- lib/http/openapi.ts
- lib/permissions/constants.ts
- lib/rate-limit/api.ts
- package.json
- routes.ts
- tests/helpers/run.ts
- tests/helpers/session.ts
- tests/integration/auth-prefix-allowlist.test.ts
- tests/integration/retention-sweep.test.ts
- tests/integration/sign-in-controls.test.ts
- tests/process/schedule-drain.test.ts
- tests/process/startup-gates.test.ts
- tests/unit/openapi-contract.test.ts
- tests/unit/otp-global-breaker.test.ts
- utils/validation/constants.ts
- utils/validation/otp.ts
- utils/validation/rules.ts

Untracked paths have no previous Git version at the baseline:

- app/api/dash/users/[id]/two-factor/handler.ts
- db/drizzle/0005_two_factor_tables.sql
- db/drizzle/0006_two_factor_method_enrollment.sql
- db/drizzle/meta/0005_snapshot.json
- db/drizzle/meta/0006_snapshot.json
- docs/2fa.md
- docs/passkey.md
- lib/auth/password-proof.ts
- lib/auth/plugin-openapi.ts
- lib/auth/trusted-device.ts
- lib/auth/two-factor-challenge.ts
- lib/auth/two-factor-otp.ts
- lib/auth/two-factor-passkey.ts
- lib/auth/two-factor.ts
- reports/two-factor-plan.md
- reports/two-factor-review.md
- tests/integration/two-factor-management.test.ts
- tests/integration/two-factor-otp.test.ts
- tests/integration/two-factor-passkey.test.ts
- tests/integration/two-factor-totp.test.ts
- tests/integration/two-factor-trusted-device.test.ts
- tests/unit/password-proof.test.ts
- tests/unit/two-factor-offered-methods.test.ts
- utils/validation/env-list.ts
- utils/validation/two-factor.ts
