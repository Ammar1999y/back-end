# Two-factor — independent verification of both repair passes

Written for someone who has not read `two-factor-repair-log.md` or
`two-factor-repair-review.md`. Everything below was checked against the code and
the running suites, not against those reports.

**Verdict: the work is real and mostly correct. Ship-blocking items: two. Both are
self-inflicted lockouts, neither is in either report, and neither needs an
attacker.**

Their suite numbers are true — I re-ran every tier. Their major structural claims
are true — the owned lifecycle exists, the plugin's `enable` / `disable` /
`generate-backup-codes` / `delete-passkey` really are gone from the router, the
companion challenge record really does fail closed, and the schema migration was
measured against live PostgreSQL, not read. What they got wrong is narrower and
sharper than that summary suggests: two claims of _completeness_ that the code
contradicts, and a class swept one level deep by each pass in turn.

---

## 0. Read first — decided, not missed

Nine things in this codebase look like defects and are settled decisions, several
taken after an argument that reversed the obvious answer. Whoever works on this
next was not present for any of it. **Do not "fix" these.** If you believe one is
wrong, say so and leave it; each already survived being challenged once.

1. **A lost pepper compare-and-swap answers 401 on a correct password.**
   `lib/auth/login-guard.ts:391-434` logs the lost race and returns the
   pre-upgrade hash, so the proof fails and the sign-in 401s. The obvious repair —
   re-read the `accounts` row and accept the stored hash — is an **authentication
   bypass**: the concurrent writer may have been a password _change_, and trusting
   that hash lets the **old** password mint a session. Verifying the re-read hash
   against the plaintext still in scope would be correct and was judged not worth
   the complexity for a race this narrow. Settled: log it, let the 401 stand.

2. **An empty `NEXT_PUBLIC_ENABLED_2FA_METHODS` signs enrolled accounts in with a
   password alone.** This reads as critical and is the decision (`H1`). The
   alternative — refusing every enrolled account the moment the feature is rolled
   back — locks out the entire population. What was required is that all three
   first-factor paths _agree_, which is what landed; the downgrade is audited per
   account and the boot log says so. Feature off ⇒ consistent downgrade; empty for
   _this user_ while the feature is on ⇒ refuse.

3. **Nothing about a user's second factor is mandatory** (`P0`). Backup codes are
   not compulsory and acknowledgement is not a gate on enrolment. An earlier
   decision said the opposite and was **withdrawn**. `F9`'s real defects —
   acknowledgement not bound to a generated set, never cleared on regeneration,
   capability not counting unused codes — are fixed without adding compulsion.

4. **There is no enrolment-time refusal of an OTP channel that overlaps the
   recovery channel.** Two variants were proposed and both rejected: the offered
   set is decided at method selection, not at enrolment, so refusing at enrolment
   closes nothing an attacker cannot walk around. Enforcement lives on the
   authentication chain (`D1`). The startup refusal that used to exist is now a
   warning **on purpose** (`L7`) — do not restore it.

5. **`D9`'s "auto-send at most once per challenge" is not implementable
   server-side.** Both repair passes reached this independently and both are
   right: the server cannot distinguish an auto-send from a legitimate resend, and
   the destination send quota already bounds the cost. The decision text is wrong,
   not the code. Correct the text; do not build a per-challenge counter.

6. **A voluntary password change keeps trusted devices; a recovery reset revokes
   them** (`D11`). It used to revoke on both. A password change that leaves trust
   standing is the decision, not a regression. What _is_ missing is the
   notification that should accompany it — see §6.

7. **`/two-factor/otp/{send,verify}` resolve the session before the challenge.** A
   caller holding both a live session and a live challenge is an enrolment on
   those endpoints. That is the library's own order (`getSessionFromCtx` first),
   adopted deliberately so our discriminator cannot drift from the plugin's
   (`M2`). The reverse — keying on the challenge cookie — guards the wrong branch.

8. **`PASSWORDLESS_ENABLED` is a source constant, not an environment variable**
   (`utils/config.ts:124`). That is this codebase's established pattern for
   switches that change which routes are served. Flipping it is an edit and a
   redeploy, by design.

9. **The 14 pre-existing `db/schema.ts` section banners stay.** They do violate the
   comment policy, and that is known. The decision was to report them and not sweep
   them inside a security diff. Their own commit, separately.

Two accepted narrowings, for the same reason — they are choices, not oversights:
**passkey is not offered as a recovery second factor** (the completion endpoint has
no context to run a WebAuthn ceremony in, so a passkey-only account has no
self-service recovery and needs the operator reset), and **the passkey assertion
ceremony has no end-to-end test** (registration is driven by a synthetic ceremony;
the assertion side needs a real signature).

