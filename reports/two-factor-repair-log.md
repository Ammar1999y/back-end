# Two-Factor Repair Log

Working record for the repair pass against `reports/two-factor-final-audit.md`.
Written as the work happened; the sections at the end (disagreements, new
defects, not closed, made false elsewhere) are the ones worth reading first if
you only read part of it.

Baseline: the same uncommitted working tree the audit describes, `HEAD` =
`25c7d4f`.

---

## 1. Landed, by finding

### Step 0

| Finding        | What landed                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **H3** mode B  | `recoveryDefeatsTwoFactor` short-circuits on `offeredMethods(state).length === 0` instead of `state.intent.length === 0`                    |
| `N2` (**H5**)  | The TOTP intent after-hook never throws: retried, then logged with the repair, and the session rotation moved out of the intent transaction |
| **M9**         | `enforceOtpVerifyQuota` keys by surface, not only `recovery`                                                                                |
| `F10` (**H5**) | Both enrolment paths keep the caller's real session; `newestSessionId` is gone                                                              |
| **M12**(a)     | The refusal audit reason splits into `two_factor_excluded_by_first_factor` and `two_factor_capability_unavailable`                          |
| **M1**         | Server-enforced at registration through `registration.afterVerification`, plus the comment corrected                                        |
| **L3**         | Comment sweep (see below)                                                                                                                   |

### Step 1 and pulled forward

| Finding                | What landed                                                                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H1**                 | `twoFactorSignInGuard` is a separate, unconditionally installed plugin; `issueTwoFactorChallenge` owns the feature-off / empty-for-this-user split; the administrative reset is no longer gated on `TWO_FACTOR_ENABLED` |
| **H2**                 | The channel list is a term of `offeredMethods`' `otp` branch, and `/two-factor/otp/send` refuses a channel the deployment has dropped, in both modes                                                                    |
| **M2**                 | One discriminator, `resolveRequestSession`, built on the library's own `getSessionFromCtx`                                                                                                                              |
| **M5** (ordering half) | Device trust is consumed AFTER the offered set is computed and the refusal has fired                                                                                                                                    |

### Step 2 — the repairs recorded as landed that were not

| Finding | What landed                                                                                                                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1**  | `registration.afterVerification` refuses `registrationInfo.userVerified !== true` before the credential row is written                                                                                                                              |
| **M7**  | `advancePasskeyCounter` is a monotonic maximum (`WHERE counter < to`), not a compare-and-swap on the read value; a no-op write means the row is already at least there                                                                              |
| **M6**  | `processOtpVerify` now marks the errors that came from a code being COMPARED; `verifyForSignIn` charges only those and restores the rest, and the passkey verifier settles its attempt exactly once through a `settled` flag with a refunding catch |
| **L10** | The administrative reset re-reads the joined target under `FOR UPDATE` and re-runs `assertTargetUserVisible` + `validateRolePermissionScope` inside the transaction; the outer read is a pre-filter                                                 |
| **M17** | Each of the four has a test that fails with the repair removed — verified by reverting each fix and watching it go red (see §7)                                                                                                                     |

### Step 3 — `H5`, the owned lifecycle

`lib/auth/two-factor-enrolment.ts` is new and serves the whole lifecycle. The
plugin's `enableTwoFactor`, `disableTwoFactor` and `generateBackupCodes` are
**removed from its endpoint map**, not merely un-allow-listed — two endpoints
cannot claim one path, and `/two-factor/enable` is not served at all.

