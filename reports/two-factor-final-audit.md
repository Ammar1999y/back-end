# Two-Factor Implementation — Final Consolidated Audit

> **Status, 2026-09-03 — read before the findings.** Two repair passes have run
> against this document (`two-factor-repair-log.md`, then
> `two-factor-repair-review.md`, itself checked by
> `two-factor-final-verification.md`). Every finding below is **closed** except
> the items those reports record as open: `D11`'s notification on a voluntary
> password change, passkey as a recovery second factor, an end-to-end passkey
> assertion test, and the 14 pre-existing `db/schema.ts` banners. §2's settled
> policy still governs. **The `Where:` and `Evidence:` lines describe the tree as
> it was before the repairs**, and much of what they cite no longer exists — the
> TOTP after-hook, `newestSessionId`, `sessionUser`, `signInTarget`'s `otpTarget`,
> `contactChangeStrandsTwoFactor(userId, kind)`, `offeredMethods(...):
TwoFactorMethod[]`, the plugin's `enable`/`disable`/`generate-backup-codes`/
> `delete-passkey` endpoints on the router. For the current code, read
> `two-factor-repair-review.md` §2, §3 and §8; for the file that owns each
> transition today, start at `lib/auth/two-factor-enrolment.ts` and
> `lib/auth/two-factor-challenge.ts`.

## 1. Scope, sources and method

**This file is the plan of record. It is self-contained — implement from it.**

Read §2's **Settled policy** before any finding. Several findings are shaped by a
decision rather than derived from the code, and implementing one against the wrong
policy is the failure this document exists to prevent.

Everything consolidated here is archived under `reports/archive/two-factor/`: the
original plan, two source reviews, the tracking document that carried the
`F`/`N`/`D` identifiers, and three independent check logs (**L1**, **L2**, **L3**,
cited below only for provenance). All of them are superseded and several were wrong
in places that were corrected here. **Do not implement from them.**

One live reference remains: `reports/two-factor-verification.md`, which holds the
reasoning behind the decisions and the library-source comparisons. Its §5.4.1
recommendation — option "B", conditional admission at enrolment — was **rejected**;
see `D1`. Read that file for _why_, never for _what_.

Baseline: working tree against `HEAD` = `origin/main` = `25c7d4f`, 31 tracked files
modified, ~31 untracked. Library claims resolved against the installed, locked
`better-auth@1.7.2`, `@better-auth/core@1.7.2`, `@better-auth/passkey@1.7.2`,
`@simplewebauthn/server@13.3.3`.

`F1`–`F31` and `N1`–`N6` were the tracking document's findings, `D1`–`D16` its
decisions, `C1`–`C10` L3's additions. Every one is accounted for: against a finding
below, in §2's policy, or in §6 or §8.

This report is a superset of the three logs, deduplicated by root cause.
Findings are grouped by remediation, not by source id, so one finding may carry
several ids. Severity is calibrated to realistic impact, reachability and blast
radius — not to the worst imaginable outcome.

Where the logs disagreed on fact, severity or remediation I resolved it against
the code rather than by majority; each resolution is recorded in §5 with its
evidence. Items documented in `reports/should-ignore.md` are excluded; the one
finding that sits close to an accepted entry says so explicitly.

Items landed and confirmed correct by every log (`F5`, `F17`, `F28`, `N3` for the
two OTP endpoints, and the landed halves of `F2`, `F3`, `F12`, `F29`, `F30`) are
not repeated as findings.

## 2. Verdict

**Not ready to merge.** The design is sound and the landed half is real: a
second-factor challenge that withdraws the first-factor session, direct passkey
sign-in left unrouted, passkey assertions bound to the challenged user and
user-verifying, a one-use password proof replacing the `password.verify` stub,
and substantial schema and test infrastructure.

What blocks merge is that enforcement is not yet unconditional and the state
transitions it depends on are still the library's:

1. An empty global method list removes the issuer hook itself, and the three
   first-factor paths then disagree about the same account (**H1**).
2. The offered set is computed from a method list while the configuration is
   channel-granular, so the control separating recovery from the second factor
   can be silently defeated by configuration (**H2**).
3. Recovery proves only the recovery code, and its predicate answers the wrong
   question in both directions (**H3**).
4. A challenge does not persist what was offered at issuance (**H4**).
5. Enrolment, removal and disable remain the library's, so no invariant this
   deployment adds is atomic with them (**H5**).

Three repairs the tracking document records as landed are not landed as
described: registration user verification (**M1**), the attempt-budget restore
branch (**M6**), and the passkey counter compare-and-swap (**M7**). Each is
protected by a green test that does not assert the claimed behaviour (**M17**).

### Premise

The original brief asked whether adding a passkey alongside password login
weakens the account. One of the three logs answered it; the answer is the premise
the rest of this report stands on, so it is recorded here rather than left to be
lost with the logs.

Adding a passkey while password login stays enabled does **not** make the existing
password credential weaker. It adds a parallel authentication route, and the
account's effective resistance remains that of its weakest permitted route.
Neither does it turn password login into two-factor authentication. For the
password-then-passkey policy this project wants, two things must hold: direct
passkey sign-in must remain unrouted, and a user-verifying WebAuthn assertion must
be bound to the password challenge. The current design does both in principle —
the plugin's own `signIn.passkey` is a direct sign-in route and is never
allow-listed, and `lib/auth/two-factor-passkey.ts` binds the assertion to the
challenged user and requires user verification. That is what makes **M1** the one
half of the policy not enforced on the server, rather than a detail.

- Better Auth passkey plugin — `signIn.passkey` is a direct sign-in route, not
  this policy: <https://better-auth.com/docs/plugins/passkey>
- SimpleWebAuthn — an MFA policy requires `userVerification: 'required'` in
  creation options **and** `requireUserVerification: true` at registration
  verification: <https://simplewebauthn.dev/docs/advanced/passkeys>
- WebAuthn Level 3 — the relying party must verify the signed UV flag when user
  verification is required: <https://www.w3.org/TR/webauthn-3/>

### Settled policy

Settled by the project owner. These are decisions, not derivations — the code
cannot tell you whether they are right, and a finding implemented against the wrong
one is worse than one left open. Where a finding's fix is shaped by a decision it
names it.

**P0 — Nothing about a user's own second factor is mandatory.** Every method is the
user's choice: what to enrol, what to keep, whether to hold recovery material. The
system may warn, and must never compel or silently decide. This governs `D2`, `D3`
and `F9`, and it retires the "mandatory backup codes" decision the tracking document
carried as `D5` — see below.

**D1 — Recovery: no single possession may satisfy both the recovery proof and the
second-factor proof in one authentication chain.** A property of the _path_, not of
the enrolled set. Enrolment-time refusal and conditional admission at enrolment were
both considered and **rejected**: neither closes the attack, because the offered set
is decided at method selection, not at enrolment. Unconditional — never gated on
whether the current environment lists overlapping channels. Granularity is contact
kind, so `email`+`whatsapp` is disjoint and `sms`+`whatsapp` is not.

**D2 — The empty offered set has two properties.**

- _Safety:_ an empty offered set never grants access. Fail closed.
- _Liveness:_ every empty state has an exit that does not require the credential the
  user lost. Under **P0** that exit is the **operator reset** — which is therefore
  load-bearing and must be reachable in every configuration (**H1**).

Two exceptions existed in the code and both are resolved as defects, not as
amendments to this decision: device trust consumed before the set is computed
(**M5** — fix the ordering) and the issuer hook absent under an empty method list
(**H1** — see its policy below).

**D3 — Exhaustion is bounded, not prevented.** A consumable factor cannot guarantee
a non-empty set, and forcing regeneration **inside a login** is the wrong placement —
it demands compliance at the moment users are least able to give it. The mechanism
is a **low-water warning in an authenticated session**, never a blocking step, with
the operator reset as the named exit. The terminal population is wider than
"OTP-only, codes spent": stale or deleted capability, method-list changes (**H1**,
**M12**) and channel-list changes (**H2**) produce the same unusable state, and the
physical loss of an authenticator is not visible in the intersection at all.

**D4 — Recovery proves a second factor _during_ the reset, before the password
write, excluding the recovery contact kind.** Deferring to the next sign-in buys
nothing and still lets a mailbox holder rewrite the password. The proof must not run
inside `processOtpVerify`'s transaction: the OTP verify commits a short-lived
**recovery grant**, and the second-factor proof plus the password write happen
against that grant in a later request. Grant constraints: single-use; short-lived;
bound to the user **and** the excluded contact kind; not sufficient alone —
possession of the grant plus nothing else must fail; invalidated if the enrolled
method set changes between the two requests; its own send quota (**M9**'s territory,
widened by the two-request shape); and the recovery challenge does **not** honour
trusted devices.

Messages: no enrolment refusal; an enrolment _warning_ only on actual overlap; the
reset prompt for every 2FA user, and text explaining an excluded method only when
one was excluded.

**~~D5~~ — withdrawn.** The tracking document made backup codes mandatory at enable.
**P0** retires it: nothing is mandatory. `F9`'s real defects stand and are unchanged
by this — acknowledgement is not bound to a generated set, is never cleared on
regeneration, and capability never counts unused codes, so an exhausted set stays
advertised as recovery material. Fix those; do not add a compulsion.

**D6 — Own the enable/disable/removal lifecycle** (**H5**), including backup-code
generation. The plugin's `/two-factor/enable` cannot enrol anything but TOTP in this
configuration and its `/two-factor/disable` cannot clean up state it does not know
about, so `D2`'s named exit otherwise returns the user to enabled-with-nothing.

**D7 — `F1`'s remedy is the companion challenge record** (**H4**), plus a
`before`-hook check on the two plugin verify paths so an unoffered method cannot
complete. Both plugin verifiers are single-method, so the path→method map is static
and total. Three constraints: store exact option identities, never method names
(**M15**); current capability may narrow the issued set and never widen it; and
apply the check in sign-in mode only, using **the library's own discriminator** —
a resolved session, not the presence of a challenge cookie (**M2**), or the hook
guards the wrong branch. Create and clean the record atomically with its challenge.

**D8 — Two OTP channels per user are supported.** `two_factor_methods` uniqueness
moves off `(user_id, method)`: partial unique on `(user_id, contact_kind) WHERE
method = 'otp'`, partial unique on `(user_id, method) WHERE method <> 'otp'`.
`contact_kind` is a generated column; `channel` survives as the phone row's delivery
preference. Precedent is `ux_verification_sessions_user_contact_purpose`. Prove the
generated column and the partial conflict targets by **applying** the migration, not
by reading SQL. Every uniqueness consumer moves with it — `recordMethodIntent`'s
`ON CONFLICT` target, method-only disable, and the offered-option type (**M15**).

**D9 — Ordering and routing.** System priority `passkey > totp > otp > backup_code`,
`backup_code` excluded from auto-routing so a routine login never spends recovery
material. User-configurable default via `is_default` with a partial unique index on
`(user_id) WHERE is_default`, constrained to reorder only _within_ the immutable
issued set and to fall back to system priority without ever producing the empty-set
branch. Auto-send for an `otp` default at most once per challenge. The challenge
response carries the ordered set, an explicit `defaultMethod` and per-method hints
(`otp.nextAllowedIn`). The client feature-detects before auto-routing to passkey.

