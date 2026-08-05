# Review of the `reports/final.md` implementation

**Reviewer:** Claude Opus 5 (1M context), with `backend-current-project` skill
**Baseline:** `HEAD` = `c13a850 update` · working tree vs. that commit
**Scope:** backend only. Excluded per instruction: `components/`, `hooks/`,
`pages/`, `styles/`, `tests/`, `*.md`, `*.txt`.

---

## 1. Files changed (backend, reviewed)

55 files, +4370 / −1321.

**New modules (7)**

| File                                             | Purpose                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `lib/auth/rotation.ts`                           | `revokeOtherSessions` / `revokePendingProofs` — one revocation policy |
| `lib/auth/live-session.ts`                       | `assertLiveSession` — proves the session row still exists             |
| `lib/auth/api-error.ts`                          | `toAuthApiError` — `CustomError` → Better Auth `APIError`             |
| `lib/data-table/column-specs.ts`                 | `FilterColumnSpec` descriptors, operator/type binding                 |
| `app/api/dash/users/[id]/target-user.ts`         | shared parent/subresource visibility predicate                        |
| `app/api/dash/users/[id]/sessions/pagination.ts` | canonical cursor + limit parsing                                      |
| `utils/time.ts` (extended)                       | timezone-correct calendar-day → UTC bounds                            |

**Modified — auth / OTP / rate limiting** `lib/auth.ts`,
`lib/auth/login-guard.ts`, `lib/auth/passwordless.ts`, `lib/rate-limit/api.ts`,
`lib/rate-limit/index.ts`, `utils/otp.ts`, `utils/config.ts`,
`app/api/auth/{otp/send,otp/verify,passwordless/send,forgot-password/send,forgot-password/reset}/handler.ts`

**Modified — dashboard / users / permissions** `app/api/dash/users/handler.ts`,
`app/api/dash/users/[id]/handler.ts`,
`app/api/dash/users/[id]/sessions/{handler,route}.ts`,
`app/api/dash/users/me/{change-email,change-email/verify,change-password,change-phone,change-phone/verify}/handler.ts`,
`app/api/dash/users/me/contact-change.ts`, `app/api/dash/users/messages.ts`,
`app/api/dash/permissions/handler.ts`,
`app/api/dash/permissions/[id]/handler.ts`, `app/api/dev/sign-up/handler.ts`,
`lib/permissions/{checker,utils}.ts`

**Modified — shared infrastructure** `lib/audit.ts`, `lib/http/session.ts`,
`lib/http/adapters/next.ts`, `utils/api-response.ts`, `utils/index.ts`,
`utils/validation/{auth,permissions,rules}.ts`,
`db/queries/{index,data-table}.ts`,
`lib/data-table/{filter-columns,parsers}.ts`, `utils/{mutation,query}.ts`,
`utils/store/data-table-store.ts`

**Modified — config / tooling (not requested by any finding — see §5)**
`.gitignore`, `eslint.config.mjs`, `next.config.js`, `package.json`,
`constants/index.js`

Previous versions retrieved with `git diff HEAD` (full diff read, not sampled).

---

## 2. Verdict summary

