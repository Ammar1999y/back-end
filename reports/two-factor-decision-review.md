# The final audit, read against the decision history

`reports/two-factor-final-audit.md` was produced by readers who had the tracking
document but not the thread that produced it. This is what changes when the
decisions and their reasoning are put back.

Checked: every finding against the settled decisions `D1`–`D16`, the corrections
made after the tracking document was written, and the source reasoning in
`reports/two-factor-verification.md`. Not checked: whether the findings are true
of the code — three independent readers already did that, and I did not repeat it.

**The consolidation is faithful about defects and lossy about the constraints
attached to their fixes.** Three qualifiers that exist in the tracking document
are absent from the final audit, and each one exists precisely because someone
already considered the obvious repair and rejected it. One of them is not merely
absent — the final audit states the repair its source forbids.

---

## 1. `M19` prescribes the fix that was explicitly rejected

**This is the one that must not reach an implementer as written.**

`M19`'s **Fix**: "re-read the row after a lost swap and mint the proof from the
stored hash."

`reports/two-factor-verification.md` §3.14, on exactly that repair:

> re-reading the row and adding its current hash to the accepted set is **wrong** —
> the concurrent writer might have been a password _change_, and accepting that
> hash would let the old password mint a session. The correct repair is to verify
> the re-read hash against the plaintext still in scope before adding it, or to
> log and accept the 401.

The tracking document carries the qualifier verbatim at `D16` (line 252-253): "the
pepper CAS repair **that verifies the re-read hash against the plaintext still in
scope**". The final audit does not — the phrase occurs nowhere in it.

**Consequence of implementing `M19` as written:** the concurrent writer whose hash
is now trusted may have been a password change. The proof then accepts the _old_
password and mints a session. A repair for a narrow 401 becomes an authentication
bypass in the same race window.

**Why it happened:** `M19` was sourced from L2's "outside the document" item 2,
which described §3.14's defect without §3.14's warning. `D16` had the qualifier;
the log did not; the merge followed the log.

**Correction:** `M19`'s Fix is "re-read the row, verify the re-read hash against
the plaintext still in scope, and only then mint the proof — or log and accept the
401." Not the stored hash unverified.

## 2. `M3` drops the constraint that keeps 2a from becoming the bug it repairs

Tracking document, `F29` property 2a (line 1399-1403):

> Invalidate the `otp` intent row for the affected contact kind inside the edit
> transaction, and audit it. **It must not touch `two_factor_enabled`**: clearing
> the flag would let `users.edit` disarm 2FA, which is precisely what
> `lib/permissions/constants.ts:60-65` says `resetTwoFactor` exists to prevent, and
> what `D2`'s safety half forbids.

`M3`'s Fix says only "the contact write must be coupled to the method lifecycle
rather than only refused (`F29` 2a/2b)". The phrase `must not touch` appears
nowhere in the final audit.

The constraint is not decoration. Deleting the last dependent intent row leaves a
user 2FA-enabled with an empty offered set; the obvious tidy-up is to clear the
flag, and that turns `users.edit` into a 2FA disarm — `F29`'s original finding,
recreated by `F29`'s own fix.

`M3` also carries the re-arm mechanism correctly for the self-service path
(`markContactVerified` re-pointing the factor), so this is a dropped constraint,
not a dropped defect.

## 3. `D3`'s exhaustion mechanism and its placement are gone

Tracking document `D3` (line 144-147): forcing regeneration **inside a login** is
the wrong placement; the mechanism is a **low-water warning in an authenticated
session**, with the operator reset as the named exit. `F9`'s Decision line (721)
repeats it.

`low-water` appears twice in the tracking document and zero times in the final
audit. `H5`'s `F9` row carries the defect — acknowledgement never cleared, an
exhausted set still advertised — but neither the warning nor the "not inside a
login" constraint survives. That constraint was the whole disagreement `D3`
settled: a blocking regeneration step inside a login demands compliance from users
at the moment they are least able to give it.

Lower stakes than §1 and §2 — liveness, not access — but it is the half that took
an argument to reach.

---

## 4. Two findings reopen something already decided

**`H1` offers "downgrade every first-factor path consistently" as a live option.**
`D2`'s safety half says an empty offered set never grants access. The audit is not
wrong to reopen it: `H1` is about the _feature_ being off, which is genuinely a
different question from _this user has no usable method_, and `D1`'s possession
invariant is vacuous when there is no second factor at all. `H1`'s own proposal —
let the issuer distinguish the two — is better than a flat reading of `D2`.

