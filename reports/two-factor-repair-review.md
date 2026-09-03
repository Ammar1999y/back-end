# Two-Factor Repair — Second Pass and Review

Second pass over `reports/two-factor-final-audit.md`, run against the tree the
first repair pass left behind (`reports/two-factor-repair-log.md` is that pass's
own record). Two jobs, kept apart below:

1. **Review** of the first pass — are its fixes correct, did they introduce
   anything, do they follow `CLAUDE.md`, and do its pushbacks hold (§1, §2, §7).
2. **Repair** of what it left open or got wrong, against the same policy (§3–§6).

§2 (defects in the handed-over tree) and §7 (where I disagree with the first
pass) are the parts worth reading first.

Baseline for this pass: the uncommitted working tree as handed over, `HEAD` =
`25c7d4f`. Every tier was re-run on that tree before any edit, and all of the
first pass's suite claims hold:

| Command                                | Result                             |
| -------------------------------------- | ---------------------------------- |
| `bun run lint`                         | pass                               |
| `bun tests/helpers/run.ts unit`        | 895 pass, 0 fail (180 s)           |
| `bun tests/helpers/run.ts integration` | 348 pass, 0 fail (78 s)            |
| `bun tests/helpers/run.ts process`     | 52 pass, 0 fail (70 s)             |
| `bun tests/helpers/run.ts matrix`      | 6 configurations × 4 tests, 0 fail |

What follows is about what those suites did not assert.

---

## 1. Review verdict on the first pass

**Substantially correct and high quality where it landed; incomplete in ways its
own log does not record.** The design decisions are the audit's, the code
follows the dominant patterns of the codebase (shared boundary in the Better
Auth before-hook, one lifecycle module, `withTransaction` + `lockUser` in
canonical order, `auditLog` inside the mutating transaction, `envelopeResponse`
on every owned endpoint), and the M17 discipline — a test that fails with the fix
removed — was applied to the repairs it names. I re-verified the ones it recorded
as landed by reading the code and, where the code alone was not enough, by
running behaviour; every item in its §1 tables is present in the tree.

What it got wrong falls into three groups:

- **Claims of completeness that the plugin's two verifiers contradict.** The log
  says of H4 "a challenge with no state row resolves to `null`, so every verifier
  fails closed". That is true of the four verifiers this deployment wrote and
  false of the two it kept from the library: `/two-factor/verify-totp` and
  `/two-factor/verify-backup-code` never read the companion record, and nothing
  sat in front of them. The `D7` before-hook the audit asked for was simply not
  built (§2.1). Likewise M8: the marker is cleared "on completion and on
  cancellation" only on the owned paths; the plugin's completion path still read
  the stale cookie (§2.2), and the passwordless first factor honoured
  `rememberMe` only when a challenge followed (§2.3).
- **A class swept on one instance.** M6's "charge guesses only" rule was applied
  to the sign-in challenge and not to the recovery grant, whose attempt budget
  the same pass created — and the recovery handler's comment claims the rule it
  does not implement (§2.4). M5/D11's "a deleted last credential revokes trusted
  devices" was left open (its §2.4 says it "belongs with H5") and then H5 landed
  without it; the passkey plugin's `delete-passkey` deleted the row and nothing
  else (§2.5).
- **Items marked landed that are partial.** M14: `BETTER_AUTH_BODIES` still had
  two entries, so the eleven owned endpoints published `z.record` bodies; the
  "exact request schemas" it reports are the Elysia recovery/re-auth routes,
  which M14 never asked about (§2.8). M12(b): the OTP and passkey enrolments
  wrote no lifecycle audit row while the log says "every owned lifecycle
  transition" does (§2.7).

Nothing it changed introduced a regression I could find, with one lock-order
exception (§2.6) that is a latent deadlock rather than a behaviour change.

### CLAUDE.md adherence

Followed: English only; assumptions stated; shared boundaries over parallel
paths; consistency with neighbouring code; every behaviour claim backed by a
tier run; verification by behaviour rather than by lint.