| ID     | Implemented                                                                            | My assessment                                                                                                                                                   |
| ------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FIN-01 | Deferred + documented                                                                  | **Correct.** Left `true`, written up in `should-ignore.md` #55 and `TODO.md`. Verified the bypass still never touches `passwordless_login` / `forgot_password`. |
| FIN-02 | Deferred + documented                                                                  | **Agree with the deferral.** See §4-A for my take.                                                                                                              |
| FIN-03 | Atomic Redis limiter in the sign-in before-hook; Better Auth pinned to trusted headers | **Agree, with one operational gate** — see §4-B.                                                                                                                |
| FIN-04 | `revokePendingProofs` on every rotation path                                           | **Agree.** Genuinely swept the class.                                                                                                                           |
| FIN-05 | `BLOCK_EXPIRY_RESET`, code-read moved above the counter bump, cycle reset on success   | **Agree — strongest fix in the set.** Found a bug the report didn't name.                                                                                       |
| FIN-06 | `revokeOtherSessions` in `commitPhoneChange` + admin phone change                      | **Agree.**                                                                                                                                                      |
| FIN-07 | Hierarchical send quotas, reserved recovery slice, sms+whatsapp collapsed              | **Agree on structure; disagree on the duplicate daily authority** — §4-C.                                                                                       |
| FIN-08 | NFKC in `passwordSchema` preprocess                                                    | **Agree.** Canonicalized at the boundary, as recommended.                                                                                                       |
| FIN-09 | Whole passwordless body inside one `APIError` boundary                                 | **Agree.**                                                                                                                                                      |
| FIN-10 | Per-surface pre-auth scopes; Better Auth `/sign-in/email: false`, `/get-session: 300`  | **Agree — and yes, it was genuine duplication.** Answer in §3.                                                                                                  |
| FIN-11 | `auditCustomRolePermissions` + versioned matrix contract                               | **Agree.**                                                                                                                                                      |
| FIN-12 | Server-owned `FilterColumnSpecs`, 422 instead of drop                                  | **Agree.**                                                                                                                                                      |
| FIN-13 | `BUSINESS_TIMEZONE` + half-open UTC bounds                                             | **Agree on approach; hardcoded zone is wrong for a starter kit** — §4-D.                                                                                        |
| FIN-14 | Bounded structured `serializeForLog`                                                   | **Agree.** Also fixed dev-mode leaking raw values — a real find.                                                                                                |
| FIN-15 | `UPDATE … RETURNING` adopted as post-state                                             | **Agree.**                                                                                                                                                      |
| FIN-16 | Keyset cursor pagination + `revokeAll`                                                 | **Agree.**                                                                                                                                                      |
| FIN-17 | Old/new phone + verified flags in admin audit                                          | **Agree.**                                                                                                                                                      |
| FIN-18 | Exact-name `Map`, `null` → falls to 500                                                | **Agree.** Constraint names verified against the real schema.                                                                                                   |
| FIN-19 | Split lenient RHF / strict server schemas                                              | **Agree — and your instinct was right**, see §3.                                                                                                                |
| FIN-20 | Deferred + documented                                                                  | **Agree with the deferral.** See §4-A.                                                                                                                          |

**Overall: I agree with 18 of 20 implementations as delivered.** The two I'd
change are FIN-07's duplicate daily counter (§4-C) and FIN-13's hardcoded
timezone (§4-D). Neither is a defect; both are design calls I'd make
differently.

---

## 3. Direct answers to your questions

### FIN-19 — "will making the schema strict cause problems later?"

**Your instinct was right, and the implementation respected it.** It did _not_
make every schema strict. It split them:

- `updateUserSchema` / `createPermissionSchema` — unchanged, still lenient,
  still used as react-hook-form resolvers (their state legitimately carries
  response-only fields like `createdAt`, `usersCount`).
- `adminUpdateUserSchema`, `adminCreatePermissionSchema`,
  `adminUpdatePermissionSchema` — new, `.strict()`, server-only.

That's the correct resolution: strictness is an API decision, and a form
resolver is not the API. I verified the coupling holds —
`pages/dash/users/edit.tsx` now builds a narrowed payload
(`id, name, email, phoneNumber, isActive, roleId, password` + conditional
`permissions`) that matches the strict schema exactly, so the UI does not 422
against its own endpoint.

The actual FIN-19 defect — `phoneProvided = 'phoneNumber' in body` reading the
_raw_ body — is fixed properly: presence now comes from
`validatedData.phoneNumber !== undefined`, and `phoneNumber` is genuinely
optional in the parsed schema (`optionalPhoneSchema.optional()`), so `undefined`
means "keep" and `null`/`''` means "clear". That distinction survives Zod's
optional short-circuit.

### FIN-20 — "is this a real fix, or does it change the concept?"