But it is a decision, and `H1` currently ships it as an implementer's choice.
Recording it: **feature off ⇒ downgrade consistently on every path; empty for this
user ⇒ refuse.** That is the exception `D2` needs written into it, and it is the
only reading under which the operator reset can stay reachable while the surfaces
are gated.

**`M5` offers "record the exception in `D2`" as an alternative to fixing the
ordering.** Under two decisions already taken, it is not an alternative. `F5`'s
fix binds trust to a proven second factor, and `D4` holds that the recovery
challenge must not honour trusted devices at all. A trust row that outlives the
capability it was granted against is a standing bypass of a factor that no longer
exists — the same shape `F5` closed. `M10` reaches this independently: it is the
first half of the self-disarm chain. **Fix the ordering; do not record the
exception.**

## 5. Where the audit is right and our decisions were incomplete

Recorded so these are not mistaken for the audit overreaching.

- **`H1` (`C1`) invalidates a premise of `D2` that was never checked.** Both
  halves of `D2` assume the issuer runs. It does not exist when the method list is
  empty. That is our gap, not the checker's.
- **`L7` confirms `D1` and dates the contradiction.** The startup overlap refusal
  was written before `D1` was settled, and it implements the configuration-time
  control `D1` rejected. Removing it is not a concession; it is `D1` being applied
  to code that predates it.
- **`M2` supplies the discriminator `D7` never specified.** `D7` says "apply the
  check only in sign-in mode" and does not say how to tell. The library branches
  session-first; a cookie-first check guards the wrong branch. Without `M2`, step 3
  would have implemented `D7` correctly as written and still been wrong.
- **`M15`/`C9` extends `D8` from a schema decision to an API one.** `D8` settled
  the uniqueness shape. It did not settle that `TwoFactorMethod[]`, a method-only
  `defaultMethod`, method-only disable and the `ON CONFLICT` target all need the
  same option identity — and that `D8`'s partial indexes break the current conflict
  target the moment they land.
- **§4's `D5` row is an open decision, not a defect.** `D5` makes backup codes
  mandatory at enable; the configuration contract still permits `backup_code` to be
  omitted from the method list, and `F8` makes it unenrollable when it is. We never
  decided what happens when 2FA is on and `backup_code` is absent. `D2`'s liveness
  half depends on the answer.

## 6. One sequencing correction

`§9`'s step 0 opens with `H3` mode B —
`offeredMethods(state).length === 0` — under the heading "each is currently a route
from a normal event to a locked-out account".

Mode B is worth landing and all three logs are right that it is a one-line change.
But on its own it closes no lockout. The population it serves holds intent rows
with no capability; after the mode-B fix they can reset their password, and then
`offeredMethods` is still empty, so step 0's refusal still refuses the sign-in.
They finish exactly as stuck, one screen later.

This is the same reasoning that rejected deferring the recovery exclusion to the
next sign-in: a repair that moves where a user is stuck buys nothing. Mode B is
still correct — a permanent unexplained refusal is worse than a permitted reset —
but it should not be counted as closing the lockout, and it must not displace what
does: `D5`'s backup codes plus an operator reset that is actually reachable, which
`H1` shows it currently is not.

---

## Verdict

The consolidation is sound. Its findings are, as far as the decision history can
judge them, correctly stated and correctly severity-rated, and four of them
(`H1`, `M2`, `M15`, `M17`) tell us things our decisions did not know.

It should not be handed to an implementer in this state, for one reason: §1. A
repair that the source material explicitly identifies as creating an
authentication bypass is written into the report as the recommended fix.

## Needed before the work starts

1. **`M19`'s Fix corrected** to the `D16` wording. Non-negotiable.
2. **`M3`'s Fix restores** "must not touch `two_factor_enabled`", with the reason.
3. **`D3`'s mechanism restored** into `H5`'s `F9` row: low-water warning in an
   authenticated session, never a blocking step inside a login.
4. **A decision on `H1`'s policy** — §4 above is my position, but it is a decision
   to take, not to leave in the report as a choice.
5. **A decision on `D5` versus the configuration contract** — §5, last item.
6. **`M5` closed as "fix the ordering"**, not as a `D2` amendment.

Items 1–3 are restorations of text that already exists in
`reports/two-factor-audit.md`. Items 4–6 are decisions only the owner of the
policy can take.
