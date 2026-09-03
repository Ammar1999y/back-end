# Two-factor check log 2

Method: working tree read against `git HEAD` (last push), plus the installed
`better-auth@1.7.2` / `@better-auth/passkey@1.7.2` / `@simplewebauthn/server`
sources. Steps 0 and 1 of the tracking document's order of work are claimed
landed; steps 2–8 are not, so findings assigned to them are judged on the
recorded fix approach only.

Files that changed (31 modified, 30 untracked) — the 2FA-relevant set:
`lib/auth.ts`, `lib/auth/{two-factor,two-factor-challenge,two-factor-otp,two-factor-passkey,trusted-device,rotation,allowed-paths,password-proof,plugin-openapi,login-guard,passwordless}.ts`,
`db/schema.ts`, `db/maintenance.ts`, `db/drizzle/000{5,6}_*.sql`,
`app/api/dash/users/[id]/{handler.ts,two-factor/handler.ts}`,
`app/api/auth/forgot-password/reset/handler.ts`, `app/api/auth/otp/messages.ts`,
`routes.ts`, `lib/permissions/constants.ts`, `lib/rate-limit/api.ts`,
`lib/http/openapi.ts`, `utils/validation/{two-factor,env-list,constants,otp,rules}.ts`,
`utils/api-messages.ts`, plus 8 new test files and 6 modified ones.

---

## In progress: F5, F17 — device trust bound to a proof; `disableSession` strip

correct

## In progress: F12 — challenge attempt counter

correct, with one conflict recorded separately below.

**Conflict (F12).** The digits-only parse only governs OUR verifiers. The
`2fa-attempts-<challenge>` row is shared with the library's `beginAttempt`
(`node_modules/better-auth/dist/plugins/two-factor/verify-two-factor.mjs:74-76`),
which still does `Number(consumed.value)` + `Number.isInteger` — so the empty-value
case F12's own test calls "the one direction this check exists to prevent" is still
open on `/two-factor/verify-totp` and `/two-factor/verify-backup-code`, which read
the same identifier. `TWO_FACTOR_ALLOWED_ATTEMPTS = 5` does match the library's
`beginAttempt(5)` at `totp/index.mjs:185` and `backup-codes/index.mjs:199`, so that
half of the coupling holds.

## In progress: F22, F13 — passkey counter CAS and user verification

F22: correct.

F13 — **partly done, and the code comment overstates it.** The assertion half is
right: `userVerification: 'required'` on `generateAuthenticationOptions` and
`requireUserVerification: true` on `verifyAuthenticationResponse`
(`lib/auth/two-factor-passkey.ts`). The registration half is a client hint only.
`lib/auth/two-factor.ts` passes `authenticatorSelection: { userVerification:
'required' }`, which reaches the ceremony options
(`@better-auth/passkey/dist/index.mjs:177-180`), but
`/passkey/verify-registration` hardcodes `requireUserVerification: false`
(`:355`) — so a client that ignores the hint still gets the credential stored.
The comment at `lib/auth/two-factor.ts` says "Refuse a non-verifying
authenticator at REGISTRATION"; nothing refuses it. Effect is liveness, not
access: such a credential is stored and then fails every assertion, so the user
holds an inert passkey rather than a weak factor. Either enforce it in an
`afterVerification` hook that rejects when
`registrationInfo.userVerified !== true`, or narrow the comment.

## In progress: F3, F29, F31, F25 — the empty offered set and the contact-rewrite chain

**F3 — real; safety half correct.** `issueTwoFactorChallenge` now withdraws the
first-factor session and returns `refused`; both callers raise 403
`TWO_FACTOR_UNAVAILABLE` (`lib/auth/two-factor.ts` `/sign-in/email` after-hook,
`lib/auth/passwordless.ts`). `two-factor-passkey.test.ts:198` asserts the refusal
and that `/api/auth/get-session` answers `null`.

**Missing (F3).** The finding's own **Fix** asks for a _distinct audit reason per
cause_ — possession exclusion versus capability loss. One reason
(`two_factor_unavailable`) fires for both, so the operator-caused case still
cannot be alerted on separately. The document's Step-0 note records the reason
rename but not the split, so this is a specified item that did not land. Low cost
to add: `params.excludeContactKind` is already in scope at the branch and is
exactly the discriminator.