It changes the concept, and it was **correctly not implemented**. Swapping
Argon2id for HMAC-SHA-256 replaces the primitive, the key lifecycle, and the
stored-hash format — that is a design change, not a fix. The deferral write-up
in `TODO.md` states the right precondition: _profile OTP verify under realistic
concurrency first_. The memory argument (64 MiB charged per _concurrent_
operation, while rate limits bound the _rate_) is real but unmeasured. The
pepper-retirement half is real and free to mitigate with a documented rule.

Keeping it deferred is the right call.

### FIN-02 — "what's the actual likelihood?"

Low for the session-insert race, and your reasoning holds: the window is a few
hundred milliseconds between password verification and session insert, and
reaching it needs an attacker who _already holds valid credentials_ to land
inside the victim's rotation. On a bounded dashboard that is not a practical
threat.

But the `TODO.md` write-up adds a second case the original report missed, and
that one is not so easily dismissed: `processOtpSend` takes an advisory lock on
`(userId, channel, purpose)` but never locks `users`, while rotation locks
`users` and then purges `verification_sessions`. Because `sendOtp()` still runs
_inside_ that transaction, the window spans the provider HTTP call — seconds on
an SMTP/SMS timeout, not milliseconds. So a `forgot_password` proof issued
concurrently with a password change can survive it and reset the _new_ password.
No precise timing required.

That said, the fix is still the same `authVersion` epoch, still needs a
migration, and still needs a hook into Better Auth's session creation that the
framework doesn't expose. Deferring is correct. I'd raise its priority above
FIN-20 on the TODO list, and note that moving OTP delivery outside the
transaction (already TODO item #54) shrinks the wider half of this race for free
— those two items should be resolved together.

### FIN-10 — "why is rate limiting in two places? Is it redundant?"

**Yes, it was genuinely redundant, and the resolution is correct.** Better Auth
had its own `/sign-in/email: {window: 60, max: 5}` rule alongside the project's
limiter. Two authorities, different policies, and the weaker one was:

- non-atomic (separate read then write, so parallel requests at the boundary all
  observe the same remaining quota), and
- keyed off Better Auth's default IP resolution, which prefers `x-forwarded-for`
  — a header this codebase deliberately treats as client-controlled.

The fix disables it (`'/sign-in/email': false`) and makes the project's atomic,
trusted-IP limiter authoritative. **I verified `false` actually disables rather
than falling back to the default** —
`better-auth/dist/api/rate-limiter/index.mjs` does
`if (resolved === false) return null;` and the caller does
`if (!config) return;`. Had it fallen back, sign-in would now be limited at
10/min non-atomically, which would have been worse than before.

Nothing was removed without replacement: the limit went from 5/min (non-atomic,
forgeable) to 20/min (atomic, trusted IPv6-/64 bucket) plus unchanged
per-account lockout. That's a strictly stronger arrangement, and the looser
number is the right trade — per-account lockout never covered spraying one
password across many accounts, which is what this layer is for.

### FIN-03 — the `getClientIp` TODO

Noted that it's test-scaffolding pending production headers. One consequence
that raises the stakes on that TODO — see §4-B.

---

## 4. Findings

Ranked by what I'd act on first.

### A. No tests were delivered, and one comment claims otherwise — **high (process)**

Your prompt said tests were preferable for the uncertain cases, and eight
findings' recommendations explicitly ask for regression tests
(FIN-01/02/04/05/08/09/12/13). None were written. Worse:

- `.gitignore` gained `/tests/**` and `eslint.config.mjs` gained `tests/**`, so
  any test written from now on is untracked _and_ unlinted.
- `app/api/dash/users/[id]/sessions/pagination.ts:56` states _"the round trip is
  asserted in the tests"_ — there are no tests. A comment asserting evidence
  that doesn't exist is worse than no comment, because the next reader will
  trust it.

The changes with the highest untested blast radius are the ones I'd cover first:
`processOtpVerify`'s consume/refund budget (exact-boundary, block-expiry,
correct-code-at-cap, repeated-success), the `filterColumns` contract matrix
(absent / malformed / empty / null / over-limit per operator × type), and
`zonedDayStart` / `zonedNextDayStart` across a DST zone.