Everything in §3 and §4 below is the opposite: open because nobody got to it.

---

## 1. What was verified, and how

| Area                                                                                       | Method                                                                 |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Eight security-critical fixes (`M19`, `M3`, `M1`, `M7`, `M6`, `D7`, `M5`, `H1`)            | code read, adversarially                                               |
| Structural ownership (router map, lifecycle, last-method rule, `H4`, schema, `D15`, `L11`) | code read + a live plugin-endpoint probe + real SQL against PostgreSQL |
| Every test tier and `lint`                                                                 | executed                                                               |
| The `H3` severity dispute                                                                  | the archived reproduction                                              |

Not verified: the ~20 findings whose fixes neither report flags as uncertain and
which no claim of completeness covers. If something below does not name a finding,
I did not open it.

## 2. Suites — their numbers hold

| Command            | Claimed           | Measured                        |
| ------------------ | ----------------- | ------------------------------- |
| `bun run lint`     | pass              | pass, zero warnings             |
| unit               | 895 / 0           | **895 / 0**                     |
| integration        | 356 / 0           | **356 / 0**                     |
| process            | "53 pass, 2 skip" | **51 pass, 2 skip** of 53 tests |
| matrix             | 6×6, 0 fail       | **32 pass, 4 skip, 0 fail**     |
| `git diff --check` | clean             | clean                           |

The process line is a double count, not a false claim, and the four matrix skips
were disclosed. Nothing is red.

---

## 3. Ship-blocking

### 3.1 A user can lock themselves out through the supported path

`/two-factor/methods/disable` refuses to remove the last method by counting rows
in `two_factor_methods` — **intent**, never intersected with capability or with
the enabled-method list, unlike `offeredMethods`
(`lib/auth/two-factor-enrolment.ts:570-581`, `two-factor-challenge.ts:1358-1371`).

1. A user enrols `totp` and `otp:email`. Two intent rows.
2. Their email becomes unverified — a contact change — or an operator drops
   `email` from `NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS`. `offeredMethods` now
   returns `[totp]`; the `otp:email` row survives.
3. The user removes `totp`. `enrolled.length === 2`, so **no 409**. Intent is
   dropped, `clearCapabilityFor` sets `verified: false`, and nothing clears
   `users.two_factor_enabled`.
4. Every later sign-in: empty offered set → `withdrawFirstFactorSession` → 403
   `TWO_FACTOR_UNAVAILABLE`. The only exit is the administrative reset.

The same sequence works through `/passkey/delete-passkey`. This is precisely the
state `D2`'s liveness half exists to prevent, reached by a user doing the ordinary
thing, and the comment at `two-factor-enrolment.ts:545-546` records the
intent-counting as deliberate — it is the safer direction against _transient_
capability loss, which is a real argument, but "removing the last usable method is
refused" is not what the code does.

**Fix:** count what a challenge would offer, not what the table holds — and if
intent-counting is kept deliberately, the removal must clear
`two_factor_enabled` when nothing usable survives, or the account is stranded by
design.

### 3.2 A hijacked session can log the legitimate user out of every device

`acknowledgeBackupCodes` (`two-factor-enrolment.ts:458-500`) takes **no
re-authentication**, yet it sets `twoFactorEnabled: true` and calls
`revokeOtherSessions`. An attacker holding one session on an account with a
generated-but-unacknowledged backup set calls it and:

- every other session of the victim dies, the attacker's survives;
- 2FA is now on, with `backup_code` offered;
- the codes were shown once, at generation, to whoever generated them.

No password is required at any step. Contrast `disableTwoFactorMethod`,
`startTotpEnrolment` and `deletePasskey`, which all require a password proof or a
re-auth grant. Acknowledgement is the only transition that flips the flag and
revokes sessions without one.

**Fix:** the transitions that change the flag or revoke sessions belong behind the
same proof as the rest of the lifecycle.

---

## 4. Real, not ship-blocking

### 4.1 `M6` is still charging non-guesses, and the comment says it is not

The agreed rule: only a code that was **compared** spends an attempt. Pass 1 built
the mechanism (`otpGuessWasEvaluated`); pass 2 found the recovery path had not
been swept and fixed the **throw** half. The **return** half is still open:
`verifyRecoveryTotp` and `consumeRecoveryBackupCode` signal non-comparison
failures by returning `false`, not by throwing — missing or unverified credential,
**decrypt failure**, version mismatch, `JSON.parse` failure
(`lib/auth/recovery-second-factor.ts:44,50,78,84,90`). Those never reach the
repaired branch; they land on `if (!proven) await attempt.recordFailure()`
(`forgot-password/complete/handler.ts:160-162`).