| Sub  | What landed                                                                                                                                                                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `N2` | The TOTP after-hook is gone. `/two-factor/totp/start` + `/two-factor/totp/confirm` are ours, and confirm writes `verified`, the intent row, `two_factor_enabled` and the session rotation in ONE transaction. The plugin's `/two-factor/verify-totp` is refused in session mode, so its enrolment branch is unreachable |
| `F4` | `/two-factor/passkey/grant` mints a single-use, user-bound re-authentication grant from a POST password check; `/passkey/verify-registration` and `/passkey/delete-passkey` consume it in the shared before-hook. A `verify-registration` after-hook records `method: 'passkey'` and the flag together                  |
| `F6` | `/two-factor/methods/disable` re-reads the enrolled set INSIDE the deleting transaction under `FOR UPDATE`, takes a password, identifies the OTP row by contact kind, clears the capability the method owned, and revokes trusted devices                                                                               |
| `F7` | `/two-factor/disable` is ours: intent rows, credentials, the flag, trusted devices and any live challenge, in one transaction                                                                                                                                                                                           |
| `F8` | Backup-code-only and passkey-only deployments have a first-enable route: `/two-factor/generate-backup-codes` creates the credential row when none exists, and acknowledgement is what sets the flag                                                                                                                     |
| `F9` | A verified TOTP secret is never silently replaced (409); backup-code acknowledgement is bound to `backup_codes_version`, cleared by regeneration; `backupCodesReady` also requires `backup_codes_remaining > 0`                                                                                                         |
| `N1` | The password is required on the ENROLMENT branch of `/two-factor/otp/send` — resolved by mode, not by path                                                                                                                                                                                                              |

### Step 4 — `H4`, `M8`, `M15`, `M13`

| Finding | What landed                                                                                                                                                                                                                                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **H4**  | A companion record `2fa-state-<challenge>` holds the exact option identities, the default, the first factor, the contact exclusion and the remember choice. Written BEFORE the challenge and deleted with it; a challenge with no state row resolves to `null`, so every verifier fails closed. `resolveTwoFactorChallenge` intersects issued ∩ current — narrowing only |
| **M15** | `OfferedOption` with a stable `id` (`otp:email`, `otp:phone`, `totp`, …), a deterministic order (user default, then `passkey > totp > otp > backup_code`, then the id), `defaultMethod` in the challenge response, and `two_factor_methods` carrying a generated `contact_kind` with two partial unique indexes so a second OTP channel adds rather than replaces        |
| **M8**  | The submitted `rememberMe` is validated by `loginSchema`, carried in the companion record, passed to `createSession` and `setSessionCookie`, and the legacy `dont_remember` marker is cleared on completion and on cancellation                                                                                                                                          |
| **M13** | `completeTwoFactorChallenge` writes one completion event carrying the first factor, the option that finished it and the remember choice; the trusted-device skip writes its own bypass event                                                                                                                                                                             |

### Step 6, pulled forward

| Finding | What landed                                                                                                                                                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H6**  | `/two-factor/otp/{send,verify}` assert liveness on the session branch only, through a new `DUAL_MODE_LIVE_SESSION_PATHS`; `enrolmentTarget` filters `isActive`                                                                                 |
| **M3**  | The stranding guard and the OTP detachment are at the shared boundary (`detachTwoFactorFromContact` in `app/api/dash/users/me/contact-change.ts`) and on the admin edit. All three settled rules, including "never touch `two_factor_enabled`" |
| **M4**  | The predicate takes a SET of contact kinds and is asked once                                                                                                                                                                                   |

---

## 2. Decisions taken without asking

Recorded here rather than raised first, per the brief.

### 2.1 `M2`'s discriminator is `getSessionFromCtx`, not a reimplementation

The finding asks for "one shared discriminator reproducing the library's order".
Reproducing it leaves two implementations that can drift. `getSessionFromCtx`
memoises its answer onto `ctx.context.session`, and `verifyTwoFactor` reads that
field before doing anything else — so calling it makes the plugin **reuse** our
answer instead of computing a second one. Agreement is structural rather than
maintained.

Consequence, and it is a real behaviour change: `/two-factor/otp/send` and
`/two-factor/otp/verify` were challenge-first and are now session-first. A caller
holding both a live session and a live challenge is now an enrolment on those two
endpoints, which is what the plugin already did on `/two-factor/verify-totp`.

### 2.2 `N2` is closed against throwing, not against the orphan state

The recorded fix is "retry, or record a repairable state". Both are in. What is
**not** in is a compensating write that undoes the plugin's commit, and the
reason is that it cannot be made correct in an after-hook: the plugin only
rotates the session on a _first_ enable, so `ctx.context.newSession` distinguishes
"this request enabled 2FA" from "this request re-verified an authenticator that
already worked" — but the compensation for the second case (clearing
`two_factor_credentials.verified`) would break a working TOTP if the failing
write was the idempotent no-op. Reading enough state to tell them apart is the
same read that just failed.