**Conflict (F3 vs D2 wording).** `issueTwoFactorChallenge` calls
`consumeDeviceTrust` BEFORE computing the offered set, so a user whose offered set
is now empty still signs in on a device trusted earlier. D2 states the safety
half as "an empty offered set never grants access. Fail closed." — that is
literally false as ordered. It is defensible (the trust row required a real proof
to exist, and trust is a documented skip), and it is not the F5 hole, but the two
statements disagree and one of them should change. The population it affects is
exactly the one an operator's method-list change creates: every other user with
that enrolment is refused, this one keeps signing in with the password alone, and
nothing in D11 revokes trust on a capability loss caused by an env-list change or
a last-passkey deletion. Either compute the offered set first and refuse before
honouring trust, or record the exception in D2.

**F29 — real. Property 1 closed by step 0; property 3 correct; 2a and 2b open as
scheduled (steps 2 and 5).** Property 3: `contactChangeStrandsTwoFactor` is called
inside `handleAdminEdit`'s locked transaction with `tx`, per kind, before the
`users` UPDATE, and raises 409 `MSG_CONTACT_CHANGE_STRANDS_TWO_FACTOR`
(`app/api/dash/users/[id]/handler.ts:621-645`). Tests at
`two-factor-management.test.ts:272,297` assert the 409 with no write and the
allowed case.

**Conflict (F29 property 3 vs D8).** The predicate is asked once per changed
contact kind, each time against the _unmodified_ state of the other kind. That is
exact only while a user can hold one OTP row. Under D8 (two OTP channels, step 3),
an edit changing email AND phone in the same request passes both checks — email
survives because phone still counts, phone survives because email still counts —
and strands the user anyway. Fix when D8 lands: build one hypothetical state with
every changed kind cleared and ask the predicate once, rather than looping.