**D10 — `rememberMe`:** persist the submitted choice in the companion record, pass
it into session creation, set the cookie consistently, clear the legacy marker on
every completion and cancellation, and add `rememberMe` to `loginSchema` so the
field is validated and published. A config flag decides whether the submitted value
is honoured; default to honouring it.

**D11 — Rotation policy, by event.** Voluntary password change: revoke sessions,
notify about trusted devices, do **not** revoke them. Recovery reset: revoke trusted
devices. Never reset 2FA methods on either. Adding or confirming a method: revoke
other sessions, carrying the caller's own session id (`F10`) or revoking all and
re-issuing. Removing a method or changing an OTP channel: revoke trusted devices,
keep sessions, require a password proof. Capability loss (an env-list change, a
deleted last credential) revokes trusted devices too — **M5**.

**D12 — Administrative re-authentication is a class, not an endpoint.** Either every
admin action that lowers another account's security posture sits behind a re-auth
boundary, or none does. The class is `PUT /api/dash/users/:id` (password, email,
phone, `isActive`, `roleId`, permissions), `DELETE /api/dash/users/:id`, the
administrative 2FA reset, and role/permission mutation one level up. The proof is
valid for a **short window**, not per-request — a per-request prompt on every row of
a batch is what gets the control disabled. The self-target case is in scope
(**M10**).

**D13 — Passwordless sign-in fails closed** when no independent factor remains,
routing the user to the password route rather than telling them to contact support.
Independent of `D14`.

**D14 — Passwordless is separately switchable**, server-side, without disabling any
other OTP surface. Both entry points gated; a disabled surface answers 404, matching
how disabled 2FA methods behave. Deployment note required.

**D15 — Test transport for unprovisioned channels.** A test can exercise any channel
end to end and assert what would have been delivered, without a provider account.
The plaintext code must not reach the logs. The integration tier runs the app
in-process, so an in-process outbox is viable. Impossible to run in production,
refused at startup. `F19` lands here. Deployment note required.

**D16 — Accepted proposals with no mechanism attached.** `two_factor_credentials.verified`
defaults to `false`; `@better-auth/core` pinned to `1.7.2` and moved to
`devDependencies` (**L4**); the `SERVER_ONLY_VIRTUAL_PATH` exemption narrowed to a
named set; the five new `db/schema.ts` banners removed and the 14 pre-existing ones
reported separately (**L3**); keep passkey; copy the library's `beginAttempt`
protocol and `valid()`'s remember-me handling verbatim; `userVerification: 'required'`
at registration plus our own assertion gate (**M1**); drive the configuration matrix
through real endpoints (**M18**).

**The pepper compare-and-swap (`M19`) is settled separately: log and accept the 401.** Re-reading the row and trusting the stored hash is an authentication bypass —
the concurrent writer may have been a password _change_, and accepting that hash
lets the old password mint a session. Verifying the re-read hash against the
plaintext still in scope would be correct but is not worth the complexity for a race
this narrow. **Log it and let the 401 stand.** Do not "fix" it any other way.

---

## 3. Findings

### High

#### H1 — An empty global method list removes enforcement, and the first-factor paths then disagree

- **Refs:** `C1`, `F3`, `D2`, `D13`
- **Status:** open, in no step of the order of work
- **Where:** `lib/auth/two-factor.ts:175-199` (`twoFactorPlugins`),
  `lib/auth/two-factor.ts:80-107` (the `/sign-in/email` after-hook),
  `lib/auth/passwordless.ts:277`,
  `app/api/dash/users/[id]/two-factor/handler.ts:44-45`,
  `utils/validation/two-factor.ts:65,91-98`
- **Evidence:** verified for this report. `TWO_FACTOR_ENABLED =
ENABLED_TWO_FACTOR_METHODS.length > 0`, and `twoFactorPlugins` is `[]` when it
  is false. The `/sign-in/email` after-hook that calls `issueTwoFactorChallenge`
  lives inside `twoFactorAuth()`, so it disappears with the plugin list.
  `lib/auth/passwordless.ts` calls the issuer directly and is not gated on
  `TWO_FACTOR_ENABLED`. The administrative reset returns 404 under
  `if (!TWO_FACTOR_ENABLED)`. The startup log at
  `utils/validation/two-factor.ts:91-98` announces only that "every two-factor
  and passkey surface answers 404"; it does not say enforcement stops.
- **Failure scenario:** an operator empties `NEXT_PUBLIC_ENABLED_2FA_METHODS`
  (rolling the feature back, or narrowing it during an incident) while accounts
  hold `two_factor_enabled = true` and intent rows. For the same account:
  `/sign-in/email` mints a full session with the password alone and writes no
  refusal; `/passwordless/verify` computes an empty offered set and answers 403
  `TWO_FACTOR_UNAVAILABLE`; password recovery still refuses, because the landed
  predicate keys on surviving intent rows (**H3**); and the operator reset — the
  documented way out — answers 404. One configuration change silently downgrades
  one population, locks out another, and removes the named recovery exit.
- **Fix:** make the empty-list case one decision in one place. Install the issuer
  hook unconditionally and let `issueTwoFactorChallenge` distinguish _feature
  off_ from _this user has no usable method_, gating only the `/two-factor/*` and
  `/passkey/*` surfaces on the method list. **The policy is settled, so do not
  choose:** _feature off_ (the method list is empty) downgrades consistently on
  every first-factor path — with the list empty there is no second factor to
  enforce, so `D1`'s invariant is vacuous and a downgrade is the operator's intent;
  _empty for this user_ (the list is non-empty but nothing survives the
  intersection) refuses, per `D2`'s safety half. What is not permitted is today's
  state, where the two questions are answered by different paths for the same
  account. The operator reset must stay reachable whenever stored 2FA state exists,
  so it cannot be gated on `TWO_FACTOR_ENABLED` — under `D2`'s liveness half it is
  the only exit. The preflight of **M12** must count accounts with stored state
  before an empty list is allowed to ship.
- **Test:** the configuration matrix of **M18**, with the empty-list row
  asserting that all three paths and the reset agree for an account holding
  stored 2FA state.
- **Severity note:** L3 rated this Critical. Downgraded to High: it is not
  attacker-reachable — it needs an operator configuration change — and for the
  password path the downgrade is arguably the operator's intent. The blast radius
  (every enrolled account) and the loss of the recovery exit keep it High.

#### H2 — The offered set is computed from the method list and never intersects the enabled OTP channel list

- **Refs:** L1 "outside the document" 1, L2 "outside the document" 1; interacts
  with `F25`, `D8`
- **Status:** open, untracked by any finding id
- **Where:** `lib/auth/two-factor-challenge.ts` (`offeredMethods`, `case 'otp'`),
  `utils/validation/two-factor.ts` (`isTwoFactorOtpChannelEnabled`,
  `twoFactorOtpEnrollSchema:154-158`), `utils/otp.ts` (`processOtpSend`)
- **Evidence:** `isTwoFactorOtpChannelEnabled` has exactly one consumer,
  `twoFactorOtpEnrollSchema`. `offeredMethods` gates `otp` on
  `ENABLED_TWO_FACTOR_METHODS.includes('otp')`, the row having a `channel`, the
  contact-kind exclusion and the verified flag —
  `NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS` is not a term. `processOtpSend` has no
  channel gate either. The "server-enabled" half of the intersection is
  method-granular while the configuration it enforces is channel-granular.
- **Failure scenario:** three, all reachable by configuration alone.
  (a) An operator removes `email` from `NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS`
  _because email is the recovery channel_ — the stated reason that variable is
  separate from `OTP_CHANNELS` — and every already-enrolled user keeps being
  offered email OTP. The overlap the variable exists to prevent stays live for
  exactly the population that has it, defeating `D1` by configuration.
  (b) `PHONE_ENABLED` off leaves `otp/sms` rows offered and routed into
  `processOtpSend` on a channel the deployment no longer supports.
  (c) In production the credential gate requires provider variables only for
  _enabled_ channels, so a removed channel's offered method is a challenge the
  user can never complete — and because the offered set is non-empty, **H1**'s
  refusal never fires and the user is simply stuck.
- **Fix:** add the channel term to the `case 'otp'` branch of `offeredMethods` —
  one condition — and route `processOtpSend` on the same predicate for
  `surface: 'two_factor'`. Same class as the method-list preflight, so **M12**'s
  preflight must count this cause too, and the fix has to be carried through
  `D8`'s two-row model.
- **Test:** `tests/integration/two-factor-management.test.ts` enrols `otp/email`
  by SQL under an `sms`-only 2FA channel configuration, and its recovery-refusal
  case passes _only because of this defect_ — fix the fixture with the code, or
  the suite pins the bug.

#### H3 — The recovery predicate answers the wrong question in both directions

- **Refs:** `F2`, `D1`, `D4`
- **Status:** liveness half landed and correct; both proof halves open (step 4)
- **Where:** `app/api/auth/forgot-password/reset/handler.ts:114-118`,
  `lib/auth/two-factor-challenge.ts` (`recoveryDefeatsTwoFactor`,
  `readEnrollment`)