Not followed, systematically: the **Comments** section. The first pass wrote
long comments that narrate what the code used to do and why it was changed —
"It used to live inside `twoFactorAuth()`…", "The previous version read the
enrolled set through the pool and then deleted…", "It used to check only that
SOME factor survived…", "it used to be the one sitting behind nothing while…",
"Every purpose used to produce a byte-identical message…". `CLAUDE.md` names
change history explicitly under _Never_, and says a trap gets a clause, not a
paragraph. Many of the `⚠️` blocks are paragraphs. I trimmed the eight clearest
history-narrating comments in the 2FA modules to the invariant or constraint they
protect (`lib/auth/two-factor.ts`, `two-factor-otp.ts`, `two-factor-enrolment.ts`,
`recovery-grant.ts`, `forgot-password/reset/handler.ts`,
`users/[id]/two-factor/handler.ts`, `utils/otp.ts`). The remaining long blocks
each do explain a deliberate choice that looks wrong or a non-local coupling, so
they are within the rule, if longer than it asks for; I left them. Test-file
comments were left alone — they document what a case proves, which is what a
test comment is for.

One `CLAUDE.md` Types point: `lib/auth/two-factor-passkey.ts` casts the request
body to SimpleWebAuthn's `AuthenticationResponseJSON`. That cast predates this
pass and is acceptable — the library verifies the shape at runtime and throws
into a catch that answers 401 — but a Zod mirror of that type would drift from
the library, so I kept the cast and said so at the site.

---

## 2. Defects in the handed-over tree

Each was confirmed against the code and, where the code alone did not settle
it, against a run. "Fix" is what this pass did; §5 has the test that fails
without it.

### 2.1 The plugin's backup-code verifier completed logins the challenge never offered (H4 / D7)

`node_modules/better-auth/dist/plugins/two-factor/backup-codes/index.mjs`: in
sign-in mode the verifier requires a `twoFactorCredentials` row and a code in
the encrypted blob. It does not read `two_factor_methods`, the acknowledgement
version, or the `2fa-state-<challenge>` record. So:

- a set generated and never acknowledged — `backup_code` is not in the offered
  set, the challenge says `['totp']` — completed the login with a real code;
- a `backup_code` method removed through `/two-factor/methods/disable`
  (`clearCapabilityFor` nulls the acknowledgement and leaves the blob) stayed
  usable at sign-in;
- a TOTP confirmed after issuance, or a set acknowledged mid-flight, widened the
  set the user was challenged on — the "never widen" rule the companion record
  exists for.

The TOTP verifier is narrower (it refuses `verified === false`) but has the same
issuance gap. **Fix:** `assertPluginVerifierOffered` in `lib/auth.ts`, in front of
both plugin paths, in sign-in mode only, requiring the path's method to be in
`resolveTwoFactorChallenge(ctx).methods` — the issued set narrowed by current
capability. The static path→method map is `PLUGIN_VERIFIER_METHOD` in
`two-factor-challenge.ts`, which `TRUST_DEVICE_STRIPPED_PATHS` and the after-hook
now derive from too. The after-hook also records the completion event and cleans
the two companion rows, which the plugin's `valid()` left to expire (M13's chain
was missing for these two paths as well).

### 2.2 The plugin's verifiers sized the session from a stale `dont_remember` marker (M8)

The plugin's `valid()` reads the `dont_remember` cookie alone. `/sign-in/email`
sets it on `rememberMe: false` and never clears it on `rememberMe: true`, and
nothing on the plugin completion path cleared it either — so a "do not remember"
login followed by a remembered one in the same browser, both completed through
TOTP, gave the second a one-day row. This is the exact scenario M8 describes,
still live on two of the six completion paths. **Fix:** `carryRememberChoice` in
`issueTwoFactorChallenge` writes the marker from what THIS sign-in submitted
(set for `false`, expired for `true`) before any verifier can read it, which
makes the plugin's paths agree with the companion record by construction.

### 2.3 Passwordless login without a second factor ignored `rememberMe` (M8 / D10)

`lib/auth/passwordless.ts` read the field only to hand it to the challenge; the
direct completion called `createSession(userData.id)` and `setSessionCookie(ctx,
{ session, user })` with no choice at all — a 28-day row whatever the client
asked. D10 names "every first-factor path". **Fix:** `passwordlessVerifySchema`
(the verify union plus `rememberMe`, published in the contract), and the direct
completion passes the choice to both the row and the cookie, clearing the marker
in the positive case.

### 2.4 The recovery completion charged non-guesses against the grant budget (M6 class)

