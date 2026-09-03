# Two-factor change — verification of the audit and the second opinion

Scope: the working tree against `25c7d4f` (which is also `origin/main`, so "since the
last push" and "since HEAD" are the same diff). Every claim below was checked in
the code or in `node_modules`, never from memory. Nothing has been changed yet.

Baseline measured now: `bun run lint` (tsc + eslint, `--max-warnings 0`) exits 0.
All three tiers measured in this session, all green:

| Tier                                   | Result                  | Files | Time    |
| -------------------------------------- | ----------------------- | ----- | ------- |
| `bun tests/helpers/run.ts unit`        | 868 pass, 0 fail        | 24    | 351.7 s |
| `bun tests/helpers/run.ts integration` | 324 pass, 0 fail        | 27    | 86.5 s  |
| `bun tests/helpers/run.ts process`     | 50 pass, 2 skip, 0 fail | 7     | 105.8 s |

So `reports/two-factor-plan.md`'s claim of "868 unit + 324 integration + 50 process
tests, 0 failures" is accurate.

Green tests are not evidence the change is sound: F4 ships a permanently inert
feature and F5 an exploitable endpoint, and both have passing tests — see §2 and §8.

---

## 1. What changed

28 tracked files modified, 28 untracked added (4 of them are the docs and reports
themselves). 1699 insertions on the tracked side; the new modules are 2369 lines.

The change is **not** mostly passkey. By line count and by risk:

| Area                                                    | Files                                                            | Lines |
| ------------------------------------------------------- | ---------------------------------------------------------------- | ----- |
| Challenge issuance / resolution / completion (2FA core) | `lib/auth/two-factor-challenge.ts`                               | 570   |
| Our OTP as a second factor + per-method enrolment CRUD  | `lib/auth/two-factor-otp.ts`                                     | 520   |
| Trusted devices                                         | `lib/auth/trusted-device.ts`                                     | 310   |
| Passkey as a second factor                              | `lib/auth/two-factor-passkey.ts`                                 | 305   |
| Plugin composition                                      | `lib/auth/two-factor.ts`                                         | 176   |
| Env gates                                               | `utils/validation/two-factor.ts`, `utils/validation/env-list.ts` | 213   |
| Fail-closed password proof                              | `lib/auth/password-proof.ts` + `lib/auth.ts` before-hook rewrite | ~300  |
| Schema (5 new tables + `users.two_factor_enabled`)      | `db/schema.ts`, 2 migrations                                     | 236   |
| Admin reset                                             | `app/api/dash/users/[id]/two-factor/handler.ts`                  | 138   |

---

## 2. Verdict on `reports/two-factor-audit.md`

**26 of 28 findings confirmed as stated.** 2 need correction (F24 partly, F27
substantially). No finding was fabricated. Where the audit gave a line number I
checked it; three are off by a few lines and are noted.

| #   | Verdict                                              | Evidence checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **Confirmed**                                        | `createVerificationValue({ value: params.userId, identifier: challengeId })` (`two-factor-challenge.ts:248`) stores the user id and nothing else. `resolveTwoFactorChallenge:368` calls `offeredMethods(state)` with **no** `excludeContactKind`. 1a: `totp/index.mjs:174-224` and `backup-codes/index.mjs:187-233` read only `two_factor_credentials`; TOTP sign-in requires `twoFactor.verified !== false` and never consults `two_factor_methods`. 1b: `/two-factor/otp/send` → `signInTarget` → `resolveTwoFactorChallenge().otpTarget` (`two-factor-otp.ts:225-237`), unfiltered. |
| F2  | **Confirmed**                                        | `recoveryDefeatsTwoFactor:491-501`. Mode A: with `otp/email` + `totp`, `offeredMethods(state,'email') === ['totp']` → non-empty → returns `false` → reset proceeds with no TOTP proof. Mode B: `state.intent.length !== 0` but `offeredMethods(state)` empty → predicate returns `true` → permanent 403. The "Also" is right: `readEnrollment` uses the module-level `db`, not the `tx` the comment claims.                                                                                                                                                                            |
| F3  | **Confirmed, Critical is right**                     | `two-factor-challenge.ts:210-223` returns `null` and keeps the first-factor session. Traced the passwordless case end to end: `passwordless.ts:270` passes `excludeContactKind: otpContactKind(channel)`; a user whose only intent is `otp/email` gets `offeredMethods(state,'email') === []` → `null` → `setSessionCookie`. **Full session from one emailed code and no password.** The same user is refused by `/forgot-password/reset`. The asymmetry is exactly as described.                                                                                                      |
| F4  | **Confirmed**                                        | `grep -rn "method: 'passkey'"` across `lib/ app/` returns only the `offeredMethods` switch case and the env check. No writer of passkey intent exists. `/passkey/verify-registration` uses `freshSessionMiddleware` (`@better-auth/passkey/dist/index.mjs:324`) with `freshAge: 60*60*10` (`lib/auth.ts:454`) and is absent from `PASSWORD_PROOF_PATHS`. `revokeTwoFactorState` does not delete `passkeys`. `tests/integration/two-factor-passkey.test.ts:76-87` seeds the intent row and the flag by direct SQL.                                                                      |
| F5  | **Confirmed, Critical is right**                     | `trusted-device.ts:214-237`: `use: [sessionMiddleware]` plus `assertLiveSession`, no `twoFactorEnabled` check, no proof marker. `consumeDeviceTrust` is called at `two-factor-challenge.ts:206`, before `offeredMethods`. No enrolment path revokes trusted devices. `tests/integration/two-factor-trusted-device.test.ts:249-264` seeds a **fresh user with no 2FA**, signs in, calls `/two-factor/trust-device`, and asserts the row exists — the planting precondition, encoded as expected behaviour.                                                                              |
| F6  | **Confirmed, one clause wrong**                      | All three defects verified (`two-factor-otp.ts:434-472`; `listEnrolledMethods` at `:455` outside the tx; path absent from `PASSWORD_PROOF_PATHS`). **Correction:** "removing a second factor is cheaper than adding one" holds for TOTP only. Adding OTP through `/two-factor/otp/verify` enrolment mode is _also_ session-only — see §4.1.                                                                                                                                                                                                                                            |
| F7  | **Confirmed**                                        | `better-auth/dist/plugins/two-factor/index.mjs:206-239`: clears the flag, deletes the credential row, rotates the caller's session, expires the caller's trust cookie and deletes the **plugin's** trust verification row (which never exists here). Untouched: `two_factor_methods`, `passkeys`, other `trusted_devices` rows, live challenges, other sessions. `resolveTwoFactorChallenge` never reads `state.enabled`.                                                                                                                                                              |
| F8  | **Confirmed**                                        | `index.mjs:381-384`: `if (method === "otp" && !otpOptions?.sendOTP) throw OTP_NOT_CONFIGURED` and `if (method === "totp" && totpOptions?.disable) throw TOTP_NOT_CONFIGURED`. `otpOptions: undefined` (`two-factor.ts:71`), `totpOptions.disable = !isTwoFactorMethodEnabled('totp')` (`:69`). With `totp` off, `/two-factor/enable` can only 400. `generate-backup-codes` throws `TWO_FACTOR_NOT_ENABLED` at `backup-codes/index.mjs:278,290`.                                                                                                                                        |
| F9  | **Confirmed**                                        | `index.mjs:149`: `verified: existingTwoFactor != null && existingTwoFactor.verified === true \|\| !!skipVerificationOnEnable` — repeat enable overwrites `secret` **and** `backupCodes` while preserving `verified: true`. `backupCodesReady = acknowledgedAt != null` (`two-factor-challenge.ts:123`); never cleared, never counts unused codes.                                                                                                                                                                                                                                      |
| F10 | **Confirmed**                                        | `newestSessionId` is `ORDER BY created_at DESC LIMIT 1` (`rotation.ts:75-85`). OTP enrolment never rotates (`sessionUser` returns only a user id). TOTP rotates only inside `if (twoFactor.verified !== true) { if (!user.twoFactorEnabled) …}` (`totp/index.mjs:205-215`), so adding TOTP to an OTP-enabled account does not rotate.                                                                                                                                                                                                                                                  |
| F11 | **Confirmed, High is right**                         | `enforceOtpVerifyQuota` (`lib/rate-limit/api.ts:229-236`): `recovery` gets `otp.verify.dest.recovery.${kind}`; every other surface, `two_factor` included, shares `otp.verify.dest.${kind}`. `/api/auth/otp/verify` is `auth: 'public'` with a client-supplied identifier (`routes.ts:168-172`). The limiter throws before `processOtpVerify`.                                                                                                                                                                                                                                         |
| F12 | **Confirmed**                                        | `spendChallengeAttempt:422` does `await rearm(used)` before returning. The library deliberately does not: `verify-two-factor.mjs:70-97` consumes, leaves no row, and returns `{recordFailure, restore}` for the caller to invoke exactly one of. Duplicate same-count rows are extra unsafe because the adapter takes the latest row and deletes duplicates for an identifier.                                                                                                                                                                                                         |
| F13 | **Confirmed**                                        | `two-factor-passkey.ts:122` `userVerification: 'preferred'`, `:257` `requireUserVerification: false`. See §6 for a library limitation the audit does not mention.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| F14 | **Confirmed**                                        | `app/api/dash/users/[id]/two-factor/handler.ts` — no `verifyLoginAttempt`, `body: 'none'` in `routes.ts:410`. `reauth_two_factor` already exists as a purpose (`login-guard.ts:63`) and is used only by the before hook.                                                                                                                                                                                                                                                                                                                                                               |
| F15 | **Confirmed**                                        | `LIVE_SESSION_PATHS` (`lib/auth.ts:232-249`) omits `/two-factor/otp/send`, `/two-factor/otp/verify`, `/two-factor/verify-totp`, `/two-factor/verify-backup-code`. `enrolmentTarget:86` filters `isNull(users.deletedAt)` and not `isActive`.                                                                                                                                                                                                                                                                                                                                           |
| F16 | **Confirmed**                                        | `completeTwoFactorChallenge:469` calls `createSession(challenge.user.id)` with no second argument; the library's `valid()` calls `createSession(consumed.value, !!dontRememberMe)` (`verify-two-factor.mjs:31`). `setSessionCookie` reads the marker itself (`cookies/index.mjs:167-178`), so the browser cookie is right and only the row is wrong. `rememberMe` reaches the handler: the before hook's returned body omits the key and `defuReplaceArrays` keeps the caller's value (`dispatch.mjs:217`). _Line note: the function starts at `:448`, not `:436`._                    |
| F17 | **Confirmed**                                        | `backup-codes/index.mjs:213-233`: the set is consumed and rewritten, then `if (!ctx.body.disableSession) return valid(ctx);` — so on `disableSession: true` no session is issued, the challenge is never consumed, and neither `recordFailure` nor `restore` runs, so `beginAttempt` throws `INVALID_TWO_FACTOR_COOKIE` on every later attempt. `TRUST_DEVICE_STRIPPED_PATHS` forces only `trustDevice`.                                                                                                                                                                               |
| F18 | **Confirmed**                                        | `readEnrollment:85-91` has no `ORDER BY`; `offeredMethods` maps in that order. `ChallengeIssued` carries no `defaultMethod`. `GET /two-factor/methods` returns `listEnrolledMethods` (intent only, no capability join).                                                                                                                                                                                                                                                                                                                                                                |
| F19 | **Confirmed, smaller than stated**                   | `sendOtpEmail:308` and `sendOtpWhatsApp:206` hardcode subject and body. **Correction:** `processOtpSend` already carries `smsMessage?: (code) => string` all the way to `sendOtpSms(identifier, code, smsMessage?.(code))` (`utils/otp.ts:375-379, 435, 503, 728`) and **no caller passes it**. So SMS needs one argument; email and WhatsApp need the hook added. Email is the channel that matters here.                                                                                                                                                                             |
| F20 | **Confirmed**                                        | `BETTER_AUTH_BODIES` has exactly two entries (`openapi.ts:320-323`). `BETTER_AUTH_LOCAL_THROTTLE_PATHS = new Set(['/passwordless/verify'])` (`:1253`). The new endpoints declare `z.record(z.string(), z.unknown())`.                                                                                                                                                                                                                                                                                                                                                                  |
| F21 | **Confirmed**                                        | `SESSION_METHOD_BY_PATH` (`lib/auth.ts:202-207`) gains only `/two-factor/verify-totp` → `'password+totp'` and `/two-factor/verify-backup-code` → `'password+backup_code'`. Custom OTP and passkey completion are absent, and the labels hardcode `password+`.                                                                                                                                                                                                                                                                                                                          |
| F22 | **Confirmed**                                        | `two-factor-passkey.ts:245-256` passes `counter: credential.counter` in; `@simplewebauthn/server` throws when `(counter > 0 \|\| credential.counter > 0) && counter <= credential.counter`. `:281-284` updates keyed on `passkeys.id` alone. The comment at `:278-280` ("Stored rather than compared") is false.                                                                                                                                                                                                                                                                       |
| F23 | **Confirmed**                                        | `rotation.ts:34-45`: the loop deletes `verifications` by `trustIdentifier`; `grantDeviceTrust` writes only `trusted_devices` + a cookie, and the plugin's trust path is disabled by the forced `trustDevice: false`. Zero rows, one round trip per device. `DELETE … WHERE value = userId` misses `2fa-attempts-<id>` rows, whose `value` is `'0'`. `passkeys` not deleted.                                                                                                                                                                                                            |
| F24 | **Confirmed for one table, wrong for the other**     | The comment claims an `expires_at`-leading index for **both** new tables. `verifications` **has** one (`idx_verifications_expires_at`, `db/schema.ts`). `trusted_devices` does **not** — only `idx_trusted_devices_user` on `(user_id, expires_at)`, and `sweepTrustedDevices` filters `expires_at` alone. So the false half is trusted devices only.                                                                                                                                                                                                                                  |
| F25 | **Confirmed**                                        | The only signal is the `twoFactorDowngraded` audit row; the startup gate in `utils/validation/two-factor.ts:117-129` refuses only the deployment-wide degenerate case and has no database access. No preflight script exists.                                                                                                                                                                                                                                                                                                                                                          |
| F26 | **Confirmed**                                        | `two-factor.ts:64` destructures `hooks` off. Nothing asserts `id === 'two-factor'`, the retained shape, or that upstream `hooks.after` has exactly one entry.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| F27 | **Confirmed in kind, three of five citations wrong** | See §3 items 1–4. The five false invariants are real (and there is a sixth — §3 item 7). The section-banner and change-history citations point at pre-existing code.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| F28 | **Confirmed**                                        | `listTrustedDevices:182` `.orderBy(trustedDevices.lastUsedAt)` — ascending. `uniquePhone()` collision argument stands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The audit's "Excluded" section is accurate. In particular its last item is right:
`reports/two-factor-plan.md:801` still says "Recovery proves the second factor
before the password is written", which contradicts the plan's own header at
`:28-33`. The plan is stale and should be corrected or retired.

---

## 3. Verdict on the second opinion

**11 of 14 substantive, 2 wrong, 1 misattributed.** It found two things neither
report had (items 5 and 7 below) that I rate as real work. Its numeric details are
loose in three places.

### A — "Incorrect, delete or re-cite"

**1. F5's quoted comment does not exist — CORRECT.** I read
`lib/auth/trusted-device.ts` in full. There is no sentence claiming
`grantDeviceTrust` "is called only after a second factor has actually been
proven". The nearest text (`:207-210`) says something different and true. The rest
of that "Also" stands: `grantDeviceTrust:135-152` swallows the insert failure,
returns, and the endpoint answers `{ trusted: true }` with no row and no cookie.

**2. F27 bullet 3, same comment — CORRECT.** Same nonexistent quote.

**3. F27 bullet 1, section banners — HALF CORRECT, and its conclusion is wrong.**
`db/schema.ts:617-619` ("User Tracking Fields") is verbatim at HEAD; `:573-575`
("Trusted Devices") is new. So the audit cited one pre-existing banner. But the
change added **five** new banners, not one: Verifications, Two-Factor Credentials,
Two-Factor Method Enrollment, Passkeys, Trusted Devices (`// ====` lines went 28 →
38). And the Consistency argument does not win here: `CLAUDE.md`'s Comments
section names section banners in its **Never** list, and its line 5 says existing
code that conflicts with the file gets fixed or reported. Correct outcome: re-scope
the bullet to the five new banners, remove those, leave the 14 pre-existing ones
and report them.

**4. F27 bullet 2, `rotation.ts:13-26` — CORRECT.** `git show HEAD:lib/auth/rotation.ts`
contains the "which is exactly how phone-change ended up without session
revocation" sentence verbatim at line 14. The change appended only the lock-order
sentence, which is legitimate non-local coupling. The new duplicate is in
`revokePendingProofs` ("a policy a caller can forget is how phone-change once
ended up without session revocation"). Re-cite there.

### B — "Correct but need amendment"

**5. Password-free OTP enrolment — CORRECT, and it is the sharper half.**
`/two-factor/otp/verify` in enrolment mode authenticates through `sessionUser(ctx)`
alone (`two-factor-otp.ts:314-320`), has no `sessionMiddleware`, and is absent from
`PASSWORD_PROOF_PATHS`. So a session holder can _add_ a second factor with no
password.

The attack it derives is real and neither report has it. An attacker holding a
session on a victim with no other intent row enrols `otp` on the channel account
recovery uses. Thereafter `recoveryDefeatsTwoFactor(userId,'email')` →
`offeredMethods(state,'email')` → `[]` → `POST /api/auth/forgot-password/reset`
answers 403 forever. **One correction:** it is escapable — `/two-factor/disable`
clears `twoFactorEnabled`, after which the predicate short-circuits on
`!state.enabled`. But that endpoint requires the password, and the user reaching
for password recovery is by definition the user who does not have it. So "this
account now needs an operator" holds for exactly the population that matters. I
rate it **High**: a temporary session hold converts into a permanent,
attacker-chosen denial of account recovery.

**6. `recoveryDefeatsTwoFactor` is a liveness hazard — CORRECT IN KIND, WRONG IN NUMBERS.**
Confirmed: `readEnrollment` fires four `Promise.all` queries on the module-level
`db` from inside `onVerified(tx, …)`, which runs inside `processOtpVerify`'s
`withTransaction` while that transaction holds one of `MAX_POOL_CONNECTIONS = 10`
(`db/limits.ts:23`).

Three corrections:

- `processOtpVerify` does **not** take `pg_advisory_xact_lock`. That is
  `processOtpSend` (`utils/otp.ts:518-529`). Verify holds `FOR UPDATE` on `users`
  and on `verification_sessions` (`:899-935`).
- The deadlock threshold is **10 concurrent resets, not five.** Four queries
  queueing behind one free connection still make progress; the hard deadlock needs
  every pool connection held by a transaction that is itself waiting.
- What makes it unrecoverable is `db/index.ts`'s deliberate absence of
  `statement_timeout` (`reports/should-ignore.md` Known Issue #2). This finding
  raises the stakes on that deferral.

"Same class as Known Issue #13, larger footprint" is a fair characterisation. I
swept the class: `recoveryDefeatsTwoFactor` is the **only** new site that reads
through the global `db` from inside a transaction. Every other `onVerified` body
and every `rotation.ts` helper takes `tx`.

**7. The TOTP after-hook's compensation is impossible — CORRECT, and this is the
best catch in the second opinion.** `lib/auth/two-factor.ts:136-150` catches its
transaction failure and throws `APIError('INTERNAL_SERVER_ERROR')` under a comment
claiming this prevents "a user told 2FA is on but holding no intent row". An
`after` hook runs after the endpoint returned (`dispatch.mjs:228-242`), so the
plugin has already committed `verified: true` and `twoFactorEnabled: true`
(`totp/index.mjs:205-221`). The throw therefore _manufactures_ precisely the state
the comment says it prevents, and every later login takes F3's downgrade branch —
2FA on, nothing offered, password-only session. A genuine **sixth** false
invariant, and it upgrades F10 from "revocation targets the wrong session" to
"enrolment has no working compensation at all".

**8a. `completeTwoFactorChallenge` line number — CORRECT.** `:448`, not `:436`.

**8b. F19's `smsMessage` hook — HALF CORRECT.** See F19 above: the hook exists and
is unwired for **SMS only**. Email and WhatsApp have no equivalent.

### C — "Not reported at all"

**9. `two_factor_credentials.verified` default — REAL BUT MISATTRIBUTED.**
`default(true)` is **the library's own declared default**:
`better-auth/dist/plugins/two-factor/schema.mjs:31-36` has
`verified: { type: "boolean", required: false, defaultValue: true, input: false }`.
So this is schema parity, not a local choice, and the second opinion presents it as
the latter. Practically it is unreachable: the plugin's adapter always sends an
explicit value, and no hand-written insert exists in this codebase. Flipping to
`false` cannot break the plugin and does make a future hand-insert fail closed, so
I would take the change — as **Low** defence in depth, not as a fail-open bug.

**10. `send` and `verify` disagree on the enrol-vs-sign-in discriminator — CORRECT.**
`/two-factor/otp/send:162` branches on `readChallengeCookie` (cookie present and
signature-valid). `/two-factor/otp/verify:214` branches on
`resolveTwoFactorChallenge` (cookie **and** a live row **and** an active user). For
up to `TWO_FACTOR_CHALLENGE_MAX_AGE_S = 600` seconds after an abandoned prompt, a
stale signed cookie sends `send` down `signInTarget`, which resolves nothing and
throws 401 at a caller holding a valid session — while `verify` in the same window
correctly takes the enrolment branch. Real, self-inflicted, and it belongs with F15
as "dual-mode endpoints need one discriminator".

**11. `@better-auth/core: "^1.7.2"` is the wrong range — CORRECT, with a narrower
consequence.** `node_modules/better-auth/package.json:476` pins
`"@better-auth/core": "1.7.2"` exactly. A caret at the top level therefore drifts
ahead on the next install and produces two copies. **But** the only import is
`import type { GenericEndpointContext }` (`two-factor-challenge.ts:18`), so the
damage is type-level — a mismatched type, caught by `tsc`, not a runtime
dual-instance. Fix: pin `"1.7.2"` exactly and move it to `devDependencies`. The
plan's rationale at `two-factor-plan.md:36-38` is indeed backwards.

**12. The OpenAPI contract guard lost its method half — CORRECT, with a caveat.**
Old: `if (!betterAuthServes(path, method))` (`HEAD:lib/http/openapi.ts:1482`). New:
`if (!BETTER_AUTH_KNOWN_PATHS.has(path))` (`:1543`). So `'GET /two-factor/enable'`
now passes. The caveat: widening from the _enabled_ table to a _known-under-any-config_
set was **necessary**, because 2FA paths are env-gated and the old check would
report every switched-off path as a problem. The method dimension was collateral
damage. Fix is a method-aware known set (`'POST /two-factor/enable'` keys), not a
revert. Also note the change _added_ a guard the old code lacked: every
`BETTER_AUTH_ENDPOINTS` entry must appear in the known set (`:1515-1520`).

**13. `SERVER_ONLY_VIRTUAL_PATH` has no caller — WRONG.** `auth.api.generateTOTP`
is called from `tests/integration/two-factor-totp.test.ts:86` and
`tests/integration/two-factor-trusted-device.test.ts:97`. That is the caller, and
it is why the exemption exists. The gate-widening observation still stands on its
own: `ctx.path === '/' && !ctx.request` exempts _every_ `serverOnly` endpoint from
the allow-list for in-process `auth.api.*` calls, `viewBackupCodes` included.
Bounded (HTTP cannot reach it — `app.ts` enforces the same list before
`auth.handler`), so **Low**: narrow the exemption to a named set rather than to the
placeholder path.

**14. A lost pepper-upgrade CAS now rejects a correct password — CORRECT.**
`upgradePasswordHash` CASes on `eq(accounts.password, upgrade.expectedHash)`
(`login-guard.ts:443-449`) and returns `null` when it loses; the caller then
returns `[verifiedHash]` (`:411`), but the row holds a third hash written by the
winner, so `consumePasswordProof(H3, token)` returns `false` and the sign-in 401s.
Narrow (two concurrent sign-ins for one account during a pepper-generation change)
and fails closed, but it is a failure mode `async () => true` did not have.

**Note on the naive fix:** re-reading the row and adding its current hash to the
accepted set is _wrong_ — the concurrent writer might have been a password
_change_, and accepting that hash would let the old password mint a session.
The correct repair is to verify the re-read hash against the plaintext still in
scope before adding it, or to log and accept the 401.

### Housekeeping note — WRONG

`reports/two-factor-audit-ar.md` and `reports/two-factor-implementation-review.md`
**do not exist**. `ls reports/` shows `two-factor-audit.md`,
`two-factor-plan-codex-review.md`, `two-factor-plan.md`, `two-factor-review.md`.
The overlap being described is presumably `two-factor-review.md`, which is one of
the two source reports the audit consolidated and is therefore superseded by it.

---

## 4. Findings in neither report

**N1 — High — `/two-factor/otp/verify` enrolment mode is password-free, and that
converts into a permanent recovery lock.** See §3 item 5.

**N2 — High — the TOTP enrolment hook's compensation cannot work.** See §3 item 7.

**N3 — Medium — `send` and `verify` use different mode discriminators.** See §3
item 10.

**N4 — Medium — 4.1 is not implemented at all.** The requirement "refuse when the
user tries to enable 2FA, with a clear message" has no code. What exists is a
_startup_ refusal for the single degenerate deployment
(`utils/validation/two-factor.ts:117-129`) and a _recovery-time_ refusal
(`recoveryDefeatsTwoFactor`). `twoFactorOtpEnrollSchema` validates only that the
channel is in `NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS`; it never compares against
`NEXT_PUBLIC_ENABLED_OTP_CHANNELS`. So a user can enrol 2FA-OTP on the exact
channel that resets their password, and the only thing that notices is a 403 much
later, when they need recovery.

**N5 — Low — a user cannot enrol two OTP channels.**
`ux_two_factor_methods_user_method` is `(user_id, method)` and `channel` is a
single column, so `otp` is one row with one channel. This is a schema decision
that 4.2's "order between email and SMS" question assumes away — see §5.2.

**N6 — Low — `@better-auth/core` in `dependencies` for a type-only import.** See
§3 item 11.

---

## 5. Answers to your points 4.1 – 4.7 and 7

### 4.1 / 4.3 — recovery OTP versus 2FA OTP

**Current interaction, precisely.** `NEXT_PUBLIC_ENABLED_OTP_CHANNELS` governs
every OTP surface — contact verification, contact change, passwordless sign-in and
password recovery. `NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS` governs 2FA delivery
only. A user has exactly one `email` and one `phone_number`, and both are recovery
contacts; there is no separate "2FA destination" column. So when the two lists
share a contact kind, one possession yields both factors.

Factor separation as implemented: `otp_purpose` is part of
`ux_verification_sessions_user_contact_purpose` and of every locked lookup, so a
`forgot_password` proof cannot satisfy a `two_factor` verify. **That holds** — I
checked it. It is also not the property that matters: the attack requests one fresh
code per purpose from one compromised mailbox, and purpose-bound lookups do not
defend against that. This is F2 mode A.

**My recommendation, and the decision I need from you.** Two coherent policies:

- **(A) Strict separation.** Refuse enrolment of 2FA-OTP on any channel whose
  contact kind is also an enabled _recovery_ contact kind, with a clear message.
  Literally what 4.1 asks. Consequence in your actual default deployment
  (`NEXT_PUBLIC_ENABLED_OTP_CHANNELS=email`, phone disabled): **2FA-OTP becomes
  unenrollable entirely.** Users get TOTP, passkey and backup codes. Honest,
  simple, and it makes `recoveryDefeatsTwoFactor` almost dead code.

- **(B) Conditional admission — what I recommend.** Allow the overlap, but never
  let an overlapping OTP be a user's _only_ factor: enrolling 2FA-OTP on a
  recovery contact kind requires at least one non-overlapping factor already
  enrolled and usable (TOTP, passkey, or acknowledged backup codes). Refuse at
  enrolment with the message 4.1 asks for. This kills F2 mode A (a disjoint factor
  always survives a reset), kills F2 mode B and N1 (the empty-offer state becomes
  unreachable by enrolment), and keeps OTP usable as a convenience factor.

I recommend **(B)**, with (A) reachable by simply pointing the two variables at
disjoint kinds. Under (B), your 4.2 sub-question "is the overlapping channel pushed
to the bottom or dropped" is answered as **neither**: it is admitted only when it
cannot be the last factor, and ranked below TOTP and passkey. Pushing it to the
bottom alone would not fix anything — F2 mode A works regardless of list position.

### 4.2 — default method, priority order, fallback, user preference

The system priority you proposed is right and I would ship it as stated:
**`passkey > totp > otp > backup_code`**, with `backup_code` excluded from
auto-routing and reachable only through "Try another method". Today there is **no
order at all** (F18) — Postgres heap order, so `methods[0]` changes between logins
for the same user.

Your two questions:

1. **Order between email and SMS inside `OTP`.** As the schema stands there is
   nothing to order: a user can enrol exactly one OTP channel (N5). The real
   question is which channel to _offer_ at enrolment, and my answer is
   **SMS/WhatsApp above email** whenever phone is enabled — email is the recovery
   channel and the account-verification channel in this deployment, so a phone code
   is a genuinely different possession while an email code usually is not. If you
   want a user to hold _both_ email and SMS as second factors, `two_factor_methods`
   needs `(user_id, method, channel)` uniqueness instead. **That is a schema change
   I need you to authorise or decline.**

2. **Overlapping channel: bottom or dropped.** Answered above under (B).

**User-configurable default:** yes, worth it, and cheap — `is_default boolean` with
a partial unique index on `(user_id) WHERE is_default`, set by a new endpoint. Two
constraints: a preference may only reorder _within_ the immutable issued set (F1),
and an unusable preference falls back to system priority without ever producing the
F3 empty-set branch.

**Auto-send for an `otp` default:** at most once per challenge. Six page reloads
would otherwise burn the per-destination send quota and lock the user out of their
own default method.

### 4.4 — `rememberMe`

Mostly already there, and cheaper than you'd expect. `/sign-in/email` already
accepts `rememberMe` (`sign-in.mjs:265`, default `true`) and already honours it
(`:354`), and the before hook's returned body is _merged_, not substituted, so a
client value already reaches the handler today. What is missing:

1. Add it to `loginSchema` so it is validated and appears in the contract.
2. Carry the choice into the challenge record and pass its inverse to
   `createSession` in `completeTwoFactorChallenge` — that is F16, currently a
   1-day-versus-28-day discrepancy that only affects _our_ completion paths.
3. Expire the `dont_remember` marker after a completed or cancelled challenge, as
   the library's verifier does.
4. A config flag for whether the submitted value is honoured, per your ask.

### 4.5 — password change: revoke trusted devices / reset 2FA methods?

I agree with your instinct, with one split you did not draw.

- **Sessions: revoke.** Already done, non-negotiable.
- **Trusted devices: revoke on a _recovery reset_, notify-only on a _voluntary
  change_.** Today both do the same thing (`revokePendingProofs` →
  `revokeTwoFactorState` at every rotation site). The distinction is what the act
  implies. A voluntary change from an authenticated session is hygiene; wiping
  trust re-prompts 2FA on every device for no gain. A forgot-password reset means
  "I lost control of my password", and that threat model explicitly includes an
  attacker on a device the victim once trusted — and a trusted device is a standing
  2FA bypass (F5). So: recovery revokes, voluntary notifies.
- **2FA methods: never reset on a password change, either flavour.** Resetting
  them _lowers_ security, and a password change is not evidence the second factor
  was compromised. Notify, and link to "review your 2FA methods and trusted
  devices". This is your position and I think it is right.

### 4.6 — 2FA method change: revoke sessions?

- **Adding or confirming a method: revoke other sessions.** Keep the intent; the
  implementation is broken (F10 can revoke the victim's session and keep the
  attacker's, and N2 means the compensation does not work at all). Fix by carrying
  the caller's own session id through, or by revoking all and re-issuing — one
  extra sign-in is the safe failure direction.
- **Removing a method: do _not_ revoke sessions, but _do_ revoke trusted devices.**
  Existing sessions already passed the gate; a trusted device grants a _future_
  skip, and the user's act says this factor is no longer trustworthy. Also require
  a password proof for removal (F6).
- **Changing the OTP channel: same as removal** — revoke trust, keep sessions.
- **A UI box asking the user:** yes, but as an _additional_ offer ("also sign out
  your other devices?"), never as the mechanism. Trust revocation must be
  automatic because it is the bypass; session revocation on removal can be the
  user's choice.

### 4.7 — a device with no passkey support

This is a client concern once the server stops re-deriving the method list. The
server cannot know whether a browser has an authenticator, so:

- Server returns the **ordered** `twoFactorMethods` plus an explicit
  `defaultMethod`, both read from the immutable challenge record (F1 + F18).
- Client feature-detects before auto-routing to passkey — `window.PublicKeyCredential`,
  `isUserVerifyingPlatformAuthenticatorAvailable()`, and a catch on
  `NotAllowedError` / `NotSupportedError` from the ceremony itself — then falls to
  the next usable method in the user's preference order, else system priority, and
  **never** automatically to `backup_code`.
- Server-side belt already exists: `/two-factor/passkey/options` answers 400
  `methodUnavailable` when the user has no credential.
- One addition worth making: return per-method hints (`otp.nextAllowedIn`) in the
  challenge response so a fallback does not immediately collide with a send quota.

Nothing in the backend blocks this today except the missing ordering and the
mutable method set.

### 7 — is passkey the cause?

**No. Keep it.** Of the 28 audit findings plus 6 new ones, exactly **three are
passkey-specific**, and all three are local:

| Finding | Fix size                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| F4      | One `after` hook on `/passkey/verify-registration`, the same shape as the existing TOTP hook (~30 lines), plus adding it to two sets. |
| F13     | Two constants — `userVerification: 'required'`, `requireUserVerification: true`.                                                      |
| F22     | One compare-and-swap on the counter update.                                                                                           |

Everything else is 2FA-general, and the critical mass is in two decisions that have
nothing to do with WebAuthn:

1. **The challenge stores only a user id** and every later request re-derives the
   offered set from mutable state (F1 → F2 1b, F3, F16, F18, F21). This is the
   single root cause behind five findings.
2. **Enable/disable is delegated to the plugin while the method model is ours**
   (F6, F7, F8, F9, N1). The plugin's `/two-factor/enable` cannot enrol anything
   but TOTP in this configuration, and its `/two-factor/disable` cannot clean up
   state it does not know about.

Passkey is also the only method in the set that a real-time phishing proxy cannot
replay, which is the reason it was worth adding. Cancelling it would remove three
small findings and the one phishing-resistant factor, and would not touch F1, F2,
F3, F5, F6, F7, F8, F9, F10, F11 or F12.

---

## 6. Where the library already solved it and we diverged

Point 5 of your prompt, checked against `better-auth@1.7.2` and
`@better-auth/passkey@1.7.2` source.

| Ours                                                | The library                                                                                                                                            | Verdict                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spendChallengeAttempt` re-arms before verification | `beginAttempt` consumes, leaves **no** row, returns `{recordFailure, restore}` for the caller to invoke exactly one of (`verify-two-factor.mjs:70-97`) | **We are worse.** Copy the library's protocol verbatim (F12).                                                                                                                                                                                      |
| `completeTwoFactorChallenge` ignores remember-me    | `valid()` reads the `dont_remember` marker and passes it to `createSession` (`verify-two-factor.mjs:23-31`)                                            | **We are worse.** Copy it (F16).                                                                                                                                                                                                                   |
| `requireUserVerification: false` on our assertion   | `@better-auth/passkey` **hardcodes** `requireUserVerification: false` at both `:355` (registration) and `:483` (authentication) — not configurable     | **Library limitation.** `authenticatorSelection.userVerification` _is_ configurable (`:177-180`), so set it to `'required'` at registration to stop non-UV authenticators up front; the hard gate has to be ours, on our own assertion path (F13). |
| `two_factor_credentials.verified` default `true`    | `schema.mjs:31-36` declares `defaultValue: true`                                                                                                       | **We match the library.** The second opinion's framing is wrong; the change to `false` is still worth taking as defence in depth.                                                                                                                  |
| F4's fix via `registration.afterVerification`?      | It runs **before** the passkey row exists and shares a transaction only when `createSession: true` (`@better-auth/passkey/dist/index.mjs:360-412`)     | **Do not use it.** Use an `after` hook on the endpoint, like the TOTP one.                                                                                                                                                                         |
| Challenge id / attempt-counter formats              | `2fa-${generateRandomString(20)}` and `2fa-attempts-${identifier}` (`two-factor/index.mjs`)                                                            | **We match**, and every drift mode fails closed. F26's contract test is still worth having.                                                                                                                                                        |
| Plugin rate limits on `/two-factor/*`               | `{ pathMatcher: /^\/two-factor\//, window: 10, max: 3 }`                                                                                               | Inert — `rateLimit: { enabled: false }`. Each path carries its own `preAuthLimit`, which is correct and already done.                                                                                                                              |

---

## 7. Decisions I need from you before I start

1. **4.1 policy: (A) strict separation or (B) conditional admission?** I recommend
   (B). Under (A), 2FA-OTP is unenrollable in your current single-channel
   deployment — that may be exactly what you want, but it is a product decision,
   not a security one.
2. **May a user hold two OTP channels as second factors?** If yes, that is a
   `two_factor_methods` uniqueness change to `(user_id, method, channel)` plus a
   migration. If no, the current schema stands and "email versus SMS ordering"
   becomes an enrolment-UI question only.
3. **F1's remedy: companion challenge record, or replace the plugin's TOTP and
   backup-code verifiers with our own endpoints?** The companion record closes F1,
   F16, F18 and F21 at one boundary and keeps the plugin's audited crypto. Owning
   the verifiers is more code but removes the whole "two issuers, two contracts"
   class (F6's first bullet, F7, F17). I lean **companion record**, plus a
   `before`-hook check on the two plugin verify paths so an unoffered method
   cannot complete.
4. **F8: own backup-code generation, or gate `/two-factor/enable` on `totp`?**
   Owning it means writing the `two_factor_credentials` row ourselves (the
   encryption helpers are importable from `better-auth/crypto`) and makes
   `otp,backup_code` and `passkey,backup_code` deployments actually work. Gating is
   two lines and leaves those deployments without a recovery path — which, given
   F3, means an unrecoverable lockout. I lean **own it**.
5. **F14: is a password re-auth on the admin 2FA reset acceptable operationally?**
   Every self-service sensitive path here re-authenticates; this one strips a
   control from someone else's account and does not. I want to add it, but it
   changes an admin workflow.
6. **F3's split:** fail closed on possession exclusion (the passwordless case —
   the user still has a password route, so nobody is locked out), and a distinct
   recoverable state for capability loss. Confirm you accept that a 2FA user whose
   only factor is OTP-to-email can no longer complete a passwordless email sign-in
   at all.
7. **Voluntary password change stops revoking trusted devices** (4.5). Confirm.

## 8. Proposed order, once those are settled

Grouped so each step is independently verifiable and each closes a class rather
than an instance.

| Step | Closes                                    | Why here                                                                                                                     |
| ---- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1    | F5, F12, F17, F13, F22, F28, N3           | Local, no schema change, no product decision. F5 and F12 are the two live bypasses that need nothing from you.               |
| 2    | F1, F16, F18, F21 (+ 4.2 ordering, 4.4)   | The companion challenge record. One boundary, four findings, and it unblocks the whole routing UX.                           |
| 3    | F2, F3, N1, N4, F11 (+ 4.1, 4.3)          | The recovery/possession policy, including the enrolment-time refusal and the `two_factor` rate-limit scope.                  |
| 4    | F4, F6, F7, F8, F9, F10, N2 (+ 4.6)       | The enrolment lifecycle: one owned routine for enable, disable and per-method removal, used by self-service and admin alike. |
| 5    | F14, F15, F23, F24, F25, F26, N6, item 12 | Hardening, guards, the preflight script, the version-coupling test, the dependency pin.                                      |
| 6    | F19, F20, F27                             | Message templating, contract schemas, comment sweep (including the six false invariants and the five new banners).           |
| 7    | Tests (your point 8)                      | Matrix over `NEXT_PUBLIC_ENABLED_2FA_METHODS` × `NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS`, driven through real endpoints.       |

On point 8 specifically: the existing 2FA tests seed final state by direct SQL in
two places (`givePasskey`, and the trusted-device fixture's TOTP path is real but
the passkey path is not), which is what let F4 ship as a permanently inert feature
with green tests. The matrix has to drive registration and enrolment through the
actual endpoints, and it has to run the tier once per method-set configuration —
`tests/helpers/run.ts` already grew a per-tier `env` hook for exactly this, so the
mechanism exists.