Silently clearing `two_factor_enabled` was considered and rejected: it turns a
database fault into a downgrade, which is what `D2`'s safety half forbids.

The remaining orphan state is bounded — three attempts, then a log naming the
administrative reset — and `D2`'s exit is now reachable in every configuration
(**H1**). **H5**'s owned lifecycle is where it closes properly, because there the
credential write and the intent write are one transaction.

### 2.3 `M9` is fixed for the whole class, not for `two_factor`

The recorded fix is "give `two_factor` its own key, as `recovery` already has".
The class is wider: `verify_contact` is anonymous and reachable by anyone who
knows an address, and it shared one key with `passwordless`, `contact_change`
**and** `two_factor`. Keying on the surface — which the send side already does,
for this exact reason — closes all four pairs in one line and leaves `recovery`'s
key string unchanged. Brute-force resistance is unaffected: each surface has its
own proof row under its own `purpose`, and the authority is the per-proof
counter, not this limiter.

### 2.4 `M5`'s ordering landed early

`M5` is step 6, but its ordering half is three lines inside
`issueTwoFactorChallenge`, which **H1** was already rewriting. Leaving it would
have meant editing the same eight lines twice. The trust-revocation-on-capability-loss
half is still open and belongs with **H5**.

### 2.5 The integration tier's 2FA OTP channel list changed to `email,sms`

**H2** predicted this: `two-factor-management.test.ts` enrolled `otp/email` under
an `sms`-only channel list, so its recovery-refusal case passed because the
method was never offered at all, not because recovery was refused. With **H2**
fixed the test went red, which is the correct signal.

`tests/helpers/run.ts` now enables both channels. That is not a weakening of the
tier's intent: `D1` settles that contact-kind disjointness is enforced on the
authentication chain and _not_ by configuration, so a tier that enables both
channels and asserts `otp/sms` passes recovery while `otp/email` refuses is the
configuration that actually exercises the rule. The old comment claimed the
opposite and has been rewritten.

---

## 3. Comment and fixture corrections (`L3`, `L1`)

- `lib/auth/two-factor.ts` — the registration-UV comment now describes the gate
  that exists (and the gate exists).
- `lib/auth/two-factor.ts` — the TOTP after-hook catch no longer claims to
  prevent the state its throw created; it no longer throws.
- `utils/validation/two-factor.ts` — "Keep `backup_code` enabled in every
  deployment … the only method that survives an operator removing another one"
  deleted. The second clause was simply false (a user holding `totp` and
  `passkey` keeps `totp` when `passkey` is removed), and `P0` retires the
  imperative. `.env` carried the same claim and now states what is true.
- `utils/validation/two-factor.ts` — the startup log for an empty method list
  said only that the surfaces answer 404. It now says enforcement stops for
  already-enrolled accounts, which is the half an operator does not expect.
- `lib/auth.ts` — the `session.create.after` comment no longer claims two
  session-creating paths.
- `db/schema.ts` — the five banners this change added are removed. The 14
  pre-existing ones are left; see §6.
- `tests/helpers/session.ts` — the `uniquePhone` doc comment moved onto
  `uniquePhone`.
- `lib/rate-limit/api.ts` — the verify-quota comment described a recovery-only
  split; it describes the surface split now.

### Step 5 — `H3` mode A, and `L7`

| Finding       | What landed                                                                                                                                                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H3** mode A | `/forgot-password/reset` no longer writes the password for an account with a second factor. It commits a **recovery grant** (`lib/auth/recovery-grant.ts`) and answers the offered options; `/forgot-password/second-factor/send` and `/forgot-password/complete` prove a factor and write the password in one transaction with the grant's consumption |
| **L7**        | The startup overlap refusal is a warning (`twoFactor.otpOverlapsRecovery`). The chain now enforces what the boot was refusing to allow                                                                                                                                                                                                                  |

### Step 6

