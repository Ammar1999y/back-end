# Consolidated Audit — Final Report

Merge of `reports/claude-opus-audit.md` (report **A**) and
`reports/claude-opus-autonomous-audit.md` (report **B**) into one register of
confirmed, actionable defects. Provenance is marked per finding (`A Fnn`,
`B nn`) so the underlying evidence can be reread.

## How to read this

- **Severity** follows the scale in `prompt-report.md`: realistic impact,
  reachability, likelihood, blast radius — not the worst imaginable outcome.
  Where the two reports disagreed, the calibration decision and its reason are
  stated in the finding.
- **Deduplication.** Findings sharing a root cause and remediation are one entry
  with the strongest description and the strongest remediation of the two,
  synthesised where neither was sufficient alone.
- **Nothing here is in `reports/should-ignore.md`.** Each finding that borders an
  accepted trade-off states why it is distinct. One ignore-list entry is
  factually stale; that is recorded under _Ignore-list corrections_, not as a
  re-report.
- **Line numbers** are as measured by the source audits, which ran before commit
  `a4bb98d`; ~28 files changed in it, so some have drifted — e.g. the lockout
  comparison reported at `lib/auth/login-guard.ts:151-153` is now `:160-161`.
  Symbols are stable; locate by symbol when a line does not match.
- **Praise, coverage records and "verified correct" inventories are excluded** by
  instruction. Only defects are recorded. Report A's withdrawn F24 is dropped.

---

# Findings

## Critical

### C1 — `mode: 'string'` timestamps decode with the host UTC offset, disabling four abuse controls and corrupting every returned timestamp

**Severity Critical.** _(B 1. Report A swept the same area and concluded "not
applicable" on the premise that `mode: 'string'` means the driver's value passes
through untouched; the decoder evidence below disproves that premise. A's sweep
answered a narrower question — Bun 1.4's `.simple()` decoding change — and
generalised the answer to the whole column set.)_

**Root cause** — `db/schema.ts:119-135` (the shared `timestamps` helper) and
every other timestamp column: `timestamp(..., { withTimezone: true, mode:
'string' })`. All 25 `timestamptz` columns are `PgTimestampString`; none is
`mode: 'date'`.

`bun:sql` hands drizzle a `Date` for `timestamptz` — asserted by the project's
own contract test (`tests/integration/driver-contract.test.ts`:
`expect(updated[0]?.updated_at).toBeInstanceOf(Date)`) — so the
`typeof value === "string"` early return in drizzle's string-mode decoder
(`node_modules/drizzle-orm/pg-core/columns/timestamp.js:66-75`) never fires, and
the branch below it always does: it takes the **UTC wall clock** and appends the
**process-local** offset, naming a different instant from the one stored.

```js
mapFromDriverValue(value) {
  if (typeof value === 'string') return value;                 // never taken
  const shortened = value.toISOString().slice(0, -1).replace('T', ' ');  // UTC wall clock
  if (this.withTimezone) {
    const offset = value.getTimezoneOffset();                  // LOCAL offset
    …
```

Measured directly against the project's own schema:

```
$ bun -e "const s = await import('./db/schema.ts');
          const truth = new Date('2026-08-21T12:34:56.780Z');
          console.log(s.sessions.createdAt.constructor.name,
                      s.sessions.createdAt.mapFromDriverValue(truth))"
PgTimestampString  2026-08-21 12:34:56.780+03      <- claims 09:34:56Z; truth is 12:34:56Z
```

Nothing pins the process timezone: no `Dockerfile`, no compose file, no
`TZ` in `.github/workflows/ci.yml`, `mise.toml`, `bunfig.toml` or any source
file; Coolify uses the server timezone; and `utils/config.ts` defaults
`BUSINESS_TIMEZONE` to `Asia/Riyadh` (UTC+3) — exactly the direction that makes
every consequence below live. Each was proven by running the same probe twice,
once under the host zone and once under `TZ=UTC`.

**1. Account lockout never applies (fail-open).** `lib/auth/login-guard.ts` reads
`lockedUntil` into JavaScript and compares it
(`new Date(user.lockedUntil).getTime() > Date.now()`). East of UTC the decoded
instant is _earlier_ than the truth, and any offset ≥ 5 minutes exceeds the whole
`LOCK_DURATION_SECONDS`, so an armed lock always reads as expired and the "lock
expired" branch resets the counter. Twelve wrong passwords through the real
`POST /api/auth/sign-in/email`, `cf-connecting-ip` varied so the per-IP limiter
never fired:

```
host TZ (UTC+3)                              TZ=UTC (counterfactual)
attempt  5: failed=5 locked_until=17:55:06Z  attempt  5: failed=5 locked_until=17:55:35Z
attempt  6: failed=1 locked_until=null       attempt  6: failed=5 locked_until=17:55:35Z
attempt 12: failed=2 locked_until=null       attempt 12: failed=5 locked_until=17:55:35Z
correct password after 12 failures -> 200    correct password after 12 failures -> 401
```

`MAX_FAILED_ATTEMPTS = 5` and `LOCK_DURATION_SECONDS = 300` are inert:
`failed_login_attempts` can never exceed 5, so there is **no cumulative bound at
all** on password guessing against one account. `lib/auth.ts:154-155` states the
two controls are complements — _"Per-account lockout does not cover this:
spraying one password across many accounts never trips it"_ — so one half of a
deliberately two-layer control is dead, and a distributed attacker bypasses the
surviving half by construction. The same dead check governs the
re-authentication counter for `/me/change-password`, `/me/change-email` and
`/me/change-phone` (5/min each): ~15 guesses/minute indefinitely, no lockout.
West of UTC the sign flips and the lock instead lasts `offset + 5 min` — a
self-inflicted denial.

**2. OTP verify block never applies (fail-open).** `utils/otp.ts:800`, same
shape. With a `verification_sessions` row blocked for five more minutes and a
live code present, the real `processOtpVerify` with a wrong code:

```
host TZ (UTC+3): 400 (wrong code)   row after: is_blocked=false verify_attempt_number=1
TZ=UTC         : 429 (blocked)      row after: is_blocked=true  verify_attempt_number=0
```

**3. OTP send block and resend cooldown never apply.** `utils/otp.ts:438`
(block) and `:465` (`nextAllowedAt`). The cooldown ladder is `30 · 2^(n-1)` s —
30, 60, 120, 240, 480 — every value smaller than the host offset, so the branch
is unreachable east of UTC. All five codes of a cycle can be requested
back-to-back instead of over ~8 minutes: five paid deliveries to a chosen
destination as fast as the endpoint limiter allows. Scope precisely: the
SQLite-backed hierarchical quotas in `lib/rate-limit/*` are **unaffected** (they
do integer-epoch arithmetic) — which is why M12 matters more than it otherwise
would, since they become the only surviving layer.

**4. Session-list pagination silently skips rows.**
`app/api/dash/users/[id]/sessions/pagination.ts:41` builds the keyset cursor from
the mangled string. Three sessions one minute apart, `limit=1`, running the
handler's exact query:

```
                  host TZ (UTC+3)                 TZ=UTC
page 1 returned   "2026-08-21 12:02:00.000+03"    "2026-08-21 12:02:00.000+00"
nextCursor        2026-08-21T09:02:00.000Z|<id>   2026-08-21T12:02:00.000Z|<id>
page 2 rows       0  (correct answer: 2)          2  (correct)
```

The remaining sessions are unreachable — precisely the failure the keyset design
was introduced to remove (`pagination.ts:8-11`: _"an OLDER compromised session
could not be discovered at all — and selective revocation needs its id"_). An
operator revoking a compromised session can be shown a list that omits it, with
200 and no signal. West of UTC page 2 re-serves page 1 — a client loop. Distinct
from `should-ignore.md` #62, which concerns only the _index_ behind a correct
cursor.

**5. Every returned timestamp is wrong, and session expiry is evaluated at the
wrong instant.** All `createdAt`/`updatedAt` on the four dashboard read endpoints
and the `updatedAt` returned by `PUT /api/dash/permissions/:id` are off by the
host offset. Date _filters_ bind real `Date` parameters and are unaffected, so
filtering and display disagree: a row can be filtered into 21 Aug and rendered as
20 Aug. Better Auth compares `expiresAt` in JavaScript and its drizzle adapter
coerces `new Date(data)` — from the shifted string. Measured: with
`sessions.expires_at = now() + 1 hour`,
`auth.api.getSession({ disableCookieCache: true })` returns **null**. East of UTC
this fails closed (a 28-day session loses three hours, invisibly); west of UTC it
accepts a session for `|offset|` hours _past_ true expiry. Three JS-side reads
were checked and are correct because the comparison happens in SQL
(`utils/otp.ts:831`, `:855`, `lib/auth/live-session.ts:43`).

**Remediation** — one root cause, one place to fix:

1. **`mode: 'date'` on the timestamp columns** (or drop `mode`; `date` is the
   default) and let the driver's `Date` reach callers. Comparison sites like
   `new Date(user.lockedUntil)` keep working. The API response shape changes from
   `"2026-08-21 12:02:00.000+03"` to an ISO string — a client-visible contract
   change, so make it deliberately, in one commit across all 25 columns.
2. **Immediate mitigation, independent of the fix:** pin `TZ=UTC` in the
   deployment environment. Verified to make all five consequences correct.
3. **Regression tests with `TZ` forced to a non-UTC zone.** A UTC CI host hides
   this entire class — see _Missing tests_.

**Verification command:** the `bun -e` probe above; prefix `TZ=UTC` for the
counterfactual.

---

## High

### H1 — `validID` does not canonicalise case, so three `===` self-guards on path UUIDs are bypassable

**Severity High.** _(A F27 + B 4 — independently reported, same root cause, same
conclusion.)_

**Root cause** — `utils/index.ts:501-513`:

```ts
const UUID_V7_REGEX = /^[0-9a-f]{8}-...-[0-9a-f]{12}$/i; // case-insensitive
export const validID = (val: unknown): string => {
  if (typeof val !== 'string') return '';
  const trimmed = val.trim();
  return UUID_V7_REGEX.test(trimmed) ? trimmed : ''; // returned verbatim
};
```

Every id in the database is lowercase (`Bun.randomUUIDv7()` output, and
PostgreSQL renders `uuid` lowercase), so `validID` mints a second spelling of the
same row id: one that fails a JavaScript `===` but matches the same row in SQL.
Both halves measured on the pinned stack — Elysia preserves path-segment case
over a real socket, and PostgreSQL compares the two as equal:

```
REAL SOCKET  sent 01A02581… | status 200 | params.id seen: 01A02581-a7ee-723b-…
{"uuid_equal": true, "text_equal": false}          <- the whole defect
drizzle WHERE users.id = <UPPER>       -> 1 row
adminUpdateUserSchema id after parse   -> 01A024F0-…  (not normalised)
```

Essentially every UUIDv7 contains at least one `a-f` digit, so the alternate
spelling always exists.

**Guard 1 — self-edit routing into the admin schema (this is the High).**
`app/api/dash/users/[id]/handler.ts:718-742`: `userId === targetId` is the
**only** thing routing to `handleSelfEdit`. `handleAdminEdit` was read in full
(`:303-470`) and contains **no self-check** — only `isProtectedSystemRole` and
`editScope === 'own' && lockedUser.createdBy !== actor.userId`, neither of which
compares target to actor. The schemas are not comparable:
`selfUpdateUserSchema` is `.pick({ name }).strict()`, while
`adminUpdateUserSchema` accepts `password`, `email`, `isActive`, `roleId`,
`permissions`.

Failure scenario: an actor holding `users.edit` at scope `all` sends
`PUT /api/dash/users/<own-id-with-one-hex-letter-uppercased>` carrying a
`password`. The self-edit branch is skipped and the handler writes a new argon2
hash to the actor's own credential row — **with no current password, no captcha
and no OTP**, the three controls `me/change-password` enforces
(`requireSession → enforceRateLimit → verifyTurnstileRequest →
verifyLoginAttempt`). The same request with a new `email` bypasses the
re-auth-plus-OTP contact-change flow, which then chains into forgot-password on
an attacker-controlled address; `handleAdminEdit` then revokes other sessions,
logging the legitimate owner out. This is not privilege escalation — such an
actor could already change _other_ users' credentials — it is the defeat of the
re-authentication boundary that exists so a stolen session cookie alone is not
enough. A stolen cookie stops being recoverable.

**Guard 2 — `cannotEditOwnRole`**, `app/api/dash/permissions/[id]/handler.ts:158`.
`id` flows through `idSchema` → `validID` and keeps its case, while
`actorRoleId` comes from the `uuid` column. Every downstream `eq(roles.id,
roleId)` still finds the row, so an actor with `permissions.edit` can deactivate
or re-scope the role currently authorising them. Destructive rather than
escalating (`validatePermissionScope` still bounds what may be granted), and on a
role shared with other administrators it is a denial of service against them.

**Guard 3 — `cannotDeleteSelf`**, `app/api/dash/users/[id]/handler.ts:776-780`.
Same skip; the soft delete then matches the actor's own row (email anonymised,
`accounts` hard-deleted, `roleId` nulled). Per `should-ignore.md` #49 that is
deliberately unrecoverable. Not covered by #42, whose reasoning is that the owner
holds the `system` role and system-role rows are filtered out of the delete path
— that protects the owner, not any other `users.delete` holder.

**Class inventory** (the same comparison, at every site):

| Site                                                      | Direction                                                                                                                                     |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `users/[id]/handler.ts` GET `isSelf`                      | fails **closed** — a self-view without `users.view` is denied                                                                                 |
| `users/[id]/handler.ts` PUT dispatch                      | fails **open** — exploitable                                                                                                                  |
| `users/[id]/handler.ts` DELETE self-guard                 | fails **open** — exploitable                                                                                                                  |
| `users/[id]/sessions/handler.ts` `isSelf`                 | fails **closed** — only _adds_ `assertTargetReachable`                                                                                        |
| `permissions/[id]/handler.ts:158`                         | fails **open** — exploitable                                                                                                                  |
| `users/[id]/handler.ts:385,593` (body `roleId` vs stored) | spurious "role changed": an extra `validateRolePermissionScope` round trip, a session-metadata refresh and an audit row for an unchanged role |

**Remediation — at the shared boundary, not the three call sites.**
`return UUID_V7_REGEX.test(trimmed) ? trimmed.toLowerCase() : '';`. All 20
`validID` call sites then compare canonical forms, and `idSchema`
(`utils/validation/rules.ts:64-68`) inherits it. Nothing that works today can
break: every stored id is already lowercase. Fixing the three comparisons
individually would leave the class open (AGENTS.md, Fix discipline).

### H2 — `POST /api/auth/sign-in/email` performs an unbounded outbound captcha call before any rate limiter

