# Two-factor implementation check 3

Date: 2026-09-02

## Scope and baseline

Assumptions used for this check:

- `HEAD` is the pre-implementation baseline because it equals `origin/main` at
  `25c7d4f6bb7a26703c3a514383bf9912d27cdd64` with zero commits ahead or behind.
- Untracked implementation files are part of the work under review. Untracked
  source reports and supplied documentation are inventory items, not evidence that
  code works.
- A repair is “correct” only when its behavior and relevant callers close the
  contract; a passing test is supporting evidence, not the decision.
- The installed, locked packages are the relevant library implementation:
  `better-auth@1.7.2`, `@better-auth/core@1.7.2`,
  `@better-auth/passkey@1.7.2`, and `@simplewebauthn/server@13.3.3`.

Baseline result:

- Branch: `main`.
- Tracked changes: 31 files, 1,761 insertions and 101 deletions.
- New untracked paths: 32.
- Total paths outside the baseline: 63.
- No code, test, migration, configuration, or tracking-document repair was made.
  This check log is the only intentional write from this review.

Process deviation: the two earlier check logs were excluded from review. One bulk
untracked-file line-count command nevertheless invoked `Get-Content` on them and
returned only their byte and line counts. No text from either file was displayed
or used, and neither was touched again. That still technically violated the
instruction not to read them and is recorded here rather than concealed.

## Outcome

**Not ready to merge.** The implementation establishes a credible second-factor
challenge, blocks direct passkey sign-in, binds passkey assertions to the challenged
user, and adds meaningful lifecycle/schema/test infrastructure. However:

1. An empty global method configuration removes the issuer hook itself. Existing
   2FA-enabled accounts then receive a normal password session, while passwordless
   login fails closed. The same configuration hides the operator reset that is
   supposed to be the recovery exit.
2. Recovery still proves only the recovery OTP and checks for another factor’s
   existence; it never proves that disjoint factor before changing the password.
3. A challenge still does not persist the exact factors offered at issuance.
4. Passkey registration requests user verification from the client, but the
   installed plugin verifies registration with `requireUserVerification: false`.
5. The new attempt-budget protocol is correct in isolation, but production callers
   do not execute its restore branch on non-verdict failures.
6. A lost passkey-counter compare-and-swap is logged and accepted, which can retain
   the lower of two valid concurrent counters and weaken clone detection.
7. The administrative reset’s new scope check is outside the transaction and is
   stale by the time the target row is locked.
8. Most of the agreed enrollment/removal/recovery/routing/audit work is explicitly
   not implemented yet.

