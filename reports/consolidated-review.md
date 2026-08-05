# Consolidated Review — FIN-01 … FIN-20 Remediation

**Role:** senior technical reviewer, consolidating six independent AI reviews of
the working tree against baseline `c13a850`.

**Source reports and reporter codes used throughout:**

| Code     | Report                                                |
| -------- | ----------------------------------------------------- |
| **CO-S** | `reports/review-Claude-Opus-5-with-skill.md`          |
| **CO-N** | `reports/review-Claude-Opus-5-without-skill.md`       |
| **GE-S** | `reports/review-Gemini_3.1_Pro_High-with-skill.md`    |
| **GE-N** | `reports/review-Gemini_3.1_Pro_High-without-skill.md` |
| **G5-S** | `reports/review-GPT-5-with-skill.md`                  |
| **G5-N** | `reports/review-GPT-5-without-skill.md`               |

Scope reviewed by all six: backend only — `components/`, `hooks/`, `pages/`,
`styles/`, `tests/`, `*.md`, `*.txt` excluded. ~51–55 files, 45–49 modified plus
6 added.

---

## 1. Merge verdict

**Do not accept the patch unchanged.** The bulk of the work is sound and in
several places sharper than the report it implements. Five issues are merge
gates; the rest are follow-ups.

**Merge gates:** C-01, C-02, C-03, C-04, C-06.

---

## 2. Unified findings

Ranked by what to act on first. Duplicates across reports are merged; where
reports proposed competing fixes, the recommendation below is the merged or
improved one, not a copy of any single report.

---

### C-01 — `OTP_AUTO_VERIFY` is still `true` and has no environment guard — **High**