**F31 — real, not implemented (step 6).** Confirmed: the admin edit's audit row
carries no 2FA state, `revokeTwoFactorState` writes no row, and the only trace is
`recordChallengeEvent` under the victim's user id with `reason:
'two_factor_unavailable'`. Recorded fix approach is right; note that after step 0
the reason string is no longer shared with a routine login (the login is refused,
not completed), so the "same reason string on every routine login" half of F31's
rationale is now stale — the remaining defect is attribution, not signal noise.

**F25 — real, not implemented (step 6).** No preflight script exists
(`scripts/` has `check-password-peppers.ts` and no 2FA equivalent). The recorded
fix looks right and is now more load-bearing than when written: post-step-0 a
method-list change turns affected logins into hard 403s rather than silent
downgrades, so an unsized rollout is an outage rather than a weakening.

## In progress: F2, N1, N4, F11 — recovery and the OTP verify budget

**F2 — real; only the liveness half was in scope for step 1, and it is correct.**
`readEnrollment` takes `executor: Tx | typeof db = db`; both predicates take it
and both callers pass `tx`
(`app/api/auth/forgot-password/reset/handler.ts:114-118`,
`app/api/dash/users/[id]/handler.ts:634`). `issueTwoFactorChallenge` and
`resolveTwoFactorChallenge` correctly keep the pool default — neither runs inside
a transaction. No other `readEnrollment` reachable call sits inside one.

Failure mode A (takeover) is open as scheduled (step 4, D4). Failure mode B is
open too, and I want to flag that the guard actually written is **not** the one
F2's **Fix** specifies:

```ts
if (state.intent.length === 0) return false; // what is there
if (offeredMethods(state).length === 0) return false; // what F2 asks for
```

`intent.length === 0` covers only the no-intent case. The case F2 names — intent
rows survive but capability is gone (last passkey deleted, method removed from
the env list, credential row cleared by `/two-factor/disable`) — still returns
`true` and refuses recovery permanently. The one-line change closes B independently
of D4 and independently of step 4; it is cheap and I would land it now rather than
carry it.

**N1 — real, not implemented (step 4).** `/two-factor/otp/verify` in enrolment
mode is authenticated by `sessionUser(ctx)` alone, has no `sessionMiddleware`, and
is absent from `PASSWORD_PROOF_PATHS` (verified in `lib/auth.ts`). The recorded
fix (add the enrolment paths to `PASSWORD_PROOF_PATHS`) has a wrinkle worth
naming now: `PASSWORD_PROOF_PATHS` is keyed by path, and this path is dual-mode —
adding it would demand a password on the _sign-in_ branch too, where the caller
has only a challenge cookie. It has to be a mode-conditional check inside
`enforceTwoFactorPathPolicy`, sharing F15/N3's one discriminator, not a set entry.

**N4 — not real as written; superseded.** D1 explicitly rejects the
enrolment-time refusal, so "the refusal has no implementation" is no longer a
defect. What remains is the enrolment _warning_, which is a D4 message item, not
this finding. The startup refusal N4 points at
(`utils/validation/two-factor.ts`) exists and is tested
(`startup-gates.test.ts:351,368`).

**F11 — real, not implemented (step 4).** `enforceOtpVerifyQuota`
(`lib/rate-limit/api.ts:229-232`) still branches only on `recovery`, so
`surface: 'two_factor'` shares `otp.verify.dest.${kind}` with the anonymous
`/api/auth/otp/verify`. The attack described holds verbatim. Recorded fix is
correct and is a three-line change; it does not depend on D4 and I see no reason
it sits in step 4 rather than being pulled forward.

_(F11 addendum: the public surface is `captcha: true`, so each of the ten
burn requests costs a Turnstile solve. It raises the price, it does not remove
the attack — the budget is 10 per 600 s per destination.)_

## In progress: F1, F16, F18, F21, N5 — challenge binding and routing (all step 3)

**F1 — real, both halves.** 1a: `totp/index.mjs:172-224` and
`backup-codes/index.mjs:187-233` resolve the credential row and never read
`two_factor_methods` or any offered set. 1b: `resolveTwoFactorChallenge` calls
`offeredMethods(state)` with no `excludeContactKind`, and the challenge row holds
only the user id — verified in the current code, unchanged.

**Trap in D7's recorded fix.** D7's constraint "apply the check only in sign-in
mode" is correctly derived, but the discriminator matters more than the document
says. `verifyTwoFactor` branches on `getSessionFromCtx(ctx)` FIRST
(`verify-two-factor.mjs:14-15`), so _session present_ selects the enrolment
branch even when a live challenge cookie is also present — no `beginAttempt`, no
challenge consumption, `valid()` returns the existing session. A `before`-hook
check keyed on "challenge cookie present" (which is what
`readChallengeCookie` gives, and what the existing TOTP intent after-hook uses)
therefore fires in a mode the library treats as enrolment, and misses nothing —
but the reverse case is the hole: a sign-in-mode caller who also holds any live
session for that user skips the sign-in branch entirely. The companion-record
check has to key on the library's own discriminator (session-first), not on the
cookie, or it guards the wrong branch.

**F16 — real, with one inaccurate sentence.** The defect is real:
`completeTwoFactorChallenge` calls `createSession(challenge.user.id)` with no
second argument, while the library passes `!!dontRememberMe`
(`verify-two-factor.mjs:31`) — 1 day versus 28. The marker does survive the
challenge, because `issueTwoFactorChallenge` calls
`deleteSessionCookie(ctx, true)`.

F16's sentence "The marker is also not cleared as Better Auth's verifier clears
it" is **wrong**. The library expires `dontRememberToken` only inside
`if (ctx.body.trustDevice)` (`verify-two-factor.mjs:57`), and this deployment
forces `trustDevice: false` on both plugin verifiers — so the library does not
clear it either. The residual (a stale marker influencing a later flow in the
same browser) is real for every path; the comparison is not.

**F18 — real, not implemented.** `readEnrollment`'s `two_factor_methods` select
has no `ORDER BY`; `offeredMethods` maps in `state.intent` order; nothing sorts,
no `defaultMethod`, no `is_default` column, and `GET /two-factor/methods` returns
`listEnrolledMethods` (intent only, no capability join). Recorded fix looks right.
`tests/unit/two-factor-offered-methods.test.ts` tests the intersection and
asserts nothing about order, so nothing will fail when D9 lands.

**F21 — real, not implemented.** `SESSION_METHOD_BY_PATH` in `lib/auth.ts` maps
four paths only; `/two-factor/otp/verify` and `/two-factor/passkey/verify` create
sessions through `completeTwoFactorChallenge` and are not in the map. The
mislabelling half is real too: the map is keyed by path alone, so a
passwordless-then-TOTP completion is recorded `password+totp`.

**N5 — real, not implemented.** `ux_two_factor_methods_user_method` is
`(user_id, method)` (`db/schema.ts`) and `recordMethodIntent`'s
`onConflictDoUpdate` targets the same pair, overwriting `channel` — so a second
channel replaces the first rather than adding. D8's partial-index shape is the
right fix. Note `recordMethodIntent`'s conflict target must change with it, or the
upsert silently keeps collapsing the two rows.

## In progress: F4, F6, F7, F8, F9, F10, N2 — the enrolment lifecycle (steps 2 and 5)

All seven are real. Confirmed against the current tree, not the document:

**F4** — three `recordMethodIntent` call sites only (`two-factor.ts:143` TOTP,
`two-factor-otp.ts:357` OTP, `:505` backup-code acknowledgement); no
`method: 'passkey'` writer anywhere; no hook on `/passkey/verify-registration`;
`revokeTwoFactorState` contains no reference to `passkeys`. The registration
authorization half is real too: `/passkey/generate-register-options` and
`/passkey/verify-registration` are allow-listed and in `LIVE_SESSION_PATHS` but
NOT in `PASSWORD_PROOF_PATHS`, and the plugin protects them with
`freshSessionMiddleware` against `freshAge: 60 * 60 * 10`.

**F6** — `/two-factor/methods/disable` reads `listEnrolledMethods(userId)`
through the pool outside the transaction and deletes inside a separate
`withTransaction`, so the last-method check is not serialised; the path is absent
from `PASSWORD_PROOF_PATHS`; nothing per-method is cleaned up.

**F7** — `resolveTwoFactorChallenge` never reads `state.enabled`, so a challenge
outlives a `/two-factor/disable`. The library's disable
(`two-factor/index.mjs:206-239`) touches none of `two_factor_methods`,
`passkeys`, or other devices' `trusted_devices` rows.

**F8** — verified in the installed `better-auth@1.7.2`:
`if (method === "otp" && !options?.otpOptions?.sendOTP) throw … OTP_NOT_CONFIGURED`
and `if (method === "totp" && options?.totpOptions?.disable) throw …
TOTP_NOT_CONFIGURED` at `two-factor/index.mjs:114-115`, against
`otpOptions: undefined` and `totpOptions: { disable: !isTwoFactorMethodEnabled('totp') }`.
Also confirmed: `/two-factor/enable`, `/two-factor/disable` and
`/two-factor/backup-codes/acknowledge` are pushed unconditionally in
`twoFactorEndpoints()`, so with `totp` off the contract publishes a 200 on an
endpoint that can only 400, and the acknowledge path is served with
`backup_code` disabled.

**F9** — verified at `two-factor/index.mjs:130-166`: a repeat enable replaces
`secret` and `backupCodes` and computes
`verified: existingTwoFactor != null && existingTwoFactor.verified === true || …`,
so a verified authenticator is silently replaced. `backupCodesReady` is still
`acknowledgedAt != null` with no set identity and no unused-code count.

_Version note._ `docs/2fa.md` (checked in with this change) documents
`TOTP_ALREADY_ENABLED` on a repeat enable. That error code does not exist in the
installed 1.7.2 — `grep` finds it nowhere in
`node_modules/better-auth/dist/plugins/two-factor/`. The doc is ahead of the pinned
version, which is worth knowing before anyone closes F9 by trusting it.
`allowPasswordless`, also documented there, IS present in 1.7.2.

**F10** — `newestSessionId` is `ORDER BY created_at DESC LIMIT 1`; `sessionUser`
returns only the user id and discards the session id it already read from
`findSession`; the plugin rotates only under
`if (twoFactor.verified !== true) { if (!user.twoFactorEnabled) … }`
(`totp/index.mjs:204-206`), so the "newest = caller's" assumption fails for a
user adding TOTP to an existing OTP enrolment. Recorded fix is right and the
cheaper half of it (`sessionUser` returning the id) is a two-line change.

**N2** — real. The `after` hook at `lib/auth/two-factor.ts:150-166` throws
`INTERNAL_SERVER_ERROR` after the plugin has already committed `verified: true`
and (on a first enable) `twoFactorEnabled: true`, so the throw manufactures the
state its comment claims to prevent. Post-step-0 this is worse than when written:
that user's next `/sign-in/email` no longer downgrades, it 403s
`TWO_FACTOR_UNAVAILABLE` and needs an operator reset. The recorded fix
("until D6, the hook must not throw; retry or record a repairable state") is
right and should be pulled forward — it is currently a route from one failed
database write to a locked-out account.

## In progress: F30, F14 — the administrative boundary

**F30 — correct.** `validateRolePermissionScope(actorPermissions, targetRoleId,
db, 'reachability')` is called in the reset handler, guarded by
`if (actorPermissions)`, which is the exact shape
`app/api/dash/users/[id]/sessions/handler.ts:172-178` uses. Verified end to end:
`two-factor-management.test.ts:361` gets 404 and the target keeps `['totp']`.

**Missing (F30, test only).** The second half of that test is tautological. The
finding's own **Tests** row asks that "the refusal matches `PUT`'s 404 on the same
id"; the actor it uses holds `{ users: { view, resetTwoFactor } }`, so the `PUT`
is refused 403 for lacking `users.edit` at all — it never reaches the role-scope
gate, and `expect(edit.status).not.toBe(OK)` would pass whatever the scope check
did. The agreement the finding is about (an actor who HAS `users.edit` but is
outranked) is untested. Observed statuses in the run: reset 404, PUT 403.

**F14 — real, not implemented (step 6, D12).** The handler runs
`requirePermission({ forceDB: true })`, `enforceRateLimit`,
`assertTargetUserVisible` and now `validateRolePermissionScope`, and calls
`verifyLoginAttempt` nowhere; `routes.ts` declares `body: 'none'` for the route.
The asymmetry with `users/me/change-password` is as described.

One thing the finding does not name and D12 should: the handler passes
`isSelf: target.id === actorUserId`, so a holder of `users.resetTwoFactor` can
clear **their own** 2FA, and `assertTargetUserVisible` exempts self from both its
narrowings. Combined with the trust-cookie ordering noted under F3, the cheapest
self-disarm in the system is "hold a trusted device, sign in with the password,
POST your own id" — no factor proven at any step. D12's class already lists this
endpoint, so the fix covers it; it should be listed as a reason rather than
discovered later.

## In progress: N3, F15 — the two dual-mode endpoint pairs

**N3 — correct.** `/two-factor/otp/send` resolves once through
`resolveTwoFactorChallenge` and `signInTarget` takes the resolved challenge
rather than re-reading it. Covered by `two-factor-otp.test.ts:294`.

**F15 — real, not implemented (step 6).** `LIVE_SESSION_PATHS` still omits
`/two-factor/otp/send`, `/two-factor/otp/verify`, `/two-factor/verify-totp` and
`/two-factor/verify-backup-code`. `sessionUser` reads the database but checks
neither `is_active` nor `deleted_at`; `enrolmentTarget` filters
`isNull(users.deletedAt)` and not `isActive`. So a suspended user holding a live
session row can still enrol OTP and set `two_factor_enabled`. Recorded fix
(conditional `assertLiveSession` on the one discriminator) is the right shape, and
N3 has already built the discriminator on the OTP pair — the remaining work is the
plugin pair, whose mode is decided inside the library by `getSessionFromCtx`, so
the hook has to reproduce that call rather than read the challenge cookie (same
trap as F1/D7 above).

## In progress: F19, F20 — messages and contract

**F19 — real, not implemented (step 7).** `utils/otp.ts` still builds one string
per transport with no purpose: `messageText ?? \`رمز التحقق هو: ${code}\``
(`:195`), the WhatsApp `content` (`:210`), and the email `subject: 'رمز التحقق - …'`
/ body (`:315-318`). `processOtpSend`receives`purpose`and uses it only for the
proof row and the advisory lock. The 2FA send passes`entityName: 'البريد الإلكتروني' | 'رقم الهاتف'`, which appears only in the
block message, so a login code and a recovery code are byte-identical.