**Action:** remove `/tests/**` from `.gitignore` and `tests/**` from the eslint
ignores, or state explicitly that tests are intentionally out of scope — and fix
that comment either way.

### B. Sign-in now hard-depends on a trusted edge IP header — **medium (new)**

`ipIdentifier()` throws **503** when neither `cf-connecting-ip` nor
`x-vercel-forwarded-for` is present. That fail-closed behavior is pre-existing
and correct — but it is now on the **login critical path**, which it was not
before.

I confirmed `app/api/auth/[...all]/route.ts` uses
`toNextJsHandler(auth.handler)` directly and has never gone through
`toNextHandler`/`preAuthIpLimit`. So `/api/auth/sign-in/email` previously
required no trusted header at all. It does now, via the before-hook.

Consequence: in any environment where the edge header is missing or renamed —
local dev, a preview deploy, a VPS where Cloudflare is bypassed, or a future
platform migration — **login is hard-down with a 503**, not degraded. That is
the right security posture, but it converts your `getClientIp` production TODO
from "review before launch" into "must be verified before the first deploy, or
nobody can log in."

**Action:** add this to the production checklist explicitly, and decide whether
local development should inject `cf-connecting-ip` via middleware or whether
`getClientIp` should have a narrowly-scoped `NODE_ENV === 'development'`
fallback. Note the second option weakens the trust boundary if it ever ships, so
I'd prefer the first.

### C. Two competing authorities for the OTP daily verify budget — **medium**

`OTP_MAX_DAILY_VERIFY_ATTEMPTS` is now enforced twice:

1. **Redis** `otp.verify.daily.<kind>:<userId>` — per user, across all purposes.
2. **DB** `verification_sessions.verifyAttemptDaily` — per
   `(user, channel, purpose)`.

The skill is explicit: _"do not keep duplicate authorities that enforce the same
policy differently."_ The Redis one is strictly tighter and therefore binding;
the DB one is now unreachable in practice except on a single purpose. And the
whole consume-then-refund apparatus — the `confirmedCodeFailure` flag, the
`releaseBudget` closure, the `try/catch` around the transaction, and
`GREATEST(verifyAttemptDaily - 1, 0)` — exists only to keep the two agreeing.

I traced the mechanics and they are correct: the Redis key strings match exactly
between `enforceOtpVerifyDailyBudget` (`scope + ':' + identifier`) and
`refundOtpVerifyAttempt` (`otpVerifyDailyKey`), the limiter instance is the same
(`limit:window` cache key), and I confirmed in
`@upstash/ratelimit/dist/index.js` that the sliding-window Lua script does
`if incrementBy > 0 and …` — so `rate: -1` genuinely skips the cap check and
refunds atomically. It works. It's just more machinery than the problem needs.

**Action:** pick one. I'd keep the DB counter (it's transactional, it's already
per-cycle-correct after the FIN-05 fix, and it needs no refund) and rekey it —
or keep Redis and drop the DB daily column. Either removes ~40 lines and one
failure mode.

Related, lower severity: `refundRateLimit` logs and swallows. If Redis is up for
the admission and down for the refund, a _successful_ verify permanently spends
a token from a 24-hour budget, and a legitimate user can be locked out of every
OTP flow for the rest of the day with only a `console.error` to show it. The
tradeoff is documented in the code, and turning a Redis blip into a 5xx would be
worse — but it's another reason to prefer the transactional counter.

**Not a finding, for the record:** I checked whether the new per-user daily
budget introduced an account-enumeration oracle, since it's only reachable for
real accounts and throws a distinguishable 429. It does not — the pre-existing
DB `verifyAttemptDaily` cap already threw 429 for exactly the same per-user
condition, and `app/api/auth/otp/verify/handler.ts` deliberately keeps 429
distinct per the documented privacy contract. Pre-existing, unchanged.