**Reported by:** G5-S (#1), G5-N (#1). CO-S acknowledged the value is still
`true` but accepted the deferral. CO-N flagged the missing write-up half only.
GE-S/GE-N did not detect it.

**Files:** `utils/config.ts:76`, `app/api/auth/otp/send/handler.ts:121`,
`app/api/auth/otp/verify/handler.ts:101`,
`app/api/dash/users/me/change-email/verify/handler.ts:60`,
`app/api/dash/users/me/change-phone/verify/handler.ts:63`,
`reports/should-ignore.md` (#55), `TODO.md`

The flag is unchanged from the base commit and is `true`, not `false`. Public
OTP send/verify mark an existing account's contact verified with no code, and
the authenticated email/phone verify routes commit request-body contact data
directly. CO-S verified the bypass never reaches `passwordless_login` or
`forgot_password`, which bounds the blast radius but does not remove it.

Deferring a production-grade OTP implementation is reasonable for a starter kit.
Shipping an _enabled, unguarded_ bypass is not — and the deferral is only half
documented: `should-ignore.md` #55 closes with "see TODO.md for the full
write-up", and no `FIN-01` / `OTP_AUTO_VERIFY` entry exists in `TODO.md` (CO-N
§6.3). FIN-02 and FIN-20, both lower severity, each got their full section.

**Fix:** default the flag to `false`; require _both_ an explicit opt-in env var
and a recognized local/test runtime to enable it; fail startup if it resolves
true outside development. Then write the missing `TODO.md` section so the
pointer in `should-ignore.md` resolves.

---

### C-02 — The application-wide OTP breaker is consumed before eligibility is known — **High**

**Reported by:** G5-S (#2), G5-N (#4). Missed by all four other reports.

**Files:** `lib/rate-limit/api.ts:158-205`,
`app/api/auth/forgot-password/send/handler.ts:67`,
`app/api/auth/otp/send/handler.ts`, `app/api/auth/passwordless/send/handler.ts`

FIN-07's new global daily delivery ceiling (2,000/day) is charged _before_ the
account/destination lookup and before any provider call. Requests for
nonexistent or already-verified destinations therefore burn the shared budget
without producing a delivery. An attacker with CAPTCHA tokens and distributed
sources can exhaust OTP delivery for the entire application using random
nonexistent destinations, at zero provider cost and without needing to know a
single valid account.

This is the strongest new defect any of the six reports found: the remediation
introduced it, and no FIN item warned about it.

**Fix:** keep the per-IP and per-destination checks _before_ lookup — they are
what makes the endpoint enumeration-resistant. Move consumption of the
provider-wide counter to immediately before the real provider dispatch, after
internal eligibility is established. Public responses and timing stay collapsed
to the same generic shape, so nothing leaks.

---

### C-03 — Trusted IP resolution: sign-in is now hard-down without an edge header, and the trusted set is a union — **High / deployment-conditional**

**Reported by:** CO-S (§4-B), CO-N (§5.8), G5-S (FIN-03), G5-N (#2). GE-N
asserted the opposite — that the limiter now "won't unexpectedly fail" — which
is wrong; it fails closed by design.

**Files:** `lib/rate-limit/api.ts:67`, `lib/auth.ts:140`, `lib/auth.ts:228`,
`lib/audit.ts:25`, `app/api/auth/[...all]/route.ts`

Two distinct problems on the same code path:

1. **New availability dependency.** `ipIdentifier()` throws 503 when neither
   `cf-connecting-ip` nor `x-vercel-forwarded-for` is present. That behavior
   pre-dates the patch and is correct, but the new sign-in before-hook puts it
   on the _login critical path_ for the first time — CO-S confirmed
   `/api/auth/[...all]` was never wrapped by `toNextHandler`. Local dev, preview
   deploys, a bare VPS, Docker, or `next start` now return 503 on every sign-in
   with no obvious cause. For a starter kit, that is the first thing a
   downstream project hits.
2. **Union trust.** `TRUSTED_IP_HEADERS` accepts both headers everywhere. On a
   Vercel-only deployment a client-supplied `cf-connecting-ip` wins unless
   Vercel is independently guaranteed to strip it (G5-N §2).

**Fix (merged from G5-N and CO-S):** make the trusted header a single
deployment-configured value (env-selected), not a union, and enforce the
matching ingress boundary. For local development, prefer injecting the
configured header in dev middleware over adding a fallback inside `getClientIp`
— a fallback that ever ships weakens the trust boundary. Either way, add "verify
the edge header before first deploy or nobody can log in" to the production
checklist; this converts the existing `getClientIp` TODO from _review before
launch_ to _blocking_.

---

### C-04 — Permission validation was made stricter beyond FIN-19 and now rejects valid payloads — **Medium-High (regression)**

**Reported by:** G5-S (#4), G5-N (#3). GE-S argued the opposite — that blanket
strictness is mandated — but reasoned from the skill file rather than from the
payloads the client actually sends. CO-S/CO-N verified the _admin user_ half was
split correctly and did not examine the permission matrix.

**Files:** `utils/validation/permissions.ts:73`,
`utils/validation/permissions.ts:83-95`, `utils/validation/permissions.ts:195`,
`app/api/dash/permissions/handler.ts:135`

Two separate over-applications:

- A known action that is _unavailable for a page_ is now rejected even when
  submitted as `false`. The previous code normalized those away. A full-matrix
  payload — `{ name: 'home', permissions: { view: true, edit: false } }` — now
  fails, while the comments in the same file state that full matrices are normal
  client input. Confirmed by schema probe in both GPT-5 reviews.
- The permissions collection POST was switched to `adminCreatePermissionSchema`
  (`.strict()`). That contract deliberately stripped server-owned fields such as
  `scope` and `createdBy`; the baseline expected 201. `final.md` explicitly said
  lenient collection contracts should not be converted wholesale.

**Fix:** normalize known-but-unavailable actions when the value is `false`;
reject them only when `true`; keep rejecting unknown/misspelled keys. Restore
the lenient collection POST, or version the contract and update every caller in
the same change. The narrow FIN-19 admin-user fix (`adminUpdateUserSchema`,
presence derived from the parsed value rather than `'phoneNumber' in body`) is
correct and should be kept — see §4.

---

### C-05 — The log serializer is a denylist over arbitrary metadata, and it both leaks and over-redacts — **Medium**

**Reported by:** G5-S (#3), G5-N (#5), CO-N (§4.3). CO-S and both Gemini reports
recorded FIN-14 as fully fixed.

**Files:** `utils/index.ts:44`, `utils/index.ts:189`, `utils/index.ts:285`,
`utils/otp.ts`

FIN-14's core is a genuine win — CO-N reproduced Drizzle embedding bound
parameters (session tokens, password hashes) in `error.message`, which every
`console.error(sanitizeForLog(...))` was printing; the new serializer withholds
it and keeps the SQLSTATE. Three gaps remain, all from the same root cause — a
substring denylist applied to arbitrary enumerable properties instead of a
per-event allowlist:

- **Leaks structured metadata.**
  `Object.assign(new Error('boom'), { code: '123456' })` serializes as
  `{"error":{"name":"Error","message":"boom","code":"123456"}}` (G5-S probe).
  Harmless driver metadata and a one-time token are indistinguishable to a
  generic logger.
- **Leaks free text.** `new Error("provider payload SENTINEL_TOKEN")` retains
  the sentinel (G5-N probe). Generic `Error.message` is preserved at
  `utils/index.ts:189`.
- **Over-redacts diagnostics.** `code` and `hash` match as substrings, so
  `statusCode`, `errorCode`, `smtpCode` and `hashUpgraded` all become
  `[redacted]`. The implementation had to work _around_ its own rule —
  `utils/otp.ts` renames a field to `smtpClass` with the comment *"Not
  `smtpCode`: the serializer redacts _code keys by default."_ That partly undoes
  what FIN-14 existed to restore.

**Fix:** replace the generic denylist with per-event safe-field schemas, or
require sanitization at the source boundary for every error/provider payload.
Exempt numbers and booleans from redaction the way `lib/audit.ts` already does
("a boolean is never a secret"). Do not mark FIN-14 complete.

---

### C-06 — Tests are ignored by Git and ESLint, none were written, and comments claim coverage that does not exist — **Medium (process)**

**Reported by:** CO-S (§4-A, §5), CO-N (§6.1, §6.2), G5-S (#5), G5-N (#7).
Unanimous among the four non-Gemini reports.

**Files:** `.gitignore:55`, `eslint.config.mjs:18`,
`app/api/dash/users/[id]/sessions/pagination.ts:56`, `reports/should-ignore.md`
(#58)

`final.md` recommends regression tests for eight findings (FIN-01, 02, 03, 04,
05, 08, 09, 12, 13). None exist. `.gitignore` gained `/tests/**` and
`eslint.config.mjs` gained `tests/**`, so any test written from here on is both
untracked and unlinted — while `package.json`'s test command still targets that
directory. Two comments assert coverage that does not exist: `pagination.ts:56`
("the round trip is asserted in the tests") and `should-ignore.md` #58 (cites a
named test). A comment asserting non-existent evidence is worse than no comment,
because the next reader trusts it.

**Fix:** remove both ignore entries. Fix or delete the two false coverage claims
either way. Highest-value coverage first, by blast radius:

- `processOtpVerify` consume/refund accounting — five outcome branches, each
  with a different charge decision (`BLOCK_EXPIRY_RESET`, exact-boundary
  attempt, correct-code-at-cap, repeated success).
- The `filterColumns` contract matrix — absent / malformed / empty / null /
  over-limit, per operator × type.
- `zonedDayStart` / `zonedNextDayStart` against a DST zone (see C-14).

---

### C-07 — Two competing authorities for the OTP daily verify budget, with a hand-rebuilt refund key — **Medium**

**Reported by:** CO-S (§4-C), CO-N (§5.6, §5.7). Unique to the Claude pair.

**Files:** `lib/rate-limit/api.ts`, `utils/otp.ts`, `db/schema.ts`

`OTP_MAX_DAILY_VERIFY_ATTEMPTS` is now enforced twice: in Redis
(`otp.verify.daily.<kind>:<userId>`, per user across all purposes) and in the DB
(`verification_sessions.verifyAttemptDaily`, per `(user, channel, purpose)`).
The Redis one is strictly tighter and therefore binding; the DB one is
effectively unreachable. The entire consume-then-refund apparatus —
`confirmedCodeFailure`, the `releaseBudget` closure, the `try/catch`,
`GREATEST(verifyAttemptDaily - 1, 0)` — exists only to keep two authorities
agreeing.

Both reviewers traced the mechanics and confirmed they work today: the key
strings match character for character, the limiter instance is shared, and the
vendored `@upstash/ratelimit` sliding-window Lua does
`if incrementBy > 0 and … >= effectiveLimit then return {-1, …}`, so `rate: -1`
genuinely skips the cap and refunds atomically. Two latent failures remain:

- `enforceOtpVerifyDailyBudget` builds the key via `${scope}:${identifier}`;
  `refundOtpVerifyAttempt` rebuilds the same string by hand in
  `otpVerifyDailyKey`. If either side changes, refunds silently target a dead
  key — and because refund failures are logged rather than thrown, the only
  symptom is a victim's cross-purpose 24h budget draining with no error
  anywhere.
- `refundRateLimit` swallows Redis errors by design. FIN-07 widened this counter
  to span _every_ purpose for a `(user, contactKind)` pair, so a partial Redis
  outage now over-charges a budget gating password recovery, passwordless login,
  and both contact-change flows at once — a 24h lockout across all of them, with
  a `console.error` to show for it.

**Fix:** collapse to one authority. Keep the DB counter — it is transactional,
per-cycle-correct after the FIN-05 fix, and needs no refund — and rekey it to
match the intended scope; drop the Redis daily verify budget. That removes ~40
lines, the refund path, the duplicated key builder, and the outage failure mode
in one change. If both must stay for now, at minimum extract a single shared
key-builder used by enforce and refund (CO-N: "the single change I would make
before shipping").

---

### C-08 — Quick search now 422s, reversing an already-ignored item, with no client recovery for the filter 422 either — **Medium**

**Reported by:** CO-N (§5.1), CO-S (§4-I).

**Files:** `db/queries/data-table.ts`, `lib/data-table/filter-columns.ts`,
`lib/data-table/parsers.ts`

The strict _filter_ contract is correct and well argued: a dropped predicate
widens an `and` query into a subtly wrong result set. That argument does **not**
transfer to quick search. Quick search is a single standalone term, so ignoring
it returns _more_ rows — visibly the unfiltered list, not a silently wrong one.
`should-ignore.md` #18 ("Search Input Silently Truncated at 200 Characters") was
already filed under _Not Real Issues / Ignored_; no FIN item asked to reverse
it. The new 3–200 character floor/ceiling breaks any bookmarked URL with a 1–2
character term and any external caller. Confirmed with a live request.

Separately, a stale bookmark referencing a renamed column now returns a hard 422
(`أحد عوامل التصفية غير صالح، أعد ضبط التصفية`) with no automatic recovery — the
user must clear filters by hand. Note also that the parser 422s on a _malformed
sort_ while an _unknown sort column_ stays lenient: two philosophies in one
function, defensible but worth a comment.

**Fix:** revert quick search to lenient; keep filters strict. Have the
data-table UI catch that specific 422 once, clear the offending filter state,
and retry.

---

### C-09 — Data-table descriptors: explicit empty array fails open, and the contract is not yet generic — **Medium**

**Reported by:** G5-N (#6), G5-S (#8).

**Files:** `lib/data-table/filter-columns.ts:117`,
`lib/data-table/column-specs.ts`, `app/api/dash/users/handler.ts:55`,
`app/api/dash/permissions/handler.ts:44`,
`db/migrations/001_add_trgm_indexes.sql`

Four residual gaps in an otherwise correct fix:

- **Fail-open.** An explicit `inArray: []` is treated as `skip`, so the request
  silently becomes unfiltered. Once a filter is serialized into an API request,
  an explicitly empty value should be rejected, not broadened — the same
  argument that justified 422 over drop everywhere else.
- **`variant` is unbound.** Column type and operator are bound to the
  descriptor; the client-supplied `variant` is not. Not currently unsafe, but it
  does not meet the strict contract FIN-12 claims.
- **`select` / `multiSelect` are treated as string-like** for emptiness
  comparison, so a future PostgreSQL enum column would generate
  `enum_column = ''`. Not reachable today — registered columns are text,
  boolean, and date only.
- **The three-character floor does not prove indexed queries.** Trigram indexes
  live in `db/migrations/001_add_trgm_indexes.sql` while Drizzle output is
  configured under `db/drizzle`, and no package script references the manual
  migration. Both live descriptors also set `allowScanOnly: true`, so
  `NOT ILIKE` scans remain accepted — a conscious small-table tradeoff, not a
  completed fix.

**Fix:** reject explicit empty arrays; bind `variant` to the descriptor; encode
DB type well enough to avoid empty-string comparison on enum-like fields; wire
the trigram migration into a script or move it into the Drizzle chain; document
`allowScanOnly` as an accepted policy with the table-size assumption stated.

---

### C-10 — FIN-02: the race is narrowed, not closed — do not describe it as eliminated — **Medium (defer, but restate)**

**Reported by:** all six, with materially different conclusions. G5-S (#6) and
G5-N (#8) identified the residual race precisely. CO-S and CO-N agreed with
deferring and added the wider `processOtpSend` variant. GE-S claimed the fix
_was_ implemented via an `authVersion` epoch — it was not. GE-N called the
likelihood "astronomically low" and stopped there.

**Files:** `lib/auth/live-session.ts:28-48`, `lib/auth/passwordless.ts:135,195`,
`app/api/dash/users/me/contact-change.ts`, `TODO.md`

`assertLiveSession` performs a **pre-transaction** lookup; a session can be
revoked between that check and the protected mutation's commit. Passwordless
consumes its proof at line 135, releases the transaction, and creates the
session at line 195; password sign-in has the equivalent verify-then-create gap.
No epoch was added.

On likelihood, the consensus is: low for accidental collision, and reaching it
requires an attacker who _already holds a valid credential or proof_ — so the
race buys little that was not already available. But it is not purely
theoretical, because that attacker can deliberately coordinate the rotation.

The point four reports underweighted, and CO-S got right: the `processOtpSend`
variant is much wider. `processOtpSend` takes an advisory lock on
`(userId, channel, purpose)` but never locks `users`, while rotation locks
`users` then purges `verification_sessions` — and `sendOtp()` still runs
_inside_ that transaction, so the window spans the provider HTTP call: seconds
on an SMTP/SMS timeout, not milliseconds. A `forgot_password` proof issued
concurrently with a password change can survive it and reset the _new_ password,
with no precise timing required.

**Fix:** keep it deferred — the real fix is an `authVersion` epoch checked
inside the same transaction as the mutation, which needs a migration plus a
Better Auth session-creation hook the framework does not expose. But: (a) raise
it above FIN-20 in `TODO.md`; (b) pair it with existing TODO #54 (move OTP
delivery outside the transaction), which shrinks the wider half for free and
should be resolved together; (c) stop describing the current pre-check as
closing the race class.

---

### C-11 — The SMS/WhatsApp collapse stops at the Redis layer — **Medium**

**Reported by:** G5-S (FIN-07), G5-N (#4).

**Files:** `lib/rate-limit/api.ts`, `db/schema.ts:502`

Redis keys now collapse both transports onto one phone destination, but
`verification_sessions` remains keyed by `(user, channel, purpose)`. After the
shared Redis window expires, switching transport still reaches a _separate_
six-hour DB block state, so the DB-side attempt block is still per-channel. The
alerting FIN-07 asked for was not added.

**Fix:** key the DB attempt state by contact _destination_ rather than channel
(or collapse `sms`/`whatsapp` to one stored channel value) so both layers agree.
Add the requested alerting hook, or record explicitly why it was skipped.

---

### C-12 — Changes shipped that no finding asked for, several reversing recorded decisions — **Medium (process)**

**Reported by:** CO-S (§4-G, §5), CO-N (§5.2, §5.3, §5.4, §5.5, §5.9), G5-S/G5-N
(inventoried `next.config.js` but excluded it from their verdicts).

| Change                                                                                               | Files                                                                           | Call                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `experimental.scrollRestoration: false` commented out                                                | `next.config.js`                                                                | **Revert or justify.** A UX behavior change hidden inside a security-and-correctness diff, with no comment and no finding behind it. Flagged by CO-S and CO-N independently.                                                                                                                                                                                                                              |
| `validatePermissionScope` loosened — `actorHoldsAction` lets an actor holding `edit` grant `editOwn` | `lib/permissions/utils.ts`                                                      | **Decide explicitly.** The reasoning is sound (`edit` is a strict superset, and `PERMISSION_ACTIONS` already says so), but it _relaxes an authorization check_ and no FIN item requested it. That should be a decision, not a side effect.                                                                                                                                                                |
| `assertLiveSession` added to `requireSession`; `sessions` joined in `checkUserPermission`            | `lib/auth/live-session.ts`, `lib/http/session.ts`, `lib/permissions/checker.ts` | **Declare it.** This implements `should-ignore.md` #52 / `TODO.md` F-03, filed under _Known Issues — Will Be Fixed Later_. The change is correct — every revocation path deletes rows, so re-reading user and role but not the session authorizes a session revoked minutes ago — but it costs a DB round-trip on every mutation and F-03 now documents a fix that partly shipped. Update F-03 or revert. |
| `revokePendingProofs` deletes already-**consumed** sibling rows                                      | `lib/auth/rotation.ts`                                                          | **Keep, update the docs.** Consumed rows have their code deleted and `consumedAt` set, so they are unreplayable, and the implementation closed the gap it created by adding the missing passwordless proof-consumption audit event in the same transaction. But `verification_sessions` is no longer a trail of any kind; `TODO.md` item 12 (verification-session TTL) should say so.                     |
| `GET /dash/users/:id` lost its parallel fetch; `actorCoversTargetRole` query added                   | `app/api/dash/users/[id]/handler.ts`, `app/api/dash/users/[id]/target-user.ts`  | **Keep, update L-7.** The security reason is legitimate — the child route's role-authority check was bypassable, since page one arrived through the parent and only page two was refused. But it adds 1–2 sequential round-trips to a hot path and reverses `TODO.md` L-7's explicit _"keep parallel fetch"_ decision.                                                                                    |
| `resolveActionScope` changed **and exported** to handle own-scoped actions                           | `lib/permissions/utils.ts`                                                      | **Keep, note it.** The comment admits no route requests an own variant today, so neither prior misbehavior was reachable. Correct on its merits; exporting a previously-private function to fix a latent case is scope expansion worth acknowledging.                                                                                                                                                     |
| DELETE-body fix; per-table data-table store scoping                                                  | `utils/mutation.ts`, `utils/store/data-table-store.ts`                          | **Keep.** Real bugs, neither in `final.md`.                                                                                                                                                                                                                                                                                                                                                               |
| Dropped the undefined `ENTITY_ID_AS_UUID` export                                                     | `constants/index.js`                                                            | **Keep.** Verified against `git show HEAD:constants/index.js` — the symbol was in the `export {}` list with no `const` declaration, i.e. a latent `ReferenceError` on import.                                                                                                                                                                                                                             |
| `"packageManager": "bun@1.3.14"`                                                                     | `package.json`                                                                  | **Keep.**                                                                                                                                                                                                                                                                                                                                                                                                 |

---

### C-13 — OTP delivery hardening exceeds its threat model — **Low-Medium**

**Reported by:** CO-N (§4.1). Unique.

**Files:** `utils/otp.ts`, `lib/rate-limit/api.ts`

The _core_ is legitimate and is a leak no report identified: SMS/WhatsApp APIs
echo the submitted message text on failure, SMTP rejections quote the rejected
body, and `response.json()` on a non-JSON 2xx throws a `SyntaxError` quoting the
body. All three carry the plaintext OTP, and callers log the thrown error.
Fixing that at the dispatcher boundary is correct and should stay, along with
the `SAFE_DELIVERY_MESSAGES` membership check — one `Set` lookup that enforces
the guarantee rather than assuming it.

What is disproportionate: `isCustomError()` wrapping
`error instanceof CustomError` in `try/catch` against "a Proxy with a throwing
`getPrototypeOf` trap"; `readErrorField()` wrapping a property read in
`try/catch` for hostile getters; and `LOGGABLE_ERROR_NAMES`, an allowlist of
error _names_ premised on `error.name` being attacker-influencable. The values
reaching this code are `fetch` responses and Nodemailer errors. ~60 lines and
heavy commentary defending against an adversary that does not exist in this
path.

**Fix:** keep the boundary and `SAFE_DELIVERY_MESSAGES`; drop the Proxy,
hostile-getter, and error-name defenses.

---

### C-14 — `BUSINESS_TIMEZONE` is a hardcoded source constant, and the DST logic is untestable against it — **Low**

**Reported by:** CO-S (§4-D), G5-S (FIN-13), G5-N (FIN-13).

**Files:** `utils/config.ts:19`, `utils/time.ts`

Committing to one calendar zone is the correct _design_ and half-open
`[start, nextDay)` ranges are the correct shape — that part of FIN-13 is right,
and probes across Riyadh, New York 23/25-hour DST days, a Santiago midnight
transition and leap dates all behaved correctly. But this is a starter kit;
hardcoding `'Asia/Riyadh'` means every fork edits a source file instead of an
env var, which is exactly how "the date filter is off by one" appears six months
later. Riyadh also has no DST, so the `resolveZonedWallClock` two-pass logic and
the `MIDNIGHT_JUMP_PROBE_HOURS` probe are untestable against the shipped
default.

**Fix:**
`export const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE ?? 'Asia/Riyadh';`
with a validity check (`Intl.supportedValuesOf('timeZone')`, or a try/catch
around one formatter construction at module load), matching how
`PHONE_NUMBER_MODE` and the OTP flags are already handled in that file. Test
against a DST zone.

---

### C-15 — `SUPERSEDING_ACTION` is defined twice — **Low**

**Reported by:** CO-S (§4-F). Unique.

**Files:** `lib/permissions/checker.ts:33`, `lib/permissions/utils.ts` (~410)

Identical definitions:
`Object.fromEntries(Object.entries(OWN_ACTION_MAP).map(([all, own]) => [own, all]))`.

**Fix:** move it next to `OWN_ACTION_MAP` in `lib/permissions/constants.ts` and
import from both sites.

---

### C-16 — `markContactVerified` is not the single writer of the verified flags — **Low (pre-existing, in-scope sibling)**

**Reported by:** CO-S (§4-H). Unique.

**Files:** `app/api/dash/users/me/contact-change.ts:111,118,176,183`,
`app/api/dash/users/[id]/handler.ts` (`handleAdminEdit`)

`emailVerified` / `phoneNumberVerified` are set inline at four sites in
`contact-change.ts`, and `handleAdminEdit` sets them to `false` — despite the
documented rule that `markContactVerified` is the only writer. This is
pre-existing, not introduced, but `contact-change.ts` was heavily edited in this
diff, so it was an in-scope sibling that went unaddressed and unrecorded.

**Fix:** route the five sites through `markContactVerified`, or record them as a
deferred site with a reason.

---

### C-17 — Session pagination has no matching index — **Low, non-blocking**

**Reported by:** G5-S (#7). Unique.

**Files:** `db/schema.ts:244-248`,
`app/api/dash/users/[id]/sessions/pagination.ts`

The `(createdAt, id)` keyset cursor is deterministic and correct — CO-N
round-tripped a real DB value (`2026-04-24 17:35:21.39+00` → `…T17:35:21.390Z`)
and confirmed the anchor row is excluded. The query filters by user and expiry
and orders by `(createdAt, id)`, but the only index starts
`(user_id, expires_at, created_at)` with no ID tie-breaker; an expiry range can
prevent it from satisfying the ordering efficiently.

**Fix:** add `(user_id, created_at, id)` only if production query plans justify
it. More than 50 live sessions per user is unlikely at the stated scale —
several reports note FIN-16 is already close to more machinery than the
deployment needs.

---

### C-18 — Successful verify now clears send-cycle state — **Low (accepted tradeoff, record it)**

**Reported by:** CO-S (§4-E). Unique.

**Files:** `utils/otp.ts`

The FIN-05 fix resets `attemptNumber: 0` and `nextAllowedAt: null` on a
successful retained-purpose verify. This is _necessary_: without it, five
successful passwordless logins left the send counter at its cap and the sixth
self-inflicted a six-hour block. Side effect: for a user who can complete
verifies — i.e. actually owns the contact — the DB-side send throttle no longer
accumulates at all and the resend cooldown is cleared. The only remaining send
bound is the Redis `otp.send.*` chain (5–6/hour per destination, fail-closed).

Acceptable — a bound moved from DB to Redis rather than disappearing — but it
should be written down, and it interacts with C-07's recommendation to keep the
DB counter.

---

### C-19 — The skill file was rewritten _after_ the implementation it now grades — **Process**

**Reported by:** CO-S (§5). Unique, and the most useful meta-observation across
all six reports.

**Files:** `.claude/skills/backend-current-project/SKILL.md` (gitignored, so
invisible in the diff)

Timestamps: `reports/final.md` 2026-08-02 00:25 → baseline commit `c13a850`
2026-08-02 00:37 → `lib/auth/rotation.ts` 2026-08-02 23:14 → `SKILL.md`
**2026-08-03 21:15**. The guidance future work is reviewed against was written a
day after the code it describes, so it can no longer serve as an independent
check on this work.

Two findings sit exactly on that seam: the skill asserts `markContactVerified`
is the single writer of the verified flags (C-16 — the code contradicts it at
five sites), and forbids duplicate rate-limit authorities enforcing the same
policy (C-07 — the OTP daily budget now is one). In both cases the rule is
stated correctly and the shipped code does not meet it.

This also shows up in the review results themselves: see §5.

**Fix:** diff `SKILL.md` against its prior version if a copy exists, and treat
rules folded back from an implementation pass as provisional until independently
re-derived.

---

## 3. Consensus positives — keep as delivered

Verified independently by at least two reports, with no dissent:

- **FIN-03 atomic sign-in limiter.** CO-N confirmed all three premises against
  `better-auth@1.6.3` source: `onRequestRateLimit` does `get` and
  `onResponseRateLimit` does `set` (non-atomic); `resolveRateLimitConfig`
  returns `null` when no IP resolves; `getIp` defaults to `x-forwarded-for`.
  Both Claude reports separately confirmed `customRules: { path: false }`
  _disables_ rather than falling back (`if (resolved === false) return null`) —
  had it fallen back, sign-in would now be limited at 10/min non-atomically,
  worse than before. Disabling the weaker duplicate instead of layering it is
  correct; a non-atomic read-then-write limiter in front of an atomic one adds
  failure modes, not security. (Subject to C-03.)
- **FIN-05.** The sharpest work in the set, and the diagnosis is better than the
  finding's. Moving the active-code read _above_ the counter increment fixes a
  DoS `final.md` only half-described: an expired code previously burned a verify
  attempt, so five requests against a stale session imposed the full six-hour
  block with no guessing. `BLOCK_EXPIRY_RESET` clearing _both_ per-cycle
  counters is right — clearing only the one the current path reads leaves the
  other at its cap and the penalty never ends.
- **FIN-04 / FIN-06.** Centralizing rotation in `lib/auth/rotation.ts` is
  exactly what the report asked for, and all six call sites go through it.
  Adding `phoneChanged` to `shouldDeleteAllSessions` in the admin path closed a
  gap the report never mentioned.
- **FIN-14's core.** Closed a real credential leak nobody had spotted — Drizzle
  embeds bound parameters in `error.message`. Raw message
  `Failed query: … params: not-a-uuid-but-a-secret-value` now serializes as
  `{"name":"QueryError","message":"[withheld…]","cause":{"name":"DriverError","code":"22P02"}}`.
  Redacting in development too is correct; "development" is a config value, not
  a guarantee. (Subject to C-05.)
- **FIN-08.** NFKC in `passwordSchema` preprocess, at the boundary, before the
  same-password compare, HIBP screen and hash. `lib/auth/password.ts:41` keeps
  NFKC as idempotent defense in depth. Unrelated to FIN-20 — normalization of
  identifier representation vs. KDF cost and key lifecycle for a different
  credential type.
- **FIN-09.** The whole passwordless body inside one `APIError` boundary; status
  and `Retry-After` survive to the wire
  (`better-call/dist/to-response.mjs:114-118` forwards `data.headers`),
  confirmed by 429 probe.
- **FIN-11, FIN-15, FIN-17, FIN-18.** Small, exact, matching their
  recommendations. FIN-18's constraint names were verified against the real
  schema — `ux_users_email` ✓, `ux_users_phone_number` ✓
  (`db/schema.ts:161,164`), `users_role_id_roles_id_fk` ✓
  (`db/drizzle/meta/0002_snapshot.json:1011`) — so exact matching does not
  silently downgrade a known conflict to a 500. Note `should-ignore.md` #23's
  claim that `ux_users_phone_number` does not exist is simply wrong.
- **FIN-19, admin-user half.** The split is the correct answer to the question
  asked: `updateUserSchema` / `createPermissionSchema` stay lenient as
  react-hook-form resolvers (their state legitimately carries response-only
  fields like `createdAt`, `usersCount`); `adminUpdateUserSchema` and the admin
  permission schemas are new, strict, server-only. Strictness is an API
  decision; a form resolver is not the API. The actual defect —
  `phoneProvided = 'phoneNumber' in body` reading the _raw_ body — is fixed via
  `validatedData.phoneNumber !== undefined`, and both edit pages were confirmed
  to send explicitly whitelisted payloads, so nothing 422s against its own
  endpoint.
- **FIN-12 / FIN-13, server half.** Binding column → type → operator → value on
  the server in one table is the correct shape. The `Object.hasOwn` guards are
  not theoretical — `constructor` and `__proto__` previously passed the
  allowlist check and now 422. Boolean `ILIKE` (a PostgreSQL cast 500) is gone.
  All 13 legitimate filter shapes still execute against the live DB. (Subject to
  C-08, C-09.)
- **Toolchain.** `bun tsc --noEmit` clean, `eslint` clean, `git diff --check`
  clean, no dangling references to `ENTITY_ID_AS_UUID`, `otpSendScope`,
  `otpVerifyScope`, `allowedColumns`. `bun run build` was **inconclusive** in
  both GPT-5 runs (timed out at 184s and 304s with no diagnostic) — it must not
  be counted as a pass.
- **FIN-20 deferral.** Unanimous. Swapping Argon2id for a versioned HMAC-SHA-256
  replaces the primitive, key lifecycle and stored-hash format — a design
  change, not a fix, and the security concept (keyed verifier, constant-time
  compare, short expiry, single use, strict attempt limits) is preserved either
  way. The pepper-retirement half is real and mitigable with a documented
  operational rule. The memory half is real but unmeasured: Argon2id at 64 MiB
  is charged per _concurrent_ operation while rate limits bound requests per
  _minute_, so it can surface as latency or OOM before any limiter rejects
  anything — G5-S measured ~96 ms hash / ~81 ms verify at 64 MiB on its machine.
  "Profile under realistic concurrency first" is the correct order. **Never**
  replace it with an unkeyed fast hash.

---

## 4. Where the reports disagreed, and the resolution

| Question                                                           | Split                                                                                                                                                                                                          | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is `OTP_AUTO_VERIFY` acceptable as documented-and-deferred?        | G5-S/G5-N: no, it is enabled and unguarded. CO-S: acceptable, bypass is bounded. GE-S/GE-N: not raised.                                                                                                        | **GPT-5 is right.** Bounded blast radius is not a guard. C-01.                                                                                                                                                                                                                                                                                                                                                                                                |
| Should mutation schemas be strict across the board?                | GE-S: yes, mandated. G5-S/G5-N: no, it regressed the permission contract. CO-S/CO-N: split lenient/strict, which is what shipped for users.                                                                    | **Split by surface.** Strict for admin mutation endpoints, lenient for form resolvers and the deliberately-lenient collection POST. GE-S reasoned from the skill file rather than from real payloads. C-04.                                                                                                                                                                                                                                                   |
| Was FIN-02 fixed?                                                  | GE-S: yes, via an `authVersion` epoch. Everyone else: no, deferred.                                                                                                                                            | **GE-S is factually wrong** — no epoch exists. C-10.                                                                                                                                                                                                                                                                                                                                                                                                          |
| Was FIN-20 implemented?                                            | GE-S implies yes and endorses it. All others: correctly deferred.                                                                                                                                              | **Deferred, and rightly.** GE-S again describes work that did not happen.                                                                                                                                                                                                                                                                                                                                                                                     |
| Is the two-place rate limiting redundant?                          | GE-S/GE-N: not redundant, just scope isolation. CO-S/CO-N/G5-S/G5-N: the `/sign-in/email` pair _was_ genuine duplication of the same admission point, one of them non-atomic and keyed off a forgeable header. | **It was duplication at that path, and disabling it is right.** Separate pre-auth / per-account / session-read / endpoint scopes elsewhere are layering, not duplication. The limit moved from 5/min (non-atomic, forgeable) to 20/min (atomic, trusted IPv6-/64 bucket) plus unchanged per-account lockout — strictly stronger, and the looser number is the right trade since per-account lockout never covered spraying one password across many accounts. |
| Does `getClientIp` hardening make the limiter safer in production? | GE-N: yes, it "won't unexpectedly fail". CO-S/CO-N/G5-S/G5-N: it fails closed with 503 and that is now on the login path.                                                                                      | **GE-N is wrong.** C-03.                                                                                                                                                                                                                                                                                                                                                                                                                                      |

---

## 5. Which report is strongest

**Best overall: `review-Claude-Opus-5-without-skill.md` (CO-N).**

Justification:

- **It executed its claims.** Live 422 probes for every filter shape, a real
  Drizzle error reproduced end to end, a live keyset cursor round trip against a
  real DB timestamp, the vendored `@upstash/ratelimit` Lua read to confirm
  negative-rate refund semantics, `better-auth@1.6.3` source read to confirm all
  three FIN-03 premises _and_ that `customRules: false` disables rather than
  falls back, and `better-call`'s `to-response.mjs` read to confirm `APIError`
  headers reach the wire.
- **It found the most unique substantive issues** — the quick-search regression
  reversing an already-ignored item (C-08), the hand-rebuilt refund key (C-07),
  the undeclared authorization relaxation and the deferred item shipped early
  (C-12), the changed retention semantics, the over-engineered delivery guards
  (C-13), the log denylist fighting its own callers (C-05), and the missing
  FIN-01 `TODO.md` section (C-01).
- **Its calibration is honest.** It states plainly what it could not test — the
  Upstash endpoint was unreachable, so the refund was verified from vendored
  source rather than executed — and it ranks its own recommendations by cost.
- **It answered the questions actually asked** rather than restating a rulebook.

**Its one real blind spot:** it accepted the FIN-01 deferral premise and did not
find the global OTP breaker DoS. Both were caught only by GPT-5.

**Full ranking:**

| Rank | Report                        | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **CO-N** (Opus 5, no skill)   | Most verified findings, most unique findings, honest limits. Missed C-01's severity and C-02 entirely.                                                                                                                                                                                                                                                                                                                                                                            |
| 2    | **G5-N** (GPT-5, no skill)    | Found the two highest-severity items in the whole set (C-01, C-02) plus C-04 and C-09's fail-open. Correctly refused to accept the patch. Read it _alongside_ CO-N — together they cover everything real.                                                                                                                                                                                                                                                                         |
| 3    | **G5-S** (GPT-5, with skill)  | Substantially overlaps G5-N with a cleaner merge gate and the `Error.code` probe; adds C-17. Slightly more deferential to the skill's framing.                                                                                                                                                                                                                                                                                                                                    |
| 4    | **CO-S** (Opus 5, with skill) | Thorough and technically precise, and contributes the best meta-finding (C-19) plus C-07, C-14, C-15, C-16, C-18. But it agreed with 18 of 20 implementations and treated an enabled bypass as adequately documented — the most accepting of the four serious reports.                                                                                                                                                                                                            |
| 5    | **GE-N** (Gemini, no skill)   | Readable summary with correct explanations of what each FIN _is_, but it reviewed the intent rather than the code. No probes, no file:line evidence, and one flatly wrong conclusion about IP fail-open behavior.                                                                                                                                                                                                                                                                 |
| 6    | **GE-S** (Gemini, with skill) | **Weakest, and actively misleading.** It states FIN-02 was fixed with an `authVersion` epoch and endorses the FIN-20 HMAC migration as delivered — neither exists in the code. It closes with "there are no issues that need to be flagged", having found zero defects in a patch that contains at least two high-severity ones. It cites `SKILL.md` rules as evidence of compliance without checking whether the code meets them, which is the exact failure mode C-19 predicts. |

**Pattern worth noting:** for both Claude and GPT-5, the _without-skill_ run was
the stronger of the pair. That is consistent with C-19 — `SKILL.md` was
rewritten after the implementation, so the with-skill reviewers were partly
grading the code against guidance derived from that same code. GE-S is the
clearest demonstration: it scored compliance against the rulebook and never
checked the rulebook's claims against the diff.

---

## 6. Recommended action order

**Merge gates**

1. **C-01** — default `OTP_AUTO_VERIFY` to `false`, require env opt-in _and_ a
   recognized local runtime, fail startup if true in production. Write the
   missing `TODO.md` section.
2. **C-02** — move global provider-breaker consumption to immediately before
   real provider dispatch; keep pre-lookup IP/destination limits.
3. **C-03** — bind trusted IP to one deployment-configured edge header; restore
   a safe local/test path; add the header requirement to the production
   checklist.
4. **C-04** — normalize known-unavailable actions when `false`; reject only when
   `true`; restore the lenient permissions collection POST.
5. **C-06** — remove `/tests/**` from `.gitignore` and `tests/**` from
   `eslint.config.mjs`; fix the two comments asserting non-existent coverage.

**Before calling it done**

6. **C-07** — collapse the OTP daily verify budget to one authority (keep the DB
   counter). If both must stay, extract a shared key-builder first.
7. **C-05** — replace the log denylist with per-event safe fields; exempt
   numbers and booleans.
8. **C-08** — revert quick search to lenient; add client-side recovery for the
   filter 422.
9. **C-09** — reject explicit empty-array filters; bind `variant`; wire the
   trigram migration.
10. **C-12** — revert or justify the `next.config.js` change; make the
    authorization relaxation and the early-shipped F-03 fix explicit decisions;
    update `TODO.md` L-7 and item 12.
11. **C-11** — key the DB attempt block by destination so it agrees with Redis.
12. **C-13** — trim the Proxy / hostile-getter / error-name defenses.
13. **C-14** — make `BUSINESS_TIMEZONE` env-driven and test against a DST zone.

**Follow-ups / record only**

14. **C-15**, **C-16**, **C-17**, **C-18** — small cleanups and one accepted
    tradeoff to write down.
15. **C-10** — raise FIN-02 above FIN-20 in `TODO.md`, pair it with TODO #54,
    and correct any text describing the race as closed.
16. **C-19** — treat `SKILL.md` rules folded back from this pass as provisional.

**Then re-run:** type check, lint, a completed production build (never
demonstrated — both attempts timed out), and focused integration tests for OTP
quota accounting, permission payload compatibility, credential-rotation
concurrency, and log redaction.
