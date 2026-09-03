# Two-factor implementation — consolidated audit and tracking document

**This file is the plan of record.** It lists every known problem and the agreed
fix. Reasoning lives in the source reports and is not restated here.

| Source                                    | Role                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `reports/two-factor-review.md`            | First-pass review. Superseded by this file.                           |
| `reports/two-factor-plan-codex-review.md` | Second opinion. Adjudicated in the verification report.               |
| `reports/two-factor-verification.md`      | Verification of both, N1–N6, and the answers to points 4.1–4.7 and 7. |
| `reports/two-factor-plan.md`              | Original plan. **Stale** — retire once the work below lands.          |

`reports/two-factor-decisions.md` and `reports/two-factor-decisions-2.md` were
never committed and are gone, not missing. **D1–D16 below is the record**, taken
from the decision replies themselves. Nothing is pending recovery.

Findings carry the identifiers the reports used: **F1–F28** (this file's own
audit), **N1–N6** (verification report §4), **F29–F31** (found during the
decision thread). Severities are unchanged except where a decision moved one.

---

## Implementation status

**Step 0 — landed.** `issueTwoFactorChallenge` returns
`{ kind: 'challenge' | 'proceed' | 'refused' }` instead of a nullable challenge.
The empty-offered-set branch now withdraws the first factor's session through the
shared `withdrawFirstFactorSession` helper and returns `refused`; `/sign-in/email`
and `/passwordless/verify` both raise 403 `TWO_FACTOR_UNAVAILABLE`
(`twoFactorUnavailableError`). The audit event changed from
`twoFactorDowngraded` / `reason: 'no offered method remained after intersection'`
to `twoFactorRefused` / `reason: 'two_factor_unavailable'`, with
`sessionAbandoned: true` and `oldData.loginSuccess: true`, matching the challenge
path now that the session really is withdrawn.

Closes F3's safety half and F29's first property. Still open from F29: property 2
on both the admin and the self-service boundary (step 5), and F31's attributable
event (step 6).

One consequence worth recording: on the admin path the F29 chain now ends in a
refused login rather than a downgraded session, so what was a takeover is now a
denial of service until an operator resets. Property 2 is what removes it.

`tests/integration/two-factor-passkey.test.ts` carried the old behaviour as an
assertion ("gets no challenge at all") and now asserts the refusal plus the
absence of a usable session.

**Step 1 — landed.**

| Finding          | What changed                                                                                                                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F5               | `/two-factor/trust-device` consumes a single-use `2fa-proven-<sessionId>` marker minted by `completeTwoFactorChallenge` and by an `after` hook on the library's two verify paths. A session that never completed a challenge is refused 403. `grantDeviceTrust` raises instead of swallowing its insert failure. |
| F12              | `spendChallengeAttempt` no longer re-arms before the verdict; it returns `{ ok, recordFailure, restore }`, matching the library's `beginAttempt`. `enforceOtpVerifyQuota` moved ahead of the spend so a quota rejection cannot destroy the challenge.                                                            |
| F13              | `authenticatorSelection.userVerification: 'required'` at registration; `userVerification: 'required'` and `requireUserVerification: true` on our assertion.                                                                                                                                                      |
| F17              | `disableSession` stripped alongside `trustDevice` on the plugin verify paths.                                                                                                                                                                                                                                    |
| F22              | Counter update is a compare-and-swap on the value the assertion was verified against; a lost swap logs rather than moving the row backwards.                                                                                                                                                                     |
| F28              | `listTrustedDevices` orders `desc(lastUsedAt)`. `uniquePhone()` is a sequential closure counter.                                                                                                                                                                                                                 |
| N3               | `/two-factor/otp/send` uses `resolveTwoFactorChallenge`, the same discriminator as `verify`; `signInTarget` now takes the resolved challenge instead of re-reading it.                                                                                                                                           |
| F30              | The reset handler calls `validateRolePermissionScope` with the actor's permissions and the target's role id, as every sibling under `/users/:id` does.                                                                                                                                                           |
| F29 property 3   | `contactChangeStrandsTwoFactor` refuses an admin contact change that would remove the target's last usable factor, 409, pointing at `resetTwoFactor`.                                                                                                                                                            |
| F2 liveness half | `readEnrollment` takes an optional executor; `recoveryDefeatsTwoFactor` and the new predicate are called with `tx`, so nothing reads through the pool from inside a transaction.                                                                                                                                 |

**Step 1 tests.** Each finding's own **Tests** row, not only its **Fix**:

| Finding        | Test                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F5             | `two-factor-trusted-device`: a session that never completed a challenge is refused the grant; the proof is single-use.                                                          |
| F12            | `tests/unit/two-factor-attempt-budget.test.ts` — seven cases against a stub adapter, including the budget being unreadable between a spend and its outcome.                     |
| F17            | `two-factor-trusted-device`: a body carrying both `trustDevice: true` and `disableSession: true` completes the challenge, issues a session, and records no trusted device.      |
| F22            | `two-factor-passkey`: two assertions verified against the same counter advance it once, and the loser does not move it backwards.                                               |
| F28            | Covered by the existing list assertion plus the F5 cases; ordering is asserted through the settings-list shape rather than its own test.                                        |
| N3             | `two-factor-otp`: a live session carrying a stale challenge cookie reaches the enrolment branch instead of 401.                                                                 |
| F30            | `two-factor-management`: an actor holding `users.resetTwoFactor` but not the target role's permissions is refused 404, and is refused the parent `PUT` on the same id.          |
| F29 property 3 | `two-factor-management`: the contact change is refused 409 and writes nothing; allowed when TOTP survives it.                                                                   |
| F2 liveness    | No test. The failure is pool exhaustion under concurrency, which needs a load harness this repo does not have; the fix is a signature change `tsc` enforces at both call sites. |

F12's test was written against the stub rather than through an endpoint because
the property is an interleaving: racing two HTTP requests asserts whichever order
the scheduler picked. **It found a second defect in the same function** — an empty
counter value read as `Number('') === 0`, so a corrupt or hand-written empty
`value` (the column is `text NOT NULL`) granted a fresh budget instead of being
treated as exhausted, which is the one direction that check exists to prevent.
The parse is now digits-only.

F22's compare-and-swap was extracted as `advancePasskeyCounter` to make it
testable: the ceremony cannot be driven without a real authenticator, so the swap
is the only part of the counter path a test can reach.

The trusted-device suite no longer seeds a trusted device by SQL. The TOTP
enrolment flow is now an `enrolTotp` helper driven through the real endpoints, so
a second enrolled user costs one call — that file was named as one of the two
seeding final state by SQL, and that pattern is what let an inert passkey
enrolment ship green.

Verified: `bun run lint` clean; 875 unit, 332 integration, 50 process (2 skip), 0
failures.

---

## Corrections to earlier claims in this file

Recorded because a tracking document must not carry claims already known false.

- **F3's closing paragraph was wrong.** It said the remaining empty-set triggers
  are "operator- or state-caused rather than attacker-chosen". F29 shows a
  third-party, attacker-chosen trigger through a legitimate `users.edit`, and a
  self-service one through the shared contact-change boundary. The paragraph is
  corrected in place.
- **F24 is half wrong.** The false-index claim applies to `trusted_devices` only;
  `verifications` does have `idx_verifications_expires_at`. Corrected in place.
- **F27 cites three things wrongly.** The `grantDeviceTrust` quote it attributes
  does not exist; the `db/schema.ts:617-619` banner and the
  `lib/auth/rotation.ts:13-26` change-history narrative are both pre-existing at
  `HEAD`. The five _new_ banners and the _new_ duplicate in `revokePendingProofs`
  are the real targets. Corrected in place.

---

## Decisions

Settled policy. Where a decision refines or overrides an entry's **Fix**, that
entry carries a **Decision** line pointing back here.

**D1 — Recovery: no single possession may satisfy both the recovery proof and the
second-factor proof in one authentication chain.** A property of the _path_, not
of the enrolled set. Enrolment-time refusal (verification report's option A) and
conditional admission (option B) are both rejected: neither closes F2 mode A,
because the offered set is decided at method selection, not at enrolment.
Unconditional — never gated on whether the current environment lists overlapping
channels. Granularity is contact kind, so `email`+`whatsapp` is disjoint and
`sms`+`whatsapp` is not.

**D2 — The empty offered set has two properties, not one.**

- _Safety:_ an empty offered set never grants access. Fail closed.
- _Liveness:_ every empty state has an exit that does not require the credential
  the user lost.

Safety is the higher priority and is now the first item of work. Liveness is held
by mandatory backup codes at enable (D5) plus the operator reset, and depends on
D6 for that exit to actually work.

**D3 — Backup-code exhaustion is bounded, not prevented.** The strong property
("no user can reach an empty recovery-time offered set") is unachievable with a
consumable factor as its only contact-independent member, and forcing regeneration
inside a login is the wrong placement. Instead: a low-water warning in an
authenticated session, and the operator reset as the named exit. A deployment that
wants the strong property literally sets `NEXT_PUBLIC_ENABLED_2FA_METHODS` to
`totp,backup_code`. The population that can reach the terminal state is exactly
"OTP-only, codes spent" — TOTP and passkey are non-consumable and
contact-independent.

**D4 — Recovery proves the second factor during the reset, before the password
write, excluding the recovery contact kind.** Deferring to the next sign-in buys
nothing and still lets a mailbox holder rewrite the password. The proof must not
run inside `processOtpVerify`'s transaction (F2's liveness half): the OTP verify
commits a short-lived **recovery grant**, and the second-factor proof plus the
password write happen against that grant in a later request. Grant constraints:

- single-use, short-lived, bound to the user **and** to the excluded contact kind;
- not sufficient alone — possession of the grant plus nothing else must fail;
- invalidated if the enrolled method set changes between the two requests;
- its own send quota, so a mailbox holder cannot restart the flow to burn the
  disjoint factor's quota (F11's territory, widened by the two-request shape);
- the recovery challenge does not honour trusted devices (F5).

Messages: the enrolment refusal is dropped (nothing left to refuse); an enrolment
_warning_ appears only on actual overlap; the reset prompt appears for every 2FA
user, and text explaining an excluded method appears only when one was excluded.

**D5 — Backup codes are mandatory at enable**, and acknowledgement is a required
step of enrolment rather than an optional follow-up. Prerequisite: D6.