### D. `BUSINESS_TIMEZONE` is a hardcoded source constant — **low**

`utils/config.ts:19` → `export const BUSINESS_TIMEZONE = 'Asia/Riyadh';`

Committing to one calendar zone is the right _design_ — FIN-13 is real, and
half-open `>= start, < nextDay` ranges are the correct shape. But this is a
starter kit, and every downstream project will have a different zone. Hardcoding
it means each fork edits a source file rather than an env var, which is exactly
the class of drift that produces "the date filter is off by one" bugs six months
later.

**Action:**
`export const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE ?? 'Asia/Riyadh';`
with a validity check (`Intl.supportedValuesOf('timeZone')` or a try/catch
around one formatter construction at module load), matching how
`PHONE_NUMBER_MODE` and the OTP flags are already handled in that file. Note
that Riyadh has no DST, so the `resolveZonedWallClock` two-pass logic and the
`MIDNIGHT_JUMP_PROBE_HOURS` probe are currently untestable against the shipped
default — which is another argument for making the zone configurable _and_
testing it against a DST zone.

### E. Successful verify now clears send-cycle state — **low (tradeoff, accept)**

The FIN-05 fix resets `attemptNumber: 0` and `nextAllowedAt: null` on a
successful retained-purpose verify. This is necessary — without it, five
successful passwordless logins left the send counter at its cap and the sixth
self-inflicted a six-hour block, which is a genuine bug the report described
correctly.

The side effect: for a user who can complete verifies (i.e. actually owns the
contact), the DB-side send throttle no longer accumulates at all, and the resend
cooldown is cleared. The only remaining send bound for that user is the Redis
`otp.send.*` chain (5–6/hour per destination, fail-closed).

That's acceptable — it's a bound that moved from the DB to Redis rather than one
that disappeared, and it requires knowing the code. Worth knowing it moved.

### F. Duplicated `SUPERSEDING_ACTION` — **low**

Defined identically in `lib/permissions/checker.ts:33` and
`lib/permissions/utils.ts:~410`, both as
`Object.fromEntries(Object.entries(OWN_ACTION_MAP).map(([all, own]) => [own, all]))`.
Skill §9: _"No duplication — extract shared filters, predicates, and validation
schemas."_ Move it next to `OWN_ACTION_MAP` in `lib/permissions/constants.ts`.

### G. Self-directed scope expansion in `resolveActionScope` — **low**

`resolveActionScope` was changed _and exported_ to handle own-scoped actions
requested directly (`editOwn` etc.). The code comment is honest that no route
asks for an own variant today, so neither prior misbehavior was reachable.

The change is correct on its merits and I'd keep it. But it isn't in any FIN,
and exporting a previously-private function widens the surface to fix a latent
case. Flagging it so it's a deliberate choice rather than an unnoticed one — the
same applies to the `utils/mutation.ts` DELETE-body fix and the
`data-table-store` per-table scoping, both of which are real bugs but neither of
which appears in `final.md`.

### H. In-scope sibling skipped: `markContactVerified` is still not the single writer — **low (pre-existing)**

Skill §2: _"Verified flags have one writer — `markContactVerified` is the only
place `emailVerified`/`phoneNumberVerified` are set."_

That is not true of the code as it stands.
`app/api/dash/users/me/contact-change.ts` sets them inline at four sites (lines
111, 118, 176, 183), and `handleAdminEdit` sets them to `false`. This is
**pre-existing, not introduced** — but `contact-change.ts` was heavily edited in
this diff, so it was an in-scope sibling that went unaddressed and unrecorded.
Per the skill's own rule, deferred sites should be listed with a reason.

### I. Bookmarked-URL 422 has no client-side recovery — **low**

The strict server filter contract is right, and the client correctly forwards
raw state instead of silently discarding it (skill §1). But the consequence is
that a stale bookmark referencing a renamed column, or a 1–2 character search,
now returns a hard 422 (`أحد عوامل التصفية غير صالح، أعد ضبط التصفية`) with no
automatic recovery — the user must clear filters manually.