**F20 — real, not implemented, and now larger than the finding says.** Confirmed:
`BETTER_AUTH_BODIES` still has two entries (`/sign-in/email`,
`/passwordless/verify`) while eight new endpoints declare
`z.record(z.string(), z.unknown())` and parse narrower schemas by hand;
`BETTER_AUTH_LOCAL_THROTTLE_PATHS` is still `new Set(['/passwordless/verify'])`
(`lib/http/openapi.ts:1253`) although `/two-factor/otp/{send,verify}` reach
`enforceOtpSurfaceSendQuota` / `enforceOtpVerifyQuota` and can answer 429/503.

**Additional, same class, introduced by step 0:** `/sign-in/email` and
`/passwordless/verify` now have a _second_ 200 shape —
`{ twoFactorRedirect: true, twoFactorMethods: [...] }` — and neither the contract
nor `tests/unit/openapi-contract.test.ts` mentions `twoFactorRedirect` anywhere
(`grep` returns nothing in both files). A client generated from this document
cannot represent the challenge response. Add it to F20's inventory.

_(Credit where due: D16's method-aware known set — `BETTER_AUTH_KNOWN_PATHS` plus
the two-way leftover checks in `openApiConsistencyProblems` — has landed, ahead of
its step.)_

## In progress: F23, F24, F26, F27, F28, N6 — the low tier