⚠️ **D5 binds at enable, so it does not cover users enrolled before it ships.**
Everything that leans on "every 2FA user holds a contact-independent factor" —
D2's liveness half, F29 2a's placement — assumes a population D5 alone does not
produce. No production data makes this a seeding concern here, but this repo is a
starter kit: a project adopting D5 over a live user base needs a backfill, and the
only safe shape is a prompt at the next authenticated session, never a silent
generation the user never sees (F9's acknowledgement gate exists for that reason).

**D6 — Own the enable/disable/removal lifecycle** (F8), including backup-code
generation. The plugin's `/two-factor/enable` cannot enrol anything but TOTP in
this configuration and its `/two-factor/disable` cannot clean up state it does not
know about, so the operator reset — D2's named exit — otherwise returns the user
to enabled-with-nothing.

**D7 — F1's remedy is the companion challenge record**, plus a `before`-hook check
on the two plugin verify paths so an unoffered method cannot complete. Confirmed
closable from outside: both plugin verifiers are single-method, so the path→method
map is static and total. Two constraints: apply the check only in sign-in mode
(`verifyTwoFactor` branches on `getSessionFromCtx`, and gating the session branch
breaks enrolment), and give the companion record an owner for cleanup, because the
plugin consumes the challenge id itself inside `valid()`.

**D8 — Two OTP channels per user are supported.** `two_factor_methods` uniqueness
moves off `(user_id, method)`: partial unique on `(user_id, contact_kind) WHERE
method = 'otp'`, partial unique on `(user_id, method) WHERE method <> 'otp'`.
`contact_kind` is a generated column; `channel` survives as the phone row's
delivery preference. Precedent is `ux_verification_sessions_user_contact_purpose`.
The generated column's immutability under an enum must be proved by running the
migration, not by reading. Follow-on: `offeredMethods` may return two OTP entries,
so D9's ordering becomes load-bearing.

**D9 — Ordering and routing.** System priority `passkey > totp > otp >
backup_code`, `backup_code` excluded from auto-routing. User-configurable default
via `is_default boolean` with a partial unique index on `(user_id) WHERE
is_default`, constrained to reorder only _within_ the immutable issued set and to
fall back to system priority without ever producing the empty-set branch.
Auto-send for an `otp` default at most once per challenge. Challenge response
carries the ordered set, an explicit `defaultMethod`, and per-method hints
(`otp.nextAllowedIn`). Client feature-detects before auto-routing to passkey.

**D10 — `rememberMe`:** all four items of verification report §5.4.4, with the
config flag defaulting to honouring the submitted value.

**D11 — Rotation policy.** Voluntary password change: revoke sessions, notify
about trusted devices, do not revoke them. Recovery reset: revoke trusted devices.
Never reset 2FA methods on either. Adding or confirming a method: revoke other
sessions (F10's implementation is broken and must carry the caller's own session
id, or revoke all and re-issue). Removing a method or changing an OTP channel:
revoke trusted devices, keep sessions, require a password proof.

**D12 — Administrative re-authentication is a class, not an endpoint.** Either
every admin action that lowers another account's security posture sits behind a
re-auth boundary, or none does. The class is `PUT /api/dash/users/:id` (password,
email, phone, `isActive`, `roleId`, permissions), `DELETE /api/dash/users/:id`,
`POST /api/dash/users/:id/two-factor/reset`, and role/permission mutation one
level up. The proof is valid for a **short window**, not per-request — a
per-request prompt on every row of a batch is what gets the control disabled.

**D13 — Passwordless sign-in fails closed** when no independent factor remains
(F3's possession-exclusion half), routing the user to the password route.
Independent of D14.

**D14 — Passwordless is separately switchable**, server-side, without disabling any
other OTP surface. Both entry points gated; a disabled surface answers 404, matching
how disabled 2FA methods behave. Deployment note required.

**D15 — Test transport for unprovisioned channels.** A test can exercise any
channel end to end and assert what would have been delivered, without a provider
account. The plaintext code must not reach the logs. The integration tier runs the
app in-process (`tests/helpers/run.ts` spawns a child, but the tests import `app`
and call `app.handle`), so an in-process outbox is viable. Impossible to run in
production, refused at startup. F19 lands here — unifying the senders is the moment
they all get the message hook. Deployment note required.

**D16 — Accepted proposals from the verification report**, no mechanism attached:
`two_factor_credentials.verified` default → `false` (§3.9); pin
`@better-auth/core` to `1.7.2` and move it to `devDependencies` (§3.11/N6);
method-aware OpenAPI known set rather than a revert (§3.12); narrow the
`SERVER_ONLY_VIRTUAL_PATH` exemption to a named set (§3.13); the pepper CAS repair
that verifies the re-read hash against the plaintext still in scope (§3.14);
remove the five _new_ banners and report the 14 pre-existing ones separately
(§3.3); §5.4.6 in full; keep passkey (§5.7); copy the library's `beginAttempt`
protocol (F12) and `valid()`'s remember-me handling (F16) verbatim;
`userVerification: 'required'` at registration plus our own assertion gate (F13);
drive the configuration matrix through real endpoints rather than seeded SQL.

---

## Order of work

Revised from the verification report's §8 by D2 and F29: fail-closed on the empty
offered set moves to the front, because every one of the newly found paths funnels
into that one branch and enrolment-side fixes cannot close it.

| Step | Closes                                                                     | Note                                                                                                                                                                                                                             |
| ---- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | F3 safety half, F29 property 1                                             | **DONE** — see Implementation status.                                                                                                                                                                                            |
| 1    | F5, F12, F17, F13, F22, F28, N3, F30, **F29 property 3**, F2 liveness half | **DONE** — see Implementation status.                                                                                                                                                                                            |
| 2    | F9 capability, F8, D5, then **F29 2a**                                     | Backup codes real before anything leans on them (D2 liveness). 2a follows D5 within this step: until every 2FA user holds a contact-independent factor, deleting the dependent intent row converts one lockout into a worse one. |
| 3    | F1, F16, F18, F21, N5→D8, D9, D10                                          | Companion challenge record and the routing surface.                                                                                                                                                                              |
| 4    | F2, N1, N4, F11, D4                                                        | Recovery grant and the possession policy.                                                                                                                                                                                        |
| 5    | F4, F6, F7, F10, N2, D6, D11, **F29 2b**                                   | Enrolment lifecycle, owned end to end. 2b needs step 4’s reusable proof. The invalidation helper both halves call lives in `rotation.ts`, beside `revokePendingProofs`.                                                          |
| 6    | F14→D12, F15, F23, F24, F25, F26, N6, F31, D13, D14                        | Hardening, admin re-auth class, preflight, contract test, audit.                                                                                                                                                                 |
| 7    | F19, F20, F27, D15                                                         | Message templating, contract schemas, comment sweep, test transport.                                                                                                                                                             |
| 8    | Configuration matrix                                                       | Through real endpoints, one run per method-set configuration.                                                                                                                                                                    |

---

## F1 — Critical — The challenge does not bind the factors it offered

**Where** `lib/auth/two-factor-challenge.ts:208` (issuance computes the allowed
set), `:248-256` (persists only the user id and an attempt count), `:367-379`
(`resolveTwoFactorChallenge` recomputes with no `excludeContactKind`).

The challenge record carries the user id and nothing else. The offered method set,
the first-factor contact kind and the remember-me choice are all re-derived on
each later request, from mutable state, without the issuance context. The
advertised `twoFactorMethods` array is therefore a UI hint, not a control. Two
independent bypasses follow.

**1a — an unoffered or removed method completes a live challenge.** Better Auth's
TOTP and backup-code verifiers consume the challenge and validate their own
credential row; they never read `two_factor_methods` or the set that was offered
(`node_modules/better-auth/dist/plugins/two-factor/totp/index.mjs:172-224`,
`.../backup-codes/index.mjs:187-233`). A method the user removed, never
acknowledged, or that was never offered for this challenge still verifies. Both
source reports reached this independently; one reproduced it with a temporary
test (`bun tests/helpers/run.ts integration two-factor-totp` — 6 pass, including a
correct TOTP completing a challenge whose advertised set was `["backup_code"]`).

**1b — the passwordless possession rule is enforced only at issuance.** A
passwordless email first factor excludes email OTP from the offered set, but the
exclusion is not persisted. `/two-factor/otp/send` resolves `otpTarget` from the
unfiltered recomputation (`lib/auth/two-factor-otp.ts:226-237`), delivers a second
code to the same mailbox, and `/two-factor/otp/verify` accepts it. One mailbox
satisfies both factors on a login the response advertised as TOTP-only.
Reproduced: `bun tests/helpers/run.ts integration two-factor-otp` — 6 pass,
including a session issued from two codes to one address.

**Fix** Persist an immutable, purpose-bound companion record alongside the
challenge holding the exact permitted `(method, channel)` pairs, the first-factor
kind and contact kind, the remember-me choice, and the purpose. Every verifier —
custom and Better Auth-backed — must reject a method absent from that record.
Current enrolment and capability state may _narrow_ the set after issuance; it
must never widen it. Better Auth expects the sign-in challenge value to remain the
user id, so use a companion verification row keyed to the challenge, or replace
the TOTP and backup verifiers with application-owned endpoints.

The cheapest partial step — enforcing the offered set in the `before` hook on
`/two-factor/verify-totp` and `/two-factor/verify-backup-code` — closes 1a without
the record, but leaves 1b, F16 and F21 open. The companion record closes all four
at one boundary and is the correct shape.

**Decision** D7 — companion record plus the `before`-hook check on the two plugin
verify paths, with the sign-in-mode-only and cleanup-owner constraints.

**Tests** Direct endpoint tests for every unoffered method, the same-contact
passwordless fallback, and cross-purpose challenge reuse.

---

## F2 — Critical — The recovery policy tests factor existence, not factor proof

**Where** `recoveryDefeatsTwoFactor`, `lib/auth/two-factor-challenge.ts:491-501`;
caller at `app/api/auth/forgot-password/reset/handler.ts:113-120`.

The predicate refuses a reset only when `offeredMethods(state, contactKind)` is
empty. It answers "does some factor survive exclusion of the recovery contact" —
not "was a disjoint factor proven", and not "is any factor completable at all".
Both errors are live.

**Failure mode A — account takeover (critical).** With email OTP _and_ TOTP
enrolled, the predicate returns `false` because TOTP survives, and the reset
proceeds with no proof of TOTP. An attacker holding the mailbox then:

1. redeems an emailed `forgot_password` code (permitted because TOTP exists);
2. sets a new password;
3. signs in with it;
4. is offered email OTP in the challenge — a password first factor applies no
   contact exclusion; and
5. completes 2FA from the same mailbox.

Nothing is cross-redeemed between purposes; the `otp_purpose` separation holds.
The attack requests one fresh code per purpose from one compromised contact.
Purpose-bound database lookups are not factor separation when both flows prove
possession of the same thing. Reproduced with a temporary test:
`bun tests/helpers/run.ts integration two-factor-management` — 6 pass, covering
the reset, the sign-in, the 2FA OTP and the issued session. Existing coverage
exercises same-contact OTP alone and a wholly disjoint factor; the dangerous
coexistence case was not tested.

**Failure mode B — permanent, unrecoverable refusal (medium).** For a user whose
intent rows survive but whose capability is gone — last passkey deleted, only
method removed from `NEXT_PUBLIC_ENABLED_2FA_METHODS`, credentials row cleared by
`/two-factor/disable` while intent rows remained (F7) — `offeredMethods` is empty
_without_ the exclusion, so the predicate refuses recovery permanently and tells
the user to "use another verification method" that does not exist. The same user
takes the downgrade branch at sign-in (F3), so the account is simultaneously
unprotected and unrecoverable, with only the administrative reset as an exit.

**Fix** Split the two questions.

```ts
if (offeredMethods(state).length === 0) return false; // nothing to defend
return offeredMethods(state, contactKind).length === 0; // all on this contact
```

That closes B. For A, the existence of a disjoint factor must stop meaning
"proceed": either refuse recovery whenever the recovery contact is an enabled
second-factor destination, or require a recovery-scoped, one-use proof from a
disjoint factor bound to that reset before the password is written. With no
disjoint factor, route to administrative recovery.

The ordinary sign-in challenge cannot serve as that proof unchanged. Better
Auth's TOTP path completes through `valid()`, which creates a normal session, and
`verifyBackupCode` with `disableSession: true` skips `valid()` and therefore skips
challenge consumption (F17). `completeTwoFactorChallenge`
(`lib/auth/two-factor-challenge.ts:448-480`) also always creates a session.
Recovery needs its own purpose-bound state machine whose verifier consumes the
challenge into a short-lived single-use password-reset grant and never issues a
session.

**Also** The comment at `app/api/auth/forgot-password/reset/handler.ts:113-117`
claims the decision and the write are atomic. They are not:
`recoveryDefeatsTwoFactor` reads through the global `db` rather than the supplied
transaction and takes no lock on the enrolment rows, so a concurrent method change
can separate the two. Pass the transaction into the policy read and lock the user
and method rows in canonical order. The residual race is the same class as the
deferred `authVersion` item in `should-ignore.md`; the false comment is not, and
must go either way (F27).

**Decision** D1, D4 — the refusal is replaced by a proof inside a recovery grant, and
the grant carries the excluded contact kind. The liveness half (`readEnrollment`
through the global `db` inside a transaction) is fixed by threading `tx`.

---

## F3 — Critical — An empty offered set silently downgrades 2FA to one factor

**Where** `lib/auth/two-factor-challenge.ts:189-223`.

When `users.twoFactorEnabled` is true but no method survives the
intent × capability × environment intersection, the code deliberately returns
`null`, writes a `twoFactorDowngraded` audit row, and keeps the first-factor
session. `tests/integration/two-factor-passkey.test.ts` asserts this as intended
behaviour.

**Why this is critical and not merely operational:** on `/passwordless/verify` the
first factor _is_ a code to a contact. Take a user whose only enrolled method is
OTP-to-email, in a deployment where the 2FA channel and the recovery channel are
both email. Issuance excludes the email contact, the offered set is empty, and the
branch issues **a full session from one emailed code and no password**. For the
identical user with identical possession, `/api/auth/forgot-password/reset`
refuses. The weaker treatment landed on the sharper path: passwordless mints a
session, recovery only rewrites a password.

The remaining triggers have three causes, not one: operator-caused (a method
removed from the environment list), state-caused (a deleted last passkey, stale
enrolment rows, an unacknowledged recovery set) and — per **F29** —
**attacker-chosen through a third party's legitimate action**. Each turns 2FA into
password-only for the affected users, and an audit row does not restore the
boundary.

> **Correction.** This paragraph previously read "operator- or state-caused rather
> than attacker-chosen". F29 disproves it.

**Fix** The two causes must stop sharing one branch, because the correct policy
differs:

- _Possession exclusion_ (the passwordless case): fail closed. Refuse the
  first-factor route and require a different first factor. The user still has a
  password path, so this locks nobody out.
- _Capability loss_ (operator config change, deleted credential): withdraw the
  first-factor session and return a distinct, recoverable "no available factor"
  state. Lockout is then prevented by enrolment invariants, by F2's corrected
  recovery predicate and by an administrative path — not by handing out a session.

Emit a distinct audit reason per cause. Today one reason
(`'no offered method remained after intersection'`) fires on every routine
passwordless login by an affected user, so the operator-caused case cannot be
alerted on. See F25 for the pre-deployment control that keeps the second cause
from being reachable by a configuration change at all.

**Decision** D2 — two properties. Safety (an empty offered set never grants access)
is step 0 and unconditional. Liveness is held by D5 plus the operator reset, with
D3 bounding exhaustion rather than preventing it. D13 applies the safety half to
passwordless.

---

## F4 — Critical — Registering a passkey never enrols it as a second factor

**Where** the plugin is installed at `lib/auth/two-factor.ts:166-173`; the only
`recordMethodIntent` call sites are TOTP confirmation (`two-factor.ts:126`), OTP
confirmation (`two-factor-otp.ts:351`) and backup-code acknowledgement
(`two-factor-otp.ts:499`).

There is no hook on `/passkey/verify-registration`, no writer of
`method: 'passkey'` anywhere, and passkey registration never sets
`users.twoFactorEnabled`. In a deployment configured
`NEXT_PUBLIC_ENABLED_2FA_METHODS=passkey`, registering a passkey produces a
`passkeys` row and nothing else: `two_factor_enabled` stays `false`,
`/sign-in/email` issues a session with no challenge, and
`/two-factor/passkey/options` and `/two-factor/passkey/verify` are unreachable
because `requireChallenge` can never be satisfied. The whole passkey branch is
registered, published in the OpenAPI contract, and permanently inert — the single
capability the original prompt asked for. Adding a passkey to an existing 2FA
account likewise never makes `passkey` appear in a challenge, and there is no
supported transition to re-enable passkey intent after removal.

`tests/integration/two-factor-passkey.test.ts:76-87` masks this: `givePasskey()`
inserts the `two_factor_methods` row and flips `two_factor_enabled` by direct SQL,
and every assertion in the file is about refusal paths, so the gap produces no
failure.

**Registration authorization is also too weak for adding an authenticator.**
Better Auth 1.7.2 protects both registration steps with `freshSessionMiddleware`
only (`@better-auth/passkey/dist/index.mjs:88,324`), and this deployment sets
`freshAge: 60 * 60 * 10` — ten hours (`lib/auth.ts:451-454`). Neither path is in
`PASSWORD_PROOF_PATHS`. Planting a persistent credential therefore needs only a
session created some time in the last working day, while enabling TOTP — a
strictly less durable credential — needs the password. `revokeTwoFactorState`
(`lib/auth/rotation.ts:34`) deletes trusted devices and verification rows but not
`passkeys`, so a credential planted in that window survives the victim's password
change and only the administrative reset removes it.

**Fix** Attach enrolment policy to successful passkey registration at a shared
server-side boundary: on the first eligible passkey, atomically
`recordMethodIntent(tx, { userId, method: 'passkey' })`, set
`twoFactorEnabled: true`, and revoke sessions and trusted devices under the same
enrolment policy the TOTP hook uses — with F10's fix, not `newestSessionId`. Add
both passkey registration paths to `PASSWORD_PROOF_PATHS`, or require an existing
second factor, one-use and bound to the registration; freshness alone is not
step-up. Add `passkeys` to `revokeTwoFactorState`. Decide the authorization
question before wiring enrolment up, not after — and set F13's user-verification
options at the same time, while no credential exists to migrate.

**Tests** Drive registration through the real endpoints and assert the intent row,
the flag and the revocations; stop seeding final state by direct SQL.

**Decision** D6 — the owned enable routine writes the passkey intent row; the fix is
no longer a standalone `after` hook. D16 keeps passkey and sets
`userVerification: 'required'` at registration.

---

## F5 — Critical — `/two-factor/trust-device` mints a 30-day bypass for any session

**Where** `lib/auth/trusted-device.ts:214-235`.

The endpoint is gated by `sessionMiddleware` and `assertLiveSession` and nothing
else. It does not check `users.twoFactorEnabled`, does not check that a challenge
was just completed, and consults no "2FA was proven" marker. `consumeDeviceTrust`
is the first thing `issueTwoFactorChallenge` calls
(`lib/auth/two-factor-challenge.ts:206`) and it returns before any method is
offered, so a trust cookie is a complete, renewable skip of the second factor.

1. **Pre-enrolment planting.** An attacker holding a stolen session on an account
   with no 2FA calls `/two-factor/trust-device`. No enrolment path revokes trusted
   devices — `verifyForEnrolment` (`two-factor-otp.ts:368-372`) and the TOTP hook
   both call only `revokeOtherSessions`. The victim later enables 2FA, their
   sessions are revoked, and the attacker's trust row and cookie survive. From
   then on the attacker's password knowledge alone completes login.
2. **Self-escalation.** Any session — including one obtained through the F3
   downgrade — can convert itself into a permanent skip without ever completing a
   challenge.

`tests/integration/two-factor-trusted-device.test.ts` asserts attack 1's
precondition as expected behaviour: it signs in a user with no 2FA and expects a
`trusted_devices` row.

**Fix** Bind trust to a proven second factor. Have `completeTwoFactorChallenge`
(and the plugin's verify paths, via the existing `after` hook) emit a one-use
grant bound to user, challenge, device cookie and a short expiry, and have
`/two-factor/trust-device` consume it atomically — or record the "2FA proven" fact
on the session row and require it here. Enabling 2FA, or materially changing a
method, must revoke existing trusted devices; today `revokeTwoFactorState` runs
only on credential rotation.

**Also** `grantDeviceTrust` (`lib/auth/trusted-device.ts:135-152`) catches its
insert failure, logs and returns, and the endpoint then answers
`{ trusted: true }` with no durable record and no cookie. The swallow is
defensible on the post-challenge path — failing there would refuse a login that
succeeded — but the response must then report `trusted: false`. The comment
claiming the function "is called only after a second factor has actually been
proven" is false while the endpoint is directly callable (F27).

**Decision** D11 — trust is granted only against a proven second factor, revoked on a
recovery reset and on method removal, and not revoked on a voluntary password
change. The recovery challenge (D4) never honours it.

---

## F6 — High — Method removal removes intent only, is non-atomic, and needs no password

**Where** `POST /two-factor/methods/disable`, `lib/auth/two-factor-otp.ts:434-472`.

Three defects in one endpoint.

- **It disables nothing for TOTP or backup codes.** It deletes the
  `two_factor_methods` intent row and no more. The plugin's
  `/two-factor/verify-totp` and `/two-factor/verify-backup-code` never read that
  table — they check the `two_factor_credentials` row (`verified !== false` for
  TOTP, row exists for backup codes) — and stay allow-listed while the method is
  server-enabled. A user who removes `totp` because they believe their
  authenticator is compromised can still complete every future challenge with a
  TOTP code. The same asymmetry makes the acknowledgement gate cosmetic: an
  unacknowledged set is not offered but is fully accepted. F1's challenge binding
  closes the _verification_ half; stale capability can still be resurrected by
  inserting intent later, so per-method cleanup is required independently.
- **It is not atomic.** The enrolled list is read outside the transaction
  (`:455-469`), so two concurrent requests can each observe two methods, both pass
  the last-method check, and delete both rows. Passkey deletion is delegated to
  the generic passkey endpoint, which has no last-method rule and no update when
  the final credential disappears.
- **It needs only a session.** The path is absent from `PASSWORD_PROOF_PATHS`
  (`lib/auth.ts:216`), so _removing_ a second factor is cheaper than adding one,
  and cheaper than every other security-control change in this codebase.

**Fix** One transaction: lock the user row, count eligible methods, and apply the
last-method check and the removal together. Route last-passkey deletion through
the same lifecycle. Define per-method cleanup — clear or rotate the TOTP
capability, invalidate backup codes and their acknowledgement, and decide
explicitly whether disabling passkey-as-2FA keeps the credential for another
purpose. Add the path to `PASSWORD_PROOF_PATHS`, or require a current-factor
proof.

**Decision** D6, D11 — removal becomes part of the owned lifecycle, atomic, with a
password proof and trusted-device revocation.

---

## F7 — High — Self-service `/two-factor/disable` leaves custom 2FA state live and reusable

**Where** the reachable endpoint is Better Auth's
(`node_modules/better-auth/dist/plugins/two-factor/index.mjs:206-239`). It clears
`users.twoFactorEnabled`, deletes the TOTP/backup credential row, rotates the
caller's session and expires the caller's trust cookie. It does not touch
`two_factor_methods` intent, `passkeys`, `trusted_devices` rows on other devices,
custom OTP/passkey challenges and their attempt counters, or other sessions.

`resolveTwoFactorChallenge` (`lib/auth/two-factor-challenge.ts:367-379`) never
checks `EnrollmentState.enabled`, so a custom OTP or passkey challenge issued
before the disable still completes after it. Surviving intent rows silently
resurrect enrolments the user never re-chose on a later re-enable, and surviving
trust rows become bypasses again. Combined with F2's failure mode B, a disable
that leaves intent rows behind is exactly the state that makes recovery refuse
permanently.

**Fix** Wrap or replace self-disable with one application-owned cleanup under a
user-row lock, and extract it as a shared routine used by both this path and
`app/api/dash/users/[id]/two-factor/handler.ts` so the two cannot drift. It must
invalidate challenges and counters, trust rows and cookies, intent, method
capability and the relevant sessions. Independently, challenge resolution must
reject disabled accounts rather than relying on cleanup having run.

**Decision** D6 — self-service disable is owned end to end, which is what makes D2's
named exit actually return the user to a clean state.

---

## F8 — High — `backup_code` and `passkey` are unenrollable in supported configurations

**Where** `utils/validation/two-factor.ts` accepts `passkey` and `backup_code` as
deployment methods. `/two-factor/enable` is the only creator of a
`two_factor_credentials` row, and in `better-auth@1.7.2` it refuses both branches
under this configuration:

```js
if (method === "otp"  && !options?.otpOptions?.sendOTP) throw … OTP_NOT_CONFIGURED;
if (method === "totp" &&  options?.totpOptions?.disable) throw … TOTP_NOT_CONFIGURED;
```

`otpOptions` is deliberately unset (`lib/auth/two-factor.ts:71`) and
`totpOptions.disable` is `!isTwoFactorMethodEnabled('totp')` (`:69`). With `totp`
off, every call to `/two-factor/enable` returns 400, so no credentials row ever
exists, so `/two-factor/generate-backup-codes` throws `TWO_FACTOR_NOT_ENABLED` and
`/two-factor/backup-codes/acknowledge` 404s on its `UPDATE … RETURNING`.

Consequences across the route surface:

- `backup_code` without `totp` has no initial credential or generation path, so in
  an `otp,backup_code` or `passkey,backup_code` deployment the load-bearing
  recovery path is unreachable — which turns F3 into an unrecoverable lockout;
- `passkey`-only cannot enable 2FA at all (F4);
- `/two-factor/enable` and `/two-factor/disable` are allow-listed whenever any
  method is on (`lib/auth/allowed-paths.ts`), so with `totp` off the contract
  publishes a 200 shape on an endpoint that can only 400;
- `/two-factor/backup-codes/acknowledge` is served whenever any method is on, even
  with `backup_code` disabled; and
- enabling TOTP generates and returns backup codes even when `backup_code` is
  disabled — a disabled method must not produce user-visible recovery material.

**Fix** Own backup-code generation rather than delegating it: write the
`two_factor_credentials` row directly (the encryption helpers are importable from
`better-auth/crypto`), or gate `/two-factor/enable` on `totp` and provide a
separate enable path per non-TOTP method. Add a startup invariant requiring at
least one enrollable primary method, and gate every management route on the method
it actually changes.

**Decision** D6 — own backup-code generation rather than gating `/two-factor/enable`
on `totp`. D5 makes acknowledgement a required enrolment step.

---

## F9 — High — Re-enable rotates credentials without proof, and acknowledgement is unbound

**Where** `node_modules/better-auth/dist/plugins/two-factor/index.mjs:125-165`;
`.../backup-codes/index.mjs:276-303`; capability at
`lib/auth/two-factor-challenge.ts:96,121-124`; acknowledgement writer at
`lib/auth/two-factor-otp.ts:495`.

- **Repeat enable silently replaces a verified factor.** A second
  `/two-factor/enable` overwrites both `secret` and `backupCodes` on the existing
  row while preserving `verified: true`. A session holder who can satisfy the
  password field replaces an already-verified TOTP secret without proving the old
  factor or the new one, and invalidates every backup code the user holds. The
  application neither rejects re-enrolment nor stages the new secret until
  confirmation.
- **Acknowledgement is not bound to a set.** `backupCodesAcknowledgedAt` is set
  once and never cleared, and `capability.backupCodesReady` is
  `acknowledgedAt != null`. `/two-factor/generate-backup-codes` updates only
  `backupCodes`, so a regenerated set is offered immediately as a fallback the
  user may never have seen. The plan states regeneration "requires its own
  acknowledgement"; it does not.
- **Exhausted sets stay offered.** `backupCodesReady` never checks whether any
  _unused_ code remains, so once all ten are spent `backup_code` is still
  advertised and can never be completed.
- **Nothing requires a user to keep their codes.** `/two-factor/enable` always
  generates, stores and returns a set, but acknowledgement is a separate optional
  call. A user who enables TOTP, ignores the codes and later loses their
  authenticator has `offeredMethods = ['totp']` — the one thing they cannot do.
  Today password recovery succeeds and still leaves them unable to log in; once F2
  is corrected they have no self-service exit at all. The administrative reset is
  the only way out.

**Fix** Reject a duplicate enable, or implement an explicit rotation ceremony
requiring the password _and_ a current factor, with the new secret staged and
activated only after verification. Clear `backupCodesAcknowledgedAt` and disable
backup intent in the same hook that handles `/two-factor/generate-backup-codes`
and `/two-factor/enable`; acknowledgement must identify the exact set or version.
Count remaining unused codes for the capability term — decode the stored set, or
keep a counter beside the acknowledgement. Gate completion of a first enrolment on
acknowledgement of the generated set, or on another independently verified
recovery method.

**Decision** D5, D3 — acknowledgement clears on regeneration, capability counts unused
codes, and a low-water warning surfaces in an authenticated session. This is a
prerequisite of D2's liveness half, so it lands before the recovery work.

---

## F10 — High — Enrolment revocation can keep the attacker's session and drop the victim's

**Where** `newestSessionId`, `lib/auth/rotation.ts:75-85`; callers at
`lib/auth/two-factor.ts:124-135` and `lib/auth/two-factor-otp.ts:366-371`.

`revokeOtherSessions(tx, userId, await newestSessionId(tx, userId))` keeps
`ORDER BY created_at DESC LIMIT 1` — "whichever session was created last", not
"the caller's". Those are equivalent only when the endpoint rotated the caller's
session moments earlier, and neither path does so in general:

- `/two-factor/otp/verify` in enrolment mode is entirely ours and never rotates.
  `sessionUser(ctx)` (`two-factor-otp.ts:108`) reads the real session and then
  discards everything but the user id.
- `/two-factor/verify-totp` rotates only inside
  `if (twoFactor.verified !== true) { if (!user.twoFactorEnabled) { … } }`. A user
  who already enabled OTP 2FA and then adds TOTP has `twoFactorEnabled === true`,
  so no rotation happens.

Failure: the attacker signs in at T2 after the victim at T1; the victim enrols a
second factor at T3; the revocation keeps T2 and kills T1. **The victim is logged
out and the attacker stays in** — the exact inversion of what enrolment revocation
exists to prevent.

Two related weaknesses on the same paths: OTP enrolment commits the enabled state
before a separate revocation transaction and swallows revocation errors
(`two-factor-otp.ts:366-376`), and the TOTP path performs intent and revocation in
an after-hook transaction, after Better Auth has already changed its own
credential and session state. Either split can leave 2FA enabled while old
sessions survive.

**Fix** Carry the caller's own session id through the enrolment operation;
`sessionUser` already has it from `findSession` and only needs to return it. For
the plugin's TOTP path, read the session id from the response's `Set-Cookie`
token, or drop `newestSessionId` and revoke _all_ sessions on confirmed enable —
one extra sign-in is the safe failure direction. A revocation failure must not be
reported as a successful enrolment.

**Decision** D11 — carry the caller's own session id, or revoke all and re-issue.

---

## F11 — High — 2FA OTP verification shares a rate-limit key with an anonymous surface

**Where** `enforceOtpVerifyQuota`, `lib/rate-limit/api.ts:221-236`.

`recovery` has a reserved scope; every other surface — including `verify_contact`,
`passwordless` and the newly added `two_factor` — shares
`otp.verify.dest.{kind}`, 10 attempts per 600 s keyed by destination.
`/api/auth/otp/verify` is `auth: 'public'` (`routes.ts:168-172`) and takes an
attacker-supplied `email`/`phoneNumber`. Ten junk verifications burn the shared
budget and, for the next ten minutes, the victim's `/two-factor/otp/verify`
returns 429 **before the code is examined** — they cannot finish signing in.
Sustained at one request per minute per victim, this is indefinite. The comment
directly above the function documents this exact attack for `recovery`. The
per-proof database counter does not help, because the shared limiter rejects
before the proof lookup.

2FA denial is strictly worse than recovery denial: it blocks ordinary login, not
just password reset.

**Fix** Give `two_factor` its own scope, exactly as `recovery` has, while keeping
its challenge-level and proof-level budgets:

```ts
scope:
  opts.surface === 'recovery' ? `otp.verify.dest.recovery.${kind}`
  : opts.surface === 'two_factor' ? `otp.verify.dest.two_factor.${kind}`
  : `otp.verify.dest.${kind}`,
```

Secondary, lower priority: `enforceOtpGlobalSendBudget` (2000/day/contact-kind) is
shared across every surface, so an app-wide send flood is also a login-denial
vector for OTP-only 2FA users. A small reserved slice for `two_factor` bounds it.
This is distinct from the deferred window-boundary item in `should-ignore.md`,
which concerns the window shape rather than the sharing.

**Tests** Exhaust the public verify surface for an address, then submit a valid
2FA code for that user and assert it is examined.

**Decision** D4 — `two_factor` gains its own verify scope key, and the recovery grant
carries its own send quota so the two-request shape cannot be used to burn the
disjoint factor's allowance.

---

## F12 — High — The challenge attempt counter is re-armed before verification

**Where** `spendChallengeAttempt`, `lib/auth/two-factor-challenge.ts:387-423`.

```ts
await rearm(used);
return { ok: true, recordFailure: () => rearm(used + 1) };
```

The row is consumed and immediately written back at the _same_ count, before the
caller verifies anything. Better Auth's own `beginAttempt` deliberately does not
do this (`node_modules/better-auth/dist/plugins/two-factor/verify-two-factor.mjs:70-97`):
it consumes and leaves no row until `recordFailure()` or `restore()` runs, so a
competing request arriving mid-verification finds nothing and is rejected.

1. **Parallel-guess window.** `consumeVerificationValue` serialises on a lock, so
   N concurrent requests each consume the row, each read the same `used`, each
   re-arm at `used`, and each pass the budget check; they then all write
   `used + 1`. N wrong answers cost one attempt. The 5-per-challenge budget,
   documented as the authority shared across every method, does not hold under
   concurrency.
2. **Lost increments without concurrency.** After `rearm(used)` and
   `rearm(used + 1)` two rows exist for the identifier;
   `consumeVerificationValue` takes `ORDER BY createdAt DESC LIMIT 1` and
   `verifications.created_at` is `timestamp(2)`. Two inserts inside one centisecond
   leave the winner undefined and the failure can be silently discarded. Better
   Auth's adapter selects the latest record and deletes all duplicates for an
   identifier (`node_modules/better-auth/dist/db/internal-adapter.mjs:818-850`),
   which makes duplicate same-count rows especially unsafe.

Today's blast radius is bounded by the _other_ counters —
`/two-factor/otp/verify` is still held by `verification_sessions`'
`verifyAttemptNumber`/`verifyAttemptDaily` under a row lock, passkey assertions
are not brute-forceable, and TOTP and backup codes use the plugin's own
`beginAttempt` — but the documented cross-method authority is not enforced, and it
becomes load-bearing the moment a method is added or a per-method counter relaxed.

**Fix** Match the plugin: do not re-arm before the outcome is known. Return
`recordFailure` and `restore` and require every caller to invoke exactly one.
While one verification owns the counter, competing requests must fail.

**Tests** A parallel passkey test submitting more than the allowed number of wrong
assertions, asserting no more than the configured budget reaches verification.

**Decision** D16 — copy the library's `beginAttempt` protocol verbatim.

---

## F13 — High — The passkey ceremony does not require user verification

**Where** `lib/auth/two-factor-passkey.ts:122` (`userVerification: 'preferred'`)
and `:257` (`requireUserVerification: false`). Registration inherits the plugin
defaults — `userVerification: "preferred"`, `requireUserVerification: false`
(`node_modules/@better-auth/passkey/dist/index.mjs:179,278,355,483`).

`preferred` lets the authenticator answer with user presence alone, and
`requireUserVerification: false` accepts that answer. A passkey then proves
possession of the device, not that a human unlocked it: a stolen unlocked device,
or a security key with no PIN, satisfies the "second factor" with no local
verification. That does not meet the biometric/PIN property the feature was asked
for.

Stated precisely: WebAuthn can require _user verification_; it cannot require
specifically biometric verification — a platform PIN is a valid UV mechanism.

**Fix** Set `userVerification: 'required'` for authentication,
`requireUserVerification: true` on assertion verification, and configure
registration consistently so a credential that cannot satisfy UV is never enrolled
as a second factor. Because F4 means no passkey is enrolled as 2FA today, this can
land before any credential exists; if registration ships first, an explicit
migration or fallback path is needed for credentials that cannot satisfy it.

**Decision** D16 — `userVerification: 'required'` at registration plus our own
assertion gate, since the plugin hardcodes `requireUserVerification: false`.

---

## F14 — High — Administrative 2FA reset does not re-authenticate the administrator

**Where** `app/api/dash/users/[id]/two-factor/handler.ts:41-62`.

The route requires the `resetTwoFactor` permission with `forceDB: true` and a rate
limit, and nothing else. Its OpenAPI body is `NULL_SCHEMA` and it never calls
`verifyLoginAttempt`, although `reauth_two_factor` already exists as a login-guard
purpose. The target's sessions and pending proofs are revoked in the same
transaction and the audit row records both actor and target — those properties
landed; re-authentication did not.

The asymmetry is the point: `app/api/dash/users/me/change-password/handler.ts`
calls `verifyLoginAttempt({ returnPasswordProof: true })` before a user may change
_their own_ password, and the same re-auth guards their own email and phone
changes. Stripping a **different** user's second factor asks for less. Permission
freshness answers whether the actor is authorized; it does not prove the human is
still holding the administrator's credential, and a stolen administrator session
is precisely the scenario this endpoint hands the most value to.

**Fix** Run the same `verifyLoginAttempt` with `purpose: 'reauth_two_factor'`
before the reset transaction, one-use and bound to the action and the target user.
Keep the database-backed permission check and the rate limit; neither is
reauthentication.

**Tests** Session-only refusal, wrong proof, proof bound to a different target,
successful one-use consumption, replay refusal.

**Decision** D12 — the boundary is a class, not this endpoint. Short-window proof,
not per-request. See also F30, which is the same endpoint's scope gap.

---

## F15 — Medium — Dual-mode endpoints escape the `assertLiveSession` sweep

**Where** `LIVE_SESSION_PATHS`, `lib/auth.ts:232`.

Four `/two-factor/*` paths are omitted because each also serves an anonymous
challenge mode, and the omission is unconditional.

- `/two-factor/otp/send` and `/two-factor/otp/verify` authenticate through their
  own `sessionUser()` (`lib/auth/two-factor-otp.ts:108-116`), which reads the
  database — so the cookie-cache half is closed — but checks neither
  `users.is_active` nor `users.deleted_at`. `enrolmentTarget` (`:74-105`) filters
  `isNull(users.deletedAt)` but not `isActive`. A **suspended** user holding a
  live session row can therefore send and verify an OTP enrolment, set
  `two_factor_enabled` and create method intent. Every other 2FA management path
  in this change refuses them.
- `/two-factor/verify-totp` and `/two-factor/verify-backup-code` have the same
  split. In authenticated mode `verifyTwoFactor` resolves the caller through
  `getSessionFromCtx` — the cookie cache, with no active/non-deleted check — so a
  suspended user can finalize a TOTP enrolment or consume a backup credential.
  The `before` hook on these paths only strips `trustDevice`.

This is not covered by the accepted cookie-cache trade-off in
`should-ignore.md`, which is scoped to read-only endpoints; these are mutations
that change an authentication control.

**Fix** Apply `assertLiveSession` conditionally — only when a real session, not a
challenge cookie, selected the authenticated mode — or split enrolment and
sign-in into separate endpoints. Make the enrolment lookup require an active,
non-deleted user.

**Tests** Suspended and soft-deleted session cases for custom OTP, TOTP and
backup-code endpoints.

**Decision** D16 — with N3, one discriminator across both dual-mode endpoint pairs.

---

## F16 — Medium — Custom completion drops "do not remember me"

**Where** `completeTwoFactorChallenge`, `lib/auth/two-factor-challenge.ts:436-475`.

Better Auth's `valid()` reads the signed `dont_remember` marker and passes it on
as `createSession(userId, !!dontRememberMe)`, which selects the row's expiry:
`dontRememberMe ? getDate(3600 * 24) : getDate(sessionExpiration)`. Our completion
calls `createSession(challenge.user.id)` with no second argument. With
`session.expiresIn: 2_419_200` (`lib/auth.ts:452`) the difference is **1 day
versus 28**.

The state does reach us — `issueTwoFactorChallenge` calls
`deleteSessionCookie(ctx, true)`, and that `true` is `skipDontRememberMe`, so the
marker survives the challenge and `setSessionCookie` re-reads it. The browser
cookie is correctly session-scoped; only the database row is wrong. The marker is
also not cleared as Better Auth's verifier clears it, so it can influence a later
flow in the same browser session.

`/sign-in/email` accepts `rememberMe` (`sign-in.mjs:265`) and the `before` hook's
returned body is merged rather than substituted, so a client-supplied
`rememberMe: false` reaches the handler even though nothing in this codebase
surfaces the option. The result is a token the user asked to be short-lived that
stays valid server-side for 28 days, and behaviour that differs between completion
paths: the plugin's TOTP and backup-code endpoints honour it, ours do not.

**Fix** Fold the remember-me choice into F1's persisted challenge state, pass its
inverse to `createSession`, and expire the marker after every successful or
cancelled completion. Reading the cookie directly in `completeTwoFactorChallenge`
is the minimal patch, but it re-derives first-factor context rather than carrying
it, which is the defect F1 exists to remove.

**Tests** Parity for `rememberMe` false and true across TOTP, backup code, OTP and
passkey, asserting both cookie attributes and database expiry.

**Decision** D7, D10 — the remember-me choice lives in the companion record; copy
`valid()`'s handling verbatim and expire the marker after a completed or
cancelled challenge.

---

## F17 — Medium — `disableSession` passthrough burns a backup code and bricks the challenge

**Where** the request policy at `lib/auth.ts:84-105,252` forces `trustDevice` to
`false` on the plugin's verifiers but leaves `disableSession` untouched. The
backup-code body explicitly accepts it
(`node_modules/better-auth/dist/plugins/two-factor/backup-codes/index.mjs:52-57`).

On a correct code with `disableSession: true`, lines 215-233 consume and rewrite
the backup set, then return **without** calling `valid()` — so no session is
issued and the challenge is not completed. `beginAttempt` has already consumed the
`2fa-attempts-<id>` row and neither `recordFailure` nor `restore` runs, so the
counter is gone and every subsequent verification on that challenge fails.

Reaching it requires the password (a challenge cookie), so this is not a bypass.
It is rated Medium rather than Low because each call permanently destroys one
one-use recovery code and strands the login, and because the fix is one line.

**Fix** Force `disableSession: false` alongside the existing `trustDevice` strip
for interactive sign-in verification, or remove the field from the served
contract.

**Tests** A hostile body carrying both `trustDevice` and `disableSession`.

**Decision** D7 — the companion record's permitted-method check rejects the call; also
strip `disableSession` alongside `trustDevice`.

---

## F18 — Medium — No default method, no deterministic order, no user preference

**Where** `ChallengeIssued` at `lib/auth/two-factor-challenge.ts:184-187`;
`readEnrollment`'s select at `:83-91` has no `ORDER BY`.

The offered list has no order at all — Postgres returns heap order, which changes
after any update to a row — so a client doing `methods[0]` gets a different
default between logins for the same user. Nothing ranks the methods by strength,
no default is selected, no OTP is dispatched as part of routing, and
`GET /two-factor/methods` returns intent only, without joining capability, so a
settings screen cannot render "enrolled but currently unusable" — exactly the
state F2's failure mode B and F3 put users into. The unordered list must be fixed
before any auto-routing UI is built, independently of whether a preference feature
is added.

**Fix**, in order:

1. Define the system priority once beside `TWO_FACTOR_METHODS` — `passkey`,
   `totp`, `otp`, `backup_code`, strongest first, recovery last — and sort
   `offeredMethods`' output by it. It must be independent of database and
   environment-list order. `backup_code` must never sort first and must be
   excluded from auto-routing even when it does: auto-routing to it spends a
   recovery code on a routine login.
2. Add `two_factor_methods.is_default boolean not null default false` with a
   partial unique index on `(user_id) WHERE is_default`, set through a new
   `POST /two-factor/methods/default` (live session; no password, since it changes
   no capability), updated transactionally. Removal of the row falls back to
   system priority naturally. A preference may reorder only within the immutable
   issued set of F1 and only while currently usable; an unavailable preference
   falls back to system priority and must never produce the F3 empty-set
   downgrade.
3. Return the ordered array as today (`twoFactorMethods`) plus an explicit
   `defaultMethod`, so the client's rule is "attempt the default, show the rest
   under _Try another way_", all from the same immutable challenge. Fallback
   selection must not call the recomputing resolver in a way that widens the set.
4. For an `otp` default, "auto-route" means an automatic send on challenge
   display. Send at most once per challenge — a user who reloads the 2FA page six
   times would otherwise exhaust the 5/hour per-destination quota and lock
   themselves out of their own default method. Re-sends stay explicit and report
   the `nextAllowedIn` the endpoint already returns.

**Decision** D9 — system priority, user-configurable default, auto-send once per
challenge, ordered set plus `defaultMethod` and per-method hints in the response.

---

## F19 — Medium — Recovery and 2FA messages are indistinguishable on a shared channel

**Where** `utils/otp.ts:179-210` (SMS/WhatsApp) and `:308-321` (email). The send
layer never receives the purpose, so every purpose gets the same generic text and
the same email subject and body.

Simultaneous password-reset and 2FA codes to one mailbox or number are visually
interchangeable. That produces wrong-screen failures and makes it materially
easier to socially engineer a user into relaying a login code as though it were a
recovery code — which is the human half of the same-contact problem F2 covers in
code.

**Fix** Pass purpose and template context into delivery and label password reset,
login second factor, contact verification and passwordless sign-in distinctly.
Include a "do not share" warning and enough context to identify the attempted
action without exposing account state.

**Decision** D15 — the message hook lands with the test transport, which is the moment
all three senders are unified.

---

## F20 — Medium — Generated OpenAPI contracts do not match runtime behaviour

**Where** endpoints declaring `z.record(z.string(), z.unknown())` and then parsing
a narrower schema by hand: `lib/auth/two-factor-otp.ts:146-218` and `:434-469`,
`lib/auth/two-factor-passkey.ts:155-174`, `lib/auth/trusted-device.ts:269-273`.
`lib/http/openapi.ts:320-323` overrides bodies only for sign-in and passwordless,
so the generated documentation advertises arbitrary objects instead of the
required `code`, `channel`, `method`, `response` and device-id fields.
`BETTER_AUTH_LOCAL_THROTTLE_PATHS` (`lib/http/openapi.ts:1253`) lists only
passwordless verification, although the custom OTP send and verify paths can
return local 429 and 503.

**Fix** Declare the real exported Zod schemas on the endpoints, or add exact
OpenAPI overrides sourced from those schemas. Document limiter and breaker
responses for every locally throttled path. Add contract assertions for required
fields and for 429/503 coverage.

---

## F21 — Medium — Authentication audit records lose or misstate the factor chain

**Where** `SESSION_METHOD_BY_PATH`, `lib/auth.ts:202-207`.

The map recognises password, passwordless, TOTP and backup-code paths only.
Sessions created by custom OTP and passkey verification are logged as `unknown`. A
TOTP or backup completion after a passwordless first factor is labelled
`password+totp` or `password+backup_code`, even though the first factor was a
contact OTP — which is precisely the combination F1's 1b and F3 make dangerous, so
the audit trail misreports the case an operator most needs to find. Management
endpoints that rotate sessions can also be recorded as login successes with no
distinct event type.

**Fix** Persist the first-factor kind in F1's challenge state and emit one explicit
completion event carrying first factor, second factor, challenge reference and
whether a trusted-device bypass was consumed. Separate credential-management
session rotation from interactive login issuance.

**Tests** Audit assertions for `password+otp`, `password+passkey`,
`passwordless+totp`, `passwordless+backup`, trust bypass, and enrolment/disable
rotations.

---

## F22 — Low — Passkey counter persistence can regress under concurrent challenges

**Where** `lib/auth/two-factor-passkey.ts:278-284`.

The stored counter is persisted after every accepted assertion, but the update is
keyed on the passkey id alone. Two live sign-in challenges can read the same
stored counter, both verify, and finish out of order, letting the lower response
counter overwrite the higher one — after which a replayed assertion carrying the
higher counter verifies again.

This matters because the counter _is_ compared, contrary to the comment above the
update. The code passes `counter: credential.counter` into
`verifyAuthenticationResponse`, and `@simplewebauthn/server@13.3.3` throws
`Response counter value … was lower than expected` when
`(counter > 0 || credential.counter > 0) && counter <= credential.counter`
(`node_modules/@simplewebauthn/server/esm/authentication/verifyAuthenticationResponse.js:144-150`).
The zero-counter compatibility the comment describes is the library's, and it
applies only while both counters are zero.

**Fix** For authenticators reporting a nonzero counter, update with
compare-and-swap on both credential id and the counter value read for
verification, check the affected row count, and reject or explicitly reconcile a
lost race. Authenticators that always report zero keep the existing path. Correct
the comment (F27).

**Tests** Two concurrent challenges, asserting the stored counter cannot decrease
and that a stale assertion cannot win.

**Decision** D16 — one compare-and-swap on the counter update.

---

## F23 — Low — `revokeTwoFactorState` has a dead loop and an incomplete blast radius

**Where** `lib/auth/rotation.ts:34-52`.

The function collects every deleted `trusted_devices.trustIdentifier` and issues
one `DELETE FROM verifications` per row. No such rows exist: `grantDeviceTrust`
writes only to `trusted_devices` and a cookie, and the plugin's own trust path —
the sole writer of those verification rows — is disabled by the forced
`trustDevice: false`. The loop is a per-device round trip that always deletes
zero rows.

The one real deletion (`WHERE value = userId`) removes challenge rows but not
their `2fa-attempts-<id>` companions, whose `value` is `'0'`, so those survive
rotation until the nightly sweep. The function also does not delete `passkeys`
(F4).

**Fix** Delete the loop. If orphaned counters matter, match
`identifier LIKE '2fa-attempts-%'` against the challenge ids collected before the
first delete.

**Decision** D11 — the blast radius is decided per rotation kind; the dead loop goes
regardless.

---

## F24 — Low — The trusted-device sweep lacks the index its comment claims

**Where** `db/maintenance.ts:79-88` states that `trusted_devices`, like
`verifications`, has "a leading index on the column they filter (`expires_at`)"
and that this was "verified with `EXPLAIN`, not assumed". The schema creates only
`idx_trusted_devices_user` on `(user_id, expires_at)` (`db/schema.ts:611-614`),
and `sweepTrustedDevices` (`db/maintenance.ts:286-299`) filters on `expires_at`
alone. That composite B-tree provides no usable leading key for the sweep.

> **Correction.** The comment covers both new tables and is false for
> `trusted_devices` **only**. `verifications` does have `idx_verifications_expires_at`.
> Re-scope the finding to the trusted-device half.

**Fix** Add an `expires_at`-leading index on `trusted_devices` and verify the
generated migration and plan, or accept the sequential scan explicitly and narrow
the comment to the table it is true for. An `EXPLAIN` assertion the schema cannot
satisfy must not survive either way (F27).

---

## F25 — Low — A method-list change cannot be sized before deployment

The empty-intersection downgrade writes `twoFactorDowngraded`
(`lib/auth/two-factor-challenge.ts:212-221`) and that is the only signal: per
affected login, after the change is live, in a table nobody reads proactively —
and per F3 it also fires on routine passwordless logins, so the signal is not even
clean. The startup gate in `utils/validation/two-factor.ts` refuses only the
deployment-wide worthless configuration; it runs at module load with no database
access and cannot answer "how many users would this remove the last factor from".
There is no script, dry-run flag or documented query for it.

**Fix** A read-only preflight command alongside `scripts/check-password-peppers.ts`
that takes a candidate method and channel set and reports affected user counts and
identifiers by reason, with a per-method breakdown, and blocks rollout when any
2FA-enabled user would be left with no independent usable method. Add it to the
deployment notes. Post-login audit rows are not a migration control.

**Decision** D2 — the preflight script sizes the population that D2's safety half will
now refuse rather than silently downgrade.

---

## F26 — Low — The `hooks`-removal coupling is untested and every drift mode is silent

**Where** `twoFactorAuth()` composes the plugin as
`const { hooks: _pluginSignInHook, ...core } = twoFactor({...})`
(`lib/auth/two-factor.ts:61-76`). That rests on two undocumented properties of
`better-auth@1.7.2`: the auth context's `getPlugin` resolves by `p.id`, so keeping
`id: 'two-factor'` is enough for the plugin's internals to find their options; and
nothing in the plugin except the sign-in hook reads `hooks`.

Neither is asserted anywhere. The two remaining `getPlugin('two-factor')` call
sites in the library are the `trustDeviceMaxAge` lookup — dead here, since
`trustDevice` is forced `false` — and `resolveAccountLockoutConfig`, whose
fallback (`enabled: true`, 10 attempts, 900 s) is identical to what an unset
config produces. So if `getPlugin` stopped resolving, nothing would change
observably, and a second `hooks` entry added upstream would be dropped without a
failing assertion. The existing drift tests cover the cookie name and the two
identifier formats, not this.

**Fix** A version-coupling contract test: instantiate Better Auth's `twoFactor`
plugin and assert the expected `id`, the retained options/schema/endpoints, and
that `hooks.after` has exactly one entry matching the three sign-in paths — the
assertion that turns an upstream addition into a red build. Add a runtime test
with a non-default account-lockout threshold to prove `getPlugin('two-factor')`
resolves the composed plugin rather than silently using defaults.

**Decision** D16 — the version-coupling contract test.

---

## F27 — Low — Comment policy violations, including false invariants

The change adds comments the project standard forbids. Examples, not the
inventory:

- **Section banners** — the change added **five** new ones to `db/schema.ts`
  (Verifications, Two-Factor Credentials, Two-Factor Method Enrollment, Passkeys,
  Trusted Devices; `// ====` lines went 28 → 38). `:617-619` is pre-existing at
  `HEAD` and was cited in error.
- **Change history** — the duplicate in `revokePendingProofs` ("a policy a caller
  can forget is how phone-change once ended up without session revocation").
  `lib/auth/rotation.ts:13-26` is pre-existing at `HEAD` and was cited in error;
  the change appended only the lock-order sentence, which is legitimate.
- **Restatement** of signatures, endpoint paths, schemas and obvious control flow
  throughout `lib/auth/allowed-paths.ts` and the new tests.
- **False invariants**, each of which asserts a property the code does not have:
  - `app/api/auth/forgot-password/reset/handler.ts:113-117` — claims the policy
    read and the password write are atomic (F2);
  - `db/maintenance.ts:79-88` — claims an `expires_at`-leading index verified by
    `EXPLAIN` (F24);
  - `lib/auth/two-factor.ts:136-150` — the TOTP after-hook's catch claims to
    prevent "a user told 2FA is on but holding no intent row"; an `after` hook runs
    after the endpoint committed, so the throw manufactures that exact state (N2);
  - `lib/auth/two-factor-passkey.ts:278-280` — "Stored rather than compared"; the
    stored counter is passed to `verifyAuthenticationResponse`, which does compare
    it (F22);
  - `utils/validation/two-factor.ts:23-26` — "keep `backup_code` enabled in every
    deployment", which the environment list can omit and which F8 makes
    unenrollable anyway.

> **Correction.** The `grantDeviceTrust` quote this finding attributed to
> `lib/auth/trusted-device.ts` does not exist in that file. Removed above and
> replaced with the sixth false invariant (N2), which is real.

**Fix** Sweep all newly changed code. Retain only what the code and types cannot
express — non-local coupling, external constraints, deliberate choices that look
wrong, traps for the next edit — and correct or delete every comment whose claimed
invariant is not enforced. A false invariant is worse than no comment: it is the
reason two reviewers had to re-derive F2, F5 and F24 from the source.

**Decision** D16 — remove the five new banners; report the 14 pre-existing ones
separately rather than sweeping them in the same commit.

---

## F28 — Low — Assorted

- **`listTrustedDevices` sorts oldest-first.** `.orderBy(trustedDevices.lastUsedAt)`
  (`lib/auth/trusted-device.ts:182`) is ascending; a settings list should lead with
  the most recently used device. Use `desc(...)`.
- **`uniquePhone()`** (`tests/helpers/session.ts`) takes the last 8 digits of a
  UUIDv7 and relies on them being unique against `ux_users_phone_number`. That is a
  birthday collision at roughly 10⁴ seeds per table reset, not an impossibility. A
  process-local counter is deterministic.

**Decision** D16 — `desc(...)` on the trusted-device list; deterministic `uniquePhone`.

---

## F29 — Critical — A contact rewrite disarms or repoints the second factor bound to it

**Where** `app/api/dash/users/me/contact-change.ts:127-136` and its phone twin
(the shared boundary for all four self-service contact endpoints — neither
touches `two_factor_methods`); `app/api/dash/users/[id]/handler.ts:633,636` (verified flags forced
`false` on a contact change), `lib/auth/two-factor-challenge.ts:158-165`
(`offeredMethods` gates `otp` on the user row's verified flag), `:210-223` (the
empty-set branch — which kept the first-factor session until step 0 and now
refuses).

The forced `false` is the exploit, not an obstacle. With `users.edit` alone:

1. the victim's only intent row is `method='otp'` — an ordinary state,
   reachable through `verifyForEnrolment` from a session and a verified contact;
2. `PUT /api/dash/users/:id` changes `email` (optionally `password`);
   `emailChanged` forces `emailVerified: false`;
3. `offeredMethods` reads that flag, so the offered set is now empty;
4. sign-in → `issueTwoFactorChallenge` → empty set → `:222` returns `null` →
   **full session, second factor never requested.**

Nothing in `handleAdminEdit` touches `two_factor_methods`,
`two_factor_credentials`, `passkeys` or `users.two_factor_enabled`;
`revokeOtherSessions` is sessions only and `revokePendingProofs` reaches
`verification_sessions` and `trusted_devices`. The only place those four are
cleared is the reset endpoint, which this path never calls. So `users.edit` alone
disarms a second factor — verbatim the invariant
`lib/permissions/constants.ts:60-65` says `resetTwoFactor` exists to prevent.

**Phone variant, no password needed.** Repoint `phoneNumber`, then
`/api/auth/passwordless/send` — its lookup filters `deletedAt` and `isActive` only
and does not require a verified contact — and `/passwordless/verify` calls
`markContactVerified` (`lib/auth/passwordless.ts:204`), so the attacker's number
ends up verified on the victim's row.

Config-reachable rather than live in this checkout (the local
`NEXT_PUBLIC_ENABLED_2FA_METHODS` is empty), gated on a phone channel for the
second variant, and blocked when the victim also holds TOTP, passkey or
acknowledged backup codes. No test covers the interaction.

**Scope: the coupling is not admin-only.** `commitEmailChange` and
`commitPhoneChange` (`app/api/dash/users/me/contact-change.ts:127-136` and the
phone twin) are the shared boundary for all four self-service contact endpoints,
and neither touches `two_factor_methods` either. The original **Where** and
**Tests** named only `PUT` because that is where the finding was found, not
because the self-service path was examined and excluded.

The two paths differ in consequence, which is why the fix splits:

| Path                             | Verified flag after | Offered set       | Consequence                                                                               |
| -------------------------------- | ------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| `PUT /api/dash/users/:id`        | forced `false`      | can become empty  | **Access** — the empty-set branch (property 1).                                           |
| `commitEmailChange` / `...Phone` | set `true`          | unchanged in size | **Persistence** — the factor still works, at a new destination the factor never approved. |

The self-service path costs a session plus the password proof plus an OTP to the
_new_ address, so it is not initial access. It is still an escalation: it converts
"holds the password and a session" into "holds the second factor", permanently,
and at no point is the enrolled second factor proven. A factor's destination must
not be changeable by anything weaker than the factor itself.

**Post-step-0 note. Step 0 closed the empty-set branch, not this finding.** The
refusal stops the login that immediately follows the edit, so `users.edit` no
longer converts straight into a session — it converts into a denial of service
until an operator resets. But the chain does not end there: `markContactVerified`
re-arms the stale intent row once the new address is verified, at the destination
the admin chose. **F29 stays open until property 2 lands.** "Step 0 refuses the
login" is not closure.

**Fix** Two properties.

1. **Fail closed on the empty offered set** (D2 safety half). Every path here
   funnels into that one branch, and enrolment-side fixes cannot close it because a
   third party produces the empty set through a legitimate action. **Step 0, landed.**
2. **A write to a contact column is a write to any factor bound to it.** The OTP
   method's destination is `users.email` / `users.phone_number` with no declared
   coupling. Two sub-fixes, sharing one helper:

   - **2a — admin path.** Invalidate the `otp` intent row for the affected contact
     kind inside the edit transaction, and audit it (F31). **It must not touch
     `two_factor_enabled`**: clearing the flag would let `users.edit` disarm 2FA,
     which is precisely what `lib/permissions/constants.ts:60-65` says
     `resetTwoFactor` exists to prevent, and what D2's safety half forbids.

     _What 2a buys, corrected._ Not the immediate consequence — the admin edit
     already forces the verified flag `false`, so `offeredMethods` drops the OTP
     method on capability alone and step 0 refuses the login. 2a matters for what
     happens **next**: `markContactVerified` (`utils/otp.ts:765`) flips the flag
     back to `true` for any unverified contact, so verifying the new address
     re-arms the stale intent row **at the destination the admin chose**. 2a is
     what stops the factor silently following the address.

     _Blocking dependency is D5, not D8._ For an OTP-only user, deleting the last
     intent row leaves the offered set empty and step 0 still refuses — trading a
     recoverable-but-unsafe state (they could re-verify) for an
     unrecoverable-but-safe one (operator reset only). Safe to land only once every
     2FA user is guaranteed a contact-independent factor, which is D5 in step 2.
     D8's generated `contact_kind` only makes the predicate exact and does not gate
     it. Lands with the notification from D3/F31 rather than silently.

   - **2b — self-service path.** Prove the second factor before committing a
     contact change that a factor is bound to. Needs a proof reusable outside
     sign-in, which is the same mechanism D4's recovery grant and D7's companion
     record build, so it follows them.

3. **Refuse a contact change that would leave the target with no usable factor**,
   naming `resetTwoFactor` as the route. **Admin path only.** Depends on nothing
   from D5 or D8, and it is what makes step 0's new failure mode legible: an
   explicit refusal at the moment of the action instead of a silent lockout the
   victim discovers at their next login.

   The consistency argument is the deciding one. `/two-factor/methods/disable`
   already refuses to remove a user's last method (F6); an edit must not be a way
   around the same rule, and the refusal pushes the operator onto the permission
   that exists for disarming 2FA rather than achieving it as a side effect of
   `users.edit`. An operator who genuinely needs the change resets first, audited
   and permission-gated. Deliberately **not** applied to the self-service path: the
   actor there is the account owner, the refusal would be harsher, and 2b's answer
   (prove the factor) is the right one.

   _Prerequisite._ The check reads enrolment inside the edit transaction, and
   `readEnrollment` is `db`-only (`lib/auth/two-factor-challenge.ts:86`). Reading
   through the module-level pool from inside a transaction is F2's nested-acquire
   trap, so `readEnrollment` must take an optional `tx` first — which closes F2's
   liveness half as a side effect.

   _Accepted disclosure, not mitigated._ `two_factor_enabled` is exposed on no
   dash read (`grep` across `app/api/dash/` outside the two-factor endpoint returns
   nothing), so this refusal is the first place an admin learns a target's 2FA
   state. Wording the message around the action does not remove the signal — the
   refusal is conditional on that state, so it leaks by occurring at all. Accepted
   because the actor holds `users.edit` on the target and plausibly
   `resetTwoFactor` too, which puts the disclosure inside their scope. Phrase the
   message around the action anyway, for legibility rather than as a control.

   The invalidation belongs in `lib/auth/rotation.ts` beside `revokePendingProofs`
   — the repo's declared single rotation policy, already called from both
   boundaries — not inlined in either handler. A fix landing only in the admin
   handler would leave the shared self-service boundary untouched.

   **Accepted interim exposure.** 2a lands in step 2 and 2b in step 5, so between
   them the self-service repoint stays open: a holder of a session and the password
   can move an enrolled OTP factor to a contact they control without ever proving
   that factor. Accepted rather than merely sequenced — 2b is persistence, not
   initial access, and its correct fix is downstream of D4 and D7, so pulling it
   forward would mean building a weaker proof mechanism twice and throwing one
   away. Recorded so the window is a decision rather than an artefact of ordering.

   This does not contradict D11's "never reset 2FA on a password change": the
   destination changing under a factor is a different event from a credential
   rotation.

**Decision** D2, D12. Placement of properties 2a, 2b and 3 in the order table.

**Tests** The four-step chain end to end through `PUT` and `/sign-in/email`; the
phone variant through `/passwordless/*`; the self-service variant through
`change-email/verify` asserting the enrolled `otp` method does not silently follow
the address; and the negative case — the same edit against a victim who also holds
TOTP still yields a challenge.

---

## F30 — High — The administrative 2FA reset skips the role-scope check its siblings apply

**Where** `app/api/dash/users/[id]/two-factor/handler.ts` calls
`assertTargetUserVisible` and never `validateRolePermissionScope`;
`resetTwoFactor` is absent from `OWN_ACTION_MAP` and therefore from
`SCOPED_ACTIONS` (`lib/permissions/checker.ts:27`), so `resolveActionScope`
returns `{ allowed: true, scope: 'all' }` unconditionally.

`assertTargetUserVisible` checks three things: the target has a role, the role is
not a protected system role, and — only when `scope === 'own'` — that the actor
created the target. Since the scope is always `'all'` for this action, the third
check never fires, leaving the protected-system-role test as the only guard.

Every sibling under `/api/dash/users/:id` calls `validateRolePermissionScope`:
the parent `PUT`/`DELETE`, the sessions endpoints, and `target-user.ts`'s own
`actorCoversTargetRole`. So a `users.resetTwoFactor` holder can wipe 2FA on a user
whose role holds every permission the actor lacks, while `PUT` on that same id
answers them 404. The two endpoints disagree about who is reachable and the weaker
check sits on the more dangerous action — which `target-user.ts:19-31` explicitly
says must not happen ("A subresource must never be reachable when its parent is
not").

**Fix** Call `validateRolePermissionScope` in the reset handler with the actor's
permissions and the target's role id, as the siblings do. Decide separately
whether `resetTwoFactor` gains an `Own` variant; if not, document that `scope` is
always `'all'` for it so the absent `createdBy` narrowing is a stated choice rather
than an oversight.

**Tests** An actor holding `users.resetTwoFactor` but not the target role's
permissions is refused, and the refusal matches `PUT`'s 404 on the same id.

---

## F31 — Medium — The downgrade has no attributable audit trail

**Where** `app/api/dash/users/[id]/handler.ts:720-756` (the admin edit's audit
row), `lib/auth/rotation.ts` (`revokeTwoFactorState` writes none),
`lib/auth/two-factor-challenge.ts:210-223` (`recordChallengeEvent`).

The admin edit writes one `users` row carrying both sides of the contact change
and `passwordChanged: true` — enough to reconstruct the credential rewrite, and
correctly attributed (`userId: actor.userId`, `recordId: target`). It carries **no
2FA state at all**, and `revokeTwoFactorState` writes no row of its own.

The only trace of the resulting downgrade is written later, under the **victim's**
user id, in a `sessions` row, best-effort and swallowed on failure, carrying the
same `reason` string that fires on every routine login by an affected user (F3,
F25). Detecting F29 therefore means manually joining two audit rows across two
different `user_id` values with no field linking them.

**Fix** An explicit audit event on the downgrade itself, recording the actor who
caused it and the method set that became unavailable, distinct from the routine
`twoFactorDowngraded` reason string. Once F29's second property lands, the
invalidation of a dependent method is the natural place to write it — inside the
edit transaction, attributed to the admin. Give `revokeTwoFactorState` an event
too, so trusted-device revocation is visible.

**Decision** D2, D12.

---

## N1 — High — Password-free OTP enrolment converts into a permanent recovery lock

**Where** `lib/auth/two-factor-otp.ts:314-320` — `/two-factor/otp/verify` in
enrolment mode authenticates through `sessionUser(ctx)` alone, has no
`sessionMiddleware`, and is absent from `PASSWORD_PROOF_PATHS`.

A session holder can _add_ a second factor with no password. Against a victim with
no other intent row, an attacker enrols `otp` on the channel account recovery uses;
thereafter `recoveryDefeatsTwoFactor(userId,'email')` returns `true` and
`/api/auth/forgot-password/reset` answers 403 forever. Escapable only through
`/two-factor/disable`, which requires the password — which is by definition what
the user reaching for recovery does not have.

**Fix** Add the enrolment paths to `PASSWORD_PROOF_PATHS`. D4 removes the
permanence independently by replacing the refusal with a proof.

**Decision** D4.

---

## N2 — High — The TOTP enrolment hook's compensation cannot work

**Where** `lib/auth/two-factor.ts:136-150`.

The hook catches its transaction failure and throws
`APIError('INTERNAL_SERVER_ERROR')` under a comment claiming this prevents "a user
told 2FA is on but holding no intent row". An `after` hook runs after the endpoint
returned, so the plugin has already committed `verified: true` and
`twoFactorEnabled: true`. The throw therefore manufactures exactly the state the
comment says it prevents, and every later login takes F3's downgrade branch.

**Fix** Subsumed by D6 — an owned enable routine writes the flag, the credential
and the intent row in one transaction, so there is nothing to compensate. Until
then the hook must not throw; it must retry or record a repairable state.

**Decision** D6. Also the sixth false invariant for F27.

---

## N3 — Medium — `send` and `verify` use different mode discriminators

**Where** `/two-factor/otp/send:162` branches on `readChallengeCookie` (cookie
present and signature-valid); `/two-factor/otp/verify:214` branches on
`resolveTwoFactorChallenge` (cookie **and** a live row **and** an active user).

For up to `TWO_FACTOR_CHALLENGE_MAX_AGE_S` seconds after an abandoned prompt, a
stale signed cookie sends `send` down `signInTarget`, which resolves nothing and
throws 401 at a caller holding a valid session — while `verify` in the same window
correctly takes the enrolment branch.

**Fix** One discriminator for both, resolved once. Belongs with F15's "dual-mode
endpoints need one discriminator".

---

## N4 — Medium — The enrolment-time overlap refusal has no implementation

**Where** `utils/validation/two-factor.ts:117-129` is a _startup_ refusal for the
single degenerate deployment; `recoveryDefeatsTwoFactor` is a _recovery-time_
refusal. `twoFactorOtpEnrollSchema` validates only that the channel is in
`NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS` and never compares against
`NEXT_PUBLIC_ENABLED_OTP_CHANNELS`.

**Fix** D1 makes the refusal unnecessary — the property moved to the path. What
remains is the enrolment **warning** on actual overlap (D4's message rules).

**Decision** D1, D4.

---

## N5 — Low — A user cannot enrol two OTP channels

**Where** `ux_two_factor_methods_user_method` is `(user_id, method)` and `channel`
is a single column, so `otp` is one row with one channel.

**Fix** D8's partial-index shape.

**Decision** D8 — accepted, with the generated column proved by running the
migration.

---

## N6 — Low — `@better-auth/core` in `dependencies` for a type-only import

**Where** `package.json`; the only import is
`import type { GenericEndpointContext }` (`lib/auth/two-factor-challenge.ts:18`),
while `node_modules/better-auth/package.json:476` pins `"@better-auth/core":
"1.7.2"` exactly. A caret at the top level drifts ahead on the next install and
produces two copies — type-level damage only, caught by `tsc`.

**Fix** Pin `"1.7.2"` exactly and move to `devDependencies`. `two-factor-plan.md:36-38`
has the rationale backwards.

**Decision** D16.

---

<a id="contradictions-resolved"></a>