`app/api/auth/forgot-password/complete/handler.ts` called `recordFailure()` for
every throw out of the proof step, under a comment saying it charges compared
codes only. A completion submitted before any second-factor code was sent — no
proof row — spent one of five attempts; five of them exhausted the grant with no
code ever compared. `otpGuessWasEvaluated` was already exported for exactly this
and used by the sign-in path. **Fix:** the same branch the sign-in verifier uses.

### 2.5 Deleting the last passkey stranded the account and kept every trusted device (M5 / D11 / H5)

The plugin's `/passkey/delete-passkey` deleted the row and nothing else. For a
passkey-only account that left `two_factor_enabled = true`, an intent row, no
credential, and a 403 at the next sign-in — the state the last-method rule on
`/two-factor/methods/disable` exists to refuse. For an account with another
method it left the `passkey` intent row pointing at nothing and every trusted
device standing, a skip of a factor that no longer exists. The audit lists this
under M5 ("a deleted last credential") and D11; the first pass's log records the
trust half as "still open, belongs with H5" and then closed H5 without it.
**Fix:** the path is served by `lib/auth/two-factor-enrolment.ts`, with the
plugin's `deletePasskey` removed from its endpoint map exactly as `enableTwoFactor`
was: one transaction under the user lock, ownership in the `WHERE`, the
last-method 409 when the passkey is the only method and this is its last
credential, and when the last credential goes with another method remaining, the
`passkey` intent row is removed, a lifecycle audit row is written and
`revokeTwoFactorState` runs. The re-authentication grant, the live-session check
and the input bounds still apply through the before-hook. The response is this
application's envelope; the 404 and 409 are published in
`BETTER_AUTH_PATH_STATUSES` and the contract test's measured table.

### 2.6 The recovery completion took locks out of canonical order

`complete/handler.ts` deleted the grant's `verifications` rows and then took
`users … FOR UPDATE`. Every other writer of a user's `verifications` rows
(`revokeVerificationArtifacts`, the lifecycle transactions) holds the user lock
first, so two such transactions could each hold what the other waited for.
Narrow — it needs a recovery completion racing a rotation for the same user —
but it is the ordering rule this codebase states in `rotation.ts` and the fix is
a swap of two statements. **Fixed.** No test: an executed deadlock is not
something the harness can produce deterministically.

### 2.7 OTP and passkey enrolment wrote no lifecycle audit row (M12(b))

`auditLifecycle` was module-private to the enrolment file and called by the five
transitions there. `verifyForEnrolment` in `two-factor-otp.ts` and
`recordPasskeyEnrolment` wrote intent and the flag with no attributable event, so
"who added this factor, and when" was unanswerable for two of the four methods.
**Fix:** `auditLifecycle` is exported and both write `twoFactorMethodAdded`
inside their transactions; `recordPasskeyEnrolment` now takes the request
session it needs for that.

### 2.8 M14 was partial: the owned endpoints still published generic bodies

`BETTER_AUTH_BODIES` had two entries. The eleven endpoints this deployment wrote
declared `z.record(z.string(), z.unknown())` to Better Call and parsed narrower
shapes by hand, so the document said "any object" for every one of them — the
exact defect M14 records. **Fix:** one schema per endpoint in
`utils/validation/two-factor.ts`, used by the endpoint AND published, so the two
cannot drift: `twoFactorPasswordSchema`, `twoFactorTotpConfirmSchema`,
`twoFactorMethodOptionSchema`, `twoFactorMethodDisableSchema`,
`twoFactorOtpSendSchema`, `twoFactorOtpVerifySchema`,
`twoFactorPasskeyVerifySchema`, `ownedRowSchema`. The unused
`twoFactorMethodSchema` is gone.

### 2.9 Smaller

- `/two-factor/methods/default` answered `otp:unknown` when `contactKind` was
  omitted for an OTP row, although the row it had just updated knew its kind.
  Fixed to return the resolved identity.
- `.env`'s `NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS` block still said the boot
  refuses the overlapping configuration; L7 made it a warning. Fixed, and the
  block now documents `OTP_DELIVERY`.
- `docs/passkey.md` documented the plugin's `delete-passkey` contract as this
  deployment's. A callout now says what is different.

---

## 3. Policy items the first pass left open, closed here

### 3.1 D15 — the test outbox (and the second half of M16)