**F23 — real, not implemented.** The loop over deleted `trustIdentifier`s in
`revokeTwoFactorState` still deletes zero `verifications` rows (nothing writes a
verification row per trusted device — `grantDeviceTrust` writes only
`trusted_devices` + a cookie, and the plugin's own trust writer is unreachable
behind the forced `trustDevice: false`). Blast radius is still incomplete, and it
is now wider than the finding records: besides the `2fa-attempts-<id>` rows
(`value = '0'`) and `passkeys`, the new `2fa-proven-<sessionId>` rows
(`value = sessionId`) also survive `WHERE value = userId`. Add them to the fix.

**F24 — real, not implemented, and correctly re-scoped.** `db/schema.ts` creates
only `idx_trusted_devices_user` on `(user_id, expires_at)`;
`sweepTrustedDevices` (`db/maintenance.ts:264-277`) filters `expires_at` alone;
the comment at `:79-88` claims a leading `expires_at` index "Verified with
EXPLAIN" for both new tables. `verifications` does have
`idx_verifications_expires_at`, so the correction in the document is right.

**F26 — real, not implemented.** No coupling test exists. One clarification: the
finding's aside that "the existing drift tests cover the cookie name and the two
identifier formats" is accurate in substance even though no test is named for it
— `two-factor-totp.test.ts:213` proves all three at once, because the library's
`beginAttempt` throws `INVALID_TWO_FACTOR_COOKIE` unless
`2fa-attempts-<challengeId>` exists under exactly that identifier, so a 200 there
is the assertion. What is genuinely uncovered is the `hooks.after` arity and the
`getPlugin('two-factor')` resolution.