The comment three lines above the repaired branch says decrypt failures are
refunded. They are charged. That is a false invariant introduced by the pass that
was removing false invariants.

**Failure sequence:** rotate the encryption key, then five recovery attempts burn
the grant with no code ever compared. Same shape, lower stakes, in the passkey
verifier: a missing or expired ceremony row charges the attempt
(`two-factor-passkey.ts:242-248`).

### 4.2 `setDefaultTwoFactorMethod` is unaudited and unproven

The only 2FA state mutation in the lifecycle file with **no audit row** and **no
re-auth** (`two-factor-enrolment.ts:600-651`). A hijacked session can re-point the
challenge default at whichever enrolled method it prefers — steering the victim to
their weakest factor — and leave no trace in `audit_logs`. Bounded, because a
preference can only reorder within the enrolled set, but it directly contradicts
pass 1's own claim that "every owned lifecycle transition writes an attributable
audit row" (`M12(b)`). `startTotpEnrolment` also writes none.

### 4.3 Enrolment revocation is missing or unsafe for two of the four methods

`D11` and the original `B.5` say adding or confirming a method revokes other
sessions. `confirmTotpEnrolment` and `acknowledgeBackupCodes` do.
`recordPasskeyEnrolment` (`two-factor-enrolment.ts:858-882`) enables 2FA and calls
**no** revocation at all. The OTP add calls it **outside** the proof transaction
with the failure swallowed (`two-factor-otp.ts:438-452`) — which is `F10`'s
original split-commit shape, surviving in the file that closed `F10` elsewhere.

### 4.4 `/passkey/verify-authentication` is one line from being served

Pass 1's "the plugin's endpoints are removed from its map" is true for the four it
names. It is not true of `/passkey/generate-authenticate-options` and
`/passkey/verify-authentication`, which are still in the map — and the second is
the unauthenticated credential-by-id → `createSession` endpoint that the whole
design exists to keep unrouted. Its entire defence is the allow-list. Compare
`/two-factor/enable`, which is defended three ways. Removing it from the map the
way the other four were removed costs one destructure.

### 4.5 The plugin can silently win a path collision

`checkEndpointConflicts` in the installed library only calls `logger.error`; it
never throws, and key-collision resolution is plugin-order dependent.
`passkeyManagement()` registers after `twoFactorEnrolment()`, both using the key
`deletePasskey`. If the destructure at `two-factor.ts:238` were ever dropped, the
library's version would silently overwrite ours. The comment there claims "two
endpoints cannot claim one path"; upstream does not enforce that.

---

## 5. Where the two passes were right, and where they were not

### Pass 1 (`two-factor-repair-log.md`)

**Right, and worth keeping:** the `M17` discipline is genuine — I re-verified the
fixes it names and they are in the tree. `M19` is implemented exactly as settled
(logged, 401 stands, no re-read — the one that would have been an authentication
bypass). `M3`'s three rules all hold, including the one that matters: nothing in
either contact path writes `two_factor_enabled`. `M1` rejects on the **signed** UV
bit, before persistence. `M7` is a true monotonic maximum. `M5`'s ordering is
right. Its pushbacks `§4.2`–`§4.5` are all sound, and `§2.3` — widening `M9` from
`two_factor` to the whole surface class — is better than the finding asked for.

**Wrong:** `§4.1`. It argues that `H3` mode A's stated impact is overstated —
"after the reset the attacker faces a challenge they cannot complete". For the
scenario mode A actually describes (`totp` **and** `otp:email` enrolled) the
challenge offers the email OTP, because a password first factor applies no contact
exclusion by design. The attacker completes it. This is not an inference: the
archived `two-factor-plan-codex-review.md` §2 records the takeover as
**reproduced** with a temporary test — "the reset, new-password sign-in, email 2FA
OTP, and issued session". Consequence is low (it fixed the finding in full anyway),
but the reasoning is wrong.

**Its two real process failures**, both claims of completeness rather than gaps:

- "a challenge with no state row resolves to `null`, **so every verifier fails
  closed**" — true of the four it wrote, false of the two it kept from the library.
  `D7` explicitly asked for a before-hook on those two paths. It was not built, and
  it appears in neither the landed list nor the not-closed list.
- "**every** owned lifecycle transition writes an attributable audit row" — two do
  not (§4.2).

`§5.1` (scoping `D15` out) was recorded honestly, but it was a settled-policy item,
and scope on those is not the implementer's call.

### Pass 2 (`two-factor-repair-review.md`)