`OTP_DELIVERY=outbox` (`utils/validation/otp.ts`) routes `sendOtp` to an
in-memory outbox (`utils/otp-outbox.ts`) instead of a provider. Parsed strictly
(`provider` | `outbox`, anything else fails the boot) and **refused in
production at load**, with a process-tier test that boots a production posture
with it set and asserts the refusal. The plaintext code is held in memory and
never logged — the seam sits inside `sendOtp`'s containment boundary, before any
provider call.

The `matrix` tier runs with it (its `env`), and `tests/matrix/two-factor-configuration.test.ts`
now asserts, per configuration row: that a recovery code and a login code to the
same address carry different subjects and their purpose's text; and that a
second-factor code reaches **every enabled 2FA channel** — including WhatsApp in
the `otp-whatsapp` row, which no test exercised before — with the `two_factor`
text. The integration tier keeps its provider stubs on purpose: several of its
files assert on the provider call itself.

Why the matrix tier and not a runtime toggle: the mode is read at module load
like every other OTP configuration, and a function tests could flip at runtime
would be a production code path whose only caller is a test.

### 3.2 D9 — the `otp.nextAllowedIn` hint

`withOtpSendHints` attaches `nextAllowedIn` to each `otp` option in the challenge
response, from `verification_sessions.next_allowed_at` for the user's
`two_factor` proof rows. One indexed read per challenge, skipped when no option
is an OTP. The first pass declined this as "an extra query per login not worth
it without evidence"; D9 is settled policy and the read is cheap, so it is in.
Published in `TWO_FACTOR_OPTION_SCHEMA` as optional.

The "auto-send at most once per challenge" half of D9 I agree with the first
pass about: the server cannot tell an auto-send from a manual resend, a
per-challenge counter would block a legitimate resend, and the destination send
quota already bounds the cost. Client behaviour; recorded, not built.

---

## 4. What this pass did not close

- **Passkey as a recovery second factor (first pass §5.3).** Agreed and left:
  the completion endpoint has no WebAuthn ceremony to hang off. A passkey-only
  account has no self-service recovery, which is fail-closed and consistent with
  D2's named exit, but it is a real availability narrowing for one of the six
  supported configurations and should be on the roadmap.
- **D11's notification on a voluntary password change (first pass §5.4).**
  Agreed and left. The SMTP transport exists (`sendOtpEmail`), so it is feasible,
  but a notification template family is its own change.
- **The 14 pre-existing `db/schema.ts` banners.** D16 asked for them to be
  reported separately, and they are: `Common Fields Helpers`, `Enums`, `Users
Table`, `Sessions Table` and ten more predate this work and are a mechanical
  sweep for its own commit.
- **The passkey plugin's own registration ceremony rows** (first pass §5.6) —
  correctly left to the retention sweep; nothing joins them to a user.
- **`cookieHeader` is copied into six test files.** Pre-existing duplication; I
  moved `mergeCookies` into `tests/helpers/session.ts` because two files now
  need it, and left the other copy alone.

---

## 5. Verification

### 5.1 Fail-without-fix (M17), on the final tree

Each repair was mutated out with a one-line `perl` edit, the named file was run,
and the file was restored from a backup whose checksum was compared afterwards
(`RESTORED OK`). In every run **only** the tests written for that repair went
red; every pre-existing test in the file stayed green.

| Run | Repair removed                                                                 | File                    | Red tests (and only these)                                                                                                                                    |
| --- | ------------------------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | the D7 method check in `assertPluginVerifierOffered`; `carryRememberChoice`    | `two-factor-totp`       | "cannot complete the sign-in through the plugin verifier"; "honours the SUBMITTED remember choice, not a stale marker" (2 of 8)                               |
| R2  | passwordless `dontRememberMe`; `withOtpSendHints`; the OTP enrolment audit row | `two-factor-otp`        | "honours 'do not remember'"; "tells the client how long the OTP send is throttled for"; "a code proven on the chosen channel…" (3 of 9)                       |
| R3  | `otpGuessWasEvaluated` branch in recovery complete                             | `two-factor-management` | "charges the grant budget for guesses only" (1 of 13)                                                                                                         |
| R4  | the last-method 409, the method/trust removal, the passkey audit row           | `two-factor-passkey`    | "the last passkey of a passkey-only account is refused…"; "…takes the method and every trusted device with it"; "accepts an authenticator that did" (3 of 17) |
| R5  | the outbox branch in `sendOtp`                                                 | `matrix` (6 rows)       | "a code says which action it approves" in every row; "a second-factor code reaches every enabled 2FA channel" in the two OTP rows                             |