Also note the parser now 422s on a _malformed sort_ (`parseSortItem` → `null` →
`onDropped` → throw) while an _unknown sort column_ stays lenient. That split is
defensible and documented, but it means the sort path has two different
philosophies in one function.

**Action:** have the data-table UI catch that specific 422 and clear the
offending filter state once before retrying.

### J. Verified as correct — no action

Things I specifically checked because they were the most likely place for a
regression, and which hold up:

- `bun tsc --noEmit` — **clean, no errors.**
- Constraint names in the new exact-match `Map`/`Set` against the real schema:
  `ux_users_email` ✓, `ux_users_phone_number` ✓ (`db/schema.ts:161,164`),
  `users_role_id_roles_id_fk` ✓ (`db/drizzle/meta/0002_snapshot.json:1011`). So
  FIN-18's exact matching does not silently downgrade a known conflict to a 500
  — and note `should-ignore.md` #23's claim that `ux_users_phone_number` doesn't
  exist was simply wrong; it does.
- No stale references to removed symbols: `otpSendScope`, `otpVerifyScope`,
  `allowedColumns`, `ENTITY_ID_AS_UUID` — all zero hits. (`ENTITY_ID_AS_UUID`
  was being _exported without ever being defined_ in `constants/index.js` — a
  latent `ReferenceError` on import. Removing it is a real fix, though unrelated
  to any finding.)
- `CustomError(message, status, code)` — third parameter is `code`, so
  `MUTATION_AFTER_SUCCESS_CODE` is passed correctly, not into `responseHeaders`.
- `useRouter` from `next/router` in `utils/query.ts` — correct; this project
  runs the Pages Router alongside `app/api/*` (20 other files import it).
- The sign-in limiter is scoped inside `if (ctx.path === '/sign-in/email')`, so
  it does not apply the 20/min budget to `/get-session`.
- `isEmpty` narrowing (dropping the `[]`/`{}` branches) has exactly one caller,
  `filter-columns.ts`, so no other consumer relied on JSON-emptiness semantics.
- `applySorting` still appends the `desc(id)` tiebreaker, and `Object.hasOwn` is
  used for the sort allowlist rather than `in`.
- `OTP_AUTO_VERIFY` still never reaches `passwordless_login` or
  `forgot_password` — the send/reset handlers document and enforce it.
- `isBetween` on a _number_ column changed semantics (a single supplied bound
  used to become `eq`, now becomes `gte`/`lte`). This is a fix, and it's
  currently unreachable — neither `USERS_FILTER_COLUMNS` nor
  `PERMISSIONS_FILTER_COLUMNS` declares a numeric column. Worth remembering
  before the first one is added.

---

## 5. Scope creep — changes no finding asked for

These are outside `final.md` entirely. Two are fine, two I'd revert.

| Change                                                                       | My call                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `next.config.js` — `experimental.scrollRestoration: false` **commented out** | **Revert or justify.** This silently re-enables Next's scroll-restoration behavior across the whole app. Nothing in the report touches it, and it's a UX change hidden inside a security-and-correctness diff.                                                                                                                                                 |
| `.gitignore` — `/tests/**`, `/prompt-*.md`; `eslint.config.mjs` — `tests/**` | **Revert the `tests` entries.** See §4-A: this actively contradicts eight findings that ask for regression tests.                                                                                                                                                                                                                                              |
| `constants/index.js` — dropped undefined `ENTITY_ID_AS_UUID` export          | **Keep.** Verified against `git show HEAD:constants/index.js`: the symbol was in the `export {}` list but had no `const` declaration, so the module was exporting a binding that didn't exist. (Stale `.next` chunks still contain `const ENTITY_ID_AS_UUID = false` from an older build, which is how the removal is safe — nothing has referenced it since.) |
| `package.json` — `"packageManager": "bun@1.3.14"`                            | **Keep.** Matches how you actually run the project.                                                                                                                                                                                                                                                                                                            |