The original security concern needs one distinction. Adding a passkey while leaving
password login enabled does not make the existing password credential weaker; it
adds another authentication route, and the account’s effective resistance remains
that of its weakest permitted route. It also does not turn password login into 2FA.
For the requested password-then-passkey policy, direct passkey sign-in must remain
unrouted and a user-verifying WebAuthn assertion must be bound to the password
challenge. The current sign-in design does that in principle. Better Auth’s own
documented `signIn.passkey` is a direct sign-in route, not this policy
([Better Auth passkey documentation](https://better-auth.com/docs/plugins/passkey)).
For an MFA policy, SimpleWebAuthn explicitly requires both
`userVerification: 'required'` in creation options and
`requireUserVerification: true` during registration verification
([SimpleWebAuthn passkey guidance](https://simplewebauthn.dev/docs/advanced/passkeys));
WebAuthn requires the relying party to verify the signed UV flag when user
verification is required
([WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/)).

## Exact change inventory

### Modified runtime and application files

| Path                                            | What changed                                                                                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/api/auth/forgot-password/reset/handler.ts` | Added the current recovery/contact-overlap predicate inside OTP proof and exposed its 403 response.                                                            |
| `app/api/auth/otp/messages.ts`                  | Added recovery refusal and two-factor API messages.                                                                                                            |
| `app/api/dash/users/[id]/handler.ts`            | Added the pre-write check that refuses an administrative contact change which would strand the target.                                                         |
| `db/maintenance.ts`                             | Added batched expiry sweeps and result fields for verification values and trusted devices.                                                                     |
| `db/schema.ts`                                  | Added the user flag, verification store, credentials, method-intent, passkey, and trusted-device schema.                                                       |
| `lib/auth.ts`                                   | Integrated plugins and path policy, replaced the permissive password callback with one-use password proofs, added live-session enforcement and login auditing. |
| `lib/auth/allowed-paths.ts`                     | Expanded the method-aware Better Auth route catalogue and status contract.                                                                                     |
| `lib/auth/login-guard.ts`                       | Added the reauthentication purpose and accepted-hash handoff needed by the one-use password proof.                                                             |
| `lib/auth/passwordless.ts`                      | Routed a successful passwordless first factor through challenge issuance and compensating audit/session cleanup.                                               |
| `lib/auth/rotation.ts`                          | Added trusted-device/challenge cleanup and newest-session selection to shared rotation helpers.                                                                |
| `lib/http/openapi.ts`                           | Added summaries, bodies, status sets, responses, and component handling for the new auth surface.                                                              |
| `lib/permissions/constants.ts`                  | Added the dedicated administrative reset permission.                                                                                                           |
| `lib/rate-limit/api.ts`                         | Added `two_factor` as an OTP surface value.                                                                                                                    |
| `routes.ts`                                     | Registered the administrative reset route.                                                                                                                     |
| `utils/api-messages.ts`                         | Added unavailable-factor and stranded-contact response constants.                                                                                              |
| `utils/validation/constants.ts`                 | Added verification-identifier and credential-ID bounds.                                                                                                        |
| `utils/validation/otp.ts`                       | Added the OTP purpose and factored strict channel-list parsing into a shared helper.                                                                           |
| `utils/validation/rules.ts`                     | Exported password normalization for password-proof validation.                                                                                                 |

### Modified package, compiler, and generated migration state

| Path                            | What changed                                                                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                  | Added Better Auth passkey/core and SimpleWebAuthn dependencies, narrowed the Better Auth minimum, and incidentally broadened `eslint-plugin-import-x` from `^4.17.1` to `^4`. |
| `bun.lock`                      | Locked the added authentication/WebAuthn packages and transitive changes.                                                                                                     |
| `db/drizzle/meta/_journal.json` | Registered the two new migrations.                                                                                                                                            |
| `tsconfig.json`                 | Reflowed an unrelated commented target line and added an unrelated commented module line.                                                                                     |

### Modified tests and harness

| Path                                              | What changed                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `tests/helpers/run.ts`                            | Added one all-methods/SMS configuration shared by unit and integration tiers. |
| `tests/helpers/session.ts`                        | Added phone fixtures and deterministic phone generation.                      |
| `tests/integration/auth-prefix-allowlist.test.ts` | Expanded allowed-path and method checks for the auth surface.                 |
| `tests/integration/retention-sweep.test.ts`       | Added verification/trusted-device sweep coverage.                             |
| `tests/integration/sign-in-controls.test.ts`      | Added password-proof, challenge, and audit assertions.                        |
| `tests/process/schedule-drain.test.ts`            | Updated maintenance mocks/results for the new sweep fields.                   |
| `tests/process/startup-gates.test.ts`             | Added strict method/channel parsing and recovery-overlap boot cases.          |
| `tests/unit/openapi-contract.test.ts`             | Added route/method/status/schema coverage for the published auth contract.    |
| `tests/unit/otp-global-breaker.test.ts`           | Included the new OTP purpose in breaker coverage.                             |

### New runtime, schema, and validation files

| Path                                               | Purpose                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `app/api/dash/users/[id]/two-factor/handler.ts`    | Administrative full reset.                                                                              |
| `db/drizzle/0005_two_factor_tables.sql`            | Core 2FA/passkey/trust/verification migration.                                                          |
| `db/drizzle/0006_two_factor_method_enrollment.sql` | Method-intent enum/table migration.                                                                     |
| `db/drizzle/meta/0005_snapshot.json`               | Generated schema snapshot.                                                                              |
| `db/drizzle/meta/0006_snapshot.json`               | Generated schema snapshot.                                                                              |
| `lib/auth/password-proof.ts`                       | Process-local, one-use bridge from manual password verification to Better Auth’s callback.              |
| `lib/auth/plugin-openapi.ts`                       | Response metadata helper for custom Better Auth endpoints.                                              |
| `lib/auth/trusted-device.ts`                       | Durable, listable, revocable trusted-device implementation.                                             |
| `lib/auth/two-factor-challenge.ts`                 | Enrollment intersection, issuance, resolution, attempts, completion, proof markers, and intent helpers. |
| `lib/auth/two-factor-otp.ts`                       | OTP second-factor and method-management endpoints.                                                      |
| `lib/auth/two-factor-passkey.ts`                   | Challenge-bound WebAuthn assertion endpoints.                                                           |
| `lib/auth/two-factor.ts`                           | Better Auth plugin composition and hooks.                                                               |
| `utils/validation/env-list.ts`                     | Strict comma-separated enum-list parser.                                                                |
| `utils/validation/two-factor.ts`                   | Method/channel environment policy and request schemas.                                                  |

### New test files

- `tests/integration/two-factor-management.test.ts`
- `tests/integration/two-factor-otp.test.ts`
- `tests/integration/two-factor-passkey.test.ts`
- `tests/integration/two-factor-totp.test.ts`
- `tests/integration/two-factor-trusted-device.test.ts`
- `tests/unit/password-proof.test.ts`
- `tests/unit/two-factor-attempt-budget.test.ts`
- `tests/unit/two-factor-offered-methods.test.ts`

### New supplied documentation and reports

- `docs/2fa.md`
- `docs/passkey.md`
- `reports/two-factor-audit.md` — tracking authority used by this check.
- `reports/two-factor-check-log-3.md` — this check.
- `reports/two-factor-check-log.md` — excluded as instructed; see the process
  deviation above.
- `reports/two-factor-check-log-2.md` — excluded as instructed; see the process
  deviation above.
- `reports/two-factor-plan-codex-review.md`
- `reports/two-factor-plan.md`
- `reports/two-factor-review.md`
- `reports/two-factor-verification.md`

The superseded plan/review reports were not used to override the tracking document
or the code.

## Additional defects and contradictions found by this check

### C1 — Critical — globally disabling methods disables enforcement

`twoFactorPlugins` is `[]` when `ENABLED_TWO_FACTOR_METHODS` is empty
(`lib/auth/two-factor.ts:175-199`). That removes the `/sign-in/email` after-hook
which calls `issueTwoFactorChallenge`; a database user with
`twoFactorEnabled=true` receives an ordinary password session. Passwordless calls
the issuer directly and refuses the identical account, so first-factor paths
disagree. The administrative reset independently returns 404 while the global
list is empty (`app/api/dash/users/[id]/two-factor/handler.ts:44-45`), removing the
named recovery exit.

Small repair direction: always install the enforcement/issuer hook, gate only
method and management endpoints, and keep the operator reset available for stored
2FA state. A preflight can prevent the configuration change but should not be the
only runtime safety control.

### C2 — Medium — successful sign-in schemas omit the challenge response

Both first-factor endpoints can return
`{ twoFactorRedirect: true, twoFactorMethods: [...] }` with status 200. The current
generated document describes only a normal session for `/sign-in/email` and only
`{ success, message, data.loggedIn }` for `/passwordless/verify`. The tests assert
those narrow schemas and therefore protect the mismatch. Generated clients cannot
model the normal challenge branch.

Small repair direction: make each 200 schema a precise union of completed-session
and challenge responses, then assert both branches.

### C3 — High — administrative reset authorization is stale before mutation

The handler reads and authorizes the target at lines 69-106, then starts a new
transaction and locks only `{ id }` at lines 110-116. It neither re-reads nor
re-authorizes `roleId`, role scope, `createdBy`, deletion state, or protected-role
status under the lock. A concurrent role change can move the target out of scope
after the check and before the reset. The parent edit correctly re-runs all gates
on its locked row (`app/api/dash/users/[id]/handler.ts:416-466`), showing the local
pattern the reset missed.

Small repair direction: select the authoritative joined target under lock inside
the reset transaction and run all reachability/scope checks there; retain the
outer check only as an optimization.

### C4 — Medium — method-change cleanup cannot revoke recent proof markers

The new marker is keyed by session ID and stores the session ID as its value
(`lib/auth/two-factor-challenge.ts:501-520`). Rotation deletes verification rows
whose value equals the user ID (`lib/auth/rotation.ts:50-51`). Under the settled
policy, method removal keeps the current session but revokes trusted devices. A
recent proof marker survives that revocation and can mint a new trusted-device row
immediately afterward.

Repair direction: give proof markers an explicit user owner—preferably a dedicated
typed record—or delete them through the user’s session IDs as part of the same
locked lifecycle transaction.

### C5 — Low — passkey management inputs do not honor local database bounds

The installed plugin accepts unbounded registration/update `name` strings and
plain strings for passkey IDs, while this schema stores names in `varchar(150)` and
IDs as UUID. Overlong names can reach the database as 500s, and malformed IDs can
reach UUID comparisons instead of returning a validation response. No test covers
these boundaries.

Small repair direction: validate plugin-path query/body fields in the shared
before-hook with `NAME_MAX` and `validID`, or expose owned management endpoints
with exact schemas.

### C6 — Medium readiness gap — there is no behavioral configuration matrix

Unit and integration tests run under one fixed configuration: all four methods and
SMS only. Process tests validate parsing and two overlap cases but do not exercise
real endpoints under method/channel subsets, including an empty list, passkey-only,
backup-only, OTP-only, email OTP, or WhatsApp. This is why the global-empty issuer
failure and unenrollable supported configurations remain green.

### C7 — Instruction conflict — new strings are not English

New Arabic strings were added in `app/api/auth/otp/messages.ts`,
`utils/api-messages.ts`, `lib/permissions/constants.ts`, and
`utils/validation/two-factor.ts:157`. That conflicts with the standing “English
only — code and communication” rule. If localized user-facing strings are meant to
be exempt, the standing instruction needs to say so; as written, these additions
violate it.

### C8 — Low — unrelated dependency/compiler drift

`eslint-plugin-import-x` was broadened from `^4.17.1` to `^4`, and `tsconfig.json`
received unrelated commented-option edits. Neither is required for 2FA. The small
repair is to revert both before merging.

### C9 — Design blocker — two OTP rows have no stable API identity yet

The agreed two-channel model can produce two offered OTP choices, but
`TwoFactorMethod[]`, `defaultMethod: 'otp'`, method-only disable, and method-only
intent upsert cannot distinguish email from phone. The planned partial indexes
also remove the unique constraint targeted by the current
`ON CONFLICT (user_id, method)`, so that writer will fail unless it changes with
the migration. Define a stable option identity such as method plus contact kind
(and transport preference where needed), then carry it through issuance, default
selection, send, verify, removal, OpenAPI, and conflict targets.

### C10 — Tracking correction — the do-not-remember marker also lingers on plugin paths

The tracking document says Better Auth clears the marker after its own verifier.
Installed source clears it only inside `if (ctx.body.trustDevice)`, while local
policy forces `trustDevice: false`. Therefore no served TOTP/backup completion
clears the marker either. A later `rememberMe: true` challenge in the same browser
session can inherit an earlier false choice. The agreed companion-state repair is
still the right repair, but tests need false-then-true sequences across plugin and
custom completion paths.

## Tracking finding ledger

Each tracking identifier appears once in this section.

| ID      | Verdict            | Check result                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1**  | Real; open         | The verification row still stores only user ID and the attempt row stores only a count. Resolution recomputes mutable capability and drops the issuance-time contact exclusion. The companion-record approach is correct, but it must store exact option identities, purpose, first factor, exclusion, and remember choice atomically, with an explicit cleanup owner.                                                             |
| **F2**  | Real; partial      | Passing the transaction executor closes the nested-pool liveness defect. Neither proof defect is closed: coexistence with a disjoint factor still lets recovery change the password without proving it, while stale intent with zero current capability still causes permanent refusal. The recovery-grant approach is sound.                                                                                                      |
| **F3**  | Real; partial      | The issuer’s configured-method empty branch now withdraws the session and refuses. C1 shows that the issuer is absent when the global set itself is empty, so the claimed safety property is not unconditional. Cause-specific recovery/audit behavior also remains open.                                                                                                                                                          |
| **F4**  | Real; open         | Successful passkey registration still writes no method intent, does not enable 2FA, and does not apply the shared enrollment lifecycle. An owned flow is correct. Do not add the existing body-password guard directly to the plugin’s GET options route; use a POST reauthentication step that mints a one-use user/ceremony-bound enrollment grant.                                                                              |
| **F5**  | correct            | —                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **F6**  | Real; open         | Removal still counts outside its write transaction, removes intent only, has no password proof, does not identify an OTP channel, and revokes neither capability nor trust. The owned locked lifecycle is the right boundary.                                                                                                                                                                                                      |
| **F7**  | Real; open         | The library self-disable route remains reachable and knows nothing about custom intent, passkeys, trusted devices, companion state, or the full cleanup contract. Replace it with the owned lifecycle rather than compensating afterward.                                                                                                                                                                                          |
| **F8**  | Real; open         | Supported backup-only and passkey-only configurations still have no valid first-enable route; generic enable/disable and acknowledgement exposure remains broader than the method actually configured. Owning backup generation and gating each management route is correct.                                                                                                                                                       |
| **F9**  | Real; open         | Repeat enable still rotates verified material; acknowledgement is not set-version-bound or cleared on regeneration; exhausted codes remain advertised because capability checks only the acknowledgement timestamp; acknowledgement is optional. The proposed staged/owned lifecycle closes the class.                                                                                                                             |
| **F10** | Real; open         | Both enrollment paths still preserve the newest session instead of the caller’s session, and OTP enrollment still commits before a separately swallowed revocation. Carry the exact caller session or revoke all and reissue atomically.                                                                                                                                                                                           |
| **F11** | Real; open         | Adding `two_factor` to the surface type and call sites did not separate verification quota keys: `enforceOtpVerifyQuota` distinguishes only `recovery`; every other surface still shares `otp.verify.dest.<kind>`.                                                                                                                                                                                                                 |
| **F12** | Real; partial      | The helper no longer re-arms before a verdict and its isolated interleaving test is good. No production caller invokes `restore`: OTP charges every thrown verification error, including infrastructure failures, and passkey DB/counter/completion faults after the spend can leave the row absent. Wire exactly one outcome on every non-consuming path and test callers, not only the helper.                                   |
| **F13** | Real; partial      | Assertion options and server verification correctly require UV. Registration only requests it from the client; installed plugin source hardcodes `requireUserVerification: false`, so a custom client can register a credential with UV unset. Reject in `registration.afterVerification` before persistence, or own registration, and test the signed UV bit.                                                                     |
| **F14** | Real; open         | Reset has permission, liveness, rate, and target checks but no short-window administrator reauthentication. Applying one shared reauthentication boundary to the entire security-lowering action class remains the correct design.                                                                                                                                                                                                 |
| **F15** | Real; open         | OTP send/verify and the library TOTP/backup verification routes still omit conditional live-session enforcement in enrollment mode. `enrolmentTarget` excludes deleted users but not inactive users. Use the resolved mode once, then require liveness only for the session branch.                                                                                                                                                |
| **F16** | Real; open         | Custom completion still creates a 28-day database row when the request asked for a one-day row. The browser cookie happens to be session-scoped. C10 corrects the tracking document’s claim about marker cleanup and broadens the repeated-flow tests required.                                                                                                                                                                    |
| **F17** | correct            | —                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **F18** | Real; open         | Issuance returns database order, has no preference/default, never auto-routes, and cannot represent two OTP choices. The priority policy is reasonable after C9 supplies exact option identity; backup codes should remain manual-only.                                                                                                                                                                                            |
| **F19** | Real; open         | Recovery, passwordless, contact verification, and second-factor delivery still share undifferentiated delivery hooks/templates. Add purpose-aware delivery with a test outbox before claiming channel coverage.                                                                                                                                                                                                                    |
| **F20** | Real; open         | Custom endpoints still declare generic record bodies, route-local limiter responses are incompletely modeled, and C2 adds a missed 200-response mismatch. Publish exact request and response schemas and verify runtime examples against them.                                                                                                                                                                                     |
| **F21** | Real; open         | Final custom OTP/passkey sessions audit as `unknown`; first-factor sessions are logged as successful before withdrawal; trusted bypass is not represented; management rotation and interactive issuance remain conflated. Persist the chain in challenge state and emit one explicit completion/bypass event.                                                                                                                      |
| **F22** | Real; partial      | Compare-and-swap prevents a backward write, but a lost swap is accepted. If a lower counter lands first and a higher valid assertion loses, the stored maximum remains too low and a clone with an intermediate fresh counter can pass. Reject or monotonically reconcile the loser. The test covers only higher-first/lower-loser ordering.                                                                                       |
| **F23** | Real; open         | The trusted-device-to-verification deletion loop is dead; challenge counters and WebAuthn ceremonies are not selected by `value = userId`; C4 adds the new proof-marker gap. Model and delete every owned artifact explicitly per rotation kind.                                                                                                                                                                                   |
| **F24** | Real; open         | The correction in the tracking document is right: `verifications.expires_at` is indexed; `trusted_devices` has only `(user_id, expires_at)`, which cannot lead an expiry-only sweep. Add an expiry-leading index or explicitly accept and document the scan.                                                                                                                                                                       |
| **F25** | Real; open         | There is no read-only deployment preflight for stored intent/capability against a proposed method set. It must report affected populations and block unsafe rollout before configuration changes.                                                                                                                                                                                                                                  |
| **F26** | Real; open         | No contract test proves the stripped library hook shape, endpoint path mapping, internal cookie/identifier formats, or the assumptions copied from installed source. Add a version-coupling test that fails loudly on drift.                                                                                                                                                                                                       |
| **F27** | Real; open         | New code remains dominated by section banners and change-history/test-narrative comments. Additional false claims now include registration options being a server “hard gate,” a unique index being “not indexed,” and backup codes being enabled in every deployment. Apply the requested changed-code comment sweep.                                                                                                             |
| **F28** | correct            | —                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **F29** | Real; partial      | Empty-set refusal works only when the issuer exists. The admin guard handles one contact against current state, but leaves dependent intent live, does not cover self-service, can race method writers, and will mis-evaluate a simultaneous email+phone change under the planned two-row model because each simulation starts from the original state. Simulate the whole mutation and couple contact writes to method lifecycle. |
| **F30** | Real; partial      | Static out-of-scope targets are now refused. C3 shows the authorization decision is not protected by the subsequent target lock, so the repaired invariant can still lose a role/deletion race. The test covers only a static target and checks the parent route merely as “not 200.”                                                                                                                                              |
| **F31** | Real; open         | Refusal is logged later under the affected user, not as an attributable method invalidation/reset event under the actor inside the mutating transaction. Add explicit actor/target/method/reason audit events to owned lifecycle operations.                                                                                                                                                                                       |
| **N1**  | Real; open         | OTP enrollment still needs only a session plus a code to a verified contact, while recovery can then become permanently blocked. Require password proof/current-factor proof in the owned enrollment flow.                                                                                                                                                                                                                         |
| **N2**  | Real; open         | The TOTP after-hook runs after library persistence, so throwing cannot roll the library write back and cannot compensate reliably. Move credential, intent, flag, acknowledgement, and rotation into one owned transaction/state machine.                                                                                                                                                                                          |
| **N3**  | correct            | —                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **N4**  | Not real as stated | The settled path-level possession rule makes enrollment refusal the wrong control. Current code instead adds a startup refusal for an OTP-only overlapping deployment, contradicting that decision. Remove the gate, retain an overlap warning, and enforce disjoint proof in each recovery/passwordless chain.                                                                                                                    |
| **N5**  | Real; open         | Schema uniqueness still permits one OTP row. The partial-index direction is valid, but the migration must also change conflict targets, method removal, offered-option types, default identity, routing, and tests; otherwise current upsert SQL has no matching unique constraint.                                                                                                                                                |
| **N6**  | Real; open         | `@better-auth/core` remains in runtime dependencies under `^1.7.2` although usage is type-only. Move it to development dependencies and pin exactly to the installed Better Auth version.                                                                                                                                                                                                                                          |

## Settled-decision check

| ID      | Assessment                                                                                                                                                                                                                                                                                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1**  | Sound, but contradicted by the current startup refusal and not implemented in recovery. Enforce contact-kind disjointness on the authentication chain, not enrollment/configuration.                                                                                                                                                                                                         |
| **D2**  | Sound. Safety is only partial because of C1; liveness still depends on mandatory acknowledged recovery material and an operator reset which remains reachable even when methods are disabled.                                                                                                                                                                                                |
| **D3**  | Bounded exhaustion is the right policy. The claim that the terminal population is exactly “OTP-only, codes spent” is too narrow: stale/deleted capability and method-list changes also produce unusable states, and physical authenticator loss is not visible in the intersection.                                                                                                          |
| **D4**  | Sound and open. The grant must be short-lived, one-use, method-set-version-bound, contact-kind-bound, independent of trusted devices, and consumed before the password write without issuing a session.                                                                                                                                                                                      |
| **D5**  | Policy is coherent but conflicts with the configuration contract, which still permits `backup_code` to be disabled. Decide whether startup requires it whenever 2FA is enabled or whether enable implicitly supplies it; otherwise “mandatory” is not enforceable.                                                                                                                           |
| **D6**  | Sound and open. One owned lifecycle is necessary because the installed plugin cannot make custom intent/capability/acknowledgement/rotation atomic.                                                                                                                                                                                                                                          |
| **D7**  | Sound with C9’s refinement: persist exact options, never only method names; current capability may narrow but never widen the issued set. Create and clean the companion record atomically with its challenge.                                                                                                                                                                               |
| **D8**  | Sound but incomplete as a migration plan. Update every uniqueness consumer and prove the generated column and partial conflict targets by applying the migration, not only by reading SQL.                                                                                                                                                                                                   |
| **D9**  | The priority and manual-only backup rule are sound. A method-only `defaultMethod` cannot identify two OTP channels; use the same stable option key through preference, response, and route selection.                                                                                                                                                                                        |
| **D10** | Sound and open. Persist the submitted choice, pass it into database-session creation, set the cookie consistently, clear legacy marker state on every completion/cancel, and test false-then-true sequences.                                                                                                                                                                                 |
| **D11** | Policy is reasonable, but current `revokePendingProofs` always calls `revokeTwoFactorState`; therefore voluntary password change already revokes trusted devices contrary to the decision. Split rotation helpers by event and include C4’s proof markers.                                                                                                                                   |
| **D12** | Sound and open. Implement one reusable short-window admin proof for the whole action class, then apply authorization again inside each mutation transaction.                                                                                                                                                                                                                                 |
| **D13** | Sound and open. Passwordless currently refuses rather than reroutes, while C1 makes password sign-in do the opposite under a globally empty list. Return a machine-readable route-to-password state without weakening either path.                                                                                                                                                           |
| **D14** | Sound and open. No independent server-side passwordless toggle exists; both entry points and the future deployment note remain.                                                                                                                                                                                                                                                              |
| **D15** | Sound and open. A production-impossible in-process outbox is the right way to test every channel and message purpose without provider accounts or plaintext-code logs.                                                                                                                                                                                                                       |
| **D16** | Partial. Password-proof replacement, method-aware runtime routing, attempt helper, assertion UV, ordering, and deterministic phone fixtures landed. Credential default, dependency placement/pin, method-aware known catalogue, named server-only exemptions, pepper-CAS reread, registration UV, comment cleanup, exact remember handling, and endpoint-driven configuration matrix remain. |

## Verification performed

| Command                    | Result                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git diff --check`         | Clean.                                                                                                                                                                |
| `bun run lint`             | Passed: TypeScript plus ESLint, zero warnings/errors.                                                                                                                 |
| `bun run test`             | Passed: 875 tests, 0 failures, 3,201 expectations, 184.24 s.                                                                                                          |
| `bun run test:integration` | Passed: 332 tests, 0 failures, 1,793 expectations, 77.56 s. The harness applied the new migrations to its database template.                                          |
| `bun run test:process`     | Passed: 50 tests, 0 failures, 136 expectations, 2 Windows-only skips, 54.56 s. The skipped cases are POSIX SIGTERM handling and the SQLite concurrent-open assertion. |

Focused suites for offered methods, attempt budgeting, password proofs, OTP breaker,
OpenAPI, management, OTP, passkey, TOTP, trusted devices, sign-in controls, auth
allowlisting, retention, and startup gates also passed before the full runs. One
earlier duplicate full unit run was manually terminated after prolonged silence;
the clean full rerun above is the authoritative result. No temporary test code was
created or retained.

Not behaviorally verified:

- A real browser/authenticator registration or assertion ceremony. Registration
  UV behavior was established from installed source and exported library types.
- The administrative role-change race or the inverse passkey-counter race. Both
  follow directly from statement ordering, but no test or mutation was added.
- Real email/SMS/WhatsApp delivery; the project has no test transport yet.
- Endpoint behavior under the missing environment matrix.
- A production-scale PostgreSQL query plan for the trusted-device sweep.

## Recommended repair order

1. Keep challenge enforcement installed under an empty global method set and keep
   operator reset reachable.
2. Finish the claimed landed security repairs: server-enforce registration UV,
   reject/reconcile a lost counter swap, wire attempt restoration, and move reset
   authorization into its locked transaction.
3. Build the owned enable/disable/removal lifecycle with mandatory, version-bound
   backup acknowledgement.
4. Add immutable exact-option challenge state, remember handling, ordering, and
   complete factor-chain audit.
5. Replace recovery refusal with the disjoint-factor recovery grant and remove the
   startup overlap refusal.
6. Finish contact-coupled invalidation, admin reauthentication, rotation-specific
   cleanup, deployment preflight, and configuration-matrix tests.
7. Repair OpenAPI unions/bodies, message/test transport, comments, validation
   bounds, dependency placement, English-policy conflict, and unrelated drift.
