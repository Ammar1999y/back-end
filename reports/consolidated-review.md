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

## 2. Unified findings

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

**Reported by:** CO-S (§4-G, §5), CO-N (§5.2, §5.3, §5.4, §5.5, §5.9), G5-S/G5-N.

| Change                                                                                               | Files                                                                           | Call                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
| `validatePermissionScope` loosened — `actorHoldsAction` lets an actor holding `edit` grant `editOwn` | `lib/permissions/utils.ts`                                                      | **Decide explicitly.** The reasoning is sound (`edit` is a strict superset, and `PERMISSION_ACTIONS` already says so), but it _relaxes an authorization check_ and no FIN item requested it. That should be a decision, not a side effect.                                                                                                                                                                |
| `assertLiveSession` added to `requireSession`; `sessions` joined in `checkUserPermission`            | `lib/auth/live-session.ts`, `lib/http/session.ts`, `lib/permissions/checker.ts` | **Declare it.** This implements `should-ignore.md` #52 / `TODO.md` F-03, filed under _Known Issues — Will Be Fixed Later_. The change is correct — every revocation path deletes rows, so re-reading user and role but not the session authorizes a session revoked minutes ago — but it costs a DB round-trip on every mutation and F-03 now documents a fix that partly shipped. Update F-03 or revert. |
| `revokePendingProofs` deletes already-**consumed** sibling rows                                      | `lib/auth/rotation.ts`                                                          | **Keep, update the docs.** Consumed rows have their code deleted and `consumedAt` set, so they are unreplayable, and the implementation closed the gap it created by adding the missing passwordless proof-consumption audit event in the same transaction. But `verification_sessions` is no longer a trail of any kind; `TODO.md` item 12 (verification-session TTL) should say so.                     |
| `GET /dash/users/:id` lost its parallel fetch; `actorCoversTargetRole` query added                   | `app/api/dash/users/[id]/handler.ts`, `app/api/dash/users/[id]/target-user.ts`  | **Keep, update L-7.** The security reason is legitimate — the child route's role-authority check was bypassable, since page one arrived through the parent and only page two was refused. But it adds 1–2 sequential round-trips to a hot path and reverses `TODO.md` L-7's explicit _"keep parallel fetch"_ decision.                                                                                    |
| `resolveActionScope` changed **and exported** to handle own-scoped actions                           | `lib/permissions/utils.ts`                                                      | **Keep, note it.** The comment admits no route requests an own variant today, so neither prior misbehavior was reachable. Correct on its merits; exporting a previously-private function to fix a latent case is scope expansion worth acknowledging.


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

## 4. Where the reports disagreed, and the resolution

| Question                                                           | Split                                                                                                                                                                                                          | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Should mutation schemas be strict across the board?                | GE-S: yes, mandated. G5-S/G5-N: no, it regressed the permission contract. CO-S/CO-N: split lenient/strict, which is what shipped for users.                                                                    | **Split by surface.** Strict for admin mutation endpoints, lenient for form resolvers and the deliberately-lenient collection POST. GE-S reasoned from the skill file rather than from real payloads. C-04.                                                                                                                                                                                                                                                                                                                                                                        |
| Is the two-place rate limiting redundant?                          | GE-S/GE-N: not redundant, just scope isolation. CO-S/CO-N/G5-S/G5-N: the `/sign-in/email` pair _was_ genuine duplication of the same admission point, one of them non-atomic and keyed off a forgeable header. | **It was duplication at that path, and disabling it is right.** Separate pre-auth / per-account / session-read / endpoint scopes elsewhere are layering, not duplication. The limit moved from 5/min (non-atomic, forgeable) to 20/min (atomic, trusted IPv6-/64 bucket) plus unchanged per-account lockout — strictly stronger, and the looser number is the right trade since per-account lockout never covered spraying one password across many accounts.
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