Also note: `.claude/skills/backend-current-project/SKILL.md` was itself
rewritten during this work — it now documents `lib/auth/rotation.ts`,
`adminUpdateUserSchema`, `FilterColumnSpec`, `serializeForLog` and the
`useDataTableStore` per-table reset as established rules. Because `.claude` is
gitignored, **that change is invisible in the diff.**

The file timestamps put it _after_ the implementation, not before it:

| Artifact                               | Last written         |
| -------------------------------------- | -------------------- |
| `reports/final.md`                     | 2026-08-02 00:25     |
| commit `c13a850` (the baseline)        | 2026-08-02 00:37     |
| `lib/auth/rotation.ts` (new impl file) | 2026-08-02 23:14     |
| `SKILL.md`                             | **2026-08-03 21:15** |

It's reasonable to fold hard-won rules back into the skill, but the guidance you
review future work against was written a day _after_ the code it now describes —
so it can no longer serve as an independent check on this work. Two of my
findings sit exactly on that seam: §4-H (the skill asserts `markContactVerified`
is the single writer of the verified flags, which the code contradicts at five
sites) and §4-C (the skill forbids duplicate rate-limit authorities, which the
OTP daily budget now is). In both cases the skill states the rule correctly and
the shipped code doesn't meet it — which is the failure mode to watch for when
guidance and implementation come from the same pass. Worth diffing that file
separately if you have a copy of the prior version.

---

## 6. What I did and did not verify

**Did:** read the complete backend diff (not sampled); `bun tsc --noEmit`;
verified constraint/index names against `db/schema.ts` and the drizzle
snapshots; read the `@upstash/ratelimit` sliding-window Lua script to confirm
negative-rate refund semantics; read `better-auth`'s rate-limiter to confirm
`customRules: false` disables rather than falls back; traced Redis key
construction end-to-end for the enforce/refund pair; grepped for stale
references to every removed symbol; confirmed the admin-edit UI payload matches
the new strict schema; confirmed `/api/auth/[...all]` was never wrapped by
`toNextHandler`.

**Did not:** run the app or any request against a live database or Redis — no
runtime verification of the new OTP budget behavior, the cursor pagination, the
timezone boundaries, or the 422 filter rejections. There is no test suite to
run. Every claim in §4 about _runtime_ behavior is reasoned from the code, not
observed. The two places I'd least want to ship unobserved are the
consume/refund budget in `processOtpVerify` and `zonedDayStart` /
`zonedNextDayStart` against a DST zone.

**Excluded per instruction:** `components/`, `hooks/`, `pages/`, `styles/`,
`tests/`, `*.md`, `*.txt`. I read `pages/dash/users/edit.tsx` only far enough to
confirm the admin PUT payload matches the strict server schema, since that is a
correctness dependency of a backend change rather than a front-end review. Note
that `utils/mutation.ts`, `utils/query.ts` and `utils/store/data-table-store.ts`
are client-side but live under `utils/`, so they were in scope and are covered
above.

---

## 7. Recommended order of action

1. Remove `tests` from `.gitignore` / eslint ignores; fix the comment in
   `pagination.ts:56` that claims tests exist (§4-A).
2. Add the trusted-IP-header requirement for `/sign-in/email` to the production
   checklist, and decide the local-dev story (§4-B).
3. Collapse the OTP daily verify budget to one authority (§4-C).
4. Make `BUSINESS_TIMEZONE` env-driven and test it against a DST zone (§4-D).
5. Revert the `next.config.js` scroll-restoration change or state why it's there
   (§5).
6. Extract the duplicated `SUPERSEDING_ACTION`; record `markContactVerified`'s
   remaining co-writers as a deferred site (§4-F, §4-H).
7. Raise FIN-02 above FIN-20 in `TODO.md` and pair it with TODO #54 (OTP
   delivery outside the transaction) — that item shrinks the wider half of the
   race on its own (§3).