| Finding    | What landed                                                                                                                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M10**    | `requirePermission({ reauth: true })` on the whole `D12` class — the user edit, the user delete, permission create/edit/delete and the two-factor reset — with `POST /api/dash/auth/reauth` opening a 15-minute window |
| **M11**    | `revokeVerificationArtifacts` models each owned `verifications` row explicitly, including the session-keyed proof marker; `revokePendingProofs` takes the trusted-device answer as a parameter, per `D11`              |
| **M12**(b) | Every owned lifecycle transition writes an attributable audit row inside its own transaction                                                                                                                           |
| **M12**(c) | `scripts/check-two-factor-rollout.ts` (`bun run preflight:two-factor`), verified against a throwaway migrated database with a seeded stranded account                                                                  |
| **M18**    | A new `matrix` tier: six configurations, one child process each                                                                                                                                                        |

### Step 7

| Finding | What landed                                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M14** | The `200` on `/sign-in/email` and `/passwordless/verify` is a union of completed-session and challenge; exact request schemas for the recovery and re-auth endpoints; `/two-factor/otp/{send,verify}` added to the local-throttle set |
| **M16** | Purpose-aware templates (`otpTextFor`, `otpSubjectFor`) on every channel. The outbox half of `D15` is NOT done — see §5                                                                                                               |
| **L1**  | `idx_trusted_devices_expires_at`, so the retention sweep's filter has a leading index                                                                                                                                                 |
| **L2**  | `tests/unit/two-factor-library-drift.test.ts` — eleven assertions against the installed package                                                                                                                                       |
| **L4**  | `@better-auth/core` moved to `devDependencies`, pinned to `1.7.2`; `@better-auth/passkey` and `@better-auth/utils` pinned exactly                                                                                                     |
| **L5**  | `NAME_MAX` and `validID` bounds on the plugin's passkey bodies, in the shared before-hook                                                                                                                                             |
| **L6**  | `tsconfig.json` and the `eslint-plugin-import-x` range reverted                                                                                                                                                                       |
| **L8**  | The two-factor messages have one home (`twoFactorMsg`); `utils/api-messages.ts` keeps only the codes                                                                                                                                  |
| **L9**  | `docs/2fa.md` carries a callout naming what 1.7.2 actually does and what this deployment serves                                                                                                                                       |
| **L11** | `PASSWORDLESS_ENABLED`, checked at both entry points                                                                                                                                                                                  |
| **M19** | The lost pepper compare-and-swap is logged and the 401 stands, exactly as settled                                                                                                                                                     |
| §6.1    | `two_factor_credentials.verified` defaults to `false`                                                                                                                                                                                 |
| §6.2    | `SERVER_ONLY_VIRTUAL_PATH` is narrowed to a named operation set                                                                                                                                                                       |

---

## 3.5 Schema and migration

`db/drizzle/0007_real_the_watchers.sql`, generated and applied:

- `two_factor_credentials`: `verified` default `false`; `backup_codes_version`,
  `backup_codes_acknowledged_version`, `backup_codes_remaining`, and a
  non-negative check.
- `two_factor_methods`: a generated `contact_kind`, `is_default`, and **three**
  partial unique indexes replacing `(user_id, method)` — `(user_id,
contact_kind) WHERE method = 'otp'`, `(user_id, method) WHERE method <> 'otp'`,
  `(user_id) WHERE is_default`.
- `trusted_devices`: `idx_trusted_devices_expires_at`.

`D8` asks for the generated column and the partial conflict targets to be proven
by APPLYING the migration rather than by reading SQL. They were: the harness
re-provisions its template from `scripts/migrate.ts` whenever the migration
fingerprint moves, so all 348 integration tests and all 24 matrix runs execute
against the applied schema, and `recordMethodIntent`'s two `ON CONFLICT … WHERE`
targets are exercised by the enrolment tests. The preflight script was separately
run against a throwaway database created and migrated for the purpose, then
dropped.

---

## 4. Disagreements

### 4.1 `H3` mode A's stated impact overstates it

The report says "an attacker holding the victim's mailbox changes the password
without touching the TOTP secret … **the attacker gets the account** and the
owner gets a lockout." The first half of that is wrong on this codebase. After
the reset the attacker knows the password, but `/sign-in/email` answers a
two-factor challenge they cannot complete, and `/passwordless/verify` by email
excludes the email OTP and challenges them too. What they actually get is a
denial of service plus knowledge of the password — one factor away instead of
two, not in.

I fixed it anyway, in full, and I would keep it at High: it is a real breach of
`D1`'s invariant and the recovery flow is the wrong place to be lenient. But the
severity argument in the report rests on a takeover that does not happen, and if
that had been the deciding factor for the ordering it deserves correcting.