**F27 — real, not implemented.** The five new `// ====` banners are all still in
`db/schema.ts` (Verifications, Two-Factor Credentials, Two-Factor Method
Enrollment, Passkeys, Trusted Devices). Of the five false invariants: the
forget-password atomicity comment has been **rewritten** and is now true
("Checked inside the proof transaction so the decision and the write cannot
separate" — `recoveryDefeatsTwoFactor` now takes `tx`); the passkey
"Stored rather than compared" comment is **gone**, replaced by an accurate one on
`advancePasskeyCounter`. The other three are live: `db/maintenance.ts:79-88`
(F24), `lib/auth/two-factor.ts:150-166` (N2), and
`utils/validation/two-factor.ts:23-26` ("Keep `backup_code` enabled in every
deployment", which the env list can omit and F8 makes unenrollable).

Two to add to the sweep, both introduced by step 1:

- `tests/helpers/session.ts` — two stacked doc comments before
  `nextPhoneSuffix`, the first of which documents `uniquePhone` and is orphaned.
- `lib/auth/two-factor.ts` — the `authenticatorSelection` comment claims a
  registration-time refusal the plugin does not perform (see F13).

**F28 — correct.** `desc(trustedDevices.lastUsedAt)` in `listTrustedDevices`;
`uniquePhone()` is a sequential closure counter. Process-local is sufficient
because each integration worker owns its own database.

**N6 — real, not implemented (step 6).** `package.json` still has
`"@better-auth/core": "^1.7.2"` in `dependencies`; `better-auth@1.7.2` pins it
exactly. The only import is still `import type { GenericEndpointContext }`.

_(F27 addendum — the forgot-password comment. It is now true in the sense it
claims: `recoveryDefeatsTwoFactor` runs with `tx` inside `onVerified`, so the
decision commits or rolls back with the password write. The residual F2's "Also"
paragraph also asked for — a row lock on `users` / `two_factor_methods` in
canonical order — is NOT there, so the decision can still be taken against a
snapshot a concurrent enrolment change has since superseded. That is the class
`should-ignore.md` accepts, but the finding asked for the lock explicitly and it
did not land.)_

---

## Outside the document

Things that do not map onto an existing id. Recorded here rather than filed
against the nearest finding.

### 1. `offeredMethods` never intersects the enrolled OTP channel with the enabled channel list

`utils/validation/two-factor.ts` exports `isTwoFactorOtpChannelEnabled`, and the
only consumer is `twoFactorOtpEnrollSchema` — so enrolment is gated on the
channel, and the offered set is not. `offeredMethods`
(`lib/auth/two-factor-challenge.ts`) gates `otp` on
`ENABLED_TWO_FACTOR_METHODS.includes('otp')`, the row having a `channel`, the
contact-kind exclusion, and the verified flag. `NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS`
is not one of the terms.

Consequences, all reachable by configuration alone:

- An operator who removes `email` from `NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS`
  **precisely because email is the recovery channel** — the stated purpose of that
  variable being separate — keeps offering email OTP to every already-enrolled
  user. The overlap the second variable exists to prevent stays live for exactly
  the population that has it.
- `PHONE_ENABLED` filters the parsed list, so turning phone support off leaves
  `otp/sms` rows offered and routed to `processOtpSend` with a channel the
  deployment no longer supports.
- In production the credential gate only requires provider env vars for
  _enabled_ channels, so a removed channel's offered method is a challenge the
  user can never complete — a non-empty offered set, so step 0's refusal does not
  fire and the user is simply stuck.

One term added to the `case 'otp'` branch fixes it. It interacts with D8 (two OTP
channels) and with F25's preflight, which would have to count this cause too.

### 2. D16 items with no step and no implementation

D16 lists accepted proposals "no mechanism attached", and the order-of-work table
does not carry all of them. These are unimplemented and unassigned:

- `two_factor_credentials.verified` default is still `true`
  (`db/schema.ts`), not `false` (§3.9).
- `SERVER_ONLY_VIRTUAL_PATH` is still the blanket `ctx.path === '/' && !ctx.request`
  exemption in `lib/auth.ts`, not narrowed to a named set (§3.13).
- The pepper CAS repair (§3.14) is not there: on a lost compare-and-swap
  `upgradePasswordHash` returns `null`, so the minted proof carries only the
  pre-upgrade hash while the row holds the concurrent writer's — and
  `password.verify` then rejects a correct password. Narrow (two concurrent
  logins during a pepper rotation), but it is the one direction that turns a
  valid credential into a 401.

Worth giving them step numbers so they are not lost between D16 and the table.

---

## Coverage

Every id in the tracking document appears above exactly once: F1–F31, N1–N6.

Verification runs, all on the working tree, no test code added or retained:

| Command                                           | Result                                            |
| ------------------------------------------------- | ------------------------------------------------- |
| `bun tests/helpers/run.ts integration two-factor` | 37 pass, 0 fail, 104 `expect()`, 5 files, 38.77 s |
| `bun tests/helpers/run.ts unit two-factor`        | 17 pass, 0 fail, 40 `expect()`, 2 files, 3.23 s   |
| `bun tests/helpers/run.ts unit password-proof`    | 10 pass, 0 fail, 16 `expect()`, 1 file, 1.17 s    |
| `bun tests/helpers/run.ts unit openapi-contract`  | 50 pass, 0 fail, 1086 `expect()`, 1 file, 7.77 s  |

Not run: the full unit tier, and the process tier (`startup-gates`,
`schedule-drain`), so the two-factor startup-gate cases at
`startup-gates.test.ts:314-378` are read-verified only. Green tests were treated
as necessary and not sufficient throughout — F13, F30's second half and the F3
audit-reason split are all cases where the suite passes and the specified
behaviour is absent.