- **Evidence:** landed and correct — `readEnrollment` takes
  `executor: Tx | typeof db = db`, both in-transaction callers pass `tx`
  (`forgot-password/reset/handler.ts:114-118`,
  `app/api/dash/users/[id]/handler.ts:634`), `issueTwoFactorChallenge` and
  `resolveTwoFactorChallenge` correctly keep the pool default, and no other
  reachable `readEnrollment` call sits inside a transaction. What the predicate
  does with the state it reads is wrong in two directions:
  - **Mode A (security).** It returns `false` as soon as a factor survives the
    contact-kind exclusion, and nothing then proves that factor. A user with TOTP
    plus `otp/email` resets the password with an email code only.
  - **Mode B (availability).** The landed short-circuit is
    `state.intent.length === 0`, not `offeredMethods(state).length === 0`. The
    case `F2` actually names — intent rows survive while capability is gone (last
    passkey deleted, method dropped from the env list, credential row cleared by
    the library's `/two-factor/disable`) — still returns `true` and refuses
    recovery permanently.
- **Failure scenario:** mode A — an attacker holding the victim's mailbox changes
  the password without touching the TOTP secret, and the reset revokes the
  victim's sessions, so the attacker gets the account and the owner gets a
  lockout. Mode B — a user whose only passkey was deleted can neither sign in
  (empty offered set, 403) nor recover (refused), and under an empty method list
  cannot be reset either (**H1**).
- **Fix:** mode B is a one-line change that depends on neither `D4` nor step 4 —
  swap the short-circuit for `offeredMethods(state).length === 0`, and land it
  now; all three logs reached that conclusion independently. Mode A needs `D4`'s
  recovery grant: short-lived, one-use, bound to the method-set version and the
  contact kind, independent of trusted devices, consumed before the password
  write, issuing no session.
- **Also open:** the row lock `F2` asked for (`users` / `two_factor_methods` in
  canonical order) is absent, so the decision can still be taken against a
  snapshot a concurrent enrolment change has superseded. The exposure is narrower
  than it looks, and step 4 should have the list: `processOtpVerify` already locks
  the user row `FOR UPDATE` before the read, so the only writers that can move the
  state under the decision are the three that do not take that lock —
  `/two-factor/methods/disable` (`F6`), the TOTP intent after-hook (`N2`) and
  backup-code acknowledgement. That is the set the lock has to cover, and **H5**
  is rewriting all three. The generic form of the race is accepted in
  `should-ignore.md` #54 and known-issue 1; this finding asked for the lock
  explicitly, so either land it or record the deviation.

#### H4 — A challenge does not persist what was offered at issuance

- **Refs:** `F1`, `D7`, `C9`
- **Status:** open (step 3)
- **Where:** `lib/auth/two-factor-challenge.ts` (`issueTwoFactorChallenge`,
  `resolveTwoFactorChallenge`),
  `node_modules/better-auth/dist/plugins/two-factor/totp/index.mjs:172-224`,
  `.../backup-codes/index.mjs:187-233`
- **Evidence:** the challenge row holds only the user id.
  `resolveTwoFactorChallenge` recomputes `offeredMethods(state)` with no
  `excludeContactKind`, so the issuance-time exclusion is dropped at
  verification. The library's TOTP and backup-code verifiers resolve their
  credential row and never read `two_factor_methods` or any offered set, so they
  sit outside the check entirely; `TRUST_DEVICE_STRIPPED_PATHS` only rewrites two
  body fields.
- **Failure scenario:** a passwordless login proves the email contact; the
  challenge excludes email OTP at issuance; the caller then verifies through a
  path that recomputes the set without the exclusion — or through the library's
  verifiers, which consult no set at all — and satisfies the "second" factor with
  the contact the first factor already proved. Separately, a capability appearing
  between issuance and verification widens the set the user was challenged on.
- **Fix:** `D7`'s companion record, written and cleaned atomically with the
  challenge, holding the exact option identities (per `C9`/**M15**, not method
  names), the purpose, the first factor, the exclusion and the remember choice.
  Current capability may narrow the issued set, never widen it. Apply the check in
  sign-in mode only — and read **M2** before choosing the discriminator, or the
  hook guards the wrong branch.

#### H5 — The enrolment, removal and disable lifecycle is not owned

- **Refs:** `F4`, `F6`, `F7`, `F8`, `F9`, `F10`, `N1`, `N2`, `D6`
- **Status:** open (steps 2 and 5)
- **Root cause:** every invariant this deployment adds — method intent,
  capability, backup-code acknowledgement, session rotation, trust revocation —
  lives outside the library transitions that produce the state it depends on. No
  compensation after the fact makes them atomic, so the class needs `D6`'s single
  owned lifecycle rather than eight separate patches.

| Sub   | Defect                                                                                                                                                                                                                                                                  | Evidence                                                                            | Impact                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `N2`  | The TOTP intent after-hook throws `INTERNAL_SERVER_ERROR` _after_ the plugin committed `verified: true` and, on a first enable, `twoFactorEnabled: true`                                                                                                                | `lib/auth/two-factor.ts:150-166`                                                    | The throw manufactures exactly the state its comment claims to prevent: 2FA on with no intent row. Post-refusal that user's next `/sign-in/email` is a hard 403 needing an operator reset. **One failed database write is a route to a locked-out account — pull this forward**                                                                                                                        |
| `F4`  | No writer of `method: 'passkey'` anywhere; `/passkey/generate-register-options` and `/passkey/verify-registration` are allow-listed and in `LIVE_SESSION_PATHS` but not `PASSWORD_PROOF_PATHS`, protected only by `freshSessionMiddleware` against `freshAge: 60*60*10` | `lib/auth/two-factor.ts`, `lib/auth.ts`                                             | A registered passkey is never a usable factor, and a ten-hour-old session adds one with no proof. Do **not** put the body-password guard on the plugin's GET options route; mint a one-use, user- and ceremony-bound enrolment grant from a POST re-authentication step                                                                                                                                |
| `F6`  | `/two-factor/methods/disable` reads `listEnrolledMethods` through the pool _outside_ the transaction that deletes, deletes intent only, has no password proof, identifies no OTP channel, revokes neither capability nor trust                                          | `lib/auth/two-factor-otp.ts`                                                        | Two concurrent removals both see two methods and both delete; a hijacked session removes factors with no proof                                                                                                                                                                                                                                                                                         |
| `F7`  | The library's `/two-factor/disable` is allow-listed and touches only the flag, the credential row, the caller's session and the plugin's trust cookie; `resolveTwoFactorChallenge` never reads `state.enabled`                                                          | `node_modules/better-auth/.../two-factor/index.mjs:206-239`                         | A live challenge outlives a disable; intent rows, passkeys and other devices' trust rows survive it                                                                                                                                                                                                                                                                                                    |
| `F8`  | `enableTwoFactor` throws `OTP_NOT_CONFIGURED` / `TOTP_NOT_CONFIGURED` against this deployment's `otpOptions: undefined` and `totpOptions.disable`; `/two-factor/enable`, `/two-factor/disable` and `/two-factor/backup-codes/acknowledge` are pushed unconditionally    | `.../two-factor/index.mjs:114-115`, `lib/auth/two-factor.ts` (`twoFactorEndpoints`) | Supported backup-only and passkey-only configurations have no valid first-enable route; the contract publishes a 200 on an endpoint that can only 400, and serves acknowledgement with `backup_code` disabled                                                                                                                                                                                          |
| `F9`  | A repeat enable replaces `secret` and `backupCodes` while computing `verified` as `existing != null && existing.verified === true \|\| …`; `backupCodesReady` is `acknowledgedAt != null` with no set identity and no unused-code count                                 | `.../two-factor/index.mjs:130-166`                                                  | A verified authenticator is silently replaced; acknowledgement is never cleared on regeneration, so an exhausted set stays advertised as recovery material                                                                                                                                                                                                                                             |
| `F10` | Both enrolment paths pass `newestSessionId` (`ORDER BY created_at DESC LIMIT 1`) instead of the caller's session, which `sessionUser` already read from `findSession` and discards; the plugin rotates only when `twoFactor.verified !== true`                          | `lib/auth/rotation.ts`, `lib/auth/two-factor-challenge.ts`                          | A user adding TOTP to an existing OTP enrolment keeps the wrong session and is signed out of their own; the OTP path commits before a separately swallowed revocation. Returning the id from `sessionUser` is a two-line half of the fix                                                                                                                                                               |
| `N1`  | Enrolment-mode `/two-factor/otp/verify` is authenticated by `sessionUser(ctx)` alone — no `sessionMiddleware`, absent from `PASSWORD_PROOF_PATHS`                                                                                                                       | `lib/auth.ts`, `lib/auth/two-factor-otp.ts`                                         | A hijacked session enrols a second factor with a code to an already-verified contact and can then make recovery refuse permanently (**H3** mode B). The recorded fix is wrong as stated: `PASSWORD_PROOF_PATHS` is path-keyed and this path is dual-mode, so listing it would demand a password on the sign-in branch, where the caller holds only a challenge cookie. It needs **M2**'s discriminator |

- **Fix:** one owned transaction per transition (enable, verify, add method,
  remove method, disable) writing credential, intent, flag, acknowledgement and
  rotation together, with the library's own enable/disable/acknowledge endpoints
  de-allow-listed rather than compensated. Until it lands, `N2`'s hook must not
  throw — retry, or record a repairable state.

#### H6 — Four dual-mode paths omit live-session enforcement, so a suspended user can mutate their own 2FA state

- **Refs:** `F15`
- **Status:** open (step 6)
- **Where:** `lib/auth.ts` (`LIVE_SESSION_PATHS`, `sessionUser`),
  `lib/auth/two-factor-challenge.ts` (`enrolmentTarget`)
- **Evidence:** `LIVE_SESSION_PATHS` omits `/two-factor/otp/send`,
  `/two-factor/otp/verify`, `/two-factor/verify-totp` and
  `/two-factor/verify-backup-code`. `sessionUser` reads the database but checks
  neither `is_active` nor `deleted_at`; `enrolmentTarget` filters
  `isNull(users.deletedAt)` and not `isActive`.
- **Failure scenario:** an account suspended by an administrator, holding a live
  session row, enrols OTP and sets `two_factor_enabled` — a security-state
  mutation on a suspended account, on paths where `assertLiveSession` is this
  codebase's established control for exactly that. Distinct from
  `should-ignore.md` known-issue 5, which accepts up to five minutes of stale
  _read_ access from the cookie cache: these are writes, and the staleness is
  unbounded.
- **Fix:** resolve the mode once, then require liveness on the session branch
  only — using the library's discriminator, per **M2**. Add `isActive` to
  `enrolmentTarget` and to `sessionUser`.

### Medium

#### M1 — Passkey registration only _requests_ user verification; the comment claims a hard gate

- **Refs:** `F13`; L1 rated this "correct"
- **Status:** assertion half landed and correct; registration half not enforced
- **Where:** `lib/auth/two-factor.ts:185-194`,
  `node_modules/@better-auth/passkey/dist/index.mjs:355`
- **Evidence:** verified for this report. The assertion half is right —
  `userVerification: 'required'` on `generateAuthenticationOptions` and
  `requireUserVerification: true` on `verifyAuthenticationResponse` in
  `lib/auth/two-factor-passkey.ts`. The registration half is a client hint only:
  `authenticatorSelection: { userVerification: 'required' }` reaches the ceremony
  options, but `/passkey/verify-registration` in the installed plugin hardcodes
  `requireUserVerification: false` (line 355; line 483 is the plugin's own
  authentication path, which is never allow-listed). Nothing on the server
  refuses a credential registered with UV unset. The comment at
  `lib/auth/two-factor.ts:188-192` states "Refuse a non-verifying authenticator
  at REGISTRATION … the hard gate can only live on ours" — there is no gate.
  SimpleWebAuthn's MFA guidance requires both halves, and WebAuthn L3 requires
  the relying party to verify the signed UV flag when UV is required.
- **Failure scenario:** a custom client drops the hint and registers a
  non-verifying credential. Because our assertion path _does_ require UV, that
  credential then fails every assertion — the user holds an inert passkey and, if
  it is their only method, is refused at the next login. The realistic impact is
  liveness plus a false invariant in the code, not a weak factor: L3's "a weak
  factor is accepted" overstates it for this deployment, and L1's "correct"
  understates it.
- **Fix:** reject in a `registration.afterVerification` hook when
  `registrationInfo.userVerified !== true`, before the credential is persisted,
  or own registration outright with `F4`. Either way correct the comment now — it
  asserts a control that does not exist.
- **Test:** assert the signed UV bit, not the requested option.

#### M2 — The mode discriminator disagrees with the library's: cookie-first vs session-first

- **Refs:** L1's `N3` conflict (unique to L1); constrains `F1`/`D7`, `F15`, `N1`
- **Status:** a live defect plus a constraint on three planned fixes
- **Where:** `lib/auth/two-factor.ts:150-166` (TOTP intent after-hook),
  `node_modules/better-auth/dist/plugins/two-factor/verify-two-factor.mjs:14-15`
- **Evidence:** `verifyTwoFactor` branches on `getSessionFromCtx(ctx)` **first**,
  so a resolved session selects the enrolment branch even when a live challenge
  cookie is also present — no `beginAttempt`, no challenge consumption, `valid()`
  returns the existing session. The TOTP after-hook branches on
  `readChallengeCookie` (present and signed). The two disagree whenever both a
  session and a challenge cookie exist.
- **Failure scenario:** two constructions inside the ten-minute window the
  existing stale-cookie test already builds. (a) A shared browser: another user's
  abandoned challenge cookie is present at a first enrolment, so the library
  treats it as enrolment and commits `verified: true` while the hook treats it as
  sign-in and writes no intent row — the enrolling user ends 2FA-on with an empty
  offered set and is refused at the next login. (b) A trusted-device skip issues
  no new challenge, leaving an old cookie intact; adding TOTP in that window
  leaves a verified secret that is never offered.
- **Fix:** one shared discriminator reproducing the library's order — "a real
  session resolved", not "no challenge cookie" — used by this hook and by the
  hooks `F1`, `F15` and `N1` will add. Getting it wrong in step 3 puts the
  companion-record check on the wrong branch, where it misses precisely the
  sign-in caller who also holds a live session for that user.

#### M3 — The contact-change stranding guard exists only on the administrative edit

- **Refs:** `F29` (2a/2b), L3's `F29` note
- **Status:** open; the admin half landed and is correct
- **Where:** `app/api/dash/users/[id]/handler.ts:637` (only caller),
  `lib/auth/two-factor-challenge.ts:624`,
  `app/api/dash/users/me/{change-email,change-phone}/`,
  `app/api/dash/users/me/contact-change.ts`
- **Evidence:** verified for this report. `contactChangeStrandsTwoFactor` has
  exactly one call site, inside `handleAdminEdit`'s locked transaction. The
  self-service contact-change handlers reference nothing 2FA-related at all — no
  stranding check, no intent-row coupling, no re-verification of the moved
  method.
- **Failure scenario:** a user changes their own email. The `otp/email` intent row
  is untouched, so either it points at a contact whose verified flag was cleared —
  and if that was their only method the next login is refused and they need an
  operator reset, the exact outcome the admin guard exists to prevent — or, once
  `markContactVerified` flips the new contact, the second factor is silently
  re-pointed at the new mailbox. In a hijack the second half is persistence
  rather than bypass (the endpoint needs an authenticated session and a password
  re-auth), which is why this is Medium and not High.
- **Fix:** the guard belongs at the shared boundary
  (`app/api/dash/users/me/contact-change.ts` plus the admin edit), not on one
  handler, and the contact write must be coupled to the method lifecycle rather
  than only refused (`F29` 2a/2b). Per `CLAUDE.md` fix discipline this is the
  class the landed fix sampled.
- **Three rules the coupling must follow — settled, and the first is the one that
  turns this fix into the bug it repairs if it is missed:**
  1. **Never touch `two_factor_enabled`.** Invalidating the dependent `otp` intent
     row can leave a user 2FA-enabled with an empty offered set, and the obvious
     tidy-up is to clear the flag. Clearing it makes `users.edit` a 2FA disarm,
     which is exactly what `lib/permissions/constants.ts:60-65` reserves for
     `resetTwoFactor` and what `D2`'s safety half forbids. The flag stays `true`.
  2. **Refuse the contact change when it would remove the target's last usable
     factor** — 409, naming the reset as the route. This already exists on the
     admin edit (`contactChangeStrandsTwoFactor`) and is what keeps rule 1 from
     stranding anyone; it must exist on the self-service boundary too. The
     operator who genuinely needs the change resets 2FA first, through the
     permission that exists for it and the audit trail that comes with it.
  3. **When another factor survives, accept the change and invalidate the OTP bound
     to the old contact,** keeping `two_factor_enabled = true`. The next login
     offers the surviving method. Without this the factor silently follows the
     address: `markContactVerified` flips the new contact's verified flag back, and
     the stale intent row re-arms at a destination the user never approved — which
     is the whole reason this finding is not closed by the refusal alone.

#### M4 — The stranding predicate is asked once per changed kind, each time against unmodified state

- **Refs:** `F29` property 3, L3's `F29`, `D8`
- **Status:** exact today, wrong the moment `D8` lands
- **Where:** `app/api/dash/users/[id]/handler.ts:621-645`
- **Evidence:** the loop asks the predicate per changed contact kind, each time
  against the _unmodified_ state of the other kind. That is exact only while a
  user can hold one OTP row (`N5`).
- **Failure scenario:** under `D8`'s two OTP channels, one request changing both
  email and phone passes both checks — email survives because phone still counts,
  phone survives because email still counts — and strands the user anyway.
- **Fix:** build one hypothetical post-edit state with every changed kind cleared
  and ask the predicate once. Land it with `D8`, not after.
- **Test:** the landed suite covers the phone variant only. The email variant is
  the same code path parameterised by kind, so a second test buys little as the
  code stands — but this fix is precisely what stops the two kinds sharing that
  path, so assert both kinds and the both-at-once case together with it. Not
  filed under **M17**: the existing test does assert what it claims, it is the
  second dimension that is missing.

#### M5 — Device trust is consumed before capability is computed, and no path revokes trust on capability loss

- **Refs:** `F3` vs `D2` wording (unique to L2), `D11`; feeds **M10**
- **Status:** open
- **Where:** `lib/auth/two-factor-challenge.ts` (`issueTwoFactorChallenge`,
  `consumeDeviceTrust`), `lib/auth/rotation.ts`
- **Evidence:** `consumeDeviceTrust` runs _before_ the offered set is computed, so
  a user whose offered set is now empty still signs in on a device trusted
  earlier. `D2` states the safety property as "an empty offered set never grants
  access. Fail closed." — which is not what the ordering does. Nothing in `D11`
  revokes trust when capability is lost through an env-list change or a last
  passkey deletion.
- **Failure scenario:** exactly the population an operator's method-list change
  creates: every other user with that enrolment is refused at 403 while this one
  keeps signing in with the password alone, indefinitely, because their trust row
  predates the change. It is defensible — the row required a real proof to exist,
  and trust is a documented skip — but it is not what `D2` claims, and it is the
  first half of **M10**'s self-disarm chain.
- **Fix — settled as a defect, not as an amendment to `D2`:** compute the offered
  set first and refuse before honouring trust. Recording the exception instead was
  considered and rejected — `F5`'s landed fix binds trust to a proven second factor,
  and `D4` holds that the recovery challenge must not honour trust at all, so a
  trust row outliving the capability it was granted against is a standing bypass of
  a factor that no longer exists: the same shape `F5` closed. Also revoke trust rows
  on capability loss, in the same lifecycle transaction as **H5** (`D11`).

#### M6 — The attempt budget never restores, so non-guesses are charged

- **Refs:** `F12` (L1 and L3); L2's separate half recorded at the end
- **Status:** helper correct and tested; no production caller restores
- **Where:** `lib/auth/two-factor-otp.ts` (`verifyForSignIn`),
  `lib/auth/two-factor-passkey.ts`, `lib/auth/two-factor-challenge.ts` (attempt
  helpers)
- **Evidence:** the landed protocol matches the library's `beginAttempt` (consume,
  no write-back, caller invokes exactly one of `recordFailure` / `restore`), and
  the verify quota now runs before the spend. But `verifyForSignIn` calls
  `recordFailure()` for every throw out of `processOtpVerify`, including exits
  that produced no verdict — no proof row (404), no live code (400), proof-row
  block (429), a database fault — and never calls `restore()`. On the passkey
  path, faults after the spend can leave the row absent.
- **Failure scenario:** a user who submits before pressing send, or a request that
  hits a transient database error, spends one of five attempts on a non-guess;
  five such exhaust the challenge. It fails toward exhaustion, so this is
  availability, not a bypass.
- **Fix:** wire exactly one outcome on every non-consuming path, and test the
  callers rather than only the helper.
- **Related (L2):** the `2fa-attempts-<challenge>` row is shared with the
  library's own `beginAttempt` (`.../verify-two-factor.mjs:74-76`), which still
  does `Number(consumed.value)` + `Number.isInteger`. The digits-only parse
  hardens our verifiers only, so the empty-value direction remains open on
  `/two-factor/verify-totp` and `/two-factor/verify-backup-code`, which read the
  same identifier. `TWO_FACTOR_ALLOWED_ATTEMPTS = 5` does match the library's
  `beginAttempt(5)` (`totp/index.mjs:185`, `backup-codes/index.mjs:199`), so that
  half of the coupling holds. Closing it means owning those two paths or never
  writing a non-numeric value; record the coupling in **L2**'s version-drift test.

#### M7 — A lost passkey counter compare-and-swap is accepted, retaining the lower counter

- **Refs:** `F22`; L1 and L2 both rated this "correct"
- **Status:** backward writes prevented; a lost swap is logged and accepted
- **Where:** `lib/auth/two-factor-passkey.ts:93-104` (`advancePasskeyCounter`),
  called at `:303-314`
- **Evidence:** verified for this report. The update is a strict compare-and-swap
  on the previous value —
  `.where(and(eq(passkeys.id, passkeyId), eq(passkeys.counter, from)))` — and the
  caller logs `twoFactor.passkey.counterRaceLost` on a lost swap, then completes
  the challenge regardless.
- **Failure scenario:** two concurrent assertions of the same credential both read
  `counter = 3`. The one carrying `newCounter = 4` lands (3→4); the one carrying
  `newCounter = 9` loses the swap, is logged, and is accepted with the stored
  counter left at 4. A cloned authenticator replaying counters 5–8 then passes the
  monotonicity check. Narrow — it needs genuinely concurrent assertions of one
  credential — but it turns clone detection into a no-op for that credential's
  next four assertions.
- **Fix:** make the write a monotonic maximum instead of a compare-and-swap —
  `set({ counter: to }).where(and(eq(passkeys.id, id), lt(passkeys.counter, to)))`
  — where "no row updated" means the stored value is already at least `to`, which
  is the correct outcome. Keep the log for the reconciled case.
- **Test:** the existing test covers only higher-first / lower-loser ordering; add
  the inverse, which is the direction that matters.

#### M8 — `rememberMe` is ignored at custom completion, and the marker is cleared nowhere

- **Refs:** `F16`, `C10`, `D10`
- **Status:** open (step 3)
- **Where:** `lib/auth/two-factor-challenge.ts` (`completeTwoFactorChallenge`),
  `lib/auth/rotation.ts` (`withdrawFirstFactorSession`),
  `node_modules/better-auth/.../verify-two-factor.mjs:31,57`
- **Evidence:** `completeTwoFactorChallenge` calls
  `createSession(challenge.user.id)` with no second argument while the library
  passes `!!dontRememberMe` — 28 days versus 1. The marker survives the challenge
  because `issueTwoFactorChallenge` calls `deleteSessionCookie(ctx, true)`, and
  the dispatcher merges the before-hook body with `defuReplaceArrays`, so a client
  `rememberMe` does reach the handler.
- **Failure scenario:** a user asking not to be remembered gets a 28-day database
  session row (the browser cookie happens to be session-scoped, which masks it);
  and because the library expires `dontRememberToken` only inside
  `if (ctx.body.trustDevice)` while this deployment forces `trustDevice: false` on
  both plugin verifiers, _nothing_ clears the marker on any served path — a later
  `rememberMe: true` flow in the same browser inherits the earlier false choice.
- **Fix:** persist the submitted choice in **H4**'s companion record, pass it into
  session creation, set the cookie consistently, and clear the legacy marker on
  every completion and cancellation. Add `rememberMe` to `loginSchema` so it is
  validated and documented — `D10`'s first item, which appears in no finding's
  fix; make sure step 3 carries it.
- **Test:** false-then-true sequences across both the plugin and the custom
  completion paths.
- **Tracking correction:** `F16`'s claim that the library clears the marker is
  wrong — see §4.

#### M9 — The 2FA OTP verify quota is shared with the public anonymous endpoint

- **Refs:** `F11`
- **Status:** open (step 4), and it does not depend on step 4
- **Where:** `lib/rate-limit/api.ts:229-232` (`enforceOtpVerifyQuota`)
- **Evidence:** the function branches only on `recovery`, so
  `surface: 'two_factor'` shares the `otp.verify.dest.${kind}` key with the
  anonymous `/api/auth/otp/verify`.
- **Failure scenario:** an attacker who knows a victim's email or phone burns the
  destination's verify budget (10 per 600 s) through the public endpoint, and the
  victim's second-factor verification is throttled out. The public surface is
  `captcha: true`, so each of the ten burn requests costs a Turnstile solve —
  that raises the price, it does not remove the attack.
- **Fix:** give `two_factor` its own key, as `recovery` already has. Three lines;
  pull it forward out of step 4.

#### M10 — No administrator re-authentication on the security-lowering class, and self-reset is the cheapest self-disarm

- **Refs:** `F14`, `D12`, L2's addendum
- **Status:** open (step 6)
- **Where:** `app/api/dash/users/[id]/two-factor/handler.ts`, `routes.ts`
  (`body: 'none'`)
- **Evidence:** the handler runs `requirePermission({ forceDB: true })`,
  `enforceRateLimit`, `assertTargetUserVisible` and `validateRolePermissionScope`
  and calls `verifyLoginAttempt` nowhere, while `users/me/change-password`
  re-authenticates for a strictly less dangerous action. It also passes
  `isSelf: target.id === actorUserId`, and `assertTargetUserVisible` exempts self
  from both its narrowings.
- **Failure scenario:** a holder of `users.resetTwoFactor` can clear **their own**
  2FA. Combined with **M5**'s trust ordering, the cheapest self-disarm in the
  system is: hold a trusted device, sign in with the password alone, POST your own
  id — no factor proven at any step. For a hijacked administrator session that is
  a complete 2FA removal with no proof.
- **Fix:** `D12`'s one reusable short-window administrator proof applied to the
  whole security-lowering class, plus re-authorization inside each mutating
  transaction (**L10**). `D12` already lists this endpoint; list the self-target
  case as a reason so it is not rediscovered later.

#### M11 — Rotation cleanup deletes almost none of its own artifacts

- **Refs:** `F23`, `C4`
- **Status:** open (step 6)
- **Where:** `lib/auth/rotation.ts:50-51` (`revokeTwoFactorState`),
  `lib/auth/trusted-device.ts` (`grantDeviceTrust`),
  `lib/auth/two-factor-challenge.ts:501-520` (proof markers)
- **Evidence:** the loop over deleted `trustIdentifier`s deletes zero
  `verifications` rows — nothing writes a verification row per trusted device
  (`grantDeviceTrust` writes `trusted_devices` plus a cookie, and the plugin's own
  trust writer is unreachable behind the forced `trustDevice: false`). The
  `WHERE value = userId` predicate misses the `2fa-attempts-<challengeId>` rows
  (value `'0'`), the WebAuthn ceremony rows, and the `2fa-proven-<sessionId>`
  markers, which store the _session_ id as their value.
- **Failure scenario:** the proof markers are the live half. Under the settled
  policy, method removal keeps the current session but revokes trusted devices; a
  surviving marker lets that same session mint a new trusted-device row
  immediately afterwards, undoing the revocation. L1 judged the markers harmless
  because they die with the session — true for user deletion and password
  rotation, not for method removal, which is the case the policy singles out.
- **Fix:** model each owned artifact explicitly and delete per rotation kind —
  give proof markers an explicit user owner, or delete them through the user's
  session ids inside the same locked lifecycle transaction as **H5**. Split
  `revokePendingProofs` / `revokeTwoFactorState` by event, since `D11` wants
  different blast radii per event.
- **Tracking correction:** this finding's "add `passkeys`" clause contradicts the
  rotation decision — see §4.

#### M12 — Operator-caused capability loss is neither attributable nor previewable

- **Refs:** `F3`'s missing per-cause reason, `F31`, `F25`
- **Status:** open (step 6 for `F31`/`F25`; the reason split is in no step)
- **Where:** `lib/auth/two-factor-challenge.ts` (`recordChallengeEvent`,
  `issueTwoFactorChallenge`), `app/api/dash/users/[id]/handler.ts`,
  `lib/auth/rotation.ts` (`revokeTwoFactorState`), `scripts/`
- **Evidence:** one audit reason (`two_factor_unavailable`) and one user message
  fire for both causes — possession exclusion (a passwordless user whose only
  method is OTP to the contact just proved, who still has a working password
  route) and capability loss (an env-list change, a deleted last passkey, an
  administrative edit). `params.excludeContactKind` is already in scope at the
  branch and is exactly the discriminator. The administrative edit's audit row
  carries no 2FA state, `revokeTwoFactorState` writes no row at all, and the only
  trace of a reset is `recordChallengeEvent` under the _victim's_ user id.
  `scripts/` holds `check-password-peppers.ts` and no 2FA preflight.
- **Failure scenario:** an operator narrows the method list and cannot tell,
  before or after, which accounts it stranded; the only signal is a refusal logged
  under each victim under a reason string shared with a benign case, with no actor
  attribution. Post-refusal this matters more, not less: a method-list change
  turns affected logins into hard 403s rather than silent downgrades, so an
  unsized rollout is an outage.
- **Fix:** (a) split the audit reason by cause at the branch — cheap, and both
  alerting and the preflight depend on it; (b) write an attributable
  actor/target/method/reason event inside the mutating transaction for every
  lifecycle operation, the administrative reset included; (c) add the read-only
  preflight script that counts stored intent and capability against a proposed
  method set, reports the affected population and blocks an unsafe rollout — it
  must count **H2**'s channel cause too.

#### M13 — The audit trail cannot say which factors completed a login

- **Refs:** `F21`
- **Status:** open (step 3)
- **Where:** `lib/auth.ts` (`SESSION_METHOD_BY_PATH`, `session.create.after`)
- **Evidence:** the map is keyed by path alone and covers four paths.
  `/two-factor/otp/verify` and `/two-factor/passkey/verify` create sessions
  through `completeTwoFactorChallenge` and are absent, so they audit as `unknown`;
  a TOTP or backup completion after a passwordless first factor is labelled
  `password+…`; first-factor sessions are logged successful before withdrawal; a
  trusted-device bypass is not represented; and the enrolment-mode TOTP session
  rotation is logged as a login.
- **Failure scenario:** an incident review cannot distinguish a password-only
  session, a trusted-device bypass and a fully verified two-factor session — and a
  bypass is precisely what such a review looks for.
- **Fix:** persist the factor chain in the challenge companion record (**H4**) and
  emit one explicit completion or bypass event from `completeTwoFactorChallenge`
  instead of inferring the method from the path.
- **Also:** the comment above `session.create.after` ("the only session-creating
  paths this deployment serves are `/sign-in/email` and `/passwordless/verify`")
  is now false — folded into **L3**.

#### M14 — The published contract omits the challenge response and declares generic bodies

- **Refs:** `F20`, `C2`
- **Status:** open (step 7)
- **Where:** `lib/http/openapi.ts` (`BETTER_AUTH_BODIES`,
  `BETTER_AUTH_LOCAL_THROTTLE_PATHS:1253`), `tests/unit/openapi-contract.test.ts`
- **Evidence:** `BETTER_AUTH_BODIES` still has two entries (`/sign-in/email`,
  `/passwordless/verify`) while eight new endpoints declare
  `z.record(z.string(), z.unknown())` and parse narrower schemas by hand;
  `BETTER_AUTH_LOCAL_THROTTLE_PATHS` is still `new Set(['/passwordless/verify'])`
  although `/two-factor/otp/{send,verify}` reach `enforceOtpSurfaceSendQuota` /
  `enforceOtpVerifyQuota` and can answer 429/503. Larger than the finding records:
  both first-factor endpoints now have a _second_ 200 shape,
  `{ twoFactorRedirect: true, twoFactorMethods: [...] }`, and neither the contract
  nor the contract test mentions `twoFactorRedirect` anywhere — the tests assert
  the narrow schemas and therefore protect the mismatch.
- **Failure scenario:** a client generated from this document cannot represent the
  normal challenge branch of a login and treats it as a completed session.
- **Fix:** make each 200 a precise union of completed-session and challenge
  responses; publish exact request schemas for the eight custom endpoints; extend
  the throttle-path set to every route-local limiter; assert both branches and
  verify runtime examples against the schemas.
- **Elysia:** these paths are not Elysia routes (§7), so none of this can be
  derived from route schemas — the tables stay hand-maintained.

#### M15 — Offered methods have no stable identity, order or default

- **Refs:** `F18`, `N5`, `C9`, `D8`, `D9`
- **Status:** open (step 3)
- **Where:** `lib/auth/two-factor-challenge.ts` (`readEnrollment`,
  `offeredMethods`, `recordMethodIntent`, `listEnrolledMethods`), `db/schema.ts`
  (`ux_two_factor_methods_user_method`),
  `db/drizzle/0006_two_factor_method_enrollment.sql`
- **Evidence:** `readEnrollment`'s `two_factor_methods` select has no `ORDER BY`;
  `offeredMethods` maps in `state.intent` order; there is no `defaultMethod`, no
  `is_default` column, and `GET /two-factor/methods` returns intent only with no
  capability join. The unique index is `(user_id, method)` and
  `recordMethodIntent`'s `onConflictDoUpdate` targets the same pair, so a second
  OTP channel _replaces_ the first rather than adding. `TwoFactorMethod[]`, a
  method-only `defaultMethod`, method-only disable and a method-only conflict
  target cannot distinguish email from phone.
- **Failure scenario:** the response order is whatever the database returns, so a
  client's default choice moves between requests; the two-channel model of `D8`
  cannot be represented at all; and `D8`'s partial indexes remove the constraint
  the current `ON CONFLICT (user_id, method)` targets, so that writer fails the
  moment the migration lands.
- **Fix:** define one stable option identity — method plus contact kind, plus
  transport where needed — and carry it through issuance, the response, default
  selection, send, verify, removal, the conflict target and the OpenAPI schemas.
  Backup codes stay manual-only, never auto-routed. Prove the generated column and
  the partial conflict targets by _applying_ the migration, not by reading SQL.
- **Test:** `tests/unit/two-factor-offered-methods.test.ts` asserts the
  intersection and nothing about order, so nothing will fail when `D9` lands — add
  the ordering assertion with the fix.

#### M16 — OTP messages are identical across purposes, and no channel is testable

- **Refs:** `F19`, `D15`
- **Status:** open (step 7)
- **Where:** `utils/otp.ts:195,210,315-318`, `lib/auth/two-factor-otp.ts` (the 2FA
  send)
- **Evidence:** one fixed string per transport with no purpose — the SMS body, the
  WhatsApp `content`, and the email `subject` / body. `processOtpSend` receives
  `purpose` and uses it only for the proof row and the advisory lock. The 2FA send
  passes an `entityName` that appears only in the block message, so a login code,
  a recovery code and a contact-verification code are byte-identical.
- **Failure scenario:** a user cannot tell a second-factor prompt from a password
  reset — the exact confusion an attacker who triggers one and phishes the other
  relies on.
- **Fix:** purpose-aware templates selected from the `purpose` already threaded
  through, plus `D15`'s production-impossible in-process outbox so every channel
  and purpose is asserted without provider accounts and without logging plaintext
  codes.

#### M17 — Green suites that do not assert the behaviour they are cited for

- **Refs:** `F30` second half, `F28`'s test claim, `F13`, `F22`
- **Status:** open
- **Evidence:**
  - `tests/integration/two-factor-management.test.ts:361` — the second half is
    tautological. The actor holds `{ users: { view, resetTwoFactor } }`, so the
    `PUT` is refused 403 for lacking `users.edit` at all and never reaches the
    role-scope gate; `expect(edit.status).not.toBe(OK)` would pass whatever the
    scope check did. Observed in L2's run: reset 404, PUT 403. The agreement the
    finding is about — an actor who _has_ `users.edit` but is outranked — is
    untested.
  - The `F28` / step-1 claim that trusted-device ordering "is asserted through the
    settings-list shape": no test asserts order; the only list assertion is a
    length of one.
  - **M1**: the UV test asserts the requested option, not the signed UV bit.
  - **M7**: the counter test covers only the ordering that already works.
- **Impact:** four repairs recorded as landed are protected by tests that would
  pass with the repair removed. This is the mechanism by which **M1**, **M6** and
  **M7** came to be recorded as complete.
- **Fix:** with each of those findings, assert the behaviour and not the input —
  and for `F30`, give the actor `users.edit` so the refusal is attributable to the
  scope gate.

#### M18 — There is no behavioural configuration matrix

- **Refs:** `C6`, `F8`, step 8
- **Status:** open
- **Evidence:** `tests/helpers/run.ts` gives unit and integration one fixed
  configuration — all four methods, SMS only. The process tier validates parsing
  and two overlap cases but never exercises real endpoints under method or channel
  subsets: empty, passkey-only, backup-only, OTP-only, email OTP, WhatsApp.
- **Impact:** this is why **H1**, **H2** and `F8`'s unenrollable configurations are
  all green. The suite proves one deployment works.
- **Fix:** an endpoint-driven matrix over the supported configurations, with the
  empty-list row asserting **H1**'s agreement across all three first-factor paths
  and the reset.

#### M19 — A lost pepper compare-and-swap turns a correct password into a 401

- **Refs:** `D16` §3.14, assigned to no step
- **Status:** open
- **Where:** `lib/auth/login-guard.ts` / `lib/auth/password-proof.ts`
  (`upgradePasswordHash`)
- **Evidence:** on a lost compare-and-swap `upgradePasswordHash` returns `null`, so
  the minted proof carries the pre-upgrade hash while the row holds the concurrent
  writer's, and `password.verify` then rejects a correct password.
- **Failure scenario:** two concurrent logins during a pepper rotation; one gets a
  401 on a valid credential. Narrow, but it is the one direction that turns a valid
  credential into a rejection rather than the reverse.
- **Fix — settled, and narrower than the obvious one: log the lost swap and let
  the 401 stand.** Do **not** re-read the row and mint the proof from the stored
  hash: the concurrent writer may have been a password _change_, so trusting that
  hash lets the **old** password mint a session — turning a narrow 401 into an
  authentication bypass in the same race window. Verifying the re-read hash against
  the plaintext still in scope would be correct, and is not worth the complexity
  for a race this narrow. A logged, explained 401 on two concurrent logins during a
  pepper rotation is the accepted outcome. See `D16`.

### Low

#### L1 — `trusted_devices` has no expiry-leading index, and the comment claims one

- **Refs:** `F24`
- **Status:** open (step 6)
- **Where:** `db/schema.ts` (`idx_trusted_devices_user`), `db/maintenance.ts:79-88`,
  `db/maintenance.ts:264-277` (`sweepTrustedDevices`),
  `db/drizzle/0005_two_factor_tables.sql`
- **Evidence:** the only index is `idx_trusted_devices_user (user_id, expires_at)`,
  which cannot lead an expiry-only scan; `sweepTrustedDevices` filters
  `expires_at` alone. The comment at `db/maintenance.ts:79-88` claims a leading
  `expires_at` index "Verified with EXPLAIN" for _both_ new tables. The tracking
  document's correction is right: `verifications` does have
  `idx_verifications_expires_at`; `trusted_devices` does not.
- **Impact:** the retention sweep full-scans a table that grows with every trusted
  device. No current impact at this data size; the false comment is the more
  expensive half, because it is the reason nobody will look again.
- **Fix:** add the expiry-leading index, or accept the scan and correct the comment
  to say so. Do not leave both.

#### L2 — No version-coupling test for the library internals this deployment copies

- **Refs:** `F26`
- **Status:** open (step 6)
- **Evidence:** no test references `hooks`, `getPlugin` or the destructured
  `_pluginSignInHook`. The assumptions copied out of installed source and relied
  on at runtime — the `hooks.after` arity, `getPlugin('two-factor')` resolution,
  `beginAttempt`'s protocol and its `5`, the `2fa-attempts-<id>` identifier
  format, the challenge cookie name, `verifyTwoFactor`'s session-first branch
  order (**M2**), `requireUserVerification: false` at registration (**M1**) — are
  proven by nothing that fails loudly on a minor library bump.
- **Impact:** a `better-auth` patch release can silently disable a security
  control rather than break a build.
- **Fix:** one drift test asserting each copied assumption against the installed
  package. One clarification for the finding: the cookie name and the two
  identifier formats _are_ covered incidentally —
  `tests/integration/two-factor-totp.test.ts:213` proves all three at once,
  because `beginAttempt` throws `INVALID_TWO_FACTOR_COOKIE` unless
  `2fa-attempts-<challengeId>` exists under exactly that identifier, so a 200
  there is the assertion. What is genuinely uncovered is the hook arity, the
  plugin resolution and the two verification defaults.

#### L3 — Comment sweep: false invariants, banners, and orphaned blocks

- **Refs:** `F27`
- **Status:** open (step 7)
- **Live false claims (each is a comment asserting a control that does not exist):**
  - `db/maintenance.ts:79-88` — the leading `expires_at` index for both new tables
    (**L1**).
  - `lib/auth/two-factor.ts:150-166` — the TOTP after-hook catch claiming to
    prevent the state its throw creates (`N2`, **H5**).
  - `lib/auth/two-factor.ts:188-192` — registration-time UV refusal (**M1**).
  - `utils/validation/two-factor.ts:23-26` — "Keep `backup_code` enabled in every
    deployment", which the env list can omit and `F8` makes unenrollable; repeated
    in `.env`.
  - `lib/auth.ts`, above `session.create.after` — "the only session-creating paths
    this deployment serves are `/sign-in/email` and `/passwordless/verify`", now
    false (**M13**).
- **Other:** the five `// ====` banners added to `db/schema.ts` (Verifications,
  Two-Factor Credentials, Two-Factor Method Enrollment, Passkeys, Trusted
  Devices) are section banners, which `CLAUDE.md` names explicitly; and
  `tests/helpers/session.ts` carries two stacked doc comments before
  `nextPhoneSuffix`, the first of which documents `uniquePhone` and is orphaned.
- **Already fixed, remove from the inventory:** the forgot-password atomicity
  comment is now true (`recoveryDefeatsTwoFactor` takes `tx` and runs inside the
  proof transaction), and the passkey "stored rather than compared" comment was
  replaced with an accurate one on `advancePasskeyCounter`.
- **Fix:** correct or delete each false claim as its finding lands — a comment
  asserting a missing control is worse than no comment, because it stops the next
  reader from checking.

#### L4 — `@better-auth/core` is a runtime dependency, unpinned, for a type-only import

- **Refs:** `N6`
- **Status:** open (step 6)
- **Where:** `package.json`
- **Evidence:** `"@better-auth/core": "^1.7.2"` sits in `dependencies` while
  `better-auth@1.7.2` pins it exactly, and the only import is
  `import type { GenericEndpointContext }`.
- **Impact:** a minor release of the transitive package can be hoisted alongside
  the pinned one and drift the types the auth layer is written against.
- **Fix:** move it to `devDependencies` and pin it exactly to the installed
  `better-auth` version.

#### L5 — Passkey management inputs bypass this schema's bounds

- **Refs:** `C5`
- **Status:** open
- **Evidence:** the installed plugin accepts unbounded registration/update `name`
  strings and plain strings for passkey ids, while this schema stores names in
  `varchar(150)` and ids as UUID. An overlong name reaches the database and
  answers 500; a malformed id reaches a UUID comparison instead of a validation
  response. No test covers either boundary.
- **Impact:** wrong status codes on an authenticated surface, and a 500 where the
  codebase's contract is a 4xx envelope everywhere else.
- **Fix:** validate the plugin paths' query and body fields in the shared Better
  Auth before-hook with `NAME_MAX` and `validID` — the same boundary that already
  holds `PASSWORD_PROOF_PATHS` and `LIVE_SESSION_PATHS` policy — or expose owned
  management endpoints with exact schemas when `F4` lands. See §7 for why this
  cannot be an Elysia route schema.

#### L6 — Unrelated dependency and compiler drift in this change

- **Refs:** `C8`
- **Status:** open
- **Where:** `package.json`, `tsconfig.json`
- **Evidence:** `eslint-plugin-import-x` was broadened from `^4.17.1` to `^4`, and
  `tsconfig.json` received unrelated commented-option edits (a reflowed commented
  `target`, an added commented module line). Neither is required for 2FA.
- **Impact:** a widened lint-plugin range can change lint behaviour on a fresh
  install for reasons unrelated to this change, and unrelated hunks make the
  security review of this diff larger than it needs to be.
- **Fix:** revert both before merging.

#### L7 — The startup refusal for an overlapping OTP-only deployment contradicts the settled recovery decision

- **Refs:** `N4`, `D1`
- **Status:** open (step 4)
- **Where:** `utils/validation/two-factor.ts` (the overlap gate),
  `tests/process/startup-gates.test.ts:351,368`
- **Evidence:** `D1` settles that contact-kind disjointness is enforced on the
  authentication chain, not at configuration or enrolment time —
  `recoveryDefeatsTwoFactor` already compares by contact kind. The startup gate
  refuses to boot an OTP-only deployment whose channel overlaps recovery, which is
  the configuration-time control `D1` rejected.
- **Impact:** a supported configuration cannot boot, and the refusal implies a
  guarantee the authentication chain does not yet provide (**H3** mode A).
- **Fix:** replace the refusal with a warning on actual overlap, and enforce
  disjointness in the recovery and passwordless chains, per `D1`. Keep the strict
  _parsing_ gates as they are.

#### L8 — Two homes for one message family

- **Refs:** L1 "outside the document" 2
- **Status:** open
- **Where:** `utils/api-messages.ts` (`MSG_CONTACT_CHANGE_STRANDS_TWO_FACTOR`,
  `MSG_TWO_FACTOR_UNAVAILABLE`), `app/api/auth/otp/messages.ts` (`twoFactorMsg`)
- **Evidence:** every other 2FA message lives in `twoFactorMsg`; these live in the
  generic API-message module.
- **Impact:** consistency only — but it is the kind that makes the next message
  land in whichever file the author saw last.
- **Fix:** one home. `twoFactorMsg` is the dominant pattern for this family; the
  handler-level constants that need to be importable from `utils/api-messages.ts`
  can re-export from it.

#### L9 — `docs/2fa.md` documents an error code the pinned version does not have

- **Refs:** L2's version note under `F9`
- **Status:** open
- **Where:** `docs/2fa.md`
- **Evidence:** the document describes `TOTP_ALREADY_ENABLED` on a repeat enable.
  That code does not exist in the installed `better-auth@1.7.2` — it appears
  nowhere under `node_modules/better-auth/dist/plugins/two-factor/`.
  `allowPasswordless`, also documented there, _is_ present in 1.7.2.
- **Impact:** the document is ahead of the pinned version, and `F9` describes a
  repeat enable that silently replaces verified material. Anyone closing `F9` by
  trusting this document will close it against behaviour the deployment does not
  have.
- **Fix:** pin the document to 1.7.2's actual behaviour, or state the version it
  anticipates.

#### L10 — The administrative reset authorizes outside the lock it then takes

- **Refs:** `C3`, `F30`
- **Status:** open
- **Where:** `app/api/dash/users/[id]/two-factor/handler.ts:69-116`
- **Evidence:** the handler reads and authorizes the target (`assertTargetUserVisible`,
  then `validateRolePermissionScope(..., 'reachability')`), then opens a new
  transaction and locks only `{ id }`, re-reading and re-authorizing nothing —
  not `roleId`, role scope, `createdBy`, deletion state or protected-role status.
  `handleAdminEdit` re-runs all of its gates on its locked row
  (`app/api/dash/users/[id]/handler.ts:416-466`), which is the local pattern this
  handler diverges from.
- **Failure scenario:** a concurrent role change moves the target out of the
  actor's scope after the check and before the reset, and the reset proceeds. It
  needs two administrators acting on the same target within the same few
  milliseconds.
- **Fix:** select the authoritative joined target under the lock inside the
  existing transaction and run the reachability and scope checks there, keeping
  the outer check as a cheap pre-filter. The transaction and the `FOR UPDATE` are
  already there, so this is a move, not new machinery — and `D12`/**M10** is
  editing this handler anyway.
- **Relationship to the ignore list:** `should-ignore.md` #16 accepts
  "TOCTOU: Permission Scope Validation Outside Transaction (POST Handlers)" as low
  probability with no real harm. This is the same shape, which is why it is Low
  rather than L3's High. It is reported because the harm here is not nothing —
  removing a security control from an account the actor may no longer reach — and
  because the sibling handler in the same route family already does it correctly,
  so leaving it is a consistency divergence rather than an accepted cost. Close it
  as covered by #16 if you prefer; it should not be rediscovered a fourth time.

#### L11 — Passwordless has no independent server-side toggle

- **Refs:** `D14`
- **Status:** open (step 6)
- **Where:** `lib/auth/passwordless.ts`, `utils/config.ts` (`OTP_ENABLED`)
- **Evidence:** passwordless sign-in is gated by `OTP_ENABLED` alone. There is no
  flag that disables the passwordless entry point while leaving OTP available for
  contact verification, recovery and second-factor delivery.
- **Impact:** the weakest first-factor route cannot be switched off without
  switching off the OTP machinery every other flow depends on. That matters most
  in exactly the situation where an operator would want it — abuse on the
  passwordless path, or the possession-exclusion population of **H3** and **M12**
  that has no second factor left to offer after the contact it just proved is
  excluded.
- **Fix:** `D14`'s independent server-side toggle, checked at the passwordless
  endpoints rather than derived from `OTP_ENABLED`; the deployment note it implies
  belongs in `reports/coolify-deployment.md` when it lands.

## 4. Corrections that were owed to the tracking document

The tracking document is archived and this file supersedes it, so these are no
longer edits to make — they are recorded because each one was a live error that a
later step would have implemented, and because two of them explain why a finding
here reads differently from the source logs.

- **The `passkeys` instruction lived in two places.** "Add `passkeys` to
  `revokeTwoFactorState`" was in `F4`'s Fix verbatim _and_ listed as a gap in
  `F23`. It contradicts `D11` — methods are never reset on a credential rotation —
  and passkey deletion belongs to the administrative reset and user deletion, where
  the reset handler already performs it. Both sites are dropped; `F23`'s
  surviving-row inventory stands (**M11**). This was the one merge error the source
  logs each saw half of.
- **`F16` claimed the library clears the do-not-remember marker.** It does not: it
  expires `dontRememberToken` only inside `if (ctx.body.trustDevice)`, and this
  deployment forces `trustDevice: false` on both plugin verifiers, so nothing
  clears it on any served path (**M8**).
- **`F25`/`F3` still named the `twoFactorDowngraded` signal** after the rename to
  `twoFactorRefused`, and `F25`'s "it also fires on routine passwordless logins"
  became untrue once the login is refused rather than completed.
- **`F31`'s signal-noise rationale was stale** for the same reason; the remaining
  defect is attribution (**M12**).
- **`F27`'s inventory** carried two entries already fixed (the forgot-password
  atomicity comment, now true; the passkey "stored rather than compared" comment,
  replaced) and was missing two introduced later (**L3**).
- **`D10` delegated its content** to another document, so its first item — add
  `rememberMe` to `loginSchema` — appeared in no finding's fix. It is carried in
  `D10` above and in **M8**.
- **`D2`, `D3`, `D5`** are superseded by the Settled policy in §2: `D2`'s two
  exceptions are resolved as defects (**H1**, **M5**), `D3`'s population is wider
  than it claimed, and `D5` is withdrawn under `P0`.

## 5. Contradictions between the source reports, resolved

| Subject                          | The disagreement                                                                                                                                                                        | Resolution and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `F13` registration UV (**M1**)   | L1: "correct". L2 and L3: partial — the plugin hardcodes `requireUserVerification: false`.                                                                                              | **L2/L3 are right.** Verified: `node_modules/@better-auth/passkey/dist/index.mjs:355` hardcodes it on `/passkey/verify-registration`; `authenticatorSelection` is a client hint reaching only the ceremony options. L2's impact analysis is the accurate one — the credential is inert rather than weak, because our assertion path does require UV — so L3's "a custom client can register a weak factor" is right about the cause and wrong about the consequence.                                                 |
| `F22` counter CAS (**M7**)       | L1 and L2: "correct". L3: partial — a lost swap is accepted.                                                                                                                            | **L3 is right, against the majority.** Verified: `advancePasskeyCounter` is `eq(passkeys.counter, from)` and the caller only logs `counterRaceLost` before completing. The stored counter can retain the lower of two valid concurrent counters.                                                                                                                                                                                                                                                                     |
| `C1` severity (**H1**)           | L3: Critical. L1 and L2: not reported at all.                                                                                                                                           | **Real, rated High.** Verified in full (see **H1**). Downgraded from Critical because it needs an operator configuration change and is not attacker-reachable; kept at High for the blast radius and the lost recovery exit. That two reviews missed it is itself evidence for **M18**.                                                                                                                                                                                                                              |
| `F12` empty-value parse (**M6**) | L1: the digits-only parse "closes the empty-value hole". L2: still open through the library's own `beginAttempt`.                                                                       | **Both, at different scopes.** L2's is the sharper statement: our verifiers are hardened, the library's two verifiers share the same row and still do `Number(consumed.value)`. Recorded under **M6** as a coupling to test rather than a bypass to fix.                                                                                                                                                                                                                                                             |
| `2fa-proven-*` markers (**M11**) | L1: they survive `WHERE value = userId` but harmlessly, since they die with the session. L3 (`C4`): they survive the method-removal trust revocation and can mint a new trusted device. | **L3 is right for the case that matters.** L1's reasoning holds where the session is also revoked (user deletion, password rotation); method removal deliberately keeps the session, which is exactly where the marker's survival is load-bearing.                                                                                                                                                                                                                                                                   |
| `F23` passkeys clause (§4)       | L1: strike it — the rotation decision forbids resetting methods. L2: add `passkeys` to the fix.                                                                                         | **L1 is right about the rotation helper.** Passkey deletion belongs to the administrative reset and user deletion, where the reset handler already performs it. L2's addition of the attempt rows and proof markers to the inventory is kept.                                                                                                                                                                                                                                                                        |
| `N4` (**L7**, §8)                | L1: nothing to check. L2: not real as written, superseded by `D1`. L3: not real as stated, _and_ the startup gate contradicts `D1`.                                                     | **L3 adds the actionable half.** The finding as written is dead; the live item is that the startup refusal implements the control `D1` rejected. Recorded as **L7**.                                                                                                                                                                                                                                                                                                                                                 |
| `D16` method-aware known set     | L2: landed. L1 and L3: partial — the known set is path-keyed, so a wrong-method summary entry would pass the leftover check.                                                            | **Unresolved, and not recorded as a finding.** The keying is deliberate and documented at `lib/http/openapi.ts:1499-1512`: bodies are checked with `betterAuthServes(key, 'POST')` because a body belongs to a POST, and `BETTER_AUTH_PATH_STATUSES` is checked against paths servable under _any_ configuration on purpose. Proving a defect needs a demonstration that a wrong-method `BETTER_AUTH_SUMMARIES` entry publishes something wrong; nobody produced one. Per `CLAUDE.md`, uncertainty is not a finding. |
| Suite results                    | Three different tallies for the same tree.                                                                                                                                              | Not a contradiction — different selections (L1 and L3 ran full tiers, L2 ran the 2FA-focused selections). All three green. See §10.                                                                                                                                                                                                                                                                                                                                                                                  |

## 6. Accepted proposals with no owner

`D16` records these as accepted; the order-of-work table carries none of them, and
all three logs found them unimplemented. They need step numbers or they will be
lost between the decision and the table.

1. `two_factor_credentials.verified` should default to `false`; schema and
   migration `0005` still say `default true` (`db/schema.ts`).
2. `SERVER_ONLY_VIRTUAL_PATH` is still the blanket
   `ctx.path === '/' && !ctx.request` exemption in `lib/auth.ts`, not the narrowed
   named set.
3. The pepper compare-and-swap repair — reported here as **M19**, because it is a
   live correctness defect rather than only an unassigned item. Its remedy is
   settled and is _not_ the obvious one: log the lost swap and accept the 401. Read
   **M19** before touching it.

## 7. Elysia determination

The `## Elysia` section of the audit prompt post-dates all three logs, so I
checked whether any finding's remediation is a workaround for a capability
Elysia 1.4 already provides. **It is not, and no finding's fix changes.** The
reason is structural, and worth recording so it is not re-examined per finding.

Every Better Auth path is served by **one** Elysia wildcard route that forwards
the raw `Request` to `auth.handler` after an allowlist check
(`app.ts:463-475`: `if (!betterAuthServes(subPath, request.method)) return
routeMiss(...)`, then `localiseAuthError(await auth.handler(forwarded))`).
Consequences:

- **Request/response validation** (`t.Object`, standalone schemas): unreachable.
  Elysia sees one wildcard, not `/two-factor/otp/verify`, so there is no route to
  attach a per-path schema to. Splitting the wildcard into per-path Elysia routes
  would duplicate Better Auth's router, dissolve the single allowlist boundary the
  comment at `app.ts:388` describes as the security property of that mount, and
  still not reach the plugin handlers' own parsing. **L5**'s input bounds
  therefore belong in the shared Better Auth before-hook, alongside the existing
  `PASSWORD_PROOF_PATHS` / `LIVE_SESSION_PATHS` policy — which is also where
  **M2**'s discriminator and **H6**'s liveness check go. One boundary, and it is
  the dominant pattern already.
- **OpenAPI derivation** (`@elysiajs/openapi`): unreachable for the same reason.
  The hand-maintained tables in `lib/http/openapi.ts` that **M14** extends are not
  a workaround for a missing feature; they are the only place the information
  exists, because the schemas live inside the plugin endpoints.
- **`guard` / `macro` for cross-cutting auth:** applicable in principle to the
  `/api/dash/*` routes (**L10**, **M10**), but the established pattern is
  `requirePermission` inside the handler, and hoisting authorization into a macro
  would move it _further_ from the transaction that **L10** needs it inside. No
  gain by this codebase's priorities.

Trade-off, stated explicitly: keeping this validation in the auth layer rather
than the framework layer costs nothing here — the alternative is not simpler, and
it preserves the framework-independent boundary the project wants. Elysia-specific
coupling would buy no security, correctness or maintainability gain for these
findings.

## 8. Reported but excluded, with reasons

- **`C7` — new strings are not English.** Not a defect. User-facing copy in this
  codebase is Arabic by pre-existing convention (`utils/api-messages.ts`,
  `utils/otp.ts`, `lib/permissions/constants.ts`), and
  `utils/validation/two-factor.ts:157` is a Zod message shown to a user.
  `CLAUDE.md` Baseline 1 governs code and communication, not localized product
  copy; the startup gate a few lines above logs in English, so no operator-facing
  string is affected. If the rule is meant to cover product copy, that is a
  `CLAUDE.md` clarification, not a 2FA finding.
- **`N4` as written** — superseded by `D1`; the live residue is **L7**.
- **`F5`, `F17`, `F28`, `N3`** (the two OTP endpoints) and the landed halves of
  `F2`, `F3`, `F12`, `F29`, `F30` — correct, and not repeated as findings. Where a
  landed half is incomplete, the gap is a finding above and says so.
- **`D16`'s method-aware known set** — contested, deliberate design, no
  demonstrated defect (§5).
- **`F2`'s snapshot race** without the row lock — the generic form is accepted in
  `should-ignore.md` #54 and known-issue 1; noted under **H3** only because the
  finding asked for the lock explicitly.
- Positive remarks in the source logs (the landed `D16` items, the method-aware
  runtime routing, the deterministic phone fixtures, credit for work ahead of its
  step) are dropped: this report records defects.
- L3's process note about incidentally line-counting the other two logs is a
  process matter, not a defect.

## 9. Recommended repair order

**Step 0 — cheap, now, blocked on nothing.** Each is a few lines and each is
currently a route from a normal event to a locked-out account or a wasted budget:

1. **H3** mode B — `offeredMethods(state).length === 0` in place of
   `state.intent.length === 0`.
2. `N2` (**H5**) — the TOTP after-hook must not throw; retry or record a
   repairable state.
3. **M9** — give `two_factor` its own OTP verify-quota key.
4. `F10` (**H5**) — `sessionUser` returns the session id it already read.
5. **M12**(a) — split the refusal audit reason by cause.
6. **M1** and **L3** — correct the comments that assert controls which do not
   exist, whether or not the controls land this week.

**Then, in order:**

1. **H1** — keep enforcement installed under an empty method list, make the three
   first-factor paths agree, and keep the operator reset reachable.
2. Finish the repairs recorded as landed: **M1** (server-enforce registration UV),
   **M7** (monotonic counter), **M6** (wire the restore branch), **L10** (move the
   reset's authorization inside its lock) — each with the test that would have
   caught it (**M17**).
3. **H5** — the owned enable/disable/removal lifecycle, with set-version-bound
   backup acknowledgement (cleared on regeneration, capability counting unused
   codes). Not mandatory acknowledgement — see `P0` and the withdrawn `D5`.
4. **H4** with **M8**, **M15** and **M13** — immutable exact-option challenge
   state, remember handling, stable option identity, and the complete factor
   chain in the audit trail. Choose the discriminator per **M2** first.
5. **H3** mode A — the disjoint-factor recovery grant; then **L7**, removing the
   startup overlap refusal it replaces.
6. **H2**, **H6**, **M3**, **M4**, **M5**, **M10**, **M11**, **M12**, **M18** —
   configuration correctness, contact-coupled invalidation across the whole class,
   trust revocation, administrator re-authentication, rotation cleanup, the
   preflight, and the configuration matrix.
7. **M14**, **M16**, **L1**–**L9** — contract unions and bodies, purpose-aware
   messages with a test outbox, indexes, the drift test, comments, validation
   bounds, dependency placement, and the unrelated drift.

## 10. Verification

### Suites, as run by the three logs on this tree

| Command                                           | Result                                                        | Source |
| ------------------------------------------------- | ------------------------------------------------------------- | ------ |
| `bun run lint` (tsc + eslint)                     | pass, zero warnings                                           | L3     |
| `bun run test` / `bun tests/helpers/run.ts unit`  | 875 pass, 0 fail, 3 201 expectations, 184 s (L3) / 296 s (L1) | L1, L3 |
| `bun run test:integration`                        | 332 pass, 0 fail, 1 793 expectations, 78 s (L3) / 89 s (L1)   | L1, L3 |
| `bun run test:process`                            | 50 pass, 2 skip (Windows), 0 fail, 55 s (L3) / 98 s (L1)      | L1, L3 |
| `bun tests/helpers/run.ts integration two-factor` | 37 pass, 0 fail, 104 expectations, 5 files, 38.8 s            | L2     |
| `bun tests/helpers/run.ts unit two-factor`        | 17 pass, 0 fail, 40 expectations, 2 files, 3.2 s              | L2     |
| `bun tests/helpers/run.ts unit password-proof`    | 10 pass, 0 fail, 16 expectations, 1.2 s                       | L2     |
| `bun tests/helpers/run.ts unit openapi-contract`  | 50 pass, 0 fail, 1 086 expectations, 7.8 s                    | L2     |
| `git diff --check`                                | clean                                                         | L3     |

Everything is green, and **M17** and **M18** are why that is not the reassurance
it looks like: three of the repairs recorded as landed are absent, and one
configuration is the only one the suites exercise.

### Verified for this consolidation

Read-only inspection of the working tree, no code, test or comment changed, no
suite re-run. Each of these settled a disagreement between the logs or a
single-source Critical claim:

| Claim                                                              | Evidence                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H1** — enforcement disappears with the method list               | `utils/validation/two-factor.ts:65` (`TWO_FACTOR_ENABLED = ENABLED_TWO_FACTOR_METHODS.length > 0`); `lib/auth/two-factor.ts:175-199` (`twoFactorPlugins` is `[]`); the issuer after-hook at `:80-107` is inside `twoFactorAuth()`; `lib/auth/passwordless.ts:277` calls the issuer with no such gate; `app/api/dash/users/[id]/two-factor/handler.ts:44-45` returns 404 |
| **M1** — registration UV is not enforced                           | `@better-auth/passkey/dist/index.mjs:355` (`requireUserVerification: false`), installed version 1.7.2; `lib/auth/two-factor.ts:185-194` passes only `authenticatorSelection`                                                                                                                                                                                            |
| **M7** — a lost counter swap is accepted                           | `lib/auth/two-factor-passkey.ts:98-104` (`eq(passkeys.counter, from)`), caller at `:303-314` logs and continues                                                                                                                                                                                                                                                         |
| **M3** — the stranding guard is a single instance                  | `contactChangeStrandsTwoFactor` has one call site (`app/api/dash/users/[id]/handler.ts:637`); no 2FA reference anywhere under `app/api/dash/users/me/`                                                                                                                                                                                                                  |
| §5 — the passkey clause belongs to the reset, not to rotation      | `app/api/dash/users/[id]/two-factor/handler.ts` deletes `passkeys` inside its own transaction                                                                                                                                                                                                                                                                           |
| §5 — the OpenAPI keying is deliberate                              | `lib/http/openapi.ts:1499-1512`, with the reasoning in its own comments                                                                                                                                                                                                                                                                                                 |
| §7 — Better Auth paths are not Elysia routes                       | `app.ts:463-475`, one wildcard forwarding to `auth.handler` behind `betterAuthServes`                                                                                                                                                                                                                                                                                   |
| §4 — every row that recorded a correction to the tracking document | the (now archived) tracking document at the lines each row cited; the pass corrected the `passkeys` row's target from `F23` to `F4` (507) and sharpened four others                                                                                                                                                                                                     |

### Limitations

- No suite was re-run for this consolidation; the table above is the three logs'
  reported output, and I did not re-execute it.
- Findings that only one log reported and that neither contradicted nor claimed a
  Critical impact were accepted on that log's evidence — chiefly `C5`/**L5**,
  `C6`/**M18**, `C8`/**L6**, `F19`/**M16**, and L1's `N3` conflict (**M2**), whose
  library-order premise I did verify.
- Nothing here was validated against a real browser or authenticator ceremony, a
  production-scale query plan, real email/SMS/WhatsApp delivery, the
  administrative role-change race, or the inverse passkey-counter race. **M7** and
  **L10** follow from statement ordering, not from an executed race.
- The archived tracking document was read where §4 records a correction to it —
  `F3`, `F4`, `F16`, `F23`, `F25`, `F27`, `F31`, `D2`, `D3`, `D5`, `D10`, `D16` and
  its order table. Its remaining finding bodies were not re-read, so every `F`/`N`
  identifier's _meaning_ here is the one the three logs give it. That matters only
  for provenance: the findings below carry their own evidence and this file no
  longer depends on that document.
- §2's Settled policy is the owner's, not a derivation. Where a finding's fix cites
  a decision, the decision governs; where the code contradicts a decision, the
  finding says which one should change and that judgement is the one most worth
  arguing with.