**Severity High.** _(B 3.)_

**Location** `app.ts:374-395` (the Better Auth prefix is registered with a plain
Elysia route handler, not through `toElysiaHandler`), `lib/auth.ts:414-423`
(`customRules['/sign-in/email']: false`), `lib/auth.ts:156-168` (the app's own
limiter, in a `before` hook).

**Evidence.** Three facts compose. (1) Because the prefix does not go through
`toElysiaHandler`, `enforcePreAuthIpLimit` — which every `preAuth: 'ip-limit'`
route in `routes.ts` gets — never runs for any Better Auth path. (2) Better
Auth's own limiter runs first in its router
(`node_modules/better-auth/dist/api/index.mjs:168` `onRequestRateLimit`, then
`:170` the plugin `onRequest` handlers), but `'/sign-in/email': false` makes
`dist/api/rate-limiter/index.mjs:274` return `null` — no limit at all for that
path. (3) The captcha plugin's `onRequest` then performs a `betterFetch` to
`challenges.cloudflare.com/turnstile/v0/siteverify` with
`timeout: CAPTCHA_VERIFY_TIMEOUT_MS = 10_000`
(`dist/plugins/captcha/constants.mjs:8`). The app's own
`SIGN_IN_IP_LIMIT_PER_MINUTE = 20` lives in `hooks.before`, which runs _after_
the plugin chain.

```
40 unauthenticated POSTs to /api/auth/sign-in/email with any x-captcha-response
  -> outbound siteverify calls: 40      statuses: {"403": 40}
control: no x-captcha-response         -> 400, outbound calls: 0
```