Not mutation-checked: the lock-order swap in the recovery completion (§2.6 — no
deterministic race in the harness) and the process-tier gate for
`OTP_DELIVERY=outbox` in production (the test spawns a real process and asserts
the refusal; removing the gate is the boot succeeding, which the test's
`expectListen: false` path would report as a failure — a boot, not a mutation,
was the check).

### 5.2 Suites, on the final tree

| Command                                | Result                                                                                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun tests/helpers/run.ts unit`        | 895 pass, 0 fail (177 s)                                                                                                                                                                |
| `bun tests/helpers/run.ts integration` | 356 pass, 0 fail (77 s) — 8 new                                                                                                                                                         |
| `bun tests/helpers/run.ts process`     | 53 tests: 51 pass, 2 skip (Windows), 0 fail (106 s) — 1 new                                                                                                                             |
| `bun tests/helpers/run.ts matrix`      | 6 configurations × 6 tests, 0 fail; the channel test skips itself in the four rows with no 2FA OTP channel                                                                              |
| `bun run lint`                         | pass, zero warnings, after the last edit                                                                                                                                                |
| `git diff --check`                     | clean                                                                                                                                                                                   |
| `prettier --check .`                   | this file and the source tree pass; the three pre-existing failures (`two-factor-final-audit.md`, `two-factor-verification.md`, one archived log) are documents this pass did not write |

### 5.3 Not exercised

- The passkey ASSERTION ceremony, as before: `/two-factor/passkey/verify` is
  covered up to the point a real signature is needed. Registration is driven by
  the synthetic ceremony in `tests/helpers/webauthn.ts`.
- An executed deadlock for §2.6.
- Real provider delivery. The matrix tier now asserts the delivered text through
  the outbox; the provider HTTP contract is still covered only by the
  integration tier's stubs.

---

## 6. What these changes made false elsewhere

- `reports/two-factor-repair-log.md` §1 step 4 ("every verifier fails closed")
  and §8 ("`/two-factor/disable` and `/two-factor/generate-backup-codes` are
  ours") are superseded: the plugin verifiers are now gated, and
  `/passkey/delete-passkey` is ours too, with a different response shape and
  two new statuses. Its §5.1 (D15 not done) and §5.2 (the D9 hint) no longer
  describe the tree.
- `reports/two-factor-final-audit.md` remains the plan; its "Where:" lines were
  already stale after the first pass and are more so now.
- The frontend contract moved again, all of it published in the OpenAPI
  document: `/passkey/delete-passkey` answers the envelope and can answer 404 and
  409; challenge options carry `nextAllowedIn`; `/passwordless/verify` accepts
  `rememberMe`; the owned endpoints now publish exact bodies and reject what
  those bodies reject (a non-six-digit TOTP confirm code is 422 rather than 400).
- `tests/helpers/run.ts`: the matrix tier sets `OTP_DELIVERY=outbox`; a matrix
  test that expects a provider call will not see one.

---

## 7. Disagreements

### 7.1 With the first pass's pushbacks

- **§4.1 (H3 mode A's impact is overstated).** _Corrected after
  `two-factor-final-verification.md` §5:_ I first endorsed this, and both of us
  were wrong. For the account mode A describes — `totp` **and** `otp:email`
  enrolled — a password first factor applies no contact exclusion by design, so
  after a mailbox-only reset the attacker signs in with the new password, is
  offered the email OTP, and completes it. The takeover is real and was
  reproduced in the archived plan review. The audit's failure scenario stands as
  written; only the fix was unaffected, because the recovery grant closes the
  path either way.
- **§4.2 (M6 needed a mechanism).** Right, and the `WeakSet` marker is a clean
  way to carry a second fact on a throw whose `code` is spent. My only objection
  is that the mechanism was then not used on the second budget it created
  (§2.4).
- **§4.3 (L10 worth more than the hedge).** Agree.
- **§4.4 (bind the admin re-auth window to the session, not a header token).**
  Agree, and it is the better design: a bearer-shaped secret that adds nothing
  over the cookie is a leak surface with no benefit.
- **§4.5 (feature-off downgrades).** Agree; it is the settled policy and the
  audit is explicit that it is the operator's intent.
- **§5.1 (D15 out of scope).** Disagree. D15 is a settled decision with a
  recorded mechanism, and "its own change with its own review" is the scope
  call the brief reserves for the owner. It cost a flag, a 40-line module, one
  branch in `sendOtp`, a process-tier gate test and a matrix test. Built (§3.1).
- **§5.2 (the D9 hint).** Disagree on the hint, agree on the auto-send rule.
  Built (§3.2).
- **§2.2 (N2 closed against throwing, not the orphan state).** Moot: the TOTP
  after-hook no longer exists; the owned confirm writes credential, intent and
  flag in one transaction. Correctly reasoned at the time.
- **§2.3 (M9 fixed for the class).** Agree — keying on the surface closes four
  pairs at once and keeps `recovery`'s key.
- **§2.5 (integration channel list to `email,sms`).** Agree, and it is the
  configuration that actually exercises D1.

### 7.2 With the audit

- **H3's failure scenario** says the attacker "gets the account". See 7.1.
- **M14's "eight custom endpoints"** undercounts: there are eleven owned Better
  Auth endpoints with bodies. Cosmetic.
- **D9's auto-send-once rule** is stated as a server property and is not one
  the server can enforce without blocking legitimate resends. It should be
  restated as client behaviour bounded by the destination send quota.

### 7.3 Decisions taken here without asking

- The passkey-delete endpoint keeps the **grant** as its password proof rather
  than taking `password` in the body like `/two-factor/methods/disable`. The
  grant mechanism already existed for this path and a client flow already
  depends on it; two proof shapes on one endpoint would be worse than one
  slightly indirect one. A refused delete (409) spends the grant, so the caller
  re-proves the password — acceptable for a refusal.
- The outbox lives in the **matrix** tier only. Reasoning in §3.1.
- `twoFactorTotpConfirmSchema` uses `otpCodeSchema` (six digits), so a TOTP
  confirm with a non-six-digit string is now 422 rather than a 400 from the
  verifier. TOTP codes here are six digits by the plugin's defaults; the
  narrowing is the documented body.

---

## 8. Response to `two-factor-final-verification.md`

An independent verification of both passes was written after §1–§7. Each of its
claims was checked against the code; the result decided whether it was fixed or
only answered.

### 8.1 Right, and fixed

- **§3.1 — the last-method rule counted intent rows.** A user with a working
  TOTP and an `otp:email` row whose contact is unverified, or whose channel the
  deployment dropped, could remove the TOTP and strand themselves. Fixed with
  `removalStrandsTwoFactor` in `two-factor-challenge.ts`, which asks what a
  challenge would OFFER after the removal — the same question
  `contactChangeStrandsTwoFactor` asks. `/two-factor/methods/disable` and
  `/passkey/delete-passkey` answer 409 when the removal empties the offered set;
  removing the row that is NOT a factor stays allowed; the sole-row refusal is
  kept; the flag is never touched (M3 rule 1). The intent-counting comment that
  argued the other way is gone.
- **§3.2 — acknowledging backup codes needed no proof** while flipping the flag
  and revoking other sessions. It now requires the password like every other
  transition that does either. Published body `twoFactorPasswordSchema`; the
  three suites that acknowledged with `{}` send the password.
- **§4.1 — the recovery checks that answer by returning `false` were charged as
  guesses**, under a comment that said otherwise. `verifyRecoveryTotp` and
  `consumeRecoveryBackupCode` now return a `RecoveryVerdict` — `matched`,
  `rejected`, `unavailable` — and the completion charges `rejected` only. A lost
  backup-code swap is `unavailable`. The passkey verifier no longer charges a
  missing ceremony row or a malformed body; it still charges an assertion naming
  a credential this user does not hold, because that request is never an
  innocent client's.
- **§4.2 — `setDefaultTwoFactorMethod` and `startTotpEnrolment` wrote no audit
  row.** Both do now (`twoFactorDefaultChanged`, `totpEnrolmentStarted`). No
  re-authentication was added to the default change: it reorders within the
  enrolled set and the challenge still offers every method, so it lowers
  nothing. Recorded rather than built.
- **§4.3 — passkey enrolment revoked no sessions; the OTP enrolment revoked
  outside the proof transaction with the failure swallowed.** The passkey
  enrolment revokes the caller's other sessions inside its transaction. The OTP
  revocation moved into `onVerified`, inside `processOtpVerify`'s transaction,
  where the user row is already locked in canonical order.
- **§4.4 — the plugin's two authentication endpoints were still in its map**,
  defended by the allow-list alone. Both are destructured out in
  `passkeyManagement()`, exactly as `deletePasskey` is.
- **§4.5 — the library's conflict check only logs.** Verified in
  `better-auth/dist/api/index.mjs`: `checkEndpointConflicts` calls
  `logger.error` and returns. The comment claiming two endpoints cannot claim
  one path was false and is rewritten; the drift test asserts the three
  destructured keys still exist on the plugin, so an upstream rename cannot
  silently un-remove them.
- **§5 — this review endorsed pass 1's H3 pushback without checking.** Correct.
  §7.1 is corrected in place: for the `totp` + `otp:email` account the takeover
  is real, because a password first factor applies no contact exclusion.
- **§2 — "53 pass, 2 skip" double-counts.** §5.2 corrected to 53 tests, 51 pass.

### 8.2 Right, and answered rather than changed

- **§6, `0007` opens with `DROP INDEX` without `IF EXISTS`.** True and left. The
  file is Drizzle's generated output, the journal applies migrations in order,
  and a database that never applied `0006` cannot reach `0007` through
  `scripts/migrate.ts`. Hand-editing generated SQL to survive an unsupported
  replay would be the divergence.
- **§6, `OTP_DELIVERY=outbox` boots under `development`.** True and by design:
  the same posture model that lets `/api/dev/sign-up` and the Turnstile test
  secret exist in development. The production refusal is the control. Recorded
  so the blast radius is named.
- **§0, the nine decided items.** All match the audit's settled policy; nothing
  here touched them.

### 8.3 Tests added for §8, each checked by removing its repair

- §3.1 — `two-factor-management` › "is refused when the surviving row is not a
  factor a challenge would offer". Without the repair the first removal answers
  200 and strands.
- §3.2 — the unproven `{}` call in `two-factor-management` › "are not a usable
  method until the user acknowledges them". Without the repair it answers 200.
- §4.1 — `two-factor-management` › "refunds a TOTP check that never reached a
  comparison". Without the repair the attempts row reads `1`.
- §4.5 — `two-factor-library-drift` › "still exist under the keys the destructure
  names". A renamed upstream key fails the unit tier.
- §4.4 has no new test: the allow-list assertion "is not routed, so a passkey
  cannot replace the password" was already the guard; the map removal is defence
  in depth behind it.

### 8.3b Follow-up from the verification of §8

- `two-factor-passkey.ts` set `settled = true` before the counter write, so a
  throw out of `advancePasskeyCounter` skipped the refund the comment promised.
  The assignment now follows the write; the comment says why a throw there is
  still refunded. Code-verified only — no harness can make that write throw.
- §4.3's two revocations now have tests: the OTP enrolment and the passkey
  registration each evict a second device signed in beforehand and keep the
  caller's session.
- `two-factor-final-audit.md` carries a status notice at the top: every finding
  closed except the recorded open items, `Where:` lines describe the pre-repair
  tree, and where the current code is described.

### 8.4 Suites after §8

On the tree with every §8 change in place:

| Command                                | Result                                                                                                                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run lint`                         | pass, zero warnings                                                                                                                                                                                                                      |
| `bun tests/helpers/run.ts unit`        | 896 pass, 0 fail — 1 new                                                                                                                                                                                                                 |
| `bun tests/helpers/run.ts integration` | 358 pass, 0 fail — 2 new                                                                                                                                                                                                                 |
| `bun tests/helpers/run.ts process`     | 53 tests: 51 pass, 2 skip (Windows), 0 fail. One earlier run failed "concurrent first-open of the rate-limit store", the SQLite open race the first pass also saw once on Windows; it passed on the re-run and is unrelated to this work |
| `bun tests/helpers/run.ts matrix`      | 6 configurations × 6 tests, 0 fail                                                                                                                                                                                                       |
| `git diff --check`                     | clean                                                                                                                                                                                                                                    |