**Right:** every defect it reports in §2 is real, and finding the `D7` gap is the
single most valuable thing either pass did after the first pass's own work — the
plugin's backup-code verifier was completing logins with codes the challenge never
offered, including sets the user never acknowledged. The stale `dont_remember`
marker, the passwordless `rememberMe`, the passkey-delete stranding, the partial
`M14`, and the lock-order swap are all confirmed. Building `D15` and the `D9` hint
over pass 1's objection was the correct call.

**Wrong:** it endorsed `§4.1` ("Correct on the facts") without checking, so the one
error both passes share is the one the review existed to catch.

**Its own sweep was partial in the same shape it criticised.** It titled §2.4 "the
`M6` class not swept", fixed the throw path, and left the return-false path in the
same file — under a comment that names the exact case it does not handle (§4.1
above). And its opening verdict, "every item its log marks as landed is in the
tree", is true and not the question: §2 then demonstrates that _in the tree_ and
_complete_ are different, which is the distinction the whole exercise turns on.

### Both, about the audit

`M14`'s "eight custom endpoints" undercounts — there are eleven. `D9`'s
"auto-send at most once per challenge" is stated as a server property and is not
one the server can enforce without blocking legitimate resends; both passes
independently reached that and both are right. `H3`'s failure scenario should be
corrected in the opposite direction to the one they propose — see §5, pass 1.

---

## 6. Open work, correctly recorded by both passes

The accepted narrowings are in §0 and are not repeated here. What is left is real
work nobody has done:

- **`D11`'s notification on a voluntary password change.** The revocation policy is
  now correct per event — keep trust on a voluntary change, revoke it on a recovery
  reset. The notification that should accompany the first is not built, because
  this codebase has no transactional-mail path other than the OTP sender. Build the
  notification; **do not** close the gap by reverting to revocation (§0.6).
- **No executed race** for the passkey counter, the administrative reset's lock, or
  the recovery grant's single use. Each follows from statement ordering and a
  `WHERE` clause; none has a deterministic harness.

Two smaller residuals neither pass names:

- `db/drizzle/0007_*.sql` opens with `DROP INDEX` with no `IF EXISTS`, so replaying
  it against a database that never had `0006` aborts the migration.
- `OTP_DELIVERY=outbox` is refused when `NODE_ENV === 'production'`. A deployment
  that boots as `development` accepts it and silently delivers no OTP at all —
  including recovery. That is the codebase's standing posture model, not a defect
  in this feature, but it is the failure mode with the widest blast radius.

## 7. What I would do next

1. **§3.1 and §3.2** before anything else. Both are lockouts, both are cheap, and
   neither is in any report.
2. **§4.1** — finish the `M6` sweep and delete the false comment, or make it true.
3. **§4.4** — one destructure, and it removes the last undefended path in the
   feature.
4. **§4.2 and §4.3** — the two lifecycle transitions missing their proof, audit
   and revocation.
5. **Update `reports/two-factor-final-audit.md`.** Both passes say it, and both are
   right: its `Where:` lines describe code that no longer exists. It is still the
   plan and the policy, and it is no longer a description. Whoever picks this up
   next will read it as one.

Nothing here needs a decision from you except §3.1's shape — whether the
last-method rule should count usable methods, or keep counting intent and clear
`two_factor_enabled` when nothing usable survives. Either closes it; the first is
what the policy says and the second is what the current comment argues for.

---

## 8. Round three — everything above was addressed. Re-verified.

`§8` of `two-factor-repair-review.md` is the response. I re-checked it against the
code and re-ran every tier. **Six of seven fixes verified, one partial. Both
ship-blockers are closed.**

| Item                        | Verdict                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3.1 last-method rule       | **VERIFIED.** `removalStrandsTwoFactor` calls `offeredMethods` itself, so it inherits the capability intersection _and_ the enabled-method/channel lists. Evaluated inside the deleting transaction under the user lock at both endpoints; the flag is written in neither. The lockout sequence now 409s.           |
| §3.2 acknowledgement proof  | **VERIFIED.** `requireReauthPassword` before the transaction that flips the flag and revokes sessions; `{}` answers 401 and a wrong password 401s through `verifyLoginAttempt`. Measured live.                                                                                                                      |
| §4.1 attempt budget         | **PARTIAL** — see below. The recovery half is fully correct; every non-comparison branch now returns `unavailable` and refunds, and only a wrong code charges.                                                                                                                                                      |
| §4.2 audit rows             | **VERIFIED.** Both inside their transactions, and `auditLog` swallows nothing, so a failed audit rolls the transition back.                                                                                                                                                                                         |
| §4.3 enrolment revocation   | **VERIFIED.** Passkey revokes inside its transaction keeping the caller's session; the OTP revoke is the last statement of `onVerified`, inside `processOtpVerify`'s transaction with no `try` around it, so a throw rolls back the enrolment and the code consumption together.                                    |
| §4.4 passkey auth endpoints | **VERIFIED by enumeration**, not by reading: the composed map with all four methods enabled has no `/passkey/generate-authenticate-options` and no `/passkey/verify-authentication`.                                                                                                                                |
| §4.5 drift test             | **VERIFIED, and better than its own description.** The review text says "the three destructured keys"; the test actually asserts all **six**, read from the installed packages. It does not assert the reverse direction — deleting a destructure line is caught by the allow-list and the passkey suite, not here. |