### 4.2 `M6`'s "wire exactly one outcome" needed a mechanism the finding does not name

The finding says to wire one outcome on every non-consuming path. It does not say
how to TELL them apart, and that is the whole problem: `processOtpVerify` throws
the same `CustomError` shape for "wrong code" and for "no proof row". Classifying
by status or message would be a string match on Arabic copy. The verdict is now
marked at the source — a `WeakSet` of errors that came from a code actually being
compared — because `CustomError.code` is already spent on the disclosure marker
and both facts have to travel on one throw.

### 4.3 `L10` is worth more than the report's own hedge

`L10` offers "close it as covered by `should-ignore.md` #16 if you prefer". I
did not: the sibling handler in the same route family already re-authorises under
its lock, so leaving this one was a consistency divergence, and the fix was a
move rather than new machinery. It also became free once `D12`/**M10** was
editing the handler anyway.

### 4.4 `M10`'s transport

`D12` settles the CLASS and the WINDOW; it does not settle how the proof
travels. I bound it to the session rather than issuing a token the client echoes
in a header. A header token adds no security — anyone who can send the session
cookie can send the header with it — while adding a bearer-shaped secret that can
land in a proxy log. The window is a row keyed by session id, so the client
simply continues on the same cookie.

### 4.5 `H1`'s "feature off downgrades" is right, and it is the uncomfortable half

Implemented as written, and it is worth being explicit about what it means: with
`NEXT_PUBLIC_ENABLED_2FA_METHODS` empty, an account that deliberately enabled a
second factor signs in with a password alone. I agree it is the operator's intent
and that the alternative (locking out every enrolled account on a rollback) is
worse. It is now audited per account and the boot says so out loud, which is the
least a silent downgrade deserves.

---

## 5. Not closed

### 5.1 `D15` — the test outbox, and therefore half of `M16`

The purpose-aware templates landed; the "production-impossible in-process
outbox" did not. A test can still only assert what a channel would deliver by
stubbing the provider's HTTP endpoint (`scriptEgress`), which is what the suites
do — so the WhatsApp and email bodies are exercised only in the sense that the
call is made, and no test asserts the delivered text per purpose.

What blocks it is not difficulty but scope: it needs a delivery seam in
`utils/otp.ts` (which is the containment boundary for provider text, so a seam
there has to be built carefully), a startup refusal that makes it impossible in
production, and a rule that keeps the plaintext code out of the logs. That is its
own change with its own review, and bolting it onto this one would have made an
already large diff larger for a Medium finding's second half.

### 5.2 `D9`'s `otp.nextAllowedIn` hint and the auto-send-once rule

The challenge response carries the ordered set and an explicit `defaultMethod`;
it does not carry per-method hints, and nothing enforces "auto-send for an `otp`
default at most once per challenge". The hint needs a read of
`verification_sessions.next_allowed_at` on every challenge issuance, and the
client already receives `nextAllowedIn` from the send response — so I judged the
extra query per login not worth it without evidence. The once-per-challenge rule
is a client behaviour whose server-side bound (`enforceOtpSurfaceSendQuota`)
already exists; a stricter per-challenge counter would be new state for a case
the destination budget already covers.

### 5.3 Passkey as a recovery second factor

`recoveryOptions` deliberately excludes `passkey`: the completion endpoint has no
request context to run a WebAuthn ceremony in. The consequence is recorded
honestly — a user whose only surviving factor after the contact exclusion is a
passkey is REFUSED recovery and needs the administrative reset. That is fail
closed and strictly safer than the previous behaviour (which reset the password
without asking for anything), but it is a real availability narrowing for
passkey-only accounts.

### 5.4 `D11`'s "notify about trusted devices" on a voluntary password change

The revocation policy is now correct per event — a voluntary password change
KEEPS trusted devices where it used to revoke them. The notification that is
supposed to accompany that is not implemented: there is no transactional-mail
path for it in this codebase, and inventing one is a separate change.

### 5.5 The 14 pre-existing `db/schema.ts` banners

`D16` asks for the five new ones to go and the pre-existing ones to be reported
separately. The five are gone. The remaining 14 (`Common Fields Helpers`,
`Enums`, `Users Table`, `Sessions Table`, …) are untouched: they predate this
change, `CLAUDE.md` names section banners as something never to write, and
removing them is a mechanical sweep that belongs in its own commit rather than
buried in a security diff.

### 5.6 `M11` — the passkey plugin's own ceremony rows

`revokeVerificationArtifacts` cannot reach them: the plugin writes a random
identifier with a JSON value, and nothing in the row joins it to a user. They are
single-use, short-lived and useless without the challenge cookie the browser
holds, so they are left to the retention sweep. Recorded in the function's own
comment.

### 5.7 `H3`'s row lock

`F2` asked for a `users` / `two_factor_methods` lock in canonical order around
the recovery decision. `processOtpVerify` already locks the user row `FOR UPDATE`
before the read, and the three writers that did not take that lock —
`/two-factor/methods/disable`, the TOTP intent after-hook and backup-code
acknowledgement — now all do (`lockUser` in the owned lifecycle, and the TOTP
after-hook no longer exists). So the set the lock had to cover is covered by the
writers taking it, rather than by a second lock on the reader. The generic form
remains accepted in `should-ignore.md` #54.

---

## 6. Found here, in no finding

### 6.1 `rememberMe`'s absent case would have shortened every session

Not a defect in the tree — a defect I nearly introduced. `M8` says to persist the
submitted choice; the obvious reading is "absent means false". Better Auth's own
`/sign-in/email` schema is `rememberMe: z.boolean().default(true)`, so absent
means REMEMBERED, and reading it as `false` silently shortens every session from
every client that does not send the field. Caught by
`sign-in-controls.test.ts`, which asserts the exact set of cookies a sign-in
emits and saw a new `better-auth.dont_remember`. `submittedRememberMe` now treats
absent as `true` and only an explicit `false` shortens.

### 6.2 The trusted-device suite's tests shared one IP budget

Adding one test to `two-factor-trusted-device.test.ts` made an unrelated one
answer 429: a full enrolment is five requests and the admission limiter is per
IP, so the file's tests were coupled through a budget none of them asserts on.
Each enrolment now uses its own source address. Not a production defect — a
harness one, and exactly the kind that makes a suite flaky as it grows.

### 6.3 `revokePendingProofs` was revoking trusted devices on a voluntary password change

`D11` says a voluntary password change should NOT revoke trusted devices. The
helper folded `revokeTwoFactorState` in unconditionally, so it did — for every
caller, including `users/me/change-password`. No finding names this; it fell out
of reading `D11` against the code while fixing **M11**.

### 6.4 The plugin's verifiers were reachable in enrolment mode

Implied by `H5`/`N2` but not stated: once enrolment is owned, the plugin's
`/two-factor/verify-totp` and `/two-factor/verify-backup-code` still served their
own enrolment branch, which writes `verified` and `twoFactorEnabled` outside the
transaction that has to carry the intent row. They are now refused in session
mode, so the branch is unreachable rather than merely unused.

---

## 7. Verification

Every repair below was verified by REMOVING the fix and watching a named test go
red, then restoring it. That is the discipline **M17** exists to enforce, and it
is the only way the repairs recorded here differ from the ones recorded as landed
before.

| Fix           | Test that fails without it                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **M1**        | `two-factor-passkey` › refuses an authenticator that did not verify the user                                                       |
| **M6**        | `two-factor-otp` › a request that never reached a code does not spend the challenge budget                                         |
| **M7**        | `two-factor-passkey` › keeps the HIGHER of two concurrent assertions (and the inverse)                                             |
| **M5**        | `two-factor-trusted-device` › a trusted device is refused once the account has no usable factor                                    |
| **M11**       | `two-factor-trusted-device` › removing a method revokes the proof that could mint a new trust                                      |
| **M4**        | `two-factor-management` › asks ONE question when a request changes both contacts                                                   |
| **H3** mode A | `two-factor-management` › does not write the password on the recovery code alone (+ completes only against a proven second factor) |
| **L5**        | `two-factor-passkey` › refuses inputs this schema could not store                                                                  |
| **H1**        | `matrix` (disabled row) › both first-factor paths agree about one enrolled account                                                 |
| **M10**       | `two-factor-management` › is refused without a FRESH password proof, self-target included                                          |

The **H1** case is worth spelling out, because the first version of that
assertion did NOT fail without the fix: the passwordless path calls the issuer
directly and writes the same audit row, so an unscoped query passed either way.
Scoping it to `api_path = '/sign-in/email'` is what makes it a test of the
unconditionally installed guard.

### Suites, as run on the final tree

| Command                       | Result                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run lint` (tsc + eslint) | pass, zero warnings                                                                                                                                  |
| `bun run test` (unit)         | 895 pass, 0 fail                                                                                                                                     |
| `bun run test:integration`    | 348 pass, 0 fail                                                                                                                                     |
| `bun run test:process`        | 50 pass, 2 skip (Windows), 0 fail                                                                                                                    |
| `bun run test:matrix` (new)   | 6 configurations × 4 tests, 0 fail                                                                                                                   |
| `bun run format:check`        | 3 pre-existing failures, all of them documents this pass did not write (`two-factor-final-audit.md`, `two-factor-verification.md`, one archived log) |

Flake seen once, not reproduced: `test:process` › `concurrent first-open of the
rate-limit store` failed on one run with a SQLite open race and passed on the two
runs after it. It is Windows-specific and unrelated to anything here.

### What was not exercised

- No browser, no real authenticator. The passkey REGISTRATION ceremony is now
  driven end to end by a synthetic one (`tests/helpers/webauthn.ts`), which is
  what makes the signed UV bit assertable — but the ASSERTION side still is not,
  so `/two-factor/passkey/verify` is covered only up to the point where a real
  signature would be needed.
- No real email, SMS or WhatsApp delivery, so the new purpose-aware templates are
  asserted only as strings, not as delivered messages. See §5.1.
- No executed race for **M7**, **L10** or the recovery grant's single use; each
  follows from statement ordering and a `WHERE` clause, and the grant's
  single-use property is asserted by a replay rather than by a concurrent one.
- The `otp-whatsapp` matrix row boots and serves, but no test sends through the
  WhatsApp provider.

---

## 8. What these changes made false elsewhere

- **`reports/two-factor-final-audit.md` is now out of date as a description of
  the code.** Its §3 findings are the plan I worked from and its §2 policy still
  governs, but every "Where:" line naming `lib/auth/two-factor.ts:150-166`, the
  TOTP after-hook, `newestSessionId`, `sessionUser`, `signInTarget`'s
  `otpTarget`, `contactChangeStrandsTwoFactor(userId, kind)` or
  `offeredMethods(...): TwoFactorMethod[]` describes code that no longer exists.
- **`reports/two-factor-verification.md`** — same status. It is a record of
  reasoning against the pre-repair tree; nothing in it was edited.
- `docs/2fa.md` described `/two-factor/enable`, `/two-factor/disable` and
  `/two-factor/generate-backup-codes` as this deployment's API. The first is not
  served at all and the other two are ours; a callout now says so.
- The `.env` comment block for `NEXT_PUBLIC_ENABLED_2FA_METHODS` said an empty
  list only makes the surfaces 404. It also stops enforcement, and now says so.
- `reports/coolify-deployment.md` claimed the overlapping-OTP configuration fails
  the boot. It warns now; the section was rewritten and the preflight added to
  the release checklist.
- The frontend contract moved in ways a client will notice, all published in the
  OpenAPI document: `/two-factor/enable` is gone; `/two-factor/disable` and
  `/two-factor/generate-backup-codes` are ours with different bodies; TOTP
  enrolment is `/two-factor/totp/{start,confirm}`; a passkey ceremony needs
  `/two-factor/passkey/grant` first; `/two-factor/methods/disable` takes a
  password and an optional `contactKind`; the enrolment branch of
  `/two-factor/otp/send` takes a password; `/sign-in/email` and
  `/passwordless/verify` can answer a challenge shape; `/forgot-password/reset`
  can answer `{ reset: false, twoFactorRequired: true, grant, options }`; and
  every action in the `D12` class needs `POST /api/dash/auth/reauth` first.
- `tests/helpers/session.ts`'s `signedInUser` now opens the re-authentication
  window. A future test asserting the re-auth REFUSAL must not use it — the
  helper says so, and `two-factor-management.test.ts` shows the pattern.