**Impact.** One inbound request of a few hundred bytes produces one outbound TLS
request held for up to 10 s, with no bound of any kind. An unauthenticated client
can exhaust outbound sockets and file descriptors, saturate the event loop and
consume Turnstile quota, on the one endpoint whose availability matters most;
legitimate sign-ins queue behind the same outbound pool. This is the only place
in the codebase that gets the ordering wrong — the same invariant is stated
verbatim and implemented correctly in `otp/send`, `otp/verify`,
`forgot-password/send` and `lib/auth/passwordless.ts` (_"Per-IP cap BEFORE
captcha so the outbound siteverify call is bounded"_). `/passwordless/verify` is
the instructive one: it also has `customRules: false` and compensates by calling
`enforceRateLimit` as its first statement — which `/sign-in/email` cannot do,
because its captcha runs in a plugin `onRequest` upstream of any hook.

**Remediation (synthesised — stronger than either report's own suggestion).**
`app.ts` already argues that the Better Auth wildcard handler is the
class-closing position: _"ANY plugin's `onRequest` runs ahead of the hook, so the
class stays open as long as the decision is made downstream of the plugin chain.
Making it here removes the class."_ The allowlist check is already made there.
Make the admission decision in the same place, before `auth.handler(request)`:

```ts
// the prefix handler becomes async; nothing else about it changes
await enforcePreAuthIpLimit(buildRequestMeta(request)); // head only, no body parse
if (prefix.paths.includes(subPath)) return auth.handler(request);
```

Placed before the allowlist check it also bounds 404-hammering of the prefix, and
`buildRequestMeta`'s `params` argument already defaults to `{}`
(`lib/http/request.ts:17-19`). **One detail the implementer must not miss:** this
handler has no `try`/`catch` of its own, and `app.ts`'s `onError` deliberately
does _not_ route through `handleApiError` — anything escaping `toElysiaHandler`
becomes a generic `500 MSG_INTERNAL_ERROR` (`app.ts:296-316`). So the limiter's
`CustomError` must be caught here and passed to `handleApiError`, the way
`toElysiaHandler` does (`lib/http/adapters/elysia.ts:63-66`), or a 429/503 with
its `Retry-After` degrades into an unlabelled 500.

`enforcePreAuthIpLimit` is deliberately framework-independent and body-free
(`lib/http/pre-auth.ts:53-66`: _"Takes only the head of the request,
deliberately: this is an ADMISSION check"_), so this adds no Elysia coupling,
needs no Better Auth configuration, and closes the class for **all four**
allowlisted auth paths rather than re-fixing `/sign-in/email` alone. B's
alternatives remain valid follow-ups; the second of them — dropping
`/sign-in/email` from the captcha plugin's `endpoints` and calling
`verifyTurnstileRequest` inside the `before` hook after `enforceRateLimit` — also
unifies the two captcha implementations (`lib/captcha.ts` has a 3 s timeout, the
plugin's is 10 s) and is the shape `lib/auth/passwordless.ts` already uses.

### H3 — a 27 KB SVG upload freezes the whole process for 3.8 s (quadratic entity expansion)

**Severity High** _(B 2, which rated it Critical)._ Downgraded because the impact
is availability and memory exhaustion, recoverable on restart, with no compromise
or irreversible data loss. It sits at the top of High: cheap, repeatable, and the
blast radius is the entire deployment.

**Location** `utils/images/svg-optimizer.ts:39-49` (the only size gate) and `:88`
(`parseFromString`); reached from `lib/r2/upload-helper.ts:204-219`; outer gate
`app/api/upload/image/handler.ts:113`.

**Evidence.** The cap is measured on the _unexpanded_ text and nothing re-checks
after the parser expands entities:

```ts
const maxSize = SERVER_MAX_IMAGE_SIZE * 2 * 1024 * 1024; // 0.4 MiB
const contentSize = new Blob([trimmed]).size; // raw input only
const doc = domParser.parseFromString(trimmed, 'image/svg+xml');
```

Measured through the real `sanitizeSvgServer` with a 100 ms interval timer to
detect event-loop starvation:

```
upload=22098B  expanded=10240093B  blockedMs=939   ticks=0 (expected ~9)   isValid=true  rss=480MiB
upload=26598B  expanded=40960093B  blockedMs=3800  ticks=0 (expected ~38)  isValid=true  rss=1575MiB
```

The law is `entityBody × refCount` and the work is fully synchronous — zero
expected ticks fired. All three defences miss it: the size cap sees 27 KB; the
element-count cap (`:74-83`) counts the DOCTYPE block as a couple of `<[^>]+>`
matches against a ceiling of 500; and `validateMagicBytes` exempts SVG
(`lib/r2/upload-helper.ts:92,98`). The sanitiser returns `isValid: true`, so the
expanded string flows on to `svgOptimizerServer` and then to R2.

**Impact.** Bun runs one JavaScript thread per process and `app.ts:203` sets
`reusePort: false`, so this is the whole server: every other in-flight request —
including `/api/health/storage`, which the orchestrator uses to decide whether
the container is alive — is stalled for the duration, and RSS climbs toward the
container limit. `limit: 20` per window plus a 120 s route timeout means 20
requests/minute at ~4 s each keeps the process wedged; under the effective
0.4 MiB input budget the arithmetic maximum is roughly
`(0.4 MiB / 2) × (0.4 MiB / 6)` characters — an unconditional OOM (derived from
the measured law, not run). Actor: any authenticated caller holding `create`
**or** `edit` on any dashboard page — the weakest grant that reaches this route.

**Remediation.** Two independent bounds, both cheap: reject a `<!DOCTYPE`
containing `<!ENTITY` before parsing — this codebase already strips comments,
CDATA and processing instructions at `:52-64`, and entity declarations belong in
that list — and re-check the size **after** serialisation, not only before
parsing. Nested expansion is already impossible (verified: one level only), so
the one-level quadratic case is the whole exposure.

### H4 — `optimizeImage` re-decodes the full source once per iteration

**Severity High.** _(B 7.)_

**Location** `lib/r2/optimize-image.ts:79-94` and `:147-173`. `encodeAttempt` is
handed the **original** buffer every time, so each of up to 32 iterations pays a
full decode of the source at up to `MAX_IMAGE_PIXELS` (25 MP). The loop admits 9
quality steps (95→50 by 5) plus 23 width steps (3048→800 by 100).

```
checkerboard 3000x3000: inputBytes=59475  ms=22314  iterations=27  outBytes=89878
                        timerTicks=222/223   (event loop stayed responsive)
```

A 2-pixel checkerboard is cheap in PNG and expensive in lossy WebP, so it never
reaches the byte target. A 5000×5000 source measures ~36 s. Unlike H3 this does
**not** stall the loop — `Bun.Image` runs off-thread — so it is CPU/thread
exhaustion rather than a freeze.

**Impact.** One account with `create`/`edit` on any page converts 59 KB of upload
into 22 s of CPU. At `limit: 20` per 60 s that is roughly 7 CPU-minutes of work
per wall minute from a single account — total saturation of a 2–4 vCPU VPS.
Precondition: an authenticated grant, nothing else.

**Remediation.** Decode once and reuse the decoded image across attempts, or
bound iteration by measured cost rather than by step count. Cheapest first move:
compute the descending width/quality ladder against a single decode and accept
the first result under target.

### H5 — `/openapi.json` is unauthenticated, uncached, rebuilt per request, and publishes the dev and internal maintenance surface

**Severity High.** _(A F1 (Medium, disclosure only) + B 6 (High, disclosure plus
cost). Resolved to High: B's measurement adds an unauthenticated
CPU-amplification vector A did not have, and both halves share one route and one
fix.)_

**Location** `routes.ts:330-336` (`preAuth: 'none'`),
`lib/http/openapi.ts:395-496` (built from the **whole** manifest with no
`NODE_ENV` filter and no allow/deny list), `:509-513` (built inside the handler,
per request).

**Availability.** Measured in-process, 100 requests each after warm-up:

```
GET /openapi.json : 9.11 ms/req   body 98 681 bytes   ≈110 req/s per core
GET /api/nope     : 0.095 ms/req  body 59 bytes       -> cost ratio 96x
```

Every request re-runs `z.toJSONSchema` over ~20 schemas plus a
`safeParse(undefined)` per object field (`openapi.ts:151-153`), and
`lib/http/response.ts:14` stamps `cache-control: no-store`, so neither a browser
nor Cloudflare caches it. A sweep of every other `preAuth: 'none'` surface shows
this is the sole outlier (all others reject in 0.03–0.18 ms). One unauthenticated
client with modest concurrency saturates a CPU core — and with `reusePort: false`
that is the whole server — plus ~1 100× bandwidth amplification from a ~90-byte
GET.

**Disclosure.** The document advertises 27 paths to any anonymous caller,
including `POST /api/dev/sign-up` with its full request schema
(`["name","email","password"]`, via `openapi.ts:98,111`),
`GET /api/dev/email-test/fixed`, `POST /api/internal/sqlite-sweep` and
`POST /api/internal/db-sweep`, each with path parameters, query parameters and
exact status codes. The dev handlers are correctly gated at entry, so this is a
map rather than a way in — but it defeats a security decision this codebase makes
explicitly, one file away: `app/api/dev/email-test/fixed/handler.ts:24-33` chose
404 over 403 precisely so the endpoint is _"indistinguishable from an unrouted
path in every other mode"_, and `/openapi.json` prints the path. It also points
directly at the two endpoints in M3. The generator already limits Better Auth's
documented paths to the server's allowlist (`openapi.ts:454-484`) and simply does
not apply the equivalent environment filter to manifest routes.

**Remediation.** Build the document once, lazily, and memoise it — a conversion
failure then fails the first request to that route rather than boot. Give the
route `preAuth: 'ip-limit'` for the same reason every other route has one. Filter
manifest routes by environment so dev and `/api/internal/*` paths are absent in
production. If the contract is for internal consumers only, gate it behind the
maintenance token as `/api/health/storage?deep=1` already is. **Do not simply
close the route without also fixing M21** — that turns the upload handler into a
working unauthenticated enumeration oracle, by the handler's own measurement.

### H6 — the verify-side per-destination OTP budget is one shared key, so anyone can cheaply deny a named victim's password recovery

**Severity High.** _(A F30 (High) + B 29 (Low — the coverage half). One root
cause: the verify-side quota's key design and coverage were never reasoned about
the way the send side's were.)_

The send side states the rule and enforces it — `lib/rate-limit/api.ts:127-134`:

> _"Recovery's own destination budget. **A separate key, not a slice of the
> shared one**: with a single shared pool two non-recovery surfaces could fill it
> between them and leave password recovery with nothing, which is a targeted
> account-recovery denial. Reserved capacity only counts as reserved if nothing
> else can spend it."_

The verify side has **one** key for everything (`api.ts:212-223`:
`otp.verify.dest.${kind}`, limit 10 / 600 s, `failClosed`), charged by all three
verify surfaces **before** any account lookup:
`app/api/auth/otp/verify/handler.ts:65`,
`app/api/auth/forgot-password/reset/handler.ts:72`,
`lib/auth/passwordless.ts:102`.

**This is a deliberate trade-off, and the finding says so:** the same function's
docstring explains the choice — _"shared across every purpose so rotating the
purpose can't multiply the per-identifier attempt budget."_ The defect is that two
comments in one file prescribe opposite designs for the same shape, and the
consequence of the verify-side choice was not weighed.

**Failure scenario, with numbers.** The window is fixed and 600 s wide
(`lib/rate-limit/index.ts:46`: `windowStart = now - (now % windowMs)`). An
attacker who knows `victim@gmail.com` POSTs `/api/auth/otp/verify` ten times with
`{channel:'email', email:'victim@gmail.com', code:'000000'}`. Each passes the
per-IP cap (60/min) and charges `otp.verify.dest.email:victim@gmail.com`. After
the tenth, `SQL_CONSUME`'s `WHERE … count < 10` stops matching and every
subsequent verify for that destination throws 429 — so for the rest of the window
the victim's `POST /api/auth/forgot-password/reset` fails at `handler.ts:72`,
before the account lookup and before `processOtpVerify`, and a **correct**
recovery code cannot be redeemed. Passwordless login and contact verification die
with it. Sustained cost: 10 requests per 600 s = **1 request/minute per victim**;
one IP's 60/min budget covers **60 victims simultaneously**.

Splitting the key does not weaken brute-force resistance: the real authority is
the per-proof database counter `OTP_MAX_VERIFY_ATTEMPTS = 5`
(`utils/validation/constants.ts:24`, enforced transactionally at
`utils/otp.ts:913`) plus `verification_sessions.verifyAttemptDaily` — both
per-user, both reached _after_ this limiter. `api.ts:225-234` says as much
itself.

**Part b — the same quota is skipped by both contact-change verify endpoints
(Low on its own).** `app/api/dash/users/me/change-email/verify/handler.ts:36-41`
and `.../change-phone/verify/handler.ts:42-47` call only a per-_user_ limiter on
their own scope key: 3 call sites against 5 verify entry points. Guesses against
`change_email` / `change_phone` are invisible to the shared budget, and
conversely a destination whose 10/600 s budget is exhausted can still be guessed
at 10/60 s through these two routes. Defence-in-depth only — the transactional
caps still bound guessing — so this is a contract violation, not a bypass.

**Remediation.** Give recovery its own verify key mirroring
`otp.send.dest.recovery.${kind}`, so a non-recovery surface cannot spend
recovery's attempts; and charge the shared destination budget from all five
verify entry points, not three.

### H7 — a verify-failure block gates the _send_ path: six unauthenticated requests deny a victim's password recovery for six hours

**Severity High.** _(B 19, rated Medium there; raised for consistency with H6 —
same outcome, cheaper per victim-hour, and the victim is told it worked.)_

**Location** `utils/otp.ts:920-939` (verify-failure block) consumed by
`utils/otp.ts:437-447` (send gate); swallowed at
`app/api/auth/forgot-password/send/handler.ts:98-111`.

`processOtpVerify` stamps a full `OTP_BLOCK_DURATION_HOURS` block on the proof
row when the per-cycle guess cap is spent, and `processOtpSend` refuses to issue
a _new_ code while that flag is set. Real routes, end to end:

```
1) attacker POST /api/auth/forgot-password/send        -> 200   row: is_blocked=false, codes:1
2) attacker POST /forgot-password/reset x5, wrong code  -> 400,400,400,400,429
                                                          row: vn:5, is_blocked=true, blocked_until=+6h
3) VICTIM   POST /api/auth/forgot-password/send        -> 200 {"nextAllowedIn":30}
   internal (swallowed): CustomError 429 "…6 hours"
   stored code changed? false        <-- no new code was ever generated or sent
4) VICTIM   POST /forgot-password/reset with the ONLY delivered code -> 429, retry-after: null
```

**Impact.** An unauthenticated actor who knows a victim's email or phone spends
six HTTP requests and removes OTP password recovery for six hours, repeatable
indefinitely. The victim is told "code sent successfully" with a 30-second
countdown while no code exists, so the failure is undiagnosable from the client.
The 429 also carries no `Retry-After` (`processOtpVerify`'s `CustomError` sets no
`responseHeaders`, while a limiter 429 on the same route does), so clients cannot
back off or distinguish the two.

Not `should-ignore.md` #58, which is about masking 429 as 200 on the send
contract. This is a verify-failure penalty gating the send path at all. The
six-hour send block is also redundant as an anti-guessing control: the bound that
actually resists guessing is `verifyAttemptDaily`, which `processOtpSend`'s upsert
deliberately preserves across resends (`utils/otp.ts:530-539`, and the comment at
`:500-502` says exactly this). Letting a resend clear the verify-side block would
not widen the guessing budget by one attempt — it would only remove the denial.

**Remediation.** Let `processOtpSend` clear (or ignore) the verify-side
`is_blocked` flag while preserving `verifyAttemptDaily`, and attach `Retry-After`
to that `CustomError` so the two 429 shapes are distinguishable.

_Evidence provenance (B):_ the six-request sequence was measured by an OTP shard;
the two code paths and the swallowing catch were verified directly.

---

## Medium

### M1 — the read path authorizes a deactivated **and soft-deleted** user for the session's full 28-day life

**Severity Medium.** _(B 10.)_

**Location** `lib/permissions/checker.ts:191-216` (cache branch) versus `:132-140`
(database branch).

The database branch treats an active, non-deleted user as a required
authorization predicate:

```ts
.where(and(
  eq(sessions.id, sessionId), eq(sessions.userId, userId),
  gt(sessions.expiresAt, sql`now()`),
  isNull(users.deletedAt),          // <-- required
  eq(users.isActive, true)          // <-- required
))
```

The read branch asks for none of it — it reads `roleId` off the session and goes
straight to the matrix. `auth.api.getSession` does not supply the missing
predicate either: Better Auth joins `users` but knows nothing about `isActive` /
`deletedAt`. Measured in-process against the live database, with the request
carrying **only** `better-auth.session_token` and **not** `better-auth.session_data`
so the cookie cache misses and `getSession` reads the database — i.e. the
5-minute window of `should-ignore.md` Known Issue #5 is not involved:

```
[1] user active                        GET(token-only)=200  POST=422
[2] is_active=false, session row kept  GET(token-only)=200  POST=401
[3] + deleted_at set, row kept         GET(token-only)=200  POST=401
[4] user restored, session row DELETED GET(token-only)=401  POST=401
```

Rows [2] and [3] are the finding; [4] is the known cookie-cache case.

**Impact.** A suspended or soft-deleted account whose session row outlives the
status change keeps full read access to every dashboard read endpoint — including
`GET /api/dash/users/:id` and its session IP/user-agent list — until
`sessions.expiresAt`, which is **28 days** (`lib/auth.ts:268`), not 300 seconds.
Known Issue #5 accepts this exposure on the stated basis that it lasts "up to 5
minutes… until cache expiration"; that mitigation does not apply, because no
cache is consulted. Writes are correctly refused, so the account cannot escalate
— it retains read.

**Reachability today is limited, and this is stated as such:** `handleAdminEdit`
and the user `DELETE` both revoke sessions in the same transaction, so no shipped
path leaves a live session behind a deactivation. What makes it worth fixing at
the boundary rather than per-caller is that the only thing holding it shut is
that two unrelated handlers remember to delete rows. The same omission is present
in `lib/http/session.ts:56-69` (`requireSession` → `assertLiveSession` checks the
session row and its expiry, not the user's status) and in
`lib/permissions/checker.ts:284-291` (`checkMultiplePermissions`' non-`forceDB`
branch, unreachable today only because its single caller passes write actions).
`requireSession` is saved only because all five current callers repeat the
`isActive` / `deletedAt` / `roleId` check inside their own transaction; a sixth
caller that forgets inherits the hole silently.

**Remediation.** Put the `isNull(users.deletedAt)` + `eq(users.isActive, true)`
predicate in the shared session-resolution boundary (the cache branch and
`assertLiveSession`), so no caller can omit it.

### M2 — Elysia's 11-character path offset lets a prepended junk segment reach any route

**Severity Medium.** _(B 8. Every consequence is proven; reachability is
conditional on the attacker controlling a ≤3-character `Host`.)_

**Location** `app.ts:195` (the `Elysia` constructor sets no
`handler.standardHostname`);
`node_modules/elysia/dist/adapter/web-standard/index.js:133`. Consumers of the
divergence: `lib/http/pre-auth.ts:29-37` (`preAuthScope`),
`lib/http/request.ts:34` (`apiPath`).

Installed Elysia 1.4.29 computes the route path by string arithmetic, not URL
parsing — confirmed in the installed source:

```js
const standardHostname = app.config.handler?.standardHostname ?? !0;
fnLiteral += `const u=r.url,s=u.indexOf('/',${standardHostname ? 11 : 7}),…`;
```

`standardHostname` defaults to `true`, so the search for the path-start `/`
begins at index 11. `http://` is 7 characters, so for a host of ≤3 characters the
real path-start slash sits below index 11 and is skipped; Elysia then takes the
_next_ slash and routes on a **suffix** of the requested path. Driven over raw
TCP sockets against a real `bun server.ts` listener:

```
Host=x    (1)  GET  /zzz/api/dash/roles           -> 401  (real dash handler ran)
Host=x    (1)  POST /zz/api/internal/sqlite-sweep -> 401  (real sweep handler ran)
Host=x    (1)  GET  /qq/api/health/storage        -> 200  (real body returned)
Host=abc  (3)  ... same three                     -> 401 / 401 / 200
Host=abcd (4)  ... same three                     -> 404 / 404 / 404
baseline: Host=127.0.0.1  GET /nope/api/dash/roles -> 404 (correct)
```

The limiter key then diverges from the executed route, because the adapter
derives the scope from `new URL(request.url).pathname` (the crafted path) while
Elysia dispatched on the suffix. Five crafted prefixes from one IP, read back out
of the live `rate-limit.db`, produced five distinct counters at 1 each.

**Impact.** (1) **Total bypass of `enforcePreAuthIpLimit`** — the 120/60 s
admission gate on all 22 `preAuth: 'ip-limit'` routes; the attacker picks segment
1, so every request lands in a brand-new counter. That limiter exists precisely so
_"traffic without a valid session can't force repeated session lookups"_, and
`/api/dash/*` performs a Better Auth session lookup before answering 401 — so
unauthenticated load on PostgreSQL becomes unbounded, and unbounded distinct keys
flow into `rate_limit` (compounding L25). (2) **Bypass of every path-prefix edge
rule**, since they match the requested path and Elysia dispatched on a suffix:
`POST /zz/api/internal/sqlite-sweep` reaches the sweep handler while matching no
`/api/internal/` rule, so the maintenance token becomes the _only_ boundary
rather than the second of two — which is what makes M3 matter more. (3)
**Falsified request records**: `apiPath` (→ `audit_logs.api_path`) records the
crafted path while the access log records Elysia's canonical path; neither shows
what was actually requested.

**Scope, measured.** Canonical requests are unaffected at every Host length, with
one exception: `GET /api/auth/get-session` returns **405** instead of 200 when the
Host is ≤3 characters, because the Better Auth wildcard prefix is the one
registration that falls through to the composed handler. (That 405 is itself the
tell that Elysia's router and the route manifest disagreed: `routeMiss` in
`app.ts:184-193` returns 405 whenever the manifest knows the path, without
re-checking the method.)

**Reachability.** The attacker must control the `Host` header Bun sees, down to
≤3 characters — direct-origin reachability, a permissive proxy router, or an
in-cluster caller. Through Cloudflare → Traefik with a Host rule the forwarded
Host is the real domain and this is not reachable. Note the coupling: the
mitigating control for that precondition (`should-ignore.md` #63, "block
direct-origin traffic at the edge") is the same assumption this finding
undermines for path-based edge rules.

**Remediation.** Pass `handler: { standardHostname: false }` to the `Elysia`
constructor — offset 7 is correct for the `http://` URLs Bun produces behind a
TLS-terminating proxy. **Caveat worth pinning:** offset 7 is correct _only_ while
`request.url` carries the 7-character `http://` scheme; if TLS is ever terminated
in-process, `https://` shifts every path by one character and the same class
reappears in the opposite direction. So pair the flag with a scheme-independent
guard — reject a request whose `Host` is not in the expected set in an `onRequest`
hook, which also fixes the falsified `audit_logs.api_path` — and add a regression
assertion that `/junk/api/...` is a 404 at every Host length.

### M3 — unlimited unauthenticated guessing of `SQLITE_MAINTENANCE_TOKEN`, which has no length floor and logs no failures

**Severity Medium.** _(A F9 (Low) + B 9 (Medium). Resolved to Medium: A's
bounded-impact analysis is correct and is preserved below, but three independent
gaps compound in one trust boundary, and one of the reachable actions takes the
SQLite writer lock the auth limiters depend on.)_

**Location** `routes.ts:288-305` (both internal routes declare `preAuth: 'none'`),
`lib/sqlite/maintenance-token.ts:20-26`, `lib/env.server.ts:192-193`.

1. **No floor.** `SQLITE_MAINTENANCE_TOKEN = process.env.SQLITE_MAINTENANCE_TOKEN ?? ''`
   — no minimum length, no format rule. The same file establishes the opposite
   standard 150 lines earlier for the other bearer secret
   (`BETTER_AUTH_SECRET_MIN_LENGTH = 32`, reasoning: _"a floor, not a strength
   test — no regex can prove randomness"_). `SQLITE_MAINTENANCE_TOKEN=x` is
   accepted at boot.
2. **No throttle.** `preAuth: 'none'` skips `enforcePreAuthIpLimit` entirely —
   confirmed by dumping `rate_limit` after a run (only `preauth.*` keys from
   `ip-limit` routes appear). Measured 401 cost: 0.024–0.052 ms/req, i.e.
   ~25 000–40 000 rps per core. `/api/health/storage?deep=1` is gated on the same
   token behind `preAuth: 'none'`.
3. **No record.** Both 401 paths log nothing and write no audit row, so an
   exhaustive guessing run leaves no trace. Every other rejection path in this
   codebase logs its class. `maintenanceTokenMatches` short-circuits on length
   (`a.length === b.length && timingSafeEqual(a, b)`), so the token's exact
   length is recoverable before any content guessing.

**Impact, bounded honestly.** Both sweeps delete only already-due rows
(`lib/sqlite/sweep.ts:54-67` is a bounded delete parameterised by `cutoff`;
`db/maintenance.ts:54-56` uses fixed retention windows), so a compromised token
cannot reset a live rate-limit counter, delete an unexpired session, or delete a
recent upload — it can only run a job early that deletes what the next scheduled
run would delete anyway. What raises it above Low is the combination: an
unmetered, unlogged oracle against a single shared secret with no floor, plus
`?deep=1` performing `PRAGMA quick_check` and a write — both of which take the
writer lock M12 shows is a full-authentication-outage primitive. The
fail-closed-on-unset behaviour is correct and verified.

**Remediation.** Give both internal routes `preAuth: 'ip-limit'` (or a tighter
dedicated `failClosed` limiter — they run once an hour and once a day, so 5/min
costs the scheduled task nothing); log the 401 with its class; and reject a
configured token below a fixed length at load time in `lib/env.server.ts`, the
way `BETTER_AUTH_SECRET` already is. M25 removes the routes entirely and is the
better long-term answer.

### M4 — hash-envelope and keyring errors escape sign-in as an empty 500, rolling back the failed-attempt counter

**Severity Medium.** _(B 11.)_

**Location** `lib/auth/password.ts:44-74` (`parsePasswordHash`) and `:97`
(`getPasswordPepper`); the missing conversion is at `lib/auth.ts:185-192`.

`verifyPasswordDetailed` is the single credential-verification entry point and
three of its outcomes are throws rather than a `{ valid: false }` result. It is
called inside the transaction at `lib/auth/login-guard.ts:207`, and **nothing
converts either error type** — verified by grep: `PasswordHashFormatError` and
`KeyringConfigurationError` appear only at their definitions and throw sites.
`lib/auth.ts:185-192` catches `LoginRejected` and re-throws everything else.
`lib/auth/api-error.ts` exists in the same directory to do exactly this
conversion and is not applied here; its own doc states the consequence: _"any
other throw escapes its boundary as a generic, empty 500."_

Measured against the live database, mutating `accounts.password` and resetting
`failed_login_attempts` to 0 before each arm:

```
A. UNKNOWN EMAIL                  401  ct=application/json  bodyLen=52  counter=0
B. p1:<unknown pepper id>:<phc>   500  ct=null              bodyLen=0   counter=0   KeyringConfigurationError
C. p2:1:<phc>                     500  ct=null              bodyLen=0   counter=0   PasswordHashFormatError
D. raw $argon2id$… (no envelope)  401  ct=application/json  bodyLen=52  counter=1
E. p1:<id>:<phc>:extra            500  ct=null              bodyLen=0   counter=0   PasswordHashFormatError
```

**Impact.** (1) The throw is inside `withTransaction`, so for every affected
account `failed_login_attempts` stays pinned at 0 (arms B/C/E versus D): brute
force gains nothing while the state persists — no attempt can succeed — but the
lockout machinery is silently inert for those accounts and the operator sees no
`accountLocked` rows to diagnose from. (2) **Account-existence oracle**: 401 +
JSON for an unknown email versus 500 + empty body for an existing email whose
stored hash references a retired pepper generation. Sharpest mid-rotation, when
only _some_ accounts still carry the old generation — an unauthenticated caller
then learns both which addresses exist and which have not signed in since the
rotation. (3) The response bypasses the API's own error envelope entirely: zero
length, no `content-type`. Only the first consequence is documented
(`lib/auth/password-pepper.ts:10-15` states retirement "surfaces as a 500, not a
failed login").

Precondition: `accounts.password` holding an envelope the current keyring cannot
resolve. Every application writer goes through `hashPassword`, so the trigger is
an operator or deploy event — retiring a generation too early, or reverting
`PASSWORD_PEPPER_KEYRING` to a version lacking the newest generation. One env-var
revert turns every recently-rotated password into an empty 500. Same missing
rotation invariant as L22, from the other direction.

**Remediation.** Convert both error types at `lib/auth.ts:185-192` through
`lib/auth/api-error.ts` so they leave as an enveloped 503/500 _outside_ the
transaction, letting the attempt counter commit. _When reproducing: restore
`accounts.password` in a `finally` — a probe that dies before its restore line
leaves the account unauthenticatable._

### M5 — external references survive SVG sanitisation, on objects stored `image/svg+xml` + `inline`

**Severity Medium.** _(B 12.)_

**Location** `utils/images/config.ts:51` (`/@import\s+url\s*\(/gi`) and `:96-106`
(`isDangerousValue`); `lib/r2/upload-helper.ts:317-320` (`inline: true`).

The blocklist explicitly targets external CSS but only the _functional_ form.
Real output from the pipeline (`sanitizeSvgServer` → `svgOptimizerServer`):

```
@import "string"    survives  <style>@import &quot;https://evil.example/x.css&quot;;</style>
@import url(...)    blocked   (the functional form IS caught)
@font-face src:url  survives  <style>@font-face{font-family:x;src:url(https://evil.example/f.woff)}</style>
style attr url()    survives  <path style="fill:url(https://evil.example/t.svg#g)"/>
<image href=http>   survives  <image width="8" height="8" href="https://evil.example/pixel.svg"/>
```

The `&quot;` is XML-escaped in the serialized text node and decodes back to `"`
when the stored object is parsed as `image/svg+xml`, so the `@import` is live.
DOMPurify does not help: `style` is in `DEFAULT_URI_SAFE_ATTRIBUTES`
(`node_modules/dompurify/dist/purify.cjs.js:740` — `_isValidAttribute` returns
true for it with no URI check) and `image` is in `DEFAULT_DATA_URI_TAGS`.
`getContentDisposition({ …, inline: true })` plus `ContentType: image/svg+xml` is
what makes the stored object render as a _document_ rather than an image, which is
the condition under which `@import` / `@font-face` actually fetch.

**Impact.** Any uploader can store an image that beacons every future viewer's
IP, User-Agent and Referer to a third-party host, and whose appearance can be
changed remotely _after_ review — the referenced CSS, font or `<image>` is fetched
at view time, not upload time. The broken invariant is the one
`DANGEROUS_CSS_PATTERNS` states by existing: external CSS is meant to be refused,
and the string form of the same directive is the trivial bypass. **No script
execution** — `<script>`, `on*`, `<foreignObject>`, `<animate>`, `<set>`,
`xlink:href="javascript:"` and comment-splicing were all confirmed stripped
across 26 payloads.

**Remediation.** Match `@import` and `@font-face` independently of the `url(`
form; treat any absolute-URL-bearing value in `style` attributes, `src:` and
`href`/`xlink:href` on `<image>` as dangerous (allowlist `data:` and same-document
`#fragment` only). Serving SVG with `Content-Disposition: attachment` and a
restrictive CSP would remove the render-as-document precondition entirely and is
worth deciding on separately.

### M6 — two parsers disagree, so `isValid: true` is returned for content outside the SVG root (deterministic 500, or a two-root document stored)

**Severity Medium.** _(B 13.)_

**Location** `utils/images/svg-optimizer.ts:88` (XML parse) versus `:230-240`
(serialize → DOMPurify HTML parse → `includes('<svg')` gate);
`utils/images/server.ts:9-16` (svgo throws a raw error);
`lib/r2/upload-helper.ts:366-370` (raw error → 500).

The app's element/attribute sweep runs on an **XML** tree where `<p>` is a child
of `<svg>`. DOMPurify then re-parses the serialized string as **HTML**, where the
breakout tag list (`p`, `div`, `table`, `h1`, `pre`, …) terminates foreign
content — so those nodes end up _after_ `</svg>`. The validity gate is only
`sanitized.includes('<svg')`, which cannot see that:

```
in=55B  isValid=true  cleaned="<svg …></svg>hi"
        svgo THREW SvgoParserError: Text data outside of root node.  -> HTTP 500
in=162B isValid=true  cleaned="<svg …/><svg><image href=\"https://evil.example/x.svg\" …/></svg>"
        svgo -> STORED a TWO-ROOT document
```

**Impact.** (a) `SvgoParserError` escapes `svgOptimizerServer` — which only guards
`!optimized.data` — is not a `CustomError`, and becomes `500 uploadMsg.uploadFailed`:
a **55-byte deterministic 500 generator**, indistinguishable in logs from a real
fault. (b) When the escaped content is itself an element, svgo emits it and a
two-root, non-well-formed document is stored and returned as a successful
`image/svg+xml` — a browser XML parser rejects it, so the record's image silently
never renders. The broken invariant is `sanitizeSvg`'s own contract: `cleanedSvg`
is documented as a sanitized SVG and consumed as one
(`utils/validation/rules.ts:246` returns it verbatim with no svgo pass behind it).
No script survives — DOMPurify walks the relocated nodes too — so this is
corruption and a 500, not XSS.

**Remediation.** Make the validity gate structural rather than substring-based:
after sanitisation, re-parse and require exactly one root element in the SVG
namespace and no sibling content. Catch `SvgoParserError` in
`svgOptimizerServer` and convert it to the same 422 the sanitiser's own rejection
uses.

### M7 — `<use>` is stripped, so every sprite SVG is stored blank with HTTP 200

**Severity Medium.** _(B 14.)_

**Location** `utils/images/svg-optimizer.ts:231-233`; the allowlist is
DOMPurify's own `svg$1` set (`node_modules/dompurify/dist/purify.cjs.js:302`),
which contains `symbol`, `defs`, `mask`, `clippath`, `pattern`, `marker` but
**no** `use`. `use` appears nowhere in `DANGEROUS_ELEMENTS`
(`utils/images/config.ts:35-44`), so its removal is unintended.

```
symbol+use (219B in)         errors=[]  out=<svg xmlns="…" viewBox="0 0 24 24"/>
gradient+clipPath (control)  errors=[]  out=<svg …><defs><linearGradient id="a">…  (intact)
```

DOMPurify strips the `<use>` elements, then svgo's `removeUselessDefs` /
`cleanupIds` garbage-collects the now-unreferenced `<symbol>`. Content inside
`<defs>` is never rendered, so the output is a blank image.

**Impact.** `<use href="#…">` is how essentially every icon set and every Figma
or Illustrator export with repeated geometry is written. The endpoint returns 200,
a key, and a `files` row claiming `mime_type = image/svg+xml`; the object renders
as nothing. Silent data loss with a success response — the sanitiser's `errors`
array is **empty**, so not even the log records it.

**Remediation.** Add `use` to DOMPurify's `ADD_TAGS` and allow `href` /
`xlink:href` on it restricted to same-document `#fragment` targets (which also
keeps M5 closed for this element).

### M8 — every malformed or over-pixel raster upload answers 500, including the decompression-bomb guard

**Severity Medium.** _(B 15.)_

**Location** `lib/r2/optimize-image.ts:121-123`, `lib/r2/upload-helper.ts:366-370`.
`Bun.Image` throws a plain `Error`; `uploadImagesToR2`'s catch only re-throws
`CustomError`, so everything else becomes `INTERNAL_ERROR` → 500. Replaying the
handler's exact gate order on real bytes:

```
png 6000x6000 (36 MP, 488 KB)  THREW Error  isCustomError=false  "Image: input exceeds maxPixels limit"
png valid 64x64                OK  iterations=1
png truncated 60%              THREW Error  isCustomError=false  "Image: decode failed"
png header only                THREW Error  isCustomError=false  "Image: decode failed"
```

All failing cases pass `isAllowedImageType` and `validateMagicBytes` and sit
under the 1 MiB per-file cap.

**Impact.** The pixel-bomb rejection — a security control — is reported to the
client as a server fault with no actionable message, and to monitoring as an
internal error, so probing it is indistinguishable from a genuine 5xx. A
legitimately truncated upload (interrupted transfer) gets the same.
`should-ignore.md` #48 accepts 500 only for _unexpected FK violations_, i.e. code
bugs; these are client-correctable input.

**Remediation.** Map `Bun.Image`'s decode and `maxPixels` errors to a 422
`CustomError` with distinct messages at the `optimize-image` boundary, so the
security rejection is visible as a rejection.

### M9 — a NUL byte in `?search=` or any filter value is a deterministic 500

**Severity Medium.** _(A F32 + B 16 — same defect, same evidence, both
measured.)_

**Location** `db/queries/data-table.ts:97-110` (quick search),
`lib/data-table/parsers.ts:39-49` (`safeString`),
`lib/data-table/filter-columns.ts:79-82` (`escapeLike`), `:150`, `:182`.

The value pipeline bounds _length_ and escapes _LIKE metacharacters_ and filters
no control characters; PostgreSQL rejects 0x00 in a text parameter at Bind time.
`U+0000` survives `URLSearchParams`, survives `.trim()`, and counts toward
`MIN_SEARCH_LENGTH`:

```
raw codepoints        [ 97, 98, 0, 99, 100 ]
after escapeLike      [ 97, 98, 0, 99, 100 ]        escapeLike('%_\\') -> \%\_\\  (metacharacters ARE handled)
DB, NUL-bearing       {"outcome":"REJECTED","errno":"22021","ctor":"PostgresError"}
DB, control           {"outcome":"accepted","rows":0}
filter iLike / eq value with NUL -> same 22021
```

`utils/index.ts:477,482` map only `23505` and `23503`, so `22021` is not a
`CustomError` and `handleApiError` returns **500** plus a full error log line
(`DrizzleQueryError.message` embeds the SQL and the parameters), on a path whose
declared contract is 422. Any caller holding `users:view` or `permissions:view`
can trigger it at will; the `eq` form on `email` has no `%` wrapper at all. No
data disclosure and no query amplification — PostgreSQL rejects at bind.

This is precisely the class the module says it eliminates
(`lib/data-table/filter-columns.ts:94-98`: _"Runs before any SQL is built so an
impossible combination becomes a 422, never a PostgreSQL cast error surfacing as a
500"_), and the project already owns the filter that removes it: `sanitizeStrict`
(`utils/validation/rules.ts:15-23`) has an allowlist that drops U+0000 and every
Zod-validated _write_ path runs it. The data-table _read_ path is the only place a
raw client string reaches a bound parameter without it.

**Remediation.** Reject (or strip) control characters in `safeString` and in the
quick-search read, so both channels are covered at their shared entry point.
Additionally map PostgreSQL `22021` in `utils/index.ts` so the class cannot
resurface as a 500 elsewhere.

### M10 — `PUT /api/dash/permissions/:id` silently ignores an omitted `description` and writes a self-contradictory audit row

**Severity Medium.** _(B 17.)_

**Location** `app/api/dash/permissions/[id]/handler.ts:218-226` (the `SET`) and
`:301-334` (the audit payload); schema at `utils/validation/permissions.ts:159-169`,
`:201`; `lib/audit.ts:268-284` (`computeChangedFields`).

`description` is optional, so it survives `.strict()` when absent; drizzle's
`mapUpdateSet` drops `undefined`, so the column is never written; and
`computeChangedFields` iterates `Object.entries(newData)`, where an
`undefined`-valued key is still an entry while `JSON.stringify` drops it:

```
safeParse({ id, roleName: 'Editors', isActive: true })  -> success, 'description' in data: false
SQL   : update "roles" set "role_name" = $1, "is_active" = $2, "updated_at" = now() where …
Object.entries({ description: undefined })       -> [["description", undefined]]
JSON.stringify({ a: 1, description: undefined }) -> {"a":1}
```

So `changed_fields` contains `description` while the stored `new_data` has no
`description` key.

**Impact.** Two invariants this repo states explicitly. The endpoint answers 200
for a field it never wrote — `utils/validation/permissions.ts:186-190` says PUT is
strict precisely because _"a misspelled `descriptionn` was dropped and answered
with 200, so the client believed a change had been applied that was never
written"_, and omitting the key reproduces that outcome through a different door.
And the audit row is internally contradictory: `changed_fields` names
`description`, `new_data` has none, `old_data` holds the real prior value — a
reader concludes the description was cleared when the column is untouched. Actor:
any holder of `permissions.edit` (or `editOwn` on a role they created). No race.

**Remediation.** Require `description` on the PUT schema (it is already strict
about unknown keys), or normalise an absent key to an explicit `null` before the
`SET`; and make `computeChangedFields` skip `undefined` values so the audit row
cannot name a field the payload does not carry.

### M11 — wrong-typed `password` / `description` values are coerced to "no change" and answered 200

**Severity Medium.** _(B 18.)_

**Location** `utils/validation/auth.ts:157-164` (password);
`utils/validation/rules.ts:15-23` with `utils/validation/permissions.ts:159-169`
(description); consumed at `app/api/dash/users/[id]/handler.ts:331-333` and
`app/api/dash/permissions/[id]/handler.ts:222`.

```ts
password: z.preprocess(
  (e) => (typeof e === 'string' && e.trim().length > 0 ? e : null),   // any non-string → null
  passwordSchema.optional().nullish()
).optional().nullish(),
```

```
adminUpdateUserSchema.password        createPermissionSchema.description
  12345678      ACCEPTED -> null       123      ACCEPTED -> ""   (overwrites the stored value)
  true          ACCEPTED -> null       {"a":1}  ACCEPTED -> ""
  ["Passw0rd!"] ACCEPTED -> null       true     ACCEPTED -> ""
  "short"       REJECTED
```

**Impact.** `PUT /api/dash/users/:id` with `{"password": 12345678}` — a JSON
number, the single most likely client mistake for a numeric password — parses to
`null`, so `hashedPassword` is `null`, the `accounts` UPDATE never runs,
`failedLoginAttempts` / `lockedUntil` are not cleared, no sessions are revoked,
and the handler answers `200 {"success":true}`. An operator resetting the
credential of a compromised or locked-out account is told it worked while the old
password still authenticates. For `description`, `''` is genuinely written,
destroying the stored value, also with a 200. The invariant this breaks is stated
at `utils/validation/auth.ts:180` and
`app/api/dash/users/[id]/handler.ts:313`: unknown keys are rejected _"so a
misspelled `passwrod` can't be read as 'field not supplied' and return a
misleading 200"_. `.strict()` closes the misspelled-_key_ case; the wrong-_type_
case walks through the same door.

Sites in the class that are **safe**, checked: `emailSchema`, `name`/`roleName`
via `sanitizeStrictSingleLine`, `phoneSchema`, `optionalPhoneSchema`,
`getIDSchema`, `getColorSchema`. `slugSchema` (`rules.ts:213-238`) has the same
defect but is unreferenced — a trap rather than a live bug (see L4).

**Remediation.** Let the preprocess pass non-strings through to the inner schema
so a type error stays a type error, or express the field as
`z.union([z.null(), passwordSchema])`. Sweep `slugSchema` with the same change.

### M12 — any second writer on `rate-limit.db` stalls the process for 2.3 s, then trips every fail-closed limiter to 503

**Severity Medium.** _(B 21.)_

**Location** `lib/sqlite/database.ts:76` (`BUSY_TIMEOUT_MS = 2000`),
`lib/rate-limit/index.ts:84-93` (every store error becomes `degraded`),
`lib/rate-limit/api.ts:266-273` (`degraded && failClosed` → 503), `app.ts:201-206`.

One external process held `BEGIN IMMEDIATE` on `rate-limit.db` for 4 s; a
concurrent `rateLimit()` in the app process blocked for **2 282 ms** and then
returned `degraded: true`. `bun:sqlite` is synchronous, so that blocks the whole
event loop — not one request. End to end, pointing the app at a non-SQLite
`rate-limit.db`:

```
ip-limit route (dash/roles) -> 503 retry-after=30
otp send (own limiter)      -> 503 retry-after=30
health/storage              -> 503 {"status":"error"}
better-auth get-session     -> 500  (auth-storage rethrows, as designed)
```

On the single-writer assumption: `reusePort: false` does work for a same-host
double start (a second `bun server.ts` exits 1). It gives no protection against a
second _container_ sharing the volume, against `bun test` or `scripts/*` (which
open the same files; `SQLITE_DIR` defaults to `./data` outside production), or
against an operator running `sqlite3`, `PRAGMA wal_checkpoint(TRUNCATE)` or a
file-level backup.

**Impact.** The failure mode is bimodal: for ~2.3 s per contended statement the
process serves nothing at all, and then every `failClosed` path (sign-in, all
five OTP surfaces, all 22 pre-auth routes) answers 503. A backup, a manual
checkpoint or a second replica on the shared volume turns a maintenance action
into a full authentication outage. Actor: any operator action or deployment
topology that adds a writer; no attacker needed. This compounds C1: with the
PostgreSQL-side per-session controls inert, these SQLite limiters are the only
surviving layer for sign-in and OTP.

**Remediation.** The 2 s ceiling is the right trade for one process, so the gap
is the _assumption_, not the number. Assert single-writer ownership at startup —
an exclusive lock file, or an advisory `PRAGMA locking_mode` probe under
`SQLITE_DIR` — so a second writer fails loudly the way a second port bind does.

_Evidence provenance (B):_ measured by the rate-limit shard; the `degraded` → 503
path and `BUSY_TIMEOUT_MS` were verified statically.

### M13 — the `haveIBeenPwned` plugin can never fire, and the hand-rolled replacement fails OPEN where the plugin fails CLOSED

**Severity Medium.** _(A F12.)_

`lib/auth.ts:472-475` registers `haveIBeenPwned({ customPasswordCompromisedMessage })`.
The installed plugin (better-auth 1.7.1,
`dist/plugins/haveibeenpwned/index.mjs`) wraps `ctx.password.hash` and returns
early unless the current path is in its list; no `paths` option is passed, so the
default applies: `/sign-up/email`, `/change-password`, `/reset-password`,
`/email-otp/reset-password`, `/phone-number/reset-password`,
`/admin/create-user`, `/admin/set-user-password`. The reachable Better Auth
surface is `lib/auth/allowed-paths.ts:16-22`: `/get-session`, `/sign-out`,
`/sign-in/email`, `/passwordless/verify`. **The intersection is empty**, and the
allowlist is enforced twice before the plugin could matter (`app.ts:382` and
`lib/auth.ts:109-113`). It is inert configuration.

The real check is `lib/auth/check-password.ts`, called by hand from four handlers.
The two implementations do the same k-anonymity lookup against the same endpoint
with the same `Add-Padding` header — and **disagree on the security-critical
case**:

|                       | plugin (dead)                                                    | `check-password.ts` (live)                                  |
| --------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| HIBP returns an error | `throw new APIError('INTERNAL_SERVER_ERROR')` — fails **closed** | logs `hibp.degraded`, loop exits, `return` — fails **open** |
| retries               | none                                                             | 3 attempts, 1 s timeout each                                |

**Impact.** The copy that survives is the permissive one, and the copy that would
refuse a password it could not check is the one that cannot run. During a HIBP
outage every password-setting path in the application accepts a known-breached
password, while the plugin registration reads as "compromised-password checking is
enabled via the auth library" and makes the real call count look like five when it
is four. The fail-open behaviour itself is `should-ignore.md` #52 — but that entry
no longer describes the code (see _Ignore-list corrections_), and neither the
duplication nor the inert registration is in it.

**Remediation.** Remove the dead registration (or pass `paths` matching the
reachable surface, which would require wiring the plugin into paths that do not
exist here), and settle the fail-open/fail-closed decision once in
`check-password.ts`. AGENTS.md Consistency applies: a second implementation of
one concept, drifted on the one case that matters.

### M14 — static-analysis gates do not fail on the classes they are configured to catch

**Severity Medium.** _(B 5 (rated High) + A F8 + A F6. Grouped: one root cause —
gates configured but not enforced on the class they exist for — and three
one-line remediations. Calibrated to Medium because all three were measured
against the current tree and the tree is clean: the exposure is future
regressions, not a live defect.)_

**(a) The CI lint step cannot fail on any `eslint-plugin-security` finding.**
`package.json:8` is `"lint": "tsc --noEmit && eslint ."`; CI runs `bun run lint`
(`ci.yml:25`); the local hooks run the stricter form
(`lefthook.yml:19`, `:32` — both `--max-warnings 0`).
`plugin:security/recommended-legacy` (`eslint.config.mjs:57`) registers all its
rules at **warn** and nothing upgrades them. Measured:

```
bunx eslint . --rule '{"no-warning-comments":["warn",…]}'                     -> EXIT=0
bunx eslint . --max-warnings 0 --rule '{…same…}'                              -> EXIT=1
printf 'const cmd = process.argv[2] as string;\nexport const out = eval(cmd);\n' | bunx eslint --stdin …
  2:20  warning  eval with argument of type Identifier  security/detect-eval-with-expression
  -> EXIT=0
```

A commit introducing `eval(userInput)`, `child_process` with a non-literal
argument, a non-literal `fs` path, a ReDoS-shaped regex or a `==` timing
comparison on a secret **passes the CI lint step**. The only thing that catches it
is lefthook, which `git push --no-verify` skips and which a clone that never ran
`bun install` does not have. semgrep's `p/typescript` overlaps partially but has
no equivalent of `detect-possible-timing-attacks`,
`detect-non-literal-fs-filename` or `detect-unsafe-regex`.
**Fix:** `"lint": "tsc --noEmit && eslint . --max-warnings 0"` — that makes the
three invocations agree. If the ~20 warn-level rules produce noise, promote the
security ones to `error` explicitly instead.

**(b) No type-aware ESLint configuration, so `no-floating-promises` and the whole
thenable family are absent.** `eslint.config.mjs:53` uses
`...tseslintConfigs.recommended`, not `recommendedTypeChecked`, and no config
object sets `parserOptions.project` / `projectService`. Confirmed from the
resolved config for a real source file: `no-floating-promises`,
`no-misused-promises`, `await-thenable`, `no-unnecessary-condition`,
`require-await` and all five `no-unsafe-*` rules report `"ABSENT"`, as does
`parserOptions.project`. Enabling them against
`app/ lib/ db/ utils/ types/ routes.ts app.ts server.ts` produced **zero**
`no-floating-promises` and **zero** `no-misused-promises` violations (the only
hits were four benign `require-await` reports on async functions satisfying an
async interface). So this is a finding about the gate. It matters because every
security-relevant operation here is a promise whose result must be awaited —
`enforcePreAuthIpLimit`, `enforceRateLimit`, `assertLiveSession`, the audit
writes, every `withTransaction`. Dropping the `await` on any of them silently
converts a security check into a no-op that still returns 200, and `tsc` reports
none of it: an unused promise is a well-typed expression. `no-floating-promises`
is the only tool in the installed toolchain that detects the class, the plugin is
already a devDependency and already loaded, and the codebase is currently clean —
so enabling it costs nothing and locks the property in.

**(c) The two `.js` files are inside the type-check program but their bodies are
never type-checked.** `tsconfig.json:7` sets `"allowJs": true`; `checkJs` appears
nowhere; neither `.js` file carries `// @ts-check`. Both are in the program as
import dependencies (`bunx tsc --noEmit --listFiles` shows `constants/index.js`
and `lib/env.js`), but being in the program is not being checked — proven with a
scratch project on the same flag combination, where two deliberate type errors
inside an annotated `.js` file are reported only with `--checkJs`. `lib/env.js`
is the module that parses `PUBLIC_ORIGIN` — the CORS allowlist (`app.ts:114`),
Better Auth's `baseURL`, and therefore the origin cookies are signed against —
and it is annotated as though it were checked (`@param {string} raw`,
`@returns {string}`, `/** @type {const} */`). Those annotations are decorative
under the current config: `bun run build` and `bun run lint` are both
`tsc --noEmit` and both stay green with an arbitrary type error in this file, ESLint
has no type-aware config (see b), and `PUBLIC_ORIGIN` has no unit test. The two
files are also not equivalent in _why_ they are `.js`: `lib/env.js` was `.js` so
`next.config.js` could import it and Next is gone; `constants/index.js` has no
stated reason at all (see L2). AGENTS.md, Types: _"A type you invented must be
earned, not asserted."_
**Fix:** convert both to `.ts` (preferred — the reason for `.js` is gone), or set
`"checkJs": true`.

### M15 — Bun 1.4: one half-sent request makes `app.stop()` hang, turning every deploy into a 135 s stall that exits 1 and skips the store closes

**Severity Medium.** _(A F4 — a Bun 1.4 behaviour change that breaks existing
code.)_

Release post, _Upgrading to 1.4_: _"`server.stop()` now closes idle keep-alive
connections immediately… **It now stays pending on a connection that has sent
part of a request and stopped.** `server.stop(true)` closes such connections."_
Reproduced on the pinned runtime — open a TCP socket, write
`"GET / HTTP/1.1\r\nHost: localhost\r\n"` with no terminating CRLF, then call
`server.stop()`:

```
{"probe":"half-sent request vs stop()","bun":"1.4.0",
 "stopResolvedWithin3s":false,"result":"stop() STILL PENDING after 3000ms"}
{"escalation":"stop(true)","resolvedInMs":1}
```

`server.ts:265` is `await app.stop()` with no argument. Failure scenario: Coolify
sends SIGTERM while one connection is mid-handshake — a half-written request from
a scanner, a client that died between headers, a cut health probe, or an attacker
holding a socket open with one byte. Then:

1. `drainAfterResponse` at `server.ts:266` is never reached.
2. The `finally` at `server.ts:283-288` never runs — **`closeDatabase`,
   `closeRateLimitStore` and `closeCacheStore` are all skipped** — because the
   forced-shutdown `process.exit(1)` at `:261` terminates the process from inside
   the timer callback, and `finally` blocks do not run on `process.exit`.
3. The process sits for the full `SHUTDOWN_TIMEOUT_MS` and exits **1**.

`SHUTDOWN_TIMEOUT_MS` is `(Math.max(60, MAX_ROUTE_TIMEOUT_SECONDS) + 15) * 1000`
and `MAX_ROUTE_TIMEOUT_SECONDS` is 120 (`routes.ts:266`, `:304`), so the bound is
**135 000 ms**: every routine deploy becomes a 135-second stop phase ending in a
non-zero exit code, from one stalled socket. Note the asymmetry — a timed-out
post-response drain is logged without changing the successful shutdown status
(`server.ts:266-275`), while a stalled `stop()` produces both a non-zero exit and
skipped store closes for a cause outside the application. The OTP senders of M16
produce the same "busy connection" condition from the application's own side.

**Remediation.** Escalate rather than replace: `await app.stop()` under a bounded
grace period, then `await app.stop(true)`. Elysia 1.4.29 forwards the argument —
`this.stop = async (closeActiveConnections) => (await this["~adapter"].stop?.(this, closeActiveConnections), …)`
(`node_modules/elysia/dist/index.js:192`), documented as _"`app.stop(true)` //
Abruptly any requests inflight"_ — so the drain semantics `server.ts` argues for
are preserved for well-behaved clients while the indefinite hang is removed. Also
move the store closes off the `finally` that `process.exit` skips.

### M16 — the three OTP delivery channels have no timeout, and delivery sits on the response path (existence oracle + unbounded handler)

**Severity Medium.** _(A F25 + B 20 — two symptoms of one placement decision;
remediations synthesised, because neither report's fix alone closes both.)_

**Part a — no timeout on any of the three senders.** The rule exists in this
codebase, stated twice, with reasoning that names this exact hazard:
`lib/captcha.ts:15-17` (_"Cap the outbound siteverify call so a Cloudflare
slowdown can't stall OTP/auth handlers indefinitely"_ →
`SITEVERIFY_TIMEOUT_MS = 3000`) and `lib/auth/check-password.ts:10-12`
(`HIBP_ATTEMPT_TIMEOUT_MS = 1000`). The three senders follow neither:

- **SMS** `utils/otp.ts:121-134` — `await fetch('https://apis.deewan.sa/…')`, no
  `signal`.
- **WhatsApp** `utils/otp.ts:148-155` — same shape, no `signal`.
- **Email** `utils/otp.ts:28-40` — `nodemailer.createTransport({ service, auth })`
  with no `connectionTimeout` / `greetingTimeout` / `socketTimeout`. Read from the
  installed package (nodemailer 9.0.5,
  `lib/smtp-connection/index.js:14-16`, applied at `:415`, `:847`, `:855`,
  `:1105` as `this.options.X || DEFAULT`): 120 s connection, **600 s socket**,
  30 s greeting. All three defaults apply.

For the two `fetch` sites there is no library default. Probed on the pinned
runtime against a socket that accepts and never replies:
`{"bun":"1.4.0","elapsedMs":20191,"outcome":"STILL PENDING at 20000ms"}`.

`POST /api/auth/otp/send` declares no `timeoutSeconds` (`routes.ts:71-77`), so it
inherits `IDLE_TIMEOUT_SECONDS = 60`. The transaction has already committed
(`utils/otp.ts:579` closes it; `:610` is `await sendOtp(...)`, deliberately after
the commit), so the row is durable with `nextAllowedAt` set. Result: the user is
throttled for the backoff window having received no code; the client connection
can be dropped at the 60 s ceiling with an empty body; the handler keeps running
(up to 600 s for email); and those in-flight requests are "busy" connections that
also hold `app.stop()` open during a deploy (M15's mechanism, from inside).

This is the same class the file already fixed once, in the same function:
`utils/otp.ts:600-609` explains that `sendOtp` was moved out of the transaction
because _"an SMTP timeout, tens… Ten concurrent sends against a hanging provider
exhausted the pool… A provider outage became a full-application outage."_ The
author identified an unbounded call and relocated it instead of bounding it.

**Part b — delivery latency defeats `ensureMinDelay`, making the send endpoints an
account-existence oracle.** `app/api/auth/otp/messages.ts:6-11` is a floor with
no cap, and the provider call sits on the response path
(`utils/otp.ts:610`, before `ensureMinDelay` at
`app/api/auth/otp/send/handler.ts:171` and the two siblings). With the SMS
provider stubbed to a 3 000 ms response — a provider slowdown, nothing else
changed — `POST /api/auth/forgot-password/send`, four unregistered numbers then
four registered, identical 200 body every time:

```
NO-ACCOUNT  1588 / 1502 / 1503 / 1502 ms   200 "code sent"
REAL        3099 / 3102 / 3106 / 3079 ms   200 "code sent"
```

The signal is one-sided and sound: any response above the 1 500 ms floor proves
the real branch ran, i.e. the address belongs to an active account. False
negatives only, so an attacker retries. `forgot-password/send` and
`passwordless/send` are pure existence oracles; `otp/send` runs the real branch
only for an _unverified_ contact, so it additionally leaks
`email_verified` / `phone_number_verified` state for a known address. This defeats
the whole generic-response design — `GENERIC_SEND_DATA`, the collapsed catch
blocks, the swallowed delivery errors — and it defeats it hardest in the
provider-outage case `handler.ts:160` names (_"Delivery / internal failures must
NOT distinguish real accounts from fake ones during a provider outage — that's a
binary oracle for account existence"_). Raising `MINIMUM_RESPONSE_MS` cannot fix
it: the floor would have to exceed an unbounded third-party call. The `TODO` at
`messages.ts:5` treats this as tuning; it is structural.

**Remediation (both parts, in order).** Move delivery off the response path —
enqueue it and return immediately — so the response time no longer depends on the
provider. That closes part b, removes the 60 s-ceiling truncation and the
`app.stop()` interaction, and completes the outage isolation the file already
started. **Bounding the calls is still required**, because the queue worker makes
the same provider call: add an `AbortSignal` to both `fetch` sites and
`connectionTimeout` / `greetingTimeout` / `socketTimeout` to the nodemailer
transport, matching the 1–3 s convention the two guarded outbound calls already
set. (Related: `should-ignore.md` #52's original complaint was precisely "no
`AbortSignal`" on the HIBP call; that was fixed and the fix was never swept to
these three sites.)

_Evidence provenance (B, part b):_ measured by the OTP shard with a stubbed
provider; `ensureMinDelay` and the ordering were verified directly.

### M17 — public `verify_contact` sends starve the shared per-destination send budget, throttling a named victim's passwordless login to one code per hour

**Severity Medium.** _(A F39 — the send-side mirror of H6, and it survives the
reservation described there.)_

`lib/rate-limit/api.ts:120-136`: `OTP_DESTINATION_SEND_CAP_PER_HOUR = 6` is
shared by every **non-recovery** surface, `OTP_RECOVERY_SEND_CAP_PER_HOUR = 5`
has its own reserved key, and `OTP_SURFACE_SEND_CAP_PER_HOUR = 5` is per surface.
So `verify_contact`, `passwordless` and `contact_change` share one budget of 6, of
which a single surface may take 5. `verify_contact` is the unauthenticated public
surface and its quota is charged **pre-lookup**
(`app/api/auth/otp/send/handler.ts:83-87`) — before the "already verified →
generic response" early return at `:109-116`, so the charge lands even though
nothing is sent.

Failure scenario: an attacker POSTs
`/api/auth/otp/send {channel:'email', email:'victim@gmail.com'}` five times an
hour. The address is already verified, so no message is delivered and the attacker
pays nothing. After the fifth request
`otp.send.surface.verify_contact.email:victim@gmail.com` is 5/5 and
`otp.send.dest.email:victim@gmail.com` is 5/6. The victim's passwordless-login
send then gets **one** code that hour instead of five, and `contact_change` gets
none. Cost: five requests per hour, well inside the 60/min per-IP cap. Recovery is
genuinely protected — that is what the reserved key buys; the defect is that the
same reasoning was applied to one of four surfaces.

**Remediation.** Either give each surface its own destination key, or charge
`verify_contact` _after_ the already-verified early return so an unproductive
request costs the victim nothing.

### M18 — all three OTP send handlers report `200 "code sent"` for a malformed body and for OTP being switched off

**Severity Medium.** _(A F31.)_

`app/api/auth/otp/send/handler.ts:176-192` (identical shape in
`forgot-password/send` and `passwordless/send`) collapses any `CustomError` with
status 400 or 404 to the generic success. The stated purpose — collapsing
unknown-identifier / already-verified — is already served elsewhere: those two
cases return `genericResponse()` **inline** at `:109-116` and never throw.
Tracing every throw that can actually reach this catch leaves exactly two, and
neither depends on account existence:

- **404** from `:41-42`, `if (!OTP_ENABLED) throw new CustomError(MSG_PAGE_NOT_FOUND, 404)`
- **400** from `requireJsonBody` (`utils/api-response.ts:45-48`)

Failure scenario A: a client posts without `Content-Type: application/json`.
`withBodyPolicy` hands the handler the constant-null reader
(`lib/http/request.ts:66,91`), `readJson()` returns `null`, `requireJsonBody`
throws 400 — and the caller receives
`200 {"success":true,"message":"code sent","data":{"nextAllowedIn":30}}`. The
client shows a code-entry screen and starts a 30-second countdown for a message
that was never sent. Same for a body of `null`, `[]` or `"x"`.

Failure scenario B, the worse one: deploy with OTP channels unconfigured so
`OTP_ENABLED === false`. Every recovery request then answers `200 "code sent"`
forever, with no 404, no log line and nothing in the health check. **Account
recovery is completely unavailable and the endpoint reports success.**

Distinct from `should-ignore.md` #58, which is about collapsing **429** and is
explicitly a privacy contract over real / fake / verified / throttled. A malformed
body and a disabled feature are neither.

**Remediation.** Narrow the collapse to the specific `CustomError` identities it
exists for (or delete it, since both cases already return inline), and let 400
and 404 through; log the `OTP_ENABLED === false` rejection so a misconfigured
deploy is visible.

### M19 — `sanitizeFilename` truncates by UTF-16 code unit and can emit a lone surrogate, which turns into a deterministic 500

**Severity Medium.** _(A F28.)_

`utils/sanitize-filename.ts:19-24` ends with `.slice(0, maxLength)` — code units,
not code points — and the allowlist `\p{L}\p{N}` admits astral characters
(U+20000 is `\p{Lo}`), each two code units. Measured with
`'a' + '\u{20000}'.repeat(30) + '.png'`:

```
{ "outputCodeUnits": 50, "outputIsWellFormed": false, "lastUnitHex": "d840",
  "loneSurrogateEmitted": true, "encodeURIComponentThrows": true }
```

Failure scenario: upload a genuine PNG (so the MIME and magic-byte checks at
`app/api/upload/image/handler.ts:120-136` pass) whose multipart filename ends in a
truncated astral character. `handler.ts:111` sanitises it,
`lib/r2/upload-helper.ts:160-162` builds `temp/${shortId}_${safeName}.${extension}`,
and that key reaches `new PutObjectCommand({ Key: key })`. A lone surrogate
cannot be percent-encoded — `encodeURIComponent` on the composed key throws
`URIError` (measured) — and `URIError` is not a `CustomError`, so
`lib/r2/upload-helper.ts:366-369` logs it and rethrows a generic 500. The result
is a deterministic 500 for attacker-chosen input, after the server has already
paid for buffering, `optimizeImage` and `generateBlurhash`.

_Attribution, stated precisely (A):_ the lone surrogate and the `URIError` from
`encodeURIComponent` were verified directly; that the AWS SDK is the throw site on
this exact path was measured by a subagent (`"temp/bad_a\ud840.webp" => URIError |
String contained an illegal UTF-16 sequence`, before any network I/O, against a
control key that failed with `ECONNREFUSED`). The class holds either way: a key
that cannot be percent-encoded cannot be put on the wire, so some layer must
throw.

Secondary, same line: `.trim()` runs **before** `.slice()`, so truncation can
reintroduce a trailing space — `sanitizeFilename('a'.repeat(49) + ' b')` →
`"aaa…a "`.

**Remediation.** Truncate by code point (or call `.toWellFormed()` / strip lone
surrogates after slicing) and move `.trim()` after `.slice()`.

### M20 — `notILike` and `ne` silently drop NULL rows, in a module that handles NULL correctly for `isEmpty`

**Severity Medium.** _(A F33.)_

`lib/data-table/filter-columns.ts:152-154` (`notIlike(column, …)`) and `:182`
(`ne(column, value)`) versus `:250-259`, which goes out of its way for exactly
this (`isEmpty` → `isStringLike(spec.type) ? isEmpty(column) : isNull(column)`).
SQL three-valued logic: `NULL NOT ILIKE '%abc%'` evaluates to NULL, not TRUE, so
the row is excluded from a predicate that plainly describes it.

The reachable nullable column is `roles.description` — `db/schema.ts:490` has no
`.notNull()` (verified), `utils/validation/permissions.ts:159-169` makes it
`.optional().nullish()` so a POST without one writes NULL, and it is registered
filterable at `app/api/dash/permissions/handler.ts:42`.

Failure scenario: a role created without a description is **absent** from the
result of "description does not contain abc" — a list it obviously belongs in —
and absent from `meta.total`, returned with a 200. An operator filtering to find
roles that lack a given description gets a silently incomplete list. Every other
text column in scope is `notNull` today, so this is one column now; the defect is
in the shared operator, so every future nullable text column inherits it.

**Remediation.** `or(notIlike(...), isNull(column))` and
`or(ne(...), isNull(column))` in the shared operator, matching what `isEmpty`
already does.

### M21 — closing `/openapi.json` turns the upload route into an enumeration oracle: the two are coupled and only one side knows it

**Severity Medium.** _(A F22 — reported separately because acting on H5 in
isolation creates a new defect.)_

`app/api/upload/image/handler.ts:41-52` documents the coupling explicitly:

> _"**Runs BEFORE the session check, which inverts the order every other handler
> here uses**… The visible consequence is that an unauthenticated caller gets 400
> for an unknown resource and 401 for a known one (measured), which distinguishes
> valid page names. That is not a leak today, for a specific reason: the valid
> names are published in `/openapi.json`, which is a public route. It WOULD become
> an enumeration oracle if `DASHBOARD_PAGES` ever gained a name that is not
> public, **or if the OpenAPI route were closed**."_

So the handler's security argument is _"this leak is free because a public route
already leaks it"_, while H5's finding is that the same public route leaks things
it should not. Both are correct, and together they mean there is no change to
`/openapi.json` that is safe on its own:

- Close or gate it → `POST /api/upload/image?resource=X` becomes a working
  unauthenticated oracle for the `DASHBOARD_PAGES` key set: `400` for `foo`,
  `401` for a real page name. `routes.ts:255-263` declares `resource` as
  `enum: DASHBOARD_PAGE_NAMES`, and `requireUploadResource` (`:54-59`) throws
  `BAD_REQUEST` before `requireAnyPermission` (`:64`) can throw `UNAUTHORIZED`.
  The oracle is exact, unauthenticated, and bounded only by the per-IP pre-auth
  limit of 120/60 s.
- Leave it public → the dev and `/api/internal/*` routes stay advertised (H5).

**Remediation.** One combined change, which the handler already names: move the
session check ahead of the resource validation — at the cost of a second session
lookup — and then apply H5. The shared boundary is "what may an unauthenticated
caller learn about the route table", and it has two sites, not one.

### M22 — `actions/checkout` leaves `GITHUB_TOKEN` in `.git/config` in six jobs

**Severity Medium.** _(B 24.)_

**Location** `.github/workflows/ci.yml:19, 138, 174, 182`;
`.github/workflows/security.yml:23, 42`.
`grep -rn "persist-credentials" .github/` returns **nothing** against 6
`actions/checkout` uses. `actions/checkout` defaults `persist-credentials` to
`true`, writing an `http.extraheader` with the job's `GITHUB_TOKEN` into
`.git/config`. The next step in three of these jobs is `jdx/mise-action`, which
resolves `semgrep` through the pipx backend per `mise.toml:19-23`.

**Impact.** Any code that runs in those jobs can read `.git/config` and
exfiltrate a token with `contents: read` on this repository.
`bun install --frozen-lockfile` is a narrow vector (Bun blocks lifecycle scripts
except those in `trustedDependencies`), but semgrep and its transitive PyPI
dependency tree are not pinned by hash and execute arbitrary Python at install
time. For a private starter kit this is read access to the whole source tree; the
token is short-lived but valid for the job's duration.

**Remediation.** Add `persist-credentials: false` to every checkout that does not
push.

### M23 — `lib/r2/client.ts` sits outside every convention the rest of the codebase follows

**Severity Medium** _(A F14; the missing configuration guard is the part that has
a runtime failure scenario, the rest is the consistency defect AGENTS.md names
explicitly: "The codebase should read as though one person wrote it.")_

**a. `deleteFromR2` is the one R2 function with no configuration guard.**
`uploadToR2` (`:61-64`), `copyFileInR2` (`:117-121`) and `getPresignedUrl`
(`:156-160`) all begin with `if (!validateR2Config) throw new Error('R2 is not
configured…')`. `deleteFromR2` (`:87-106`) does not. Failure scenario: on a
deploy with `R2_*` unset, the retention sweep (`db/maintenance.ts:280` is the
production caller) issues a DeleteObject to the literal host
`https://undefined.r2.cloudflarestorage.com` with `accessKeyId: ''` and fails
with an opaque SDK/DNS error, where every sibling function would have failed with
a sentence naming the cause. Already known and written down in a test helper —
`tests/helpers/object-store.ts:13`: _"`deleteFromR2` has no such [guard]"_ — but
not fixed and not in `should-ignore.md`.

**b. R2 is the only env group with no boot-time validation.** `:10-15` reads all
six `R2_*` variables straight from `process.env`, and they appear nowhere else in
application code. `lib/env.server.ts:8-14` states its contract — _"Hard-fail at
module-load time when a required server env var is missing… Imported by every
server-only module that depends on these values (auth, DB, rate-limit, captcha,
OTP)"_ — and R2 is absent from that list. A deploy missing R2 credentials boots
green, passes the health check, and fails on the first upload.

**c. Four no-op `try { … } catch (error) { throw error; }` blocks** — lines 83,
105, 136, 190 (`grep -n 'throw error;'` returns exactly those four). Each only
widens the stack. A class of four, not one slip.

**d. `getR2ConfigStatus` leaks values where it reports presence.** `:302-311`
returns `accountId` / `accessKeyId` / `secretAccessKey` as booleans but
`publicBucket`, `privateBucket` and `publicUrl` as their **actual values**. No
HTTP caller today (only a dev probe), so this is latent — but
`app/api/health/storage/handler.ts:18-19` states the opposite rule for this
codebase: _"The body reports status only: no paths, schema contents, or row
counts."_ (The export is also dead — see L4.)

**e. Logging convention** — `:167-171` uses a plain interpolated
`console.error('[R2] Expiry time …')` at `error` level for a value that was
successfully clamped. Covered with the rest of the class in L10.

### M24 — the deployment health check verifies SQLite and never touches PostgreSQL

**Severity Medium** _(A F47, which rated it Low; raised because the failure mode
is an orchestrator routing production traffic to a container on which every
request fails, under a realistic trigger.)_

`app/api/health/storage/handler.ts` is the deployment's readiness endpoint and
every check it performs is against the rate-limit SQLite store. An unreachable
PostgreSQL — a wrong `DATABASE_URL` after a rotation, the database container not
yet up, an exhausted pool — still answers `200 {"status":"ok"}`, so the
orchestrator keeps routing traffic to a container on which every login, dashboard
route and OTP send fails. The lazy `bun:sql` pool means nothing else forces the
failure to surface either. That is the same argument the handler's own header
makes for existing, not applied to the primary datastore. `should-ignore.md` #8
does not cover it: its reasoning is _"we do not have one"_, and an absent health
check fails safe where one that asserts `ok` does not.

**Remediation.** Add a PostgreSQL `SELECT 1`. Whether it belongs in the
`?deep=1` branch or as a shallow check with a short timeout depends on the poll
interval configured on the server, so decide it together with the deployment
runbook rather than in code alone.

### M25 — two internet-reachable maintenance endpoints exist only as a scheduler trigger, which `Bun.cron` can replace

**Severity Medium** _(A F44 + B's Bun assessment. Attack-surface reduction, not a
defect in the sweep itself.)_

`runMaintenanceSweep` is already independent of HTTP and Elysia
(`lib/sqlite/maintenance.ts:12-43`), and `reusePort: false` enforces the
single-process assumption an in-process schedule requires. Bun 1.4 supplies a
runtime-level cron API, verified on the pinned runtime:

```
Bun.cron.parse("*/15 * * * *") -> 2026-08-21T18:00:00.000Z
Bun.cron("* * * * *", fn)      -> { cron, ref, stop, unref }   (no OS cron involved)
Bun.cron(expr, fn, { tz })     -> accepted
```

Jobs never overlap — which matters, because `runMaintenanceSweep` is a bounded
batch loop (`lib/sqlite/sweep.ts:54-67`) that must not run twice concurrently.
Adopting it would remove: `POST /api/internal/sqlite-sweep` and
`POST /api/internal/db-sweep` as unauthenticated-reachable routes
(`routes.ts:288-305`, `preAuth: 'none'`); `SQLITE_MAINTENANCE_TOKEN` and every
gap in **M3**; two paths from the public contract in **H5**; and the
`/api/internal/*` edge-rule half of **M2**. The trade is losing the external
scheduler's own failure alerting, which the current design deliberately relies on
— so pair adoption with an in-process failure log the deployment can alert on.

**Two caveats an adopter must not miss.** (1) _Upgrading to 1.4_:
_"`Bun.cron.parse()` and in-process `Bun.cron()` now use local time… Before, they
used UTC… To keep the old times, pass `{ tz: 'UTC' }`."_ This project already has
a timezone concept (`resolveBusinessTimezone`) and, per C1, an unpinned process
zone — so the schedule must state its zone explicitly rather than inherit the
container's. (2) `Bun.cron` takes five fields; seconds are rejected
(`TypeError: Invalid cron expression: too many fields`) — irrelevant for an hourly
or daily sweep. Note also that the string-path form registers a real OS job;
only the function form is in-process. Prefer `Bun.cron` over `@elysiajs/cron`:
the sweep is already framework-independent and should stay that way.

---

## Low

### Validation, filters and data-table edges

**L1 — `positiveInt` accepts non-canonical number spellings and substitutes a
default for out-of-range, which the sibling paginator explicitly refuses.**
_(A F34 + B 33a.)_ `utils/index.ts:423-427` uses bare `Number(val)` and returns
`0` for out-of-range, while
`app/api/dash/users/[id]/sessions/pagination.ts:96-124` rejects this exact input
class locally, for the same concept, with the reason stated inline: _"Canonical
decimal integers only. `Number()` accepts a whole family of spellings a query
string has no business carrying — `1e2`, `0x10`, `+1`, `' 5 '` and `'05'`… and
the over-cap rejection could be bypassed by spelling the number differently…
Over the maximum is rejected, not clamped."_ Measured with `maxValue = 100`:
`"1e2"→100`, `"0x10"→16`, `"+1"→1`, `" 5 "→5`, `"05"→5`, `"10.9"→10`, `"101"→0`.
Consumers are `lib/data-table/parsers.ts:309-312` (`maxPerPage`, `page`,
`perPage`), where the `0` meets a `||` and becomes a _default_: so
`?perPage=101` serves **10** rows rather than 100 or a 422, and `?page=10001`
silently returns page 1, while `?limit=1e1` on the sessions route is a 422. Two
spelling policies for one concept in one API. No authorization consequence —
`perPage` stays bounded by `MAX_PER_PAGE = 100`, `page` by `MAX_PAGE = 10_000`.
Same class, same module: `safeNumber` (`lib/data-table/filter-columns.ts:67-70`)
accepts `"0x10"→16` and `"1e3"→1000` — latent, since no live descriptor
registers a `number` column. Also latent: `num | 0` is a 32-bit signed
truncation, so a `maxValue` above 2³¹−1 returns a negative result for an in-range
input; no current caller passes such a `maxValue`. And
`db/queries/data-table.ts:74`'s `Math.min(parsed.perPage, MAX_PER_PAGE)` is
unreachable protection — it reads as the clamp that enforces the ceiling, while
the ceiling is actually enforced by a fallback. **Fix:** reuse the paginator's
`CANONICAL_INTEGER` shape in the shared helper and reject over-cap rather than
defaulting.

**L2 — an inverted `isBetween` range is accepted and answered 200 with a
provably empty set.** _(A F35 + B 33b.)_
`lib/data-table/filter-columns.ts:228-248` validates that bounds are _present_
and never that they are _ordered_ — the same class the same function rejects
fourteen lines earlier (`:113-117`), with the reason stated there: a malformed
range _"answered a question nobody asked with a 200 instead of reporting the
malformed range."_ A `createdAt` `isBetween` of `["2026-12-31","2026-01-01"]`
generates an unsatisfiable predicate and returns `200, data: [], total: 0`, so a
user who transposed two dates is told there are no matching records rather than
that the range is backwards. Same shape in the numeric branch (`:241-247`).

**L3 — `toCalendarDate` coerces numerics as epoch milliseconds, so a malformed
date filter answers for 1970.** _(B 25.)_ `utils/time.ts:210-220`, consumed at
`lib/data-table/filter-columns.ts:86-91`. `Number(raw)` is applied to arbitrary
client JSON: `"2026" → "1970-01-01"`, `1700000000 → "1970-01-20"`,
`"0x10" → "1970-01-01"`, `[1700000000000] → "2023-11-15"`,
`"  2026-08-02  " → null`. `dayBounds` raises a 422 only on `null`, so every
other value resolves and the query runs for 1970 — confirmed in generated SQL
(`created_at >= '1969-12-31T21:00Z' and < '1970-01-01T21:00Z'`), HTTP 200, empty
table, no signal. A bare year is the realistic trigger. DST and month-end
arithmetic in the same module were checked separately and are correct.

**L4 — a duplicated `?filters=` key silently discards the earlier list.**
_(B 33c.)_ `Object.fromEntries(searchParams.entries())`
(`db/queries/data-table.ts:62`) keeps the **last** value for a repeated key, with
no `onDropped` call — the one discard path the strict-filter contract does not
cover. Distinct from `should-ignore.md` #59, which is about an explicitly empty
filter array.

**L5 — a `roleId` union failure returns Zod's English `"Invalid input"`,
defeating the reason `zodIssueMessage` exists.** _(A F43.)_
`utils/validation/auth.ts:40` is
`z.union([z.literal(CUSTOM_ROLE_VALUE), idSchema])`. `zodIssueMessage` was
written because _"Zod's built-in unknown-key message is English and would be the
only non-Arabic string a client ever sees"_ (`utils/validation/rules.ts:41-44`),
but `invalid_union`'s own message is `"Invalid input"` and neither branch's
message survives. On `POST /api/dash/users` and `PUT /api/dash/users/:id`, a
client sending `roleId: "not-a-uuid"`, a v4 UUID, `0`, `null` or `""` receives
`422 "Invalid input"` where `idSchema` alone would have returned the Arabic
message. No security impact; the validation layer's stated contract does not hold
at the one field that uses a union.

**L6 — `zodIssueMessage` reflects unbounded, attacker-controlled JSON key names
into the 422 body.** _(A F29 (Medium) + B's "examined" note. Calibrated to Low:
B independently measured that every reachable door is behind a session and a
10–20/min limiter — 100 000 keys → 176 ms and an ~889 KB message — which makes it
a nuisance rather than a lever.)_ `utils/validation/rules.ts:45-50` interpolates
`issue.keys.join('، ')` with no length bound and no character filter, and the
result becomes `CustomError.message` → the client's `message` field; every other
client-facing message in this API is a server-owned constant. Reachable from
every `.strict()` schema. Measured against the real `selfUpdateUserSchema`: a key
named `<img src=x onerror=alert(1)>` is echoed verbatim, and one 200 000-character
key name produces a 200 026-character message. The CRLF case is JSON-escaped, so
header injection is **not** possible; whether the reflected text can become XSS
depends on a front-end that is not in this repository (flagged as uncertain by A).
The unbounded length is a defect regardless. **Fix:** cap the count and length of
reflected key names, or name only the count.

**L7 — extended Arabic-Indic digits are rejected as a _missing_ phone number.**
_(B's "examined" list; a genuine, actionable localisation defect.)_
`normalizeArabicDigits` (`utils/index.ts:6-9`) covers U+0660–U+0669 but not
U+06F0–U+06F9, and `phoneCleanupRegex = /[^\d]/g` (ASCII `\d`) then deletes them,
so a phone number typed in extended Arabic-Indic digits fails with "phone number
is required" rather than a format error. One extra range fixes it. No security
consequence, and not in conflict with `should-ignore.md` #56 (which is about the
Saudi format regex, not digit normalisation).

### Auth, OTP and rate-limit hardening

**L8 — the keyring accepts an active key that is not the newest generation.**
_(B 27.)_ `lib/auth/keyring.ts:152-201`, consumed at `lib/auth/password.ts:106`.
`parseConfiguration` validates that generations are unique and that the active id
exists, but never that the active key holds the _highest_ generation — while
`generation`'s single consumer reads it as staleness
(`needsRehash: pepper.generation < activePepper.generation`). With keys
`{"1":{generation:1},"2":{generation:2}}` and the active id set to `1`, the
keyring is accepted and `needsRehash` for a generation-2 hash evaluates to
`false` forever. Actor: whoever sets deployment environment variables, including
an automated rollback. After an emergency rotation away from a leaked generation,
reverting `PASSWORD_PEPPER_ACTIVE_ID` alone — the common half-rollback — is
accepted silently: boot succeeds, logins keep working, every password
subsequently set is re-peppered with the _older_ key, and the automatic upgrade at
`lib/auth/login-guard.ts:318-331` never migrates anything back. No error, no log,
no startup failure. A single "`activeId` must own `max(generation)`" check closes
it. Same missing invariant as M4, from the other direction: the rollback rule is
"roll the keyring and the active id together, never one alone". Every other rule
in the file rejects correctly (non-canonical base64url, padded base64, 31-byte
secrets, duplicate generations, absent active id, >8 keys, extra fields,
non-integer generations).

**L9 — the HIBP network call and the argon2 hash run before any check on the
_target_ user.** _(A F40.)_ `app/api/dash/users/[id]/handler.ts:339-341` performs
`checkPasswordCompromise` and `hashPassword` before the transaction, and therefore
before the target row read (`:344-362`), the protected-system-role check (`:368`),
the ownership check (`:375`) and the role-authority check (`:385`). An actor
holding only `users.editOwn` who sends a `PUT` with a `password` at a user they
did not create causes an outbound HTTPS request to the HIBP range API and one
argon2id hash at `memoryCost: 65_536, timeCost: 3, parallelism: 4` — and then
gets a 404. Bounded to 10/min/actor by the limiter at `:708-713`, so this is
amplification rather than a DoS primitive, but the work is spent unconditionally
on behalf of a target the caller has no authority over, one statement away from
the checks that would have refused. Distinct from `should-ignore.md` #45
(throughput) and #52 (HIBP fail-open/timeout): the claim is ordering.

**L10 — the daily OTP spend breaker allows 2× the day's budget in one second at
the UTC boundary.** _(A F41.)_ With `OTP_GLOBAL_SEND_CAP_PER_DAY = 2000` and
`window = ONE_DAY_S` (`lib/rate-limit/api.ts:121`, `:200-206`),
`windowStart = now - (now % 86_400_000)` is UTC midnight: 2000 charges at
`23:59:59.999Z` and 2000 at `00:00:00.000Z` dispatch **4000 paid messages inside
one second** and leave the whole of day two at zero. A spend cap that can be
doubled in a burst is not a strict daily cap. Anchor it on a rolling counter, or
halve the cap across staggered windows.

**L11 — the global daily OTP budget is charged from inside the PostgreSQL
transaction.** _(B 32.)_ `utils/otp.ts:571`, contract at
`lib/rate-limit/api.ts:196-206`. The call is the last statement inside
`withTransaction`, holding a `FOR UPDATE` row lock, an advisory lock and one of
`MAX_POOL_CONNECTIONS` (10) — and the comment immediately below it explains why
`sendOtp` was moved _out_ of the transaction for precisely this reason.
`enforceOtpGlobalSendBudget` is a synchronous `bun:sqlite` statement, measured
blocking for 2 282 ms under writer contention (M12), so the same amplification
applies at smaller scale; it is the one limiter call in the codebase made while
holding PostgreSQL locks. Secondarily, the charge is not atomic with the
transaction: a successful charge followed by a failed COMMIT permanently burns one
unit of the daily paid-delivery budget with nothing sent, and there is
deliberately no refund primitive. _The outage-amplification magnitude is a
hypothesis; the placement and the non-atomicity are code-evident._

**L12 — `MISSING_RESPONSE` is unmapped, so the sign-in endpoint's most common
client error answers in English with no `content-type`.** _(B 28.)_
`lib/auth/code-errors.ts:6-66`. Measured: `POST /api/auth/sign-in/email` with no
`x-captcha-response` returns
`400 {"message":"Missing CAPTCHA response","code":"MISSING_RESPONSE"}` with no
`content-type`, and falls through to `console.error(sanitizeForLog(...))` at
`lib/auth.ts:232-238` — so ordinary client misuse is logged at error level. Any
client that reaches sign-in without a Turnstile token (a stale page, a blocked
`challenges.cloudflare.com`, a native client) gets an untranslated string with a
raw framework code, in an application where every other response on this prefix
is `{"message":…,"code":"__"}`. The three origin-rejection codes the table _does_
carry answer correctly.

**L13 — 403-vs-404 divergence on `PUT`/`DELETE /api/dash/users/:id` discloses
which accounts outrank the caller.** _(A F36.)_
`app/api/dash/users/[id]/handler.ts:385-391` calls `validateRolePermissionScope`,
which throws `MSG_CANNOT_GRANT_UNOWNED_PERMISSIONS` with **403**
(`lib/permissions/utils.ts:442-446`), while every neighbouring unreachable-target
gate deliberately answers **404 `MSG_NOT_FOUND`** — `:368` (protected system
role), `:375` (out-of-scope owner) and all three checks in
`app/api/dash/users/[id]/target-user.ts:40-51`. `handleApiError` passes a
`CustomError`'s message and status through verbatim. An actor holding
`users.view` + `users.edit` but **not** `permissions.view` can list users (which
per `should-ignore.md` #39 shows every non-system user) and send a minimal valid
`PUT` at each id: `404` means nonexistent / system-role / not-mine, while `403`
means _this account exists and its role holds a permission I do not_. That
reconstructs the relative privilege ranking of every account without ever
granting `permissions.view` — the grant that is supposed to gate exactly that
knowledge. Same leak on `DELETE` (`:814`) and in `sessions/handler.ts`'s
`assertTargetReachable`. Distinct from `should-ignore.md` #9 (a user GET exposing
role permissions to its own holder): this is a cross-account inference by a caller
with no permissions grant at all.

**L14 — the SQLite sweep's per-run ceiling is below the reachable insertion
rate.** _(B 30.)_ `lib/sqlite/sweep.ts:30-37` (`BATCH_SIZE = 500`,
`MAX_BATCHES = 200`), `lib/sqlite/maintenance.ts:12-43`. 400 000 expired rows
swept in one run removed exactly 100 000 and returned `hasMore: true`; four runs
were needed. At 263 bytes/row and an hourly schedule, sustained creation of more
than ~28 new expired keys per second outruns it permanently. `hasMore: true` is
returned with HTTP 200 by design, so a bare `curl -fsS` cannot see it. Mitigated
by disk alerting and by the fact that the cheap high-cardinality vectors are
captcha-gated — **M2 removes that mitigation for the `preauth.*` keyspace.**

**L15 — the disposable cache database is coupled into the maintenance sweep with
no error containment, and has no production reader or writer.** _(B 31.)_
`lib/cache/index.ts:246-253`, `lib/sqlite/maintenance.ts:15-41`.
`cacheGet`/`cacheSet`/`cacheDelete` each swallow store failures (_"A cache that
throws is worse than a cache that misses"_), but `cacheSweepExpired` and
`cacheHasExpiredRows` call `getStore()` directly, which throws.
`runMaintenanceSweep` awaits the limiter sweep first, so a corrupt `cache.db`
makes the endpoint report failure _after_ the limiter deletions have committed —
while the module header states the opposite property (_"Corrupt or oversized
cache? Delete the file and restart"_), which is why separate files were chosen.
Also worth knowing: `cacheGet`/`cacheSet`/`cacheDelete`/`cacheDeletePrefix`
appear only in `lib/cache/index.ts` and one unit test, so the maintenance endpoint
creates and maintains a database nothing else uses.

### Logging, observability and diagnostics

**L16 — `serializeLogValue`'s `seen` set is visit-scoped, `\p{Cf}` is not
redacted, and one throwing getter discards the whole log line.**
_(A F37 + B 26.)_ `utils/index.ts:117-127`, `:315-325`, `:384-387`.
(a) Nothing is deleted from `seen`, so the second occurrence of any repeated but
**acyclic** reference is dropped and mislabelled:
`sanitizeForLog({ x: shared, y: shared })` → `{"x":{"a":1,"b":2},"y":"[circular]"}`.
During an incident that is a false lead about the shape of the data, in the one
artefact the responder has; the correct form is a path-scoped set (add before
recursing, delete after). (b) `LOG_CONTROL_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu`
neutralises CRLF and U+2028 correctly, but bidi overrides (U+202E/U+202C) and
zero-width characters survive — and the access log at
`lib/http/after-response.ts:62-70` writes a client-controlled `summary.path`
through bare `JSON.stringify`, which escapes below 0x20 but not `\p{Cf}`.
_(Reachability of the `\p{Cf}` case is a hypothesis.)_ (c) A single `try` around
the whole payload means one awkward accessor replaces the entire diagnostic with
`[unserializable log payload]` — at exactly the moment diagnostics matter, since
`utils/api-response.ts:146` is the only record of an unexpected 500. Redaction
_coverage_ held up under every hostile shape tried (nested objects, arrays,
`Map`/`Set`, `Error.cause` chains, getters, symbol keys, `__proto__` from
`JSON.parse`, `AggregateError`, Better Auth `APIError` bodies) — these are the
three edges only.

**L17 — three log sites bypass the structured-logging convention with a
bracket-prefixed string.** _(A F26 + its pass-2 correction.)_ Every log call in
this codebase emits one JSON object — `console.error(JSON.stringify({ msg, … }))`
or `console.error(sanitizeForLog({ msg, … }))` — with `msg` as a dotted or spaced
key; `lib/http/after-response.ts:62-71` defines the shape. Three sites do not:
`lib/captcha.ts:32`, `lib/r2/client.ts:167-171`, and
`app/api/dash/users/me/contact-change.ts:41`
(`console.error('cookie cache refresh failed:', sanitizeForLog(e))`). A
deployment shipping stdout to a JSON pipeline gets three lines that do not parse,
and they are not arbitrary lines: the captcha one is the signal that **CAPTCHA
verification is disabled by misconfiguration and every protected request is being
rejected** — the highest-value alert in the file and the one least likely to reach
an alerting rule, because it has no `msg` key to match on. `lib/env.server.ts:29`
puts `TURNSTILE_SECRET_KEY` in `REQUIRED_IN_PRODUCTION`, so in production that
branch is unreachable, which leaves it reachable exactly where it is hardest to
notice: a non-production deployment with `NODE_ENV=test` where
`lib/captcha.ts:26-29` selects `process.env.TURNSTILE_SECRET_KEY` and it is unset.
The contact-change site fires when a user's cached identity is known to be stale.

**L18 — `ipIdentifier`'s failure log emits present, IP-bearing headers, which is
the opposite of the boundary rule the sibling module states.** _(A F42.)_
`lib/rate-limit/api.ts:76-84` logs `cf-connecting-ip`, `x-forwarded-for`, `host`
and `user-agent` values; none matches a denylist fragment in `serializeLogValue`,
so `sanitizeForLog` passes them through verbatim.
`lib/rate-limit/store-failure.ts:19-33` states the rule this area works under —
withhold values that embed a destination, because _"withholding it costs no
diagnostic value."_ The branch fires whenever `cf-connecting-ip` is absent **or**
fails `IP_SCHEMA`, i.e. on every non-Cloudflare ingress path, and in exactly that
case `x-forwarded-for` is the header most likely to carry the real client address
chain — so every such request writes a client IP into the application log.
`should-ignore.md` #63 blesses _"the missing headers are logged"_; the distinction
is that what gets logged is not the _missing_ header but a _present, IP-bearing_
one. Logging the header **names** that were absent carries the same diagnostic
value with none of the data.

**L19 — no `unhandledRejection` / `uncaughtException` handler: an escaped async
error hard-kills the process and bypasses the entire shutdown design.**
_(A F20.)_ `server.ts:312-315` registers `SIGTERM` and `SIGINT` and nothing else;
grep confirms neither event is registered anywhere. Reproduced on the pinned
runtime — an unhandled rejection in detached work with a `Bun.serve` listener up
exits the process with code 1 and the queued follow-up never runs. **No reachable
trigger exists in application code today**: `lib/http/after-response.ts:31-59`
isolates every task and its drain uses `Promise.all(inFlight).catch(() => {})`,
`lib/auth/passwordless.ts:209` has a `.catch(() => {})`, and `server.ts:314`'s
`void shutdown(signal)` cannot reject. So this is a resilience gap, like M14. What
remains unwrapped is the `Bun.SQL` pool (`db/index.ts:48`), `bun:sqlite` raising
asynchronously outside a query `await`, and any future post-response caller. When
one fires the outcome is strictly worse than a normal stop: `shutdown()` never
runs, so `closeDatabase`, `closeRateLimitStore` and `closeCacheStore` are skipped,
the after-response queue is dropped, and the only record is a raw multi-line stack
trace that will not parse in a JSON log pipeline. Bun 1.4 also changes what a
handler must cover: _"Exceptions thrown in `node:fs`, `node:dns`, and
`crypto.pbkdf2` callbacks are now `uncaughtException`… A handler registered
there [on `unhandledRejection`] no longer sees it."_ This codebase uses
`node:crypto` (`lib/sqlite/maintenance-token.ts:10`) and `node:path`/`node:fs`, so
a handler must be on **both** events — registering only `unhandledRejection`
would already be the wrong choice on 1.4.0.

**L20 — OPTIONS requests produce no access-log line.** _(B's "examined" list.)_
Both OPTIONS answers short-circuit in an `onRequest` hook, so preflight volume
and OPTIONS-based path scanning are invisible in the log. An observability gap
rather than a correctness defect, and it is the one request shape M2's scanning
would use.

### Dependencies, tooling and repository hygiene

**L27 — CI gates only Knip's unused-file check, and three cheap gates are
missing.** _(A F11 + A F46 + B 36.)_ `.github/workflows/ci.yml` runs
`bunx knip --include files`, while the full `bun run find:unused-files` also
checks unused exports and types — so those categories can regress without failing
CI (and they are the ones L21 lives in). Widen the gate once the remaining export
findings are resolved. Two more: `bun dedupe --check` currently reports three
removable duplicates and exits 0 unless wired in
(`@types/node 26.2.0 → 24.13.3`, `get-tsconfig`, `undici-types`); and the CI JUnit
report (`ci.yml:142-147`) is written and thrown away — no step uploads or parses
it, GitHub does not read JUnit XML on its own, and `.gitignore:14` keeps it out of
the repo.

**L29 — `@tanstack/react-table` is a production dependency for one type-only
import, in a repository with no React.** _(A F17 + B 36.)_ `types/data-table.ts:3`
is the only import site, used once at `:9`
(`extends Omit<ColumnSort, 'id'>`) — and since `ColumnSort` is
`{ id: string; desc: boolean }`, the entire value drawn from the package is
`{ desc: boolean }`. There is no React in this repository: no `.tsx` file exists,
no module imports `react`, and `react` is in neither dependency list. A React
table library in `dependencies` ships: `bun prune --production` cannot remove it,
`bun audit` includes it and its transitive tree in the attack surface this project
must track, and Renovate raises PRs for it.

**L30 — `sharp` and `unrs-resolver` are in both `trustedDependencies` and
`ignoreScripts`, where Bun 1.4 makes the first entry dead.** _(A F19.)_
`package.json:79-87`. Bun 1.4 release post: _"`ignoreScripts` skips a package's
lifecycle scripts entirely, **even if it is also in `trustedDependencies`**."_ So
the only effective `trustedDependencies` entry is `argon2`. The two lists state
opposite intents for the same two packages and Bun resolves it silently — a
future maintainer removing `sharp` from `ignoreScripts` to fix a native-build
problem would simultaneously re-enable its postinstall via the still-present
`trustedDependencies` entry, which is not what removing one line looks like.
`sharp` is a `devDependency` used only by `bench/`, so the whole pair exists for
benchmark tooling.

**L31 — Bun 1.4 makes the `Set-Cookie` re-append workaround unnecessary.**
_(A F21.)_ `lib/http/response-policy.ts`'s immutable-header fallback deletes and
re-appends `getSetCookie()` values. Measured on Bun 1.4.0, `new Headers(h)`
already preserves repeated `Set-Cookie` entries
(`copy_getSetCookie: ["a=1; Path=/","b=2; Path=/"]`,
`copy_preserves_two_cookies: true`). The block is idempotent, so there is no
runtime failure scenario; it is unnecessary work in the fallback path and can be
removed.

**L33 — `scripts/find-non-null-assertions.ts` misses roughly half of all
`@ts-ignore` / `@ts-expect-error` comments.** _(B 36.)_ Lines `148-161` create a
`/g` regex once outside the loop and call `.test()` per line, so `lastIndex`
carries across lines. A false negative, contained because the script is advisory
and not wired into CI.