Suites re-run on the final tree: lint clean, unit **896**, integration **358**,
process **51 pass + 2 skip** of 53, matrix 6×6 with 0 fail, `git diff --check`
clean. Every claimed number matches.

Their two "answered rather than changed" items are correctly answered. The
`0007` `DROP INDEX` cannot be reached by a database that never applied `0006`,
because the journal is ordered — hand-editing generated SQL to survive an
unsupported replay would be the divergence. And `OTP_DELIVERY=outbox` booting
under `development` is the same posture model that permits `/api/dev/sign-up`;
the production refusal is the control.

The re-authentication they declined on `/two-factor/methods/default` is bounded,
and I checked it independently rather than taking the argument: the target must
already be in `listEnrolledMethods` or the call 404s, `is_default` is read in
exactly two places, and `AUTO_ROUTABLE` excludes `backup_code`. The whole
reachable effect is the order of the offered list — worst case steering a victim's
next challenge onto their own verified email or phone OTP. Nothing escapes the
enrolled set. The reasoning belongs at the endpoint, though; today it lives only
in the report.

### 8.1 The one still open — Low, and it is the same defect a third time

`lib/auth/two-factor-passkey.ts:329` sets `settled = true` **before** the counter
write at `:337`. The comment at `:224-231` promises that "a counter write that
throws gives the attempt back"; it does not — a throw out of
`advancePasskeyCounter` skips `attempt.restore()` at `:366`.

Failure sequence: a valid assertion, then the `UPDATE passkeys SET counter`
statement faults (pool exhaustion, lock timeout). The attempt row stays deleted,
every later `spendChallengeAttempt` on that challenge returns `ok: false`, and the
user is answered `tooManyAttempts` until the cookie expires. Fail-closed, no
attacker, the user's own sign-in is stranded once.

The severity is Low. What is worth naming is the shape: this is the **third**
round in which a comment promising a refund sat above code that charges — first in
`processOtpVerify`, then in the recovery completion, now in the passkey verifier —
each time introduced by the pass that was closing the previous one. Moving
`settled = true` to after the counter write, or narrowing the comment, closes it.
No test asserts either enrolment revocation from §4.3 either; both are code
reading only.

### 8.2 Where this stops

Three rounds of independent verification have taken the open list from two
ship-blocking lockouts to one false comment and one unasserted refund path. That
is the point at which further rounds cost more than they return. Close §8.1, add
the two revocation assertions if they are cheap, update
`reports/two-factor-final-audit.md` so its `Where:` lines describe the code that
exists — and stop.

### 8.3 Closed

All three landed and were re-verified against the code:

- `two-factor-passkey.ts:349` — `settled = true` now follows the counter write at
  `:337`, so a throw out of `advancePasskeyCounter` reaches `attempt.restore()`.
  The comment at `:224-231` is now true of the code beneath it.
- Both revocation assertions are in place (`two-factor-otp.test.ts:166`,
  `two-factor-passkey.test.ts:263`): a second device signed in before the
  enrolment is evicted and the caller's session survives.
- `two-factor-final-audit.md` opens with a status notice that names every finding
  as closed except the recorded open items, marks the `Where:` and `Evidence:`
  lines as describing the pre-repair tree, and points at the files that own each
  transition today. The findings and the settled policy are untouched.

The decision not to re-run the unit, process and matrix tiers is sound:
`lib/auth/two-factor-passkey.ts` is imported by exactly one test file, and it is
in the integration tier. Integration re-run here: **358 pass, 0 fail**, with
`expect()` calls at 2016 against 2010 before — the six new assertions sit inside
existing tests, which is why the test count did not move.

**Nothing is open that this work introduced.** What remains is the recorded list
in §0 and §6: `D11`'s notification, passkey as a recovery factor, an end-to-end
passkey assertion test, and the 14 pre-existing banners — each a separate piece of
work with its reason on record.
