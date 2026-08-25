# Autonomous Audit — Claude Opus

**Date:** 2026-08-22
**Target:** working tree at `D:\apps\job-app\soft-house-dash-3` (branch `main`, uncommitted changes included)
**Runtime verified:** Bun 1.4.0, PostgreSQL 18.6, Elysia 1.4.29, drizzle-orm 0.45.2, better-auth 1.7.1, zod 4.4.3, svgo 4, DOMPurify via isomorphic-dompurify
**Excluded by instruction:** every item in `reports/should-ignore.md`, including its "Known Issues — Will Be Fixed Later" section. Nothing below restates, renames or rephrases one of those.

---

## Method

This was not a read-through. The decisive evidence here comes from running the
application:

- **A scratch PostgreSQL database** (`audit_probe_tmp`) was created, migrated with the
  project's own `scripts/migrate.ts`, and seeded with a role, a permission matrix, a user
  and a credential account. It was dropped at the end.
- **The Elysia app was driven in-process** (`app.handle(new Request(...))`) so real routes —
  including Better Auth's — executed against that database with real middleware, real
  limiters and real security headers. Where the framework's own request parsing was the
  question, a real listener was driven over **raw TCP sockets** instead, because that is the
  only way to control the `Host` header.
- **`globalThis.fetch` was stubbed** for `challenges.cloudflare.com` and
  `pwnedpasswords.com` so nothing left the machine.
- **Counterfactuals were run** wherever a claim depended on the environment. All of
  Finding 1 is established by running the same probe under two values of `TZ`.
- Library behaviour was read from `node_modules` at the installed version, never from
  memory.
- Nine parallel read-only shards covered the rest of the tree. **Every finding they
  returned was re-verified here before inclusion**; their unproven hypotheses were dropped.
  Where a measurement could not be reproduced in the time available, the finding says so
  explicitly.

Nothing in the application was modified. Probe scripts were written outside the repository
and deleted.

### The project's own gates, run

| Gate                                     | Exit  | Result                                                                           |
| ---------------------------------------- | ----- | -------------------------------------------------------------------------------- |
| `bunx tsc --noEmit`                      | 0     | clean                                                                            |
| `bun run lint`                           | 0     | clean today — **but see Finding 5: it cannot fail on a security rule**           |
| `bun run format:check`                   | **1** | 2 untracked files unformatted (`docs/bun-s3.md`, `reports/claude-opus-audit.md`) |
| `bun audit`                              | 0     | no vulnerabilities, 573 packages                                                 |
| `bunx knip`                              | 1     | 1 unused export (see Low findings)                                               |
| `bun dedupe --check`                     | 0     | 3 duplicate versions removable                                                   |
| `bun run scan:secrets` (gitleaks 8.30.1) | 0     | 20 commits, no leaks                                                             |
| `bun run scan:sast` (semgrep 1.173.0)    | 0     | 257 files, 111 rules, 0 findings                                                 |
| `bun run test` (unit)                    | 0     | 239 pass / 0 fail                                                                |
| `bun run test:integration`               | 0     | 105 pass / 0 fail                                                                |
| `bun run test:process`                   | 0     | 3 pass / 1 skip (Windows-gated)                                                  |
| `bun run smoke`                          | 0     | all 9 checks pass                                                                |

The codebase is unusually disciplined: dense and accurate rationale comments, one helper per
job, explicit policy fields on every route, and a genuinely hardened filter DSL. Almost
everything below was found by **executing** it rather than reading it — which is the point,
because the two heaviest findings are invisible to type-checking, linting and the entire
existing test suite.

---

## Findings at a glance

| #     | Severity     | Finding                                                                                                                                                                                                                                                    |
| ----- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | **Critical** | `mode: 'string'` timestamps decode with the host UTC offset — this silently disables the login lockout, both OTP blocks and the OTP resend cooldown, and breaks session-list pagination                                                                    |
| 2     | **Critical** | A 27 KB SVG upload freezes the whole process for 3.8 s via quadratic XML entity expansion                                                                                                                                                                  |
| 3     | **High**     | `POST /api/auth/sign-in/email` makes an unbounded outbound captcha call before any rate limiter                                                                                                                                                            |
| 4     | **High**     | `validID` preserves letter case, so three `===` self-guards on path UUIDs are bypassable — defeating re-authentication on self-credential change                                                                                                           |
| 5     | **High**     | The CI lint step cannot fail on any `eslint-plugin-security` finding, and is strictly weaker than the local hook                                                                                                                                           |
| 6     | **High**     | `/openapi.json` is unauthenticated, uncached, rebuilt per request at ~96× the cost of a 404, and advertises the internal and dev surfaces                                                                                                                  |
| 7     | **High**     | `optimizeImage` re-decodes the full source once per iteration — a 59 KB PNG burns 22 s of CPU, 20 per window per account                                                                                                                                   |
| 8     | Medium       | Elysia's 11-character path offset lets a prepended junk segment reach any route when the `Host` header is ≤3 characters                                                                                                                                    |
| 9     | Medium       | Unlimited unauthenticated guessing of `SQLITE_MAINTENANCE_TOKEN`, which has no length floor                                                                                                                                                                |
| 10    | Medium       | The read path authorizes a deactivated **and soft-deleted** user for the session's full 28-day life                                                                                                                                                        |
| 11    | Medium       | Hash-envelope and keyring errors escape sign-in as an empty 500, rolling back the lockout counter and creating a 500-vs-401 account oracle                                                                                                                 |
| 12    | Medium       | External references survive SVG sanitisation, on objects stored `image/svg+xml` + `inline`                                                                                                                                                                 |
| 13    | Medium       | The sanitiser and DOMPurify use different parsers, so `isValid: true` is returned for output with content outside the SVG root                                                                                                                             |
| 14    | Medium       | `<use>` is stripped, so every sprite/symbol SVG is stored blank with HTTP 200 and no error                                                                                                                                                                 |
| 15    | Medium       | Every malformed or over-pixel raster upload answers 500 — including the decompression-bomb guard itself                                                                                                                                                    |
| 16    | Medium       | A NUL byte in any filter value or in `?search=` is a deterministic 500                                                                                                                                                                                     |
| 17    | Medium       | `PUT /api/dash/permissions/:id` silently ignores an omitted `description` and writes a contradictory audit row                                                                                                                                             |
| 18    | Medium       | Wrong-typed `password` / `description` values are coerced to "no change" and answered 200                                                                                                                                                                  |
| 19    | Medium       | Six unauthenticated requests deny a victim's password recovery for six hours                                                                                                                                                                               |
| 20    | Medium       | Delivery latency defeats `ensureMinDelay`, making the send endpoints an account-existence oracle                                                                                                                                                           |
| 21    | Medium       | Any second writer on `rate-limit.db` stalls the process for 2.3 s and then trips every fail-closed limiter to 503                                                                                                                                          |
| 22    | Medium       | `find-unused-files.ts` permanently exempts the live SVG sanitiser from the reachability gate                                                                                                                                                               |
| 23    | Medium       | The destructive-write guard's enforcement half has three regex bypasses                                                                                                                                                                                    |
| 24    | Medium       | `actions/checkout` leaves `GITHUB_TOKEN` in `.git/config` in six jobs, three of which then execute code from PyPI                                                                                                                                          |
| 25–36 | Low          | Grouped below: `toCalendarDate` epoch coercion, log-redaction gaps, keyring downgrade, unmapped captcha error, missing verify quota, sweep ceiling, cache coupling, budget inside a transaction, data-table edges, a vacuous test, dead code, repo hygiene |

Test-coverage gaps and the Bun 1.4 assessment follow the findings.

---

## 1. Critical — `mode: 'string'` timestamps decode with the host UTC offset, disabling four abuse controls

### Root cause

`db/schema.ts:120-136` — the shared `timestamps` helper, and every other timestamp column in
the schema, declares `mode: 'string'` with `withTimezone: true`:

```ts
const timestamps = {
  createdAt: timestamp('created_at', {
    withTimezone: true,
    precision: 2,
    mode: 'string',
  })
```

Enumerated at runtime through `getTableColumns`: **all 25** `timestamptz` columns in the
schema are `PgTimestampString`; none is `mode: 'date'`.

`bun:sql` hands drizzle a JavaScript `Date` for `timestamptz` — the project's own driver
contract test asserts this at `tests/integration/driver-contract.test.ts:768`. drizzle's
decoder for a `mode: 'string'`, `withTimezone: true` column
(`node_modules/drizzle-orm/pg-core/columns/timestamp.js:66-75`) then does this:

```js
mapFromDriverValue(value) {
  if (typeof value === "string") return value;
  const shortened = value.toISOString().slice(0, -1).replace("T", " ");  // UTC wall-clock
  if (this.withTimezone) {
    const offset = value.getTimezoneOffset();                            // LOCAL offset
    const sign = offset <= 0 ? "+" : "-";
    return `${shortened}${sign}${...}`;
  }
```

It takes the **UTC wall-clock** and appends the **process-local offset**. The result names a
different instant from the one stored. Measured on this host (offset −180):

```
DB truth (driver Date)      : 2026-08-21T15:28:39.740Z
what drizzle returns        : "2026-08-21 15:28:39.740+03"   → parses as 12:28:39Z
```

Nothing pins the process timezone. There is no `Dockerfile`, no compose file, and no `TZ` in
`.github/workflows/ci.yml`, `mise.toml`, `bunfig.toml` or any source file;
`reports/coolify-deployment.md:792` states that Coolify uses the _server_ timezone; and
`utils/config.ts:24` defaults `BUSINESS_TIMEZONE` to `Asia/Riyadh` (UTC+3), which is exactly
the offset that makes every consequence below live.

Every consequence is proven by running the identical probe twice — once under the host
timezone, once under `TZ=UTC`.

### 1.1 The login account lockout never applies (fail-open)

`lib/auth/login-guard.ts:151-153` reads the value into JavaScript and compares it:

```ts
if (user.lockedUntil) {
  const lockTime = new Date(user.lockedUntil).getTime();
  if (lockTime > Date.now()) {
    return { outcome: 'reject_locked', passwordCostPaid: false };
  }
  // Lock expired — reset within the same transaction before proceeding
```

East of UTC the decoded instant is _earlier_ than the truth, and any offset ≥ 5 minutes
exceeds the entire `LOCK_DURATION_SECONDS`, so an armed lock is **always** read as expired
and the "lock expired" branch resets the counter. Twelve consecutive wrong passwords through
the real `POST /api/auth/sign-in/email`, `cf-connecting-ip` varied so the 20/min per-IP
limiter never fired:

```
host TZ (UTC+3)                              TZ=UTC (counterfactual)
attempt  5: failed=5 locked_until=17:55:06Z  attempt  5: failed=5 locked_until=17:55:35Z
attempt  6: failed=1 locked_until=null       attempt  6: failed=5 locked_until=17:55:35Z
attempt  7: failed=2 locked_until=null       attempt  7: failed=5 locked_until=17:55:35Z
...                                          ...
attempt 12: failed=2 locked_until=null       attempt 12: failed=5 locked_until=17:55:35Z
correct password after 12 failures -> 200    correct password after 12 failures -> 401
audit rows with lockoutCleared: 2            audit rows with lockoutCleared: 0
```

`MAX_FAILED_ATTEMPTS = 5` / `LOCK_DURATION_SECONDS = 300` are inert. `failed_login_attempts`
can never exceed 5, so there is **no cumulative bound at all** on password guessing against
one account, and the correct password is accepted immediately afterwards. Under `TZ=UTC` the
same probe holds the lock and refuses even the _correct_ password — the designed behaviour.

The only surviving control on this path is the per-IP sign-in limit (20/min per IPv6 /64).
`lib/auth.ts:154-155` states plainly that the two are complements — "Per-account lockout does
not cover this: spraying one password across many accounts never trips it" — so one half of a
deliberately two-layer control is dead, and a distributed attacker bypasses the surviving half
by construction. The same dead check also governs the re-authentication counter for
`/me/change-password`, `/me/change-email` and `/me/change-phone`, which are limited to 5/min
each: ~15 guesses/minute, indefinitely, with no lockout.

West of UTC the sign flips (`sign = offset <= 0 ? '+' : '-'`) and the lock instead lasts
`offset + 5 min` — a self-inflicted denial. That direction is read from the decoder source;
Bun on this Windows host honoured only `TZ=UTC`, not an arbitrary zone override.

### 1.2 The OTP verify block never applies (fail-open)

`utils/otp.ts:800` has the same shape. With a `verification_sessions` row blocked for another
five minutes and a live code present, calling the real `processOtpVerify` with a wrong code:

```
host TZ (UTC+3): 400 "رمز التحقق غير صحيح"    row after: is_blocked=false verify_attempt_number=1
TZ=UTC         : 429 "تجاوزت الحد الأقصى..."   row after: is_blocked=true  verify_attempt_number=0
```

Under `TZ=UTC` the block short-circuits before any code is read and nothing is charged —
exactly as `utils/otp.ts:793-796` describes. On the host timezone the block is cleared and the
guess is evaluated. The control that stops OTP code-guessing once the attempt budget is spent
stops nothing.

### 1.3 The OTP send block and the resend cooldown never apply

`utils/otp.ts:438` (block) and `utils/otp.ts:465` (`nextAllowedAt` cooldown) are the same
pattern. With a session blocked for five more minutes and a 30-second cooldown armed, calling
the real `processOtpSend`:

```
host TZ (UTC+3): both ignored — proceeds all the way to SMTP delivery (fails only on EAUTH),
                 row after: is_blocked=false blocked_until=null
TZ=UTC         : throws 429 "تم حظر البريد الإلكتروني مؤقتاً. يرجى المحاولة بعد 5 دقيقة",
                 row unchanged
```

The cooldown ladder is `30 · 2^(n-1)` seconds — 30, 60, 120, 240, 480 — every value smaller
than the host offset, so the branch is unreachable east of UTC. All five codes of a cycle can
be requested back-to-back instead of spread over ~8 minutes: five paid deliveries to a chosen
destination as fast as the endpoint limiter allows.

Scope worth stating precisely: the **hierarchical quotas** in `lib/rate-limit/*` are
_unaffected_, because they live in SQLite and do their arithmetic on integer epoch
milliseconds. What is dead is the per-session PostgreSQL-backed layer. Aggregate delivery cost
is still bounded by the SQLite destination/surface caps — which is also why Finding 21 matters
more than it otherwise would.

### 1.4 Session-list pagination silently skips rows

`app/api/dash/users/[id]/sessions/pagination.ts:48` builds the cursor from the mangled string,
and `.../sessions/handler.ts:196-231` feeds the parsed instant back into
`(created_at, id) < ($1, $2::uuid)` against real column values. Three sessions one minute
apart, `limit=1`, running the handler's exact query:

```
                        host TZ (UTC+3)                     TZ=UTC
page 1 returned         "2026-08-21 12:02:00.000+03"        "2026-08-21 12:02:00.000+00"
nextCursor issued       2026-08-21T09:02:00.000Z|<id>       2026-08-21T12:02:00.000Z|<id>
page 2 rows             0   (correct answer: 2)             2   (correct)
DB truth                12:02Z, 12:01Z, 12:00Z              12:02Z, 12:01Z, 12:00Z
```

The remaining two sessions are unreachable. This is precisely the failure the keyset design
was introduced to remove — `pagination.ts:8-11`: "an OLDER compromised session could not be
discovered at all — and selective revocation needs its id". An operator revoking a compromised
session can be shown a list that omits it, with HTTP 200 and no signal. West of UTC the cursor
lands in the future instead and page 2 re-serves page 1 — a client loop.

### 1.5 Every timestamp the API returns is wrong, and session expiry is evaluated at the wrong instant

Every `createdAt` / `updatedAt` on `GET /api/dash/users`, `GET /api/dash/users/:id`,
`GET /api/dash/permissions`, `GET /api/dash/permissions/:id` and the `updatedAt` returned by
`PUT /api/dash/permissions/:id` is off by the host offset. Data-table _date filters_ are not
affected — they bind `Date` parameters — so filtering and display disagree: a row can be
filtered into 21 Aug and rendered as 20 Aug.

Better Auth compares `expiresAt` in JavaScript
(`node_modules/better-auth/dist/api/routes/session.mjs:148,173,359,468`). Its drizzle adapter
does coerce (`new Date(data)` for `date`-typed fields), so it receives a real `Date` — but one
built from the shifted string:

```
Better Auth sees : 2026-09-18T14:51:54.710Z
DB truth         : 2026-09-18T17:51:54.710Z
```

Measured: with `sessions.expires_at` set to `now() + 1 hour`,
`auth.api.getSession({ disableCookieCache: true })` returns **null** — a session with an hour
of genuine validity left is rejected. East of UTC this fails closed (a 28-day session loses
three hours, invisibly). West of UTC the same arithmetic accepts a session for `|offset|` hours
_past_ its true expiry.

Two other JS-side reads were checked and are **correct**, because the comparison happens in
SQL: `utils/otp.ts:831` (`gt(verificationCodes.expiresAt, new Date().toISOString())` — a
correct UTC parameter compared server-side) and `utils/otp.ts:855`
(`NOW() - verify_attempt_window_start > INTERVAL '24 hours'`). So does
`lib/auth/live-session.ts:43` (`gt(sessions.expiresAt, sql\`now()\`)`).

### Reproduction

```ts
// needs only a migrated database and the repo's own modules
process.env.DATABASE_URL = '<a migrated scratch database>';
const s = await import('<repo>/db/schema.ts');
const truth = new Date('2026-08-21T12:34:56.780Z');
console.log((s.sessions.createdAt as any).mapFromDriverValue(truth));
// TZ=UTC        -> "2026-08-21 12:34:56.780+00"   (correct)
// any other TZ  -> "2026-08-21 12:34:56.780+03"   (claims 09:34:56Z)
```

For the lockout: five wrong passwords against one account, read
`select failed_login_attempts, locked_until from users`, then send a sixth request — on a
non-UTC host `locked_until` is `null` again. Re-run the whole thing with `TZ=UTC` prefixed.

### Fix

One root cause, one place to fix, in order of preference:

1. **`mode: 'date'` on the timestamp columns** (or drop `mode` — `date` is the default) and let
   the driver's `Date` reach the callers. Comparison sites like `new Date(user.lockedUntil)`
   keep working. The API response shape changes from `"2026-08-21 12:02:00.000+03"` to an ISO
   string, which is a client-visible contract change and should be made deliberately.
2. **Immediate mitigation, independent of the fix:** pin `TZ=UTC` in the deployment
   environment. Verified above to make all five consequences correct. The deployment half —
   the variable, the reason it is not optional, and why a green CI run is not evidence — is
   now `reports/coolify-deployment.md` **gate 1**; it is not repeated here.
3. Add the regression tests that do not exist (see _Test coverage_), with `TZ` forced to a
   non-UTC zone — a UTC CI host hides this entire class.

---

## 2. Critical — a 27 KB SVG upload freezes the whole process for 3.8 s (quadratic entity expansion)

**Location** `utils/images/svg-optimizer.ts:39-49` (the only size gate) and `:88`
(`parseFromString`); reached from `lib/r2/upload-helper.ts:204-219`; outer gate at
`app/api/upload/image/handler.ts:113`.

**Evidence.** The size cap is measured on the _unexpanded_ text and nothing re-checks after the
parser expands entities:

```ts
const maxSize = SERVER_MAX_IMAGE_SIZE * 2 * 1024 * 1024;   // 0.4 MiB
const contentSize = new Blob([trimmed]).size;              // raw input only
...
const doc = domParser.parseFromString(trimmed, 'image/svg+xml');
```

Measured through the real `sanitizeSvgServer`, with a 100 ms interval timer running to detect
event-loop starvation:

```
upload=22098B  expanded=10240093B  blockedMs=939   timerTicksDuringBlock=0 (expected ~9)   isValid=true  rss=480MiB
upload=26598B  expanded=40960093B  blockedMs=3800  timerTicksDuringBlock=0 (expected ~38)  isValid=true  rss=1575MiB
```

The expansion law is `entityBody × refCount`, and the work is **fully synchronous** — zero of
the expected timer ticks fired. All three defences miss it: the size cap sees 27 KB; the
element-count cap (`:74-83`) counts the DOCTYPE block as a couple of `<[^>]+>` matches against
a ceiling of 500; and `validateMagicBytes` exempts SVG (`lib/r2/upload-helper.ts:92,98`). The
sanitiser returns `isValid: true`, so the expanded string flows on to
`svgOptimizerServer(...)` and then to R2 (`upload-helper.ts:218-220`).

**Impact.** Bun runs one JavaScript thread per process, and `app.ts:216` sets
`reusePort: false`, so this is the whole server: every other in-flight request — including
`/api/health/storage`, which is what the orchestrator uses to decide whether the container is
alive — is stalled for the duration, and RSS climbs toward the container limit. (The health-check
tuning that survives a 3.8 s stall is `reports/coolify-deployment.md` §7; the measured stall is
carried there as capacity input, not as a substitute for this fix.) The budget is
`limit: 20` per window (`app/api/upload/image/handler.ts:78-83`) and `routes.ts:269` grants the
route a 120 s timeout, so 20 requests per minute at ~4 s each keeps the process wedged. Under
the effective 0.4 MiB input budget the arithmetic maximum is roughly
`(0.4 MiB / 2) × (0.4 MiB / 6)` characters — an unconditional OOM (derived from the measured
law, not run).

Actor: any authenticated caller holding `create` **or** `edit` on any dashboard page — the
weakest grant that reaches this route (`requireAnyPermission`, `handler.ts:63-67`).

**Repro** (<1 min, no database):

```ts
globalThis.fetch = (() => {
  throw new Error('blocked');
}) as any;
const { sanitizeSvgServer } = await import('<repo>/utils/images/server.ts');
const S = 'http://www.w3.org/2000/svg';
const svg =
  `<!DOCTYPE svg [<!ENTITY a "${'A'.repeat(20 * 1024)}">]><svg xmlns="${S}">` +
  `<desc>${'&a;'.repeat(2000)}</desc><rect width="8" height="8"/></svg>`;
let ticks = 0;
const iv = setInterval(() => ticks++, 100);
await new Promise((r) => setTimeout(r, 400));
const base = ticks;
const t = performance.now();
const r = sanitizeSvgServer(svg);
console.log({
  upload: svg.length,
  expanded: r.cleanedSvg.length,
  blockedMs: performance.now() - t,
  ticksFired: ticks - base,
  isValid: r.isValid,
});
clearInterval(iv);
```

**Fix.** Two independent bounds, both cheap: reject a `<!DOCTYPE` containing `<!ENTITY` before
parsing (this codebase already strips comments, CDATA and processing instructions at
`:52-64` — entity declarations belong in that list), and re-check the size **after**
serialisation, not only before parsing. Note that nested-entity expansion is already
impossible (verified: one level only), so the one-level quadratic case is the whole exposure.

---

## 3. High — `POST /api/auth/sign-in/email` performs an unbounded outbound captcha call before any rate limiter

**Location** `lib/auth.ts:414-423` (`customRules['/sign-in/email']: false`), `lib/auth.ts:156-168`
(the limiter, in a `before` hook), `app.ts:387-403` (the Better Auth prefix is registered
without `toElysiaHandler`, so it gets no pre-auth limit).

**Evidence.** Three facts compose:

1. `app.ts:387-403` registers `/api/auth/*` directly on the Elysia instance rather than through
   `toElysiaHandler`, so `enforcePreAuthIpLimit` — which every other authenticated surface gets
   from `routes.ts` — never runs for any Better Auth path.
2. Better Auth's own limiter runs first in its router
   (`node_modules/better-auth/dist/api/index.mjs:168` `onRequestRateLimit`, then line 170 the
   plugin `onRequest` handlers) — but `lib/auth.ts:420` sets `'/sign-in/email': false`, and
   `dist/api/rate-limiter/index.mjs:274` is `if (resolved === false) return null;`. No limit at
   all for that path.
3. The captcha plugin's `onRequest`
   (`node_modules/better-auth/dist/plugins/captcha/index.mjs`) then performs the outbound
   `betterFetch` to `challenges.cloudflare.com/turnstile/v0/siteverify` with
   `timeout: CAPTCHA_VERIFY_TIMEOUT_MS` = **10 000 ms**
   (`dist/plugins/captcha/constants.mjs:8`).

The app's own limiter (`SIGN_IN_IP_LIMIT_PER_MINUTE = 20`) lives in `hooks.before`, which runs
_after_ the plugin chain. Measured with `globalThis.fetch` intercepted to count and stub the
call:

```
40 unauthenticated POSTs to /api/auth/sign-in/email with any x-captcha-response value
  -> outbound siteverify calls: 40
  -> statuses: {"403": 40}
control: no x-captcha-response header
  -> 400 "Missing CAPTCHA response", outbound calls: 0
```

**Impact.** One inbound request of a few hundred bytes produces one outbound TLS request held
for up to 10 s, with no bound of any kind. An unauthenticated client can exhaust outbound
sockets and file descriptors, saturate the event loop, and consume Turnstile quota, on the one
endpoint whose availability matters most; legitimate sign-ins queue behind the same outbound
pool.

**This is the only place in the codebase that gets the ordering wrong**, which is what makes
it worth fixing rather than debating. The same invariant is stated verbatim and implemented
correctly in four other handlers:

- `app/api/auth/otp/send/handler.ts:43-55` — "Coarse per-IP cap BEFORE the captcha siteverify
  call: bounds the outbound HTTPS request to Cloudflare per IP"
- `app/api/auth/otp/verify/handler.ts:38-46` — same
- `app/api/auth/forgot-password/send/handler.ts:43-51` — same
- `lib/auth/passwordless.ts:75-82` — "Per-IP cap BEFORE captcha so the outbound siteverify call
  is bounded"

`/passwordless/verify` is the instructive one: it also has `customRules: false`, and it
compensates by calling `enforceRateLimit` as the first statement of its own endpoint, before
`verifyTurnstileRequest`. `/sign-in/email` cannot do that, because its captcha runs in a plugin
`onRequest` upstream of any hook.

**Fix.** Either restore a Better Auth `customRules['/sign-in/email']` budget as an _outer_
bound — it runs before the plugin chain, line 168 precedes line 170 — while keeping the atomic
in-hook limiter as the authoritative one; or drop `/sign-in/email` from the captcha plugin's
`endpoints` and call `verifyTurnstileRequest` inside the `before` hook after
`enforceRateLimit`, which is exactly the shape `lib/auth/passwordless.ts` already uses and
would also unify the two captcha implementations (`lib/captcha.ts` has a 3 s timeout; the
plugin's is 10 s).

---

## 4. High — `validID` preserves letter case, so `===` self-guards on path UUIDs are bypassable

**Location** root cause `utils/index.ts:503-515`; exploitable guards at
`app/api/dash/users/[id]/handler.ts:719`, `:771`, and
`app/api/dash/permissions/[id]/handler.ts:158`.

**Evidence.** `validID` is the project's gate for identifiers, but it validates without
canonicalising, and its regex is case-insensitive:

```ts
const UUID_V7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const validID = (val: unknown): string => {
  if (typeof val !== 'string') return '';
  const trimmed = val.trim();
  return UUID_V7_REGEX.test(trimmed) ? trimmed : ''; // original case returned
};
```

JavaScript `===` is byte-exact; PostgreSQL `uuid` equality is not. Every link measured against
the live database:

```
stored id                           : 01a024f0-3f36-70bf-a1dd-5474fe9be403
validID(UPPER)                      : 01A024F0-3F36-70BF-A1DD-5474FE9BE403
JS  lower === upper                 : false
drizzle WHERE users.id = UPPER      : 1 row  [{"id":"01a024f0-3f36-70bf-a1dd-5474fe9be403"}]
SELECT lower::uuid = upper::uuid    : true
adminUpdateUserSchema id after parse: 01A024F0-...  (unchanged; not normalised)
```

**Impact — three guards fail open.**

1. **`handler.ts:719` — re-authentication on self-credential change is bypassed.**

   ```ts
   if (userId === targetId) {
     const selfResult = await handleSelfEdit(actor, targetId, body, auditMeta);
   ```

   With an uppercased own id this is false and the request is routed into `handleAdminEdit`.
   `handleSelfEdit` accepts only `{ id, name }` (`selfUpdateUserSchema` is
   `.pick({ name }).strict()`); `handleAdminEdit` accepts `password`, `email`, `isActive`,
   `roleId` and `permissions`. I read `handleAdminEdit` (`:303-470`) in full: it contains **no
   self-check** — only `isProtectedSystemRole` (`:359`) and
   `editScope === 'own' && lockedUser.createdBy !== actor.userId` (`:367`).

   So an actor holding `users.edit` at `all` scope, on a role that is not a protected system
   role, can set **their own password with no current-password re-authentication**
   (`/me/change-password` requires `verifyLoginAttempt`) and **change their own primary email
   with no OTP proof** (`/me/change-email` requires `verifyLoginAttempt` plus
   `processOtpSend`). `handleAdminEdit` then revokes other sessions, logging the legitimate
   owner out. This converts a stolen session cookie into a permanent account takeover. It is
   not a permission escalation — such an actor could already change _other_ users'
   credentials — it is the defeat of the re-authentication boundary that exists so that a
   session alone is not enough.

2. **`handler.ts:771`** — `if (actorUserId === userId) throw cannotDeleteSelf` is bypassed; the
   soft-delete at `:819` then matches the actor's own row (email anonymised, `accounts`
   hard-deleted, `roleId` nulled).

3. **`permissions/[id]/handler.ts:158`** — `if (actorRoleId === roleId) throw
cannotEditOwnRole` is bypassed; the actor rewrites the permission matrix of the role
   currently authorising them. `validatePermissionScope` still bounds what may be _granted_, so
   this is destructive rather than escalating — but on a role shared with other administrators
   it is a denial of service against them.

**Class inventory** (the same comparison, checked at every site):

| Site                                                      | Direction                                                                                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `users/[id]/handler.ts:87` (`isSelf`, GET)                | fails **closed** — a self-view without edit permission is denied                                                                               |
| `users/[id]/handler.ts:719` (PUT dispatch)                | fails **open** — exploitable                                                                                                                   |
| `users/[id]/handler.ts:771` (DELETE self-guard)           | fails **open** — exploitable                                                                                                                   |
| `users/[id]/sessions/handler.ts:95` (`isSelf`)            | fails **closed** — only _adds_ `assertTargetReachable`                                                                                         |
| `permissions/[id]/handler.ts:158`                         | fails **open** — exploitable                                                                                                                   |
| `users/[id]/handler.ts:385,593` (body `roleId` vs stored) | spurious "role changed": an extra `validateRolePermissionScope` round trip, a session-metadata refresh, and an audit row for an unchanged role |

**Fix at the shared boundary:** make `validID` canonicalise —
`return UUID_V7_REGEX.test(trimmed) ? trimmed.toLowerCase() : '';`. Every id in the database is
lowercase (`Bun.randomUUIDv7()` output, and PostgreSQL renders `uuid` lowercase), so this closes
all three guards at once and cannot break a comparison that works today.

---

## 5. High — the CI lint step cannot fail on any `eslint-plugin-security` finding

**Location** `package.json:8`, `.github/workflows/ci.yml:25`, versus `lefthook.yml:35,48`.

**Evidence.**

```json
"lint": "tsc --noEmit && eslint .",
```

CI runs `bun run lint` (`ci.yml:25`). The local hooks run the stricter form:
`bunx eslint --max-warnings 0 --no-warn-ignored {staged_files}` (`lefthook.yml:35`) and
`bunx eslint . --max-warnings 0` (`lefthook.yml:48`).

`plugin:security/recommended-legacy` (`eslint.config.mjs:57`) registers all of its rules at
**warn**, and nothing upgrades them. Measured exit codes on this tree, with a warning forced to
exist:

```
bunx eslint . --rule '{"no-warning-comments":["warn",{"terms":["todo"],"location":"anywhere"}]}'
  -> EXIT=0
bunx eslint . --max-warnings 0 --rule '{...same...}'
  -> EXIT=1
```

And the concrete case, fed through stdin so nothing was written to the repo:

```
$ printf 'const cmd = process.argv[2] as string;\nexport const out = eval(cmd);\n' \
    | bunx eslint --stdin --stdin-filename lib/__audit_probe.ts
  1:1   warning  Filename is not in kebab case...        unicorn/filename-case
  2:20  warning  eval with argument of type Identifier   security/detect-eval-with-expression
✖ 2 problems (0 errors, 2 warnings)
EXIT=0
```

**Impact.** A commit introducing `eval(userInput)`, `child_process` with a non-literal
argument, a non-literal `fs` path (path traversal), a ReDoS-shaped regex, or a `==` timing
comparison on a secret **passes the CI lint step**. The only thing that catches it is
`lefthook`, which `git push --no-verify` skips and which a clone that never ran `bun install`
does not have. `lefthook.yml:1-2` states the opposite as its design rationale — "GitHub Actions
re-runs the same checks, so a skipped hook … is still caught." For the lint gate that sentence
is false. semgrep's `p/typescript` overlaps partially but has no equivalent of
`detect-possible-timing-attacks`, `detect-non-literal-fs-filename` or `detect-unsafe-regex`.

**Fix.** One flag: `"lint": "tsc --noEmit && eslint . --max-warnings 0"`. That makes the three
invocations agree. If the 20 warn-level rules produce noise, promote the security ones to
`error` explicitly instead of relying on a flag.

---

## 6. High — `/openapi.json` is unauthenticated, uncached and rebuilt per request

**Location** `routes.ts:333-339` (`preAuth: 'none'`), `lib/http/openapi.ts:556-561` (the
document is built inside the handler, per request).

**Evidence.** Measured in-process, 100 requests each after warm-up:

```
GET /openapi.json : 9.11 ms/req   body 98 681 bytes   ≈110 req/s per core
GET /api/nope     : 0.095 ms/req  body 59 bytes
cost ratio        : 96×
```

Every request re-runs `z.toJSONSchema` over ~20 schemas plus a `safeParse(undefined)` per
object field (`lib/http/openapi.ts:182-184`), and `lib/http/response.ts:14` stamps
`cache-control: no-store`, so neither a browser nor Cloudflare will cache it. A sweep of every
other `preAuth: 'none'` surface shows this is the sole outlier — the rest reject early and
cheaply:

```
GET  /api/health/storage        0.178 ms  200
GET  /api/health/storage?deep=1 0.034 ms  401
POST /api/internal/sqlite-sweep 0.046 ms  401
POST /api/internal/db-sweep     0.052 ms  401
GET  /openapi.json              5.3–9.1 ms 200
```

**Impact.** Two things from one route.

_Availability._ A single unauthenticated client with modest concurrency saturates a CPU core;
Bun serves one JavaScript thread per process and `reusePort: false` means one process, so that
is the whole server. ~1 100× bandwidth amplification from a ~90-byte GET as a secondary effect.

_Disclosure._ The served document advertises 27 paths to any anonymous caller, including the
operational and development surfaces:

```
/api/internal/sqlite-sweep      /api/internal/db-sweep
/api/dev/sign-up                /api/dev/email-test/fixed
```

and the full request schema for `/api/dev/sign-up` (`["name","email","password"]`). The dev
routes are correctly gated at handler entry on `NODE_ENV !== 'development'` — verified, they
return 403/404 in any other mode — so this is a map rather than a way in. It does, however,
point directly at the two endpoints in Finding 9.

**Fix.** Build the document once, lazily, and memoise it — a conversion failure then still does
not block boot, it fails the first request to that route. Add `preAuth: 'ip-limit'` for the
same reason every other route has it. If the contract is for internal consumers only, gate it
behind the maintenance token as `/api/health/storage?deep=1` already is. The edge-side half —
rate-limit it at Cloudflare whatever else is decided, and the coupling that makes blocking it
outright a regression — is `reports/coolify-deployment.md` §5.

---

## 7. High — `optimizeImage` re-decodes the full source once per iteration

**Location** `lib/r2/optimize-image.ts:79-94` and `:147-173`.

**Evidence.** `encodeAttempt` is handed the **original** buffer every time, so each of up to 32
iterations pays a full decode of the source at up to `MAX_IMAGE_PIXELS` (25 MP):

```ts
async function encodeAttempt(input: Buffer, width: number, quality: number) {
  const image = new Bun.Image(input, { maxPixels: MAX_IMAGE_PIXELS })
    .resize(width, undefined, { withoutEnlargement: true })
    .webp({ quality });
```

The loop admits 9 quality steps (95→50 by 5) plus 23 width steps (3048→800 by 100). Measured
with a 2-pixel checkerboard — cheap in PNG (predictable rows), expensive in lossy WebP (high
frequency), so it never reaches the byte target:

```
checkerboard 3000x3000: inputBytes=59475  ms=22314  iterations=27  outBytes=89878
                        timerTicks=222/223  (event loop stayed responsive)
```

Unlike Finding 2 this does **not** stall the loop — `Bun.Image` runs off-thread — so it is
CPU/thread exhaustion rather than a freeze. A 5000×5000 source measures ~36 s.

**Impact.** One account with `create`/`edit` on any page converts 59 KB of upload into 22 s of
CPU. At `limit: 20` per 60 s that is roughly 7 CPU-minutes of work per wall minute from a
single account — total saturation of the 2–4 vCPU VPS this deploys to. Precondition: an
authenticated grant; nothing else. (Recorded as capacity input in
`reports/coolify-deployment.md` §5, which is where the VPS sizing question lives.)

**Fix.** Decode once and reuse the decoded image across attempts, or bound the iteration count
by measured cost rather than by step count. A cheap first move is to compute the descending
width/quality ladder against a single decode and accept the first result under target.

---

## 8. Medium — Elysia's 11-character path offset lets a prepended junk segment reach any route

**Location** `app.ts:203` (the `Elysia` constructor sets no `handler.standardHostname`);
`node_modules/elysia/dist/adapter/web-standard/index.js:133`;
`node_modules/elysia/dist/adapter/bun/compose.js:27`. Consumers of the divergence:
`lib/http/pre-auth.ts:29-37` (`preAuthScope`), `lib/http/request.ts:34` (`apiPath`).

**Evidence.** Installed Elysia 1.4.29 computes the route path by string arithmetic, not by URL
parsing:

```js
// web-standard/index.js:133
const standardHostname = app.config.handler?.standardHostname ?? !0;
fnLiteral += `const u=r.url,s=u.indexOf('/',${standardHostname ? 11 : 7}),...`;
```

`standardHostname` defaults to `true`, so the search for the path-start `/` begins at index 11.
`http://` is 7 characters, so for a host of ≤3 characters the real path-start slash sits below
index 11 and is skipped; Elysia then takes the _next_ slash and routes on a **suffix** of the
requested path. Driven over raw TCP sockets against a real `bun server.ts` listener (no client
library involved):

```
Host=x    (1)  GET  /zzz/api/dash/roles           -> 401 Unauthorized      (real dash handler ran)
Host=x    (1)  POST /zz/api/internal/sqlite-sweep -> 401 Unauthorized      (real sweep handler ran)
Host=x    (1)  GET  /qq/api/health/storage        -> 200 OK                (real body returned)
Host=abc  (3)  ... same three                     -> 401 / 401 / 200
Host=abcd (4)  ... same three                     -> 404 / 404 / 404
Host=abcde(5)  ... same three                     -> 404 / 404 / 404
baseline: Host=127.0.0.1  GET /nope/api/dash/roles -> 404                  (correct)
absolute-form target with a normal Host            -> 404                  (not a vector)
```

The limiter key then diverges from the executed route, because the adapter derives the scope
from `new URL(request.url).pathname` (the crafted path) while Elysia dispatched on the suffix.
Five crafted prefixes from one IP, read back out of the live `rate-limit.db`:

```
preauth.aaa.dash:ip:203.0.113.55 -> 1     preauth.ddd.dash:ip:203.0.113.55 -> 1
preauth.bbb.dash:ip:203.0.113.55 -> 1     preauth.eee.dash:ip:203.0.113.55 -> 1
preauth.ccc.dash:ip:203.0.113.55 -> 1     preauth.dash.roles:ip:203.0.113.55 -> 1  (the canonical request)
```

**Impact.**

1. **Total bypass of `enforcePreAuthIpLimit`** — the 120/60 s admission gate on all 22
   `preAuth: 'ip-limit'` routes. The attacker picks segment 1, so every request lands in a
   brand-new counter. That limiter exists precisely so "traffic without a valid session can't
   force repeated session lookups" (`lib/http/pre-auth.ts:6-8`), and `/api/dash/*` performs a
   Better Auth session lookup before answering 401 — so unauthenticated load on PostgreSQL
   becomes unbounded. It also feeds unbounded distinct keys into `rate_limit` (see Finding 27).
2. **Bypass of every path-prefix edge rule**, since they match the requested path and Elysia
   dispatched on a suffix of it. `POST /zz/api/internal/sqlite-sweep` reaches the sweep handler
   while matching no `/api/internal/` rule, so the maintenance token becomes the _only_
   boundary rather than the second of two — which is what makes Finding 9 matter more. The
   deployment consequence, and the firewall rule that keeps it unreachable meanwhile, are
   `reports/coolify-deployment.md` **gate 2**.
3. **Falsified request records.** `apiPath` (used by `getAuditMeta` → `audit_logs.api_path`)
   records the crafted path while the access log records Elysia's canonical path; neither shows
   what was actually requested.

**Scope, measured precisely.** Canonical requests are _unaffected_ at every Host length —
static routes and `:id` dynamic routes both matched correctly with `Host: x` — with one
exception: `GET /api/auth/get-session` returns **405** instead of 200 when the Host is ≤3
characters, because the Better Auth wildcard prefix is the one registration that falls through
to the composed handler. (That 405 rather than 404 is itself the tell that Elysia's router and
the route manifest disagreed on the path: `routeMiss` in `app.ts:192-201` returns 405 whenever
the manifest knows the path, without re-checking the method.)

**Reachability is conditional and I could not test the deployed ingress.** The attacker must
control the `Host` header that Bun sees, down to ≤3 characters — i.e. direct-origin
reachability, a permissive proxy router, or an in-cluster caller. Through Cloudflare → Traefik
with a Host rule the forwarded Host is the real domain and this is not reachable. Note the
awkward coupling: the mitigating control for that same precondition
(`reports/should-ignore.md` #63) is "block direct-origin traffic at the edge", which is the
assumption this finding undermines for path-based edge rules. The parser defect and every
consequence above are proven; only reachability is conditional.

**Fix.** Pass `handler: { standardHostname: false }` to the `Elysia` constructor — offset 7 is
correct for the `http://` URLs Bun produces behind a TLS-terminating proxy — or stop relying on
the offset. Either way add a regression assertion that `/junk/api/...` is a 404 at every Host
length.

---

## 9. Medium — unlimited unauthenticated guessing of `SQLITE_MAINTENANCE_TOKEN`, which has no length floor

**Location** `routes.ts:291-308` (both internal routes declare `preAuth: 'none'`),
`lib/sqlite/maintenance-token.ts:20-26`, `lib/env.server.ts:192-193`
(`SQLITE_MAINTENANCE_TOKEN = process.env.SQLITE_MAINTENANCE_TOKEN ?? ''`).

**Evidence.** The token is the only boundary, and nothing bounds attempts. Measured 401
rejection cost in-process, warmed:

```
POST /api/internal/sqlite-sweep (bad token)  0.036–0.046 ms/req  ≈25 000 rps/core
POST /api/internal/db-sweep     (bad token)  0.024–0.052 ms/req  ≈40 000 rps/core
```

No `rate_limit` row is created for these paths, because `preAuth: 'none'` skips
`enforcePreAuthIpLimit` entirely — confirmed by dumping the table after a run (only
`preauth.*` keys from `ip-limit` routes appear). The 401 path logs nothing, so repeated
failures leave no trace. `maintenanceTokenMatches` short-circuits on length
(`a.length === b.length && timingSafeEqual(a, b)`), so the token's exact length is recoverable
before any content guessing. `SQLITE_MAINTENANCE_TOKEN` is deliberately excluded from
`REQUIRED_IN_PRODUCTION` and has **no minimum-length or charset check anywhere**;
`/api/health/storage` only reports whether it is non-empty.

**Impact.** An unauthenticated caller who can reach the origin gets an unmetered oracle against
a single shared secret with no lockout, no backoff and no log. A valid token yields the
whole-deployment SQLite sweep, the PostgreSQL retention sweep (which deletes `sessions`,
`verification_sessions` and `verification_codes` rows and issues R2 object deletes), and the
deep storage probe (`PRAGMA quick_check` plus a write, both of which take the writer lock the
auth limiter depends on). If the operator picks a short value — nothing stops them — this is
directly brute-forcible. The fail-closed-on-unset behaviour is correct and verified.

**Fix.** Give both internal routes `preAuth: 'ip-limit'`, or a tighter dedicated `failClosed`
limiter — they run once an hour and once a day, so 5/min costs the scheduled task nothing. And
reject a configured token below a fixed length at load time in `lib/env.server.ts`, the way
`BETTER_AUTH_SECRET` already is. Until then the generated value is the entire control, which
is `reports/coolify-deployment.md` **gate 4**.

---

## 10. Medium — the read path authorizes a deactivated **and soft-deleted** user for the session's full life

**Location** `lib/permissions/checker.ts:191-216` (cache branch) versus `:132-140` (database
branch).

**Evidence.** The database branch treats an active, non-deleted user as a required
authorization predicate:

```ts
.where(and(
  eq(sessions.id, sessionId), eq(sessions.userId, userId),
  gt(sessions.expiresAt, sql`now()`),
  isNull(users.deletedAt),          // <-- required
  eq(users.isActive, true)          // <-- required
))
```

The read branch asks for none of it — it reads `roleId` off the session and goes straight to
the matrix. `auth.api.getSession` does not supply the missing predicate either: better-auth
joins `users` but knows nothing about `isActive` / `deletedAt`.

Measured in-process against the live database. Critically, the request carries **only** the
`better-auth.session_token` cookie and **not** `better-auth.session_data`, so the cookie cache
misses and `getSession` reads the database — the 5-minute window of
`reports/should-ignore.md` #5 is not involved:

```
[1] user active                        GET(token-only)=200  POST=422  GET(full cookies)=200
[2] is_active=false, session row kept  GET(token-only)=200  POST=401  GET(full cookies)=200
[3] + deleted_at set, row kept         GET(token-only)=200  POST=401  GET(full cookies)=200
[4] user restored, session row DELETED GET(token-only)=401  POST=401  GET(full cookies)=200
```

Row `[4]` is the known cookie-cache case and is out of scope; rows `[2]` and `[3]` are not.

**Impact.** A suspended or soft-deleted account whose session row outlives the status change
keeps full read access to every dashboard read endpoint — `GET /api/dash/users`,
`/api/dash/permissions`, `/api/dash/roles`, and `/api/dash/users/:id` including its session
IP/user-agent list — until `sessions.expiresAt`, which is **28 days** (`lib/auth.ts:268`), not
300 seconds. `should-ignore.md` #5 accepts this exposure on the stated basis that it lasts "up
to 5 minutes… until cache expiration"; that mitigation does not apply here, because no cache is
consulted. Writes are correctly refused, so the account cannot escalate — it retains read.

**Reachability today is limited and I am stating it as a hypothesis:** `handleAdminEdit`
(`app/api/dash/users/[id]/handler.ts:599-676`) and the user DELETE both revoke sessions in the
same transaction, so no shipped path leaves a live session behind a deactivation. What makes it
worth fixing at the boundary rather than per-caller is that the only thing holding it shut is
that two unrelated handlers remember to delete rows. The same omission is present in
`lib/http/session.ts:56-69` (`requireSession` → `assertLiveSession` checks the session row and
its expiry, not the user's status) and in `lib/permissions/checker.ts:284-291`
(`checkMultiplePermissions`' non-`forceDB` branch, unreachable today only because its single
caller passes write actions). `requireSession` is saved only because all five current callers
repeat the `isActive` / `deletedAt` / `roleId` check inside their own transaction; a sixth
caller that forgets inherits the hole silently.

---

## 11. Medium — hash-envelope and keyring errors escape sign-in as an empty 500

**Location** `lib/auth/password.ts:44-74` (`parsePasswordHash`) and `:97`
(`getPasswordPepper`); the missing conversion is at `lib/auth.ts:185-192`.

**Evidence.** `verifyPasswordDetailed` is the single credential-verification entry point, and
three of its outcomes are throws rather than a `{ valid: false }` result:

```ts
const parsed = parsePasswordHash(hash); // throws PasswordHashFormatError
if (!parsed) return { valid: false, needsRehash: false, costPaid: false };
const pepper = getPasswordPepper(parsed.pepperId); // throws KeyringConfigurationError
```

It is called from inside the transaction at `lib/auth/login-guard.ts:207`, and **nothing
converts either error type** — verified by grep: `PasswordHashFormatError` and
`KeyringConfigurationError` appear only at their definitions and throw sites.
`lib/auth.ts:185-192` catches `LoginRejected` and re-throws everything else.
`lib/auth/api-error.ts` exists in the same directory to do exactly this conversion and is not
applied here; its own doc states the consequence: "any other throw escapes its boundary as a
generic, empty 500."

Measured against the live database, mutating `accounts.password` and resetting
`failed_login_attempts` to 0 before each arm:

```
A. UNKNOWN EMAIL                  401  ct=application/json  bodyLen=52  counter=0
B. p1:<unknown pepper id>:<phc>   500  ct=null              bodyLen=0   counter=0   KeyringConfigurationError
C. p2:1:<phc>                     500  ct=null              bodyLen=0   counter=0   PasswordHashFormatError
D. raw $argon2id$… (no envelope)  401  ct=application/json  bodyLen=52  counter=1
E. p1:<id>:<phc>:extra            500  ct=null              bodyLen=0   counter=0   PasswordHashFormatError
```

**Impact.** Three consequences, only the first of which is documented
(`lib/auth/password-pepper.ts:10-15` states retirement "surfaces as a 500, not a failed
login"):

1. **The failed-attempt counter and the lockout audit roll back.** The throw is inside
   `withTransaction`, so for every affected account `failed_login_attempts` stays pinned at 0
   (arms B/C/E versus arm D). Brute force gains nothing while the state persists — no attempt
   can succeed — but the lockout machinery is silently inert for those accounts and the
   operator sees no `accountLocked` rows to diagnose from.
2. **Account-existence oracle.** 401 + JSON for an unknown email versus 500 + empty body for an
   existing email whose stored hash references a retired pepper generation. Sharpest
   mid-rotation, when only _some_ accounts still carry the old generation: an unauthenticated
   caller then learns both which addresses exist and which have not signed in since the
   rotation.
3. The response bypasses the API's own error envelope entirely — zero-length body, no
   `content-type`.

Precondition: `accounts.password` holding an envelope the current keyring cannot resolve. Every
application writer goes through `hashPassword`, so the trigger is an operator or deploy event —
retiring a generation too early, or reverting `PASSWORD_PEPPER_KEYRING` to a version lacking
the newest generation. One env-var revert turns every recently-rotated password into an empty 500. That is the same missing rotation invariant as Finding 27, from the other direction. The
rollback procedure both findings imply — roll the keyring and the active id together, never one
alone — is now `reports/coolify-deployment.md` §3.2.

**Note for whoever reproduces this:** restore `accounts.password` in a `finally`. A probe that
dies before its restore line leaves the account unauthenticatable.

---

## 12. Medium — external references survive SVG sanitisation, on objects stored `image/svg+xml` + `inline`

**Location** `utils/images/config.ts:51` (`/@import\s+url\s*\(/gi`) and `:96-106`
(`isDangerousValue`); `lib/r2/upload-helper.ts:317-320` (`inline: true`).

**Evidence.** The blocklist explicitly targets external CSS, but only the _functional_ form.
Real output from the pipeline (`sanitizeSvgServer` → `svgOptimizerServer`):

```
@import "string"    externalRefSurvives=YES  <style>@import &quot;https://evil.example/x.css&quot;;</style>
@import url(...)    externalRefSurvives=no   (the functional form IS blocked)
@font-face src:url  externalRefSurvives=YES  <style>@font-face{font-family:x;src:url(https://evil.example/f.woff)}</style>
style attr url()    externalRefSurvives=YES  <path style="fill:url(https://evil.example/t.svg#g)"/>
<image href=http>   externalRefSurvives=YES  <image width="8" height="8" href="https://evil.example/pixel.svg"/>
```

The `&quot;` is XML-escaped in the serialized text node and decodes back to `"` when the stored
object is parsed as `image/svg+xml`, so the `@import` is live. DOMPurify does not help: `style`
is in `DEFAULT_URI_SAFE_ATTRIBUTES` (`node_modules/dompurify/dist/purify.cjs.js:740` —
`_isValidAttribute` returns true for it with no URI check) and `image` is in
`DEFAULT_DATA_URI_TAGS`. `getContentDisposition({ …, inline: true })` plus
`ContentType: image/svg+xml` is what makes the stored object render as a _document_ rather than
an image, which is the condition under which `@import` / `@font-face` actually fetch.

**Impact.** Any uploader can store an image that beacons every future viewer's IP, User-Agent
and Referer to a third-party host, and whose appearance can be changed remotely _after_ review
— the referenced CSS, font or `<image>` is fetched at view time, not upload time. The broken
invariant is the one `DANGEROUS_CSS_PATTERNS` states by existing: external CSS is meant to be
refused, and the string form of the same directive is the trivial bypass. **No script
execution:** `<script>`, `on*`, `<foreignObject>`, `<animate>`, `<set>`,
`xlink:href="javascript:"` and comment-splicing were all confirmed stripped across 26 payloads.

---

## 13. Medium — two parsers disagree, so `isValid: true` is returned for content outside the SVG root

**Location** `utils/images/svg-optimizer.ts:88` (XML parse) versus `:230-240` (serialize →
DOMPurify HTML parse → `includes('<svg')` gate); `utils/images/server.ts:9-16` (svgo throws a
raw error); `lib/r2/upload-helper.ts:366-370` (raw error → 500).

**Evidence.** The app's element/attribute sweep runs on an **XML** tree where `<p>` is a child
of `<svg>`. DOMPurify then re-parses the serialized string as **HTML**, where the HTML
breakout tag list (`p`, `div`, `table`, `h1`, `pre`, …) terminates foreign content — so those
nodes end up _after_ `</svg>`. The validity gate is only `sanitized.includes('<svg')`, which
cannot see that:

```
in=55B  isValid=true  cleaned="<svg xmlns=\"...\"></svg>hi"
        svgo THREW SvgoParserError: <input>:1:47: Text data outside of root node.   -> HTTP 500

in=84B  isValid=true  cleaned="<svg xmlns=\"...\"></svg><style>a{fill: red}</style>"
        svgo THREW SvgoParserError                                                   -> HTTP 500

in=162B isValid=true  cleaned="<svg .../><svg><image href=\"https://evil.example/x.svg\" .../></svg>"
        svgo -> STORED a TWO-ROOT document
```

**Impact.** Two outcomes from a well-formed request. (a) `SvgoParserError` escapes
`svgOptimizerServer` — it only guards `!optimized.data` — is not a `CustomError`, and becomes
`500 uploadMsg.uploadFailed`: a **55-byte deterministic 500 generator**, indistinguishable in
logs from a real fault. (b) When the escaped content is itself an element, svgo emits it and a
two-root, non-well-formed document is stored and returned as a successful `image/svg+xml` — a
browser XML parser rejects it, so the record's image silently never renders. The broken
invariant is `sanitizeSvg`'s own contract: `cleanedSvg` is documented as a sanitized SVG and
consumed as one (`utils/validation/rules.ts:246` returns it verbatim with no svgo pass behind
it). No script survives — DOMPurify walks the relocated nodes too — so this is corruption and a
500, not XSS.

---

## 14. Medium — `<use>` is stripped, so every sprite SVG is stored blank with HTTP 200

**Location** `utils/images/svg-optimizer.ts:231-233`; the allowlist is
`node_modules/dompurify/dist/purify.cjs.js:302` (`svg$1` — contains `symbol`, `defs`, `mask`,
`clippath`, `pattern`, `marker`, but **no** `use`).

**Evidence.** `use` appears nowhere in `DANGEROUS_ELEMENTS` (`utils/images/config.ts:35-44`), so
its removal is unintended. Real pipeline output:

```
symbol+use (219B in)          errors=[]  out=<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>
gradient+clipPath (control)   errors=[]  out=<svg ...><defs><linearGradient id="a">...  (intact)
```

DOMPurify strips the `<use>` elements, then svgo's `removeUselessDefs` / `cleanupIds`
garbage-collects the now-unreferenced `<symbol>`. Content inside `<defs>` is never rendered, so
the output is a blank image.

**Impact.** `<use href="#…">` is how essentially every icon set and every Figma or Illustrator
export with repeated geometry is written. The endpoint returns 200, a key, and a `files` row
claiming `mime_type = image/svg+xml`; the object renders as nothing. Silent data loss with a
success response — the sanitiser's `errors` array is **empty** for this case, so not even the
log records it.

---

## 15. Medium — every malformed or over-pixel raster upload answers 500, including the decompression-bomb guard

**Location** `lib/r2/optimize-image.ts:121-123`, `lib/r2/upload-helper.ts:366-370`.

**Evidence.** `Bun.Image` throws a plain `Error`; `uploadImagesToR2`'s catch only re-throws
`CustomError`, so everything else becomes `INTERNAL_ERROR` and `handleApiError` returns 500.
Replaying the handler's exact gate order on real bytes:

```
png 6000x6000 (36 MP, 488 KB)  THREW Error  isCustomError=false  "Image: input exceeds maxPixels limit"
png valid 64x64                OK  iterations=1
png truncated 60%              THREW Error  isCustomError=false  "Image: decode failed"
png header only                THREW Error  isCustomError=false  "Image: decode failed"
```

All the failing cases pass `isAllowedImageType` and `validateMagicBytes` and sit under the
1 MiB per-file cap.

**Impact.** The pixel-bomb rejection — a security control — is reported to the client as a
server fault with no actionable message, and to monitoring as an internal error, so probing it
is indistinguishable from a genuine 5xx. A legitimately truncated upload (interrupted transfer)
gets the same. `should-ignore.md` #48 accepts 500 only for _unexpected FK violations_, i.e. code
bugs; these are client-correctable input.

---

## 16. Medium — a NUL byte in any filter value or in `?search=` is a deterministic 500

**Location** `lib/data-table/filter-columns.ts:80-82` (`escapeLike`), `:150` / `:182`;
`db/queries/data-table.ts:97-110`; `lib/data-table/parsers.ts:39-49` (`safeString`).

**Evidence.** `escapeLike` escapes only LIKE metacharacters, and `safeString` trims and
length-checks but never rejects control characters. `U+0000` survives `URLSearchParams`,
survives `.trim()`, and counts toward `MIN_SEARCH_LENGTH`. Executed against the live database
through `parseDataTableParams` plus the exact query `app/api/dash/users/handler.ts:90-111`
builds:

```
?search=ab%00cd            -> THREW Error  isCustomError=false  errno=22021  invalid byte sequence for encoding "UTF8": 0x00
?search=abcd (control)     -> EXECUTED ok
filter iLike value with NUL-> THREW Error  isCustomError=false  errno=22021
filter eq    value with NUL-> THREW Error  isCustomError=false  errno=22021
```

`utils/index.ts:480,485` map only `23505` and `23503`, so `22021` is not a `CustomError` and
becomes a 500.

**Impact.** Any caller holding `users:view` or `permissions:view` turns the request into a 500
plus a full-error log line (`DrizzleQueryError.message` embeds the SQL and the parameters). No
data disclosure and no query amplification — PostgreSQL rejects at parameter bind. It is a
contract violation and an alert-noise generator, and it is precisely the class the module says
it eliminates: `lib/data-table/filter-columns.ts:94-98` — "Runs before any SQL is built so an
impossible combination becomes a 422, never a PostgreSQL cast error surfacing as a 500."

---

## 17. Medium — `PUT /api/dash/permissions/:id` silently ignores an omitted `description` and writes a contradictory audit row

**Location** `app/api/dash/permissions/[id]/handler.ts:218-226` (the `SET`) and `:301-334` (the
audit payload); schema at `utils/validation/permissions.ts:159-169`, `:201`;
`lib/audit.ts:268-284` (`computeChangedFields`).

**Evidence.** `description` is optional, so it survives `.strict()` when absent:

```
adminUpdatePermissionSchema.safeParse({ id, roleName: 'Editors', isActive: true })
  success: true    'description' in data: false    value: undefined
```

drizzle's `mapUpdateSet` (`node_modules/drizzle-orm/utils.js:84`) drops `undefined`, so the
column is never written:

```
SQL   : update "roles" set "role_name" = $1, "is_active" = $2, "updated_at" = now() where ...
params: ["Editors", true, "<id>"]
```

`computeChangedFields` iterates `Object.entries(newData)`, and an `undefined`-valued key is
still an entry, while `JSON.stringify` drops it from the stored payload:

```
Object.entries({ description: undefined })       -> [["description", undefined]]
JSON.stringify({ a: 1, description: undefined }) -> {"a":1}
```

So `changed_fields` contains `description` while the stored `new_data` has no `description` key
at all.

**Impact.** Two defects against invariants this repo states explicitly. The endpoint answers
200 for a field it never wrote — `utils/validation/permissions.ts:186-190` says PUT is strict
precisely because "a misspelled `descriptionn` was dropped and answered with 200, so the client
believed a change had been applied that was never written", and omitting the key reproduces
that outcome through a different door. And the audit row is internally contradictory:
`changed_fields` names `description`, `new_data` has none, `old_data` holds the real prior
value — a reader concludes the description was cleared when the column is untouched. Actor: any
holder of `permissions.edit` (or `editOwn` on a role they created). No race.

---

## 18. Medium — wrong-typed `password` / `description` values are coerced to "no change" and answered 200

**Location** `utils/validation/auth.ts:157-164` (password); `utils/validation/rules.ts:15-23`
with `utils/validation/permissions.ts:159-169` (description); consumed at
`app/api/dash/users/[id]/handler.ts:331-333` and `app/api/dash/permissions/[id]/handler.ts:222`.

**Evidence.**

```ts
password: z
  .preprocess(
    (e) => (typeof e === 'string' && e.trim().length > 0 ? e : null),  // any non-string → null
    passwordSchema.optional().nullish()
  ).optional().nullish(),
```

Measured against the real schemas:

```
adminUpdateUserSchema.password        createPermissionSchema.description
  12345678      ACCEPTED -> null       123      ACCEPTED -> ""   (overwrites the stored value)
  true          ACCEPTED -> null       {"a":1}  ACCEPTED -> ""
  {"a":1}       ACCEPTED -> null       true     ACCEPTED -> ""
  ["Passw0rd!"] ACCEPTED -> null
  "short"       REJECTED
```

**Impact.** `PUT /api/dash/users/:id` with `{"password": 12345678}` — a JSON number, the single
most likely client mistake for a numeric password — parses to `null`, so `hashedPassword` is
`null` (`handler.ts:333`), the `accounts` UPDATE at `:611` never runs,
`failedLoginAttempts` / `lockedUntil` are not cleared, no sessions are revoked, and the handler
answers `200 {"success":true,"message":"تم التحديث بنجاح"}`. An operator resetting the
credential of a compromised or locked-out account is told it worked while the old password
still authenticates. For `description`, `''` is genuinely written, destroying the stored value,
also with a 200.

The invariant this breaks is stated at `utils/validation/auth.ts:180` and
`app/api/dash/users/[id]/handler.ts:313`: unknown keys are rejected "so a misspelled `passwrod`
can't be read as 'field not supplied' and return a misleading 200". `.strict()` closes the
misspelled-_key_ case; the wrong-_type_ case walks through the same door.

Sites in the class that are **safe**, checked: `emailSchema`, `name`/`roleName` via
`sanitizeStrictSingleLine`, `phoneSchema`, `optionalPhoneSchema`, `getIDSchema`,
`getColorSchema`. `slugSchema` (`rules.ts:213-238`) has the same defect but is unreferenced — a
trap rather than a live bug.

**Fix.** Let the preprocess pass non-strings through to the inner schema so a type error stays a
type error, or express the field as `z.union([z.null(), passwordSchema])`.

---

## 19. Medium — six unauthenticated requests deny a victim's password recovery for six hours

**Location** `utils/otp.ts:920-939` (verify-failure block) consumed by `utils/otp.ts:437-447`
(send gate); swallowed at `app/api/auth/forgot-password/send/handler.ts:98-111`.

**Evidence.** `processOtpVerify` stamps a full `OTP_BLOCK_DURATION_HOURS` block on the proof row
when the per-cycle guess cap is spent, and `processOtpSend` refuses to issue a _new_ code while
that flag is set. Real routes end to end:

```
1) attacker POST /api/auth/forgot-password/send            -> 200   row: is_blocked=false, codes:1
2) attacker POST /forgot-password/reset x5, wrong code      -> 400,400,400,400,429
                                                              row: vn:5, is_blocked=true, blocked_until=+6h, codes:1
3) VICTIM   POST /api/auth/forgot-password/send            -> 200 {"message":"تم إرسال رمز التحقق بنجاح","nextAllowedIn":30}
   internal (swallowed): CustomError 429 "تم حظر البريد الإلكتروني مؤقتاً. يرجى المحاولة بعد 6 ساعة"
   stored code changed? false          <-- no new code was ever generated or sent
4) VICTIM   POST /forgot-password/reset with the ONLY delivered code -> 429, retry-after: null
```

**Impact.** An unauthenticated actor who knows a victim's email or phone spends six HTTP
requests and removes OTP password recovery for six hours, repeatable indefinitely. The victim is
told "code sent successfully" with a `nextAllowedIn: 30` countdown while no code exists, so the
failure is undiagnosable from the client. The 429 also carries no `Retry-After` because
`processOtpVerify`'s `CustomError` sets no `responseHeaders`, while a limiter 429 on the same
route does — so clients cannot back off correctly or distinguish the two.

This is **not** `should-ignore.md` #58, which is about masking 429 as 200. This is about a
verify-failure penalty gating the _send_ path at all. The six-hour send block is also redundant
as an anti-guessing control: the bound that actually resists guessing is `verifyAttemptDaily`,
which `processOtpSend`'s upsert deliberately preserves across resends
(`utils/otp.ts:530-539`, and the comment at `:500-502` says exactly this). Letting a resend
clear the verify-side block would not widen the guessing budget by a single attempt — it would
only remove the denial.

_Evidence provenance:_ the end-to-end sequence above was measured by the OTP shard against the
live scratch database; I verified the two code paths (`:437-447` gate, `:920-939` stamp) and the
swallowing catch, but did not re-run the six-request sequence myself.

---

## 20. Medium — delivery latency defeats `ensureMinDelay`, making the send endpoints an account-existence oracle

**Location** `app/api/auth/otp/messages.ts:6-11`; consumed at
`app/api/auth/otp/send/handler.ts:171`, `app/api/auth/forgot-password/send/handler.ts:108`,
`app/api/auth/passwordless/send/handler.ts:108`; the delivery it fails to cover is
`utils/otp.ts:610`.

**Evidence.** `ensureMinDelay` is a floor with no cap, and the provider call sits on the
response path:

```ts
export async function ensureMinDelay(elapsed: number): Promise<void> {
  if (elapsed < MINIMUM_RESPONSE_MS)
    await new Promise((r) => setTimeout(r, MINIMUM_RESPONSE_MS - elapsed));
}
```

The invariant is stated in the code itself, at `app/api/auth/otp/send/handler.ts:160`:
"Delivery / internal failures must NOT distinguish real accounts from fake ones during a
provider outage — that's a binary oracle for account existence."

With the SMS provider stubbed to a 3 000 ms response (a provider slowdown, nothing else
changed), `POST /api/auth/forgot-password/send`, four unregistered numbers then four
registered — **identical 200 body every time**:

```
NO-ACCOUNT  1588 / 1502 / 1503 / 1502 ms   200 "تم إرسال رمز التحقق بنجاح"
REAL        3099 / 3102 / 3106 / 3079 ms   200 "تم إرسال رمز التحقق بنجاح"
```

**Impact.** The signal is one-sided and sound: any response above the 1 500 ms floor proves the
real branch ran, i.e. the address belongs to an active account. False negatives only, so an
attacker simply retries. `forgot-password/send` and `passwordless/send` run the real branch for
**any** active user, making them pure existence oracles; `otp/send` runs it only for an
_unverified_ contact, so it additionally leaks `email_verified` / `phone_number_verified` state
for a known address. This defeats the whole generic-response design — `GENERIC_SEND_DATA`, the
collapsed catch blocks, the swallowed delivery errors — and it defeats it hardest in the
provider-outage case the comment names, because that is when the latency gap is widest. Raising
`MINIMUM_RESPONSE_MS` cannot fix it: the floor would have to exceed an unbounded third-party
call. The `TODO` at `messages.ts:5` treats this as tuning; it is structural.

**Fix.** Move delivery off the response path — enqueue it and return immediately — so the
response time no longer depends on the provider. That also removes the outage-amplification the
codebase already worried about when it moved `sendOtp` out of the transaction.

_Evidence provenance:_ measured by the OTP shard with a stubbed provider; I verified
`ensureMinDelay`'s implementation and that delivery (`utils/otp.ts:610`) precedes it on the
response path, but did not re-run the timing sweep.

---

## 21. Medium — any second writer on `rate-limit.db` stalls the process for 2.3 s, then trips every fail-closed limiter to 503

**Location** `lib/sqlite/database.ts:76` (`BUSY_TIMEOUT_MS = 2000`),
`lib/rate-limit/index.ts:95-104` (every store error becomes `degraded`),
`lib/rate-limit/api.ts:266-273` (`degraded && failClosed` → 503), `app.ts:209-216`
(`reusePort: false` and its rationale).

**Evidence.** One external process held `BEGIN IMMEDIATE` on `rate-limit.db` for 4 s; a
concurrent `rateLimit()` in the app process blocked for **2 282 ms** and then returned
`degraded: true`. `bun:sqlite` is synchronous, so that blocks the whole event loop — not one
request. `enforceRateLimit` then converts `degraded` into `503 + Retry-After: 30`, confirmed
end to end by pointing the app at a non-SQLite `rate-limit.db`:

```
ip-limit route (dash/roles) -> 503 retry-after=30
otp send (own limiter)      -> 503 retry-after=30
health/storage              -> 503 {"status":"error"}
better-auth get-session     -> 500  (auth-storage rethrows, as designed)
```

On the single-writer assumption: `reusePort: false` does work for a same-host double start (a
second `bun server.ts` exits 1 with "Is port in use?"). It gives no protection against a second
_container_ sharing the volume, against `bun test` or `scripts/*` (which open the same files;
`SQLITE_DIR` defaults to `./data` outside production), or against an operator running `sqlite3`,
`PRAGMA wal_checkpoint(TRUNCATE)` or a file-level backup — all of which
`reports/coolify-deployment.md` contemplates.

Separately, the rationale at `app.ts:213-215` — "Each process opens its own SQLite files, so the
rate-limit counters silently halve during an accidental double-start" — does not describe the
accidental-double-start case. With a shared `SQLITE_DIR` the counters are **shared and exact**:
measured across 4 processes, one key, limit 200, 250 attempts each — `admitted 200 / denied 800
/ degraded 0`, stored `count: 200`. The halving claim holds only for replicas with _separate_
volumes.

**Impact.** With the PostgreSQL-side abuse controls currently inert (Finding 1), these SQLite
limiters are the only surviving layer for sign-in, OTP send and OTP verify — and the failure mode
is bimodal: for ~2.3 s per contended statement the process serves nothing at all, and then every
`failClosed` path (sign-in, all five OTP surfaces, all 22 pre-auth routes) answers 503. A backup,
a manual checkpoint, or a second replica on the shared volume turns a maintenance action into a
full authentication outage. Actor: any operator action or deployment topology that adds a
writer; no attacker needed.

**Fix.** The 2 s ceiling is the right trade for one process, so the gap is the _assumption_, not
the number. Assert single-writer ownership at startup — an exclusive lock file, or an advisory
`PRAGMA locking_mode` probe under `SQLITE_DIR` — so a second writer fails loudly the way a
second port bind does. The operational half — that a manual checkpoint, a file-level backup or
a second container on the volume is a full authentication outage, and that scaling replicas is
a decision rather than a replica count — is now `reports/coolify-deployment.md` §4.

_Evidence provenance:_ measured by the rate-limit shard; I verified the `degraded` → 503 path and
`BUSY_TIMEOUT_MS` statically but did not re-run the lock-contention timing.

---

## 22. Medium — `find-unused-files.ts` permanently exempts the live SVG sanitiser from the reachability gate

**Location** `scripts/find-unused-files.ts:79-87`.

**Evidence.** The allowlist names the file it exempts as a "second, DIVERGENT copy", and says
the live one is elsewhere:

```ts
 * `utils/images/server.ts` — a second, DIVERGENT copy of the server-side SVG
 * sanitiser/optimiser. The live one is `utils/svg/server.ts`
 * (`lib/r2/upload-helper.ts` imports it); …
const KNOWN_UNREACHABLE = new Set(['utils/images/server.ts']);
```

Both halves are now false:

```
$ ls utils/svg
ls: cannot access 'utils/svg': No such file or directory

$ grep -rn "sanitizeSvgServer" lib/
lib/r2/upload-helper.ts:14:import { sanitizeSvgServer, svgOptimizerServer } from '@/utils/images/server';
```

`git status` confirms the direction of the move (`D utils/svg/config.ts`). The gate itself is
real and currently green (`bun scripts/find-unused-files.ts` → "No unreachable files").

**Impact.** `utils/images/server.ts` — which holds `sanitizeSvgServer`, the boundary between an
uploaded SVG and a public R2 bucket fronted by a CDN — is exempt from the one CI check
(`ci.yml:49`) that would notice it becoming dead code. If a future refactor drops the
`upload-helper.ts:14` import, exactly the kind of edit that just happened to `utils/svg/`, CI
still prints "Every file is reachable from an entry point" and the sanitiser is silently
unwired. The allowlist is documented as "a NAMED list with a reason each … an entry here is a
decision someone has to defend"; the reason recorded is wrong in both halves. Removing the entry
has no effect on today's output, which is the test that it is stale.

---

## 23. Medium — the destructive-write guard's enforcement half has three regex bypasses

**Location** `tests/unit/harness-layout.test.ts:120-133`.

**Evidence.** The detector:

```ts
const IMPORTS_DB = /from\s+'@\/db'/;
const REACHES_GUARD =
  /(resetTables|seedUser|signedInUser|assertHarnessDatabase)\s*\(/;
```

`readFile` (`:34-37`) does **not** strip comments — unlike `scripts/find-unused-files.ts:184`,
which calls `stripComments()` for precisely this reason. Both regexes run against synthetic
sources:

```
A: honest guarded file                    importsDb=true  reachesGuard=true  -> passes (correct)
B: import { db } from '@/db/index'        importsDb=false                    -> PASSES THE GATE
C: double quotes                          importsDb=false                    -> passes (unreachable; prettier enforces single quotes)
D: const { db } = await import('@/db')    importsDb=false                    -> PASSES THE GATE
E: guard named only in a comment          importsDb=true  reachesGuard=true  -> PASSES THE GATE
```

B, D and E are real bypasses. D matters most: dynamic `await import('@/…')` is already idiomatic
in this suite (`tests/integration/harness.test.ts:268`, `:294`, `:314`).

**Impact.** `tests/helpers/database.ts:41-56` calls `assertHarnessDatabase()` "the load-bearing
safety guard", and this test is "the enforcement half". A test file can hold the raw Drizzle
client and write with a bare `db.execute(...)` without the layout gate ever requiring it to
reach the guard. The failure sequence: author `tests/integration/foo.test.ts` with
`const { db } = await import('@/db')` and a truncating statement; `bun run test` passes; then run
that file the way the docs say must be safe — a bare `bun test tests/integration/foo.test.ts`
with no tier runner. `bunfig.toml:23` loads only `preload-base.ts`, which deliberately does not
rewrite `DATABASE_URL`, and `bun test` auto-loads `.env` — the repo's own measured claim at
`tests/helpers/preload-database.ts:44-58`. The write lands on the developer's real database.

_Not executed end to end:_ doing so requires pointing a truncating statement at a live
database. The regex behaviour is measured; the consequence is derived from the repo's own
documented `.env` auto-load.

---

## 24. Medium — `actions/checkout` leaves `GITHUB_TOKEN` in `.git/config` in six jobs

**Location** `.github/workflows/ci.yml:19, 138, 174, 182`; `.github/workflows/security.yml:23, 42`.

**Evidence.** `grep -rn "persist-credentials" .github/` returns **nothing**, against 6
`actions/checkout` uses. `actions/checkout` defaults `persist-credentials` to `true`, writing an
`http.extraheader` with the job's `GITHUB_TOKEN` into `.git/config`. The next step in three of
these jobs is `jdx/mise-action`, which resolves `semgrep` through the pipx backend per
`mise.toml:19-23`.

**Impact.** Any code that runs in those jobs can read `.git/config` and exfiltrate a token with
`contents: read` on this repository. `bun install --frozen-lockfile` is a narrow vector (Bun
blocks lifecycle scripts except the three in `trustedDependencies`), but semgrep and its
transitive PyPI dependency tree are not pinned by hash and execute arbitrary Python at install
time. For a private starter kit this is read access to the whole source tree; the token is
short-lived but valid for the job's duration.

**Fix.** Add `persist-credentials: false` to every checkout that does not push.

Everything else on the supply-chain checklist is clean and was verified mechanically: all four
distinct actions pinned by 40-hex SHA; no `pull_request_target`; `permissions: contents: read`
at workflow scope with no job-level widening; zero `secrets.*` references; zero `${{ … }}`
interpolations inside any `run:` block (`security.yml:29-31` correctly routes
`github.event.pull_request.base.sha` through `env:`); no `continue-on-error`, `|| true`,
`set +e` or bare `exit 0` anywhere in `.github/**` or `lefthook.yml`.

---

## Low findings

**25. `toCalendarDate` coerces numerics as epoch milliseconds, so a malformed date filter
answers for 1970.** `utils/time.ts:210-220`, consumed at `lib/data-table/filter-columns.ts:86-91`.
`Number(raw)` is applied to arbitrary client JSON: `"2026" → "1970-01-01"`,
`1700000000 → "1970-01-20"`, `"0x10" → "1970-01-01"`, `[1700000000000] → "2023-11-15"`,
`"  2026-08-02  " → null`. `dayBounds` raises a 422 only on `null`, so every other value
resolves and the query runs for 1970 — confirmed in generated SQL:
`created_at >= '1969-12-31T21:00Z' and < '1970-01-01T21:00Z'`, HTTP 200, empty table, no
signal. A bare year is the realistic trigger. That is the outcome the strict-filter contract
exists to prevent — the same file says so at line 92. DST and month-end arithmetic in the same
module were checked separately and are **correct** across spring-forward, fall-back, a
30-minute transition, a skipped midnight, a skipped calendar day and the five-digit year
rollover.

**26. Log redaction misses `\p{Cf}`, and one throwing getter discards a whole log line.**
`utils/index.ts:117-123`, `:317`, `:386-387`. `LOG_CONTROL_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu`
neutralises CRLF and U+2028 correctly, but bidi overrides (U+202E/U+202C) and zero-width
characters survive — so the docstring's "a log line can't be forged" claim does not hold for
that class. Separately, `seen` is added to but never removed from, so a diamond reference
(`{ before: state, after: state }`) reports the second arm as `[circular]`; and a single `try`
around the whole payload means one awkward accessor replaces the entire diagnostic with
`[unserializable log payload]` — at exactly the moment diagnostics matter, since
`utils/api-response.ts:146` is the only record of an unexpected 500. Redaction _coverage_ held
up under every hostile shape tried (nested objects, arrays, `Map`/`Set`, `Error.cause` chains,
getters, symbol keys, `__proto__` from `JSON.parse`, `AggregateError`, better-auth `APIError`
bodies) — this is about the two edges only. Reachability of the `\p{Cf}` case is a hypothesis,
reported as an implementation-versus-docstring gap; note that the access log at
`lib/http/after-response.ts:139-147` writes a client-controlled `summary.path` through bare
`JSON.stringify`, which escapes below 0x20 but not `\p{Cf}`.

**27. The keyring accepts an active key that is not the newest generation.**
`lib/auth/keyring.ts:152-201`, consumed at `lib/auth/password.ts:106`. `parseConfiguration`
validates that generations are unique and that the active id exists, but never that the active
key holds the _highest_ generation — while `generation`'s single consumer reads it as
staleness: `needsRehash: pepper.generation < activePepper.generation`. With keys
`{"1":{generation:1},"2":{generation:2}}` and the active id set to `1`, the keyring is accepted
and `needsRehash` for a generation-2 hash evaluates to `false` forever. Actor: whoever sets
deployment environment variables, including an automated rollback. After an emergency rotation
away from a leaked generation, reverting `PASSWORD_PEPPER_ACTIVE_ID` alone — the common
half-rollback — is accepted silently: boot succeeds, logins keep working, and every password
subsequently set is re-peppered with the _older_ key, with the automatic upgrade at
`lib/auth/login-guard.ts:318-331` never migrating anything back. No error, no log, no startup
failure. A single "`activeId` must own `max(generation)`" check closes it; the deployment-side
rule meanwhile is `reports/coolify-deployment.md` §3.2. Every other rule in
the file does reject correctly (non-canonical base64url, padded base64, 31-byte secrets,
duplicate generations, absent active id, >8 keys, extra fields, non-integer generations).

**28. `MISSING_RESPONSE` is unmapped, so the sign-in endpoint's most common client error
answers in English with no `content-type`.** `lib/auth/code-errors.ts:6-66`. Measured:
`POST /api/auth/sign-in/email` with no `x-captcha-response` returns
`400 {"message":"Missing CAPTCHA response","code":"MISSING_RESPONSE"}` with no `content-type`,
and falls through to `console.error(sanitizeForLog(...))` at `lib/auth.ts:232-238` — so ordinary
client misuse is logged at error level. Any client that reaches sign-in without a Turnstile
token (a stale page, a blocked `challenges.cloudflare.com`, a native client) gets an
untranslated string with a raw framework code, in an application where every other response on
this prefix is `{"message":…,"code":"__"}`. For contrast the three origin-rejection codes the
table _does_ carry answer correctly.

**29. `enforceOtpVerifyQuota` is skipped by both contact-change verify endpoints.**
`app/api/dash/users/me/change-email/verify/handler.ts:36-41` and
`.../change-phone/verify/handler.ts:42-47`; the contract is at `lib/rate-limit/api.ts:208-223`
— "shared across every purpose so rotating the purpose can't multiply the per-identifier
attempt budget." Verified by grep: 3 call sites (`otp/verify`, `forgot-password/reset`,
`passwordless/verify`) against 5 verify entry points. The two `/me/**/verify` handlers call only
a per-_user_ limiter on their own scope key and never touch the shared
`otp.verify.dest.<kind>:<identifier>` budget, so guesses against `change_email` /
`change_phone` are invisible to it, and conversely a destination whose 10/600 s budget is
exhausted can still be guessed at 10/60 s through these two routes. Defense-in-depth only —
the transactional caps (`OTP_MAX_VERIFY_ATTEMPTS = 5` per cycle, `verifyAttemptDaily = 15`)
still bound guessing — so this is a contract violation rather than a bypass.

**30. The SQLite sweep's per-run ceiling is below the reachable insertion rate.**
`lib/sqlite/sweep.ts:30-37` (`BATCH_SIZE = 500`, `MAX_BATCHES = 200`),
`lib/sqlite/maintenance.ts:40-71`. 400 000 expired rows swept in one run removed exactly
100 000 and returned `hasMore: true`; four runs were needed. At 263 bytes/row and an hourly
schedule, sustained creation of more than ~28 new expired keys per second outruns it
permanently. `hasMore: true` is returned with HTTP 200 by design, so a bare `curl -fsS` cannot
see it — the runbook's scheduled-task command already inverts a `grep` on it for that reason,
and the ceiling, the escalation and the full-volume end state are now recorded there
(`reports/coolify-deployment.md` §9). Mitigated by disk alerting and by the fact that the cheap
high-cardinality vectors are captcha-gated. Finding 8 removes that mitigation for the
`preauth.*` keyspace.

**31. The disposable cache database is coupled into the maintenance sweep with no error
containment.** `lib/cache/index.ts:246-253`, `lib/sqlite/maintenance.ts:43-69`.
`cacheGet`/`cacheSet`/`cacheDelete` each swallow store failures ("A cache that throws is worse
than a cache that misses"), but `cacheSweepExpired` and `cacheHasExpiredRows` call `getStore()`
directly, which throws. `runMaintenanceSweep` awaits the limiter sweep first, so a corrupt
`cache.db` makes the endpoint report failure _after_ the limiter deletions have committed. The
module header at `lib/cache/index.ts:11-13` states the opposite property — "Corrupt or oversized
cache? Delete the file and restart" — and separate files were chosen for exactly that. That
remedy, and the fact that a 500 from the sweep task points at `cache.db` rather than at the
limiter, are now in `reports/coolify-deployment.md` §9. Also
worth knowing: the cache has **no production reader or writer** anywhere
(`cacheGet`/`cacheSet`/`cacheDelete`/`cacheDeletePrefix` appear only in `lib/cache/index.ts` and
one unit test), so the maintenance endpoint creates and maintains a database nothing else uses.

**32. The global daily OTP budget is charged from inside the PostgreSQL transaction.**
`utils/otp.ts:571`, contract at `lib/rate-limit/api.ts:196-206`. The call is the last statement
inside `withTransaction`, holding a `FOR UPDATE` row lock, an advisory lock and one of
`MAX_POOL_CONNECTIONS` (10) — and the comment immediately below it explains why `sendOtp` was
moved _out_ of the transaction for precisely this reason. `enforceOtpGlobalSendBudget` is a
synchronous `bun:sqlite` statement, measured blocking for 2 282 ms under writer contention
(Finding 21), so the same amplification applies at smaller scale; it is the one limiter call in
the codebase made while holding PostgreSQL locks. Secondarily, the charge is not atomic with
the transaction: a successful charge followed by a failed COMMIT permanently burns one unit of
the daily paid-delivery budget with nothing sent, and there is deliberately no refund
primitive. The outage-amplification magnitude is a **hypothesis**; the placement and the
non-atomicity are code-evident.

**33. Data-table edges.** Three small ones in the same module, all proven, none a privilege
issue. (a) `safeNumber` (`lib/data-table/filter-columns.ts:67-70`) accepts `"0x10" → 16` and
`"1e3" → 1000`, the exact class the sibling parser at
`app/api/dash/users/[id]/sessions/pagination.ts:108-119` already fixed and documented —
**latent**, since no live descriptor registers a `number` column. (b) A reversed `isBetween`
range is accepted and answered 200 with an empty table (`:228-248`); `filter.value.length !== 2`
is rejected but `from <= to` is never checked, and the comment on the length guard describes
exactly this outcome as the thing it was fixing. (c) `Object.fromEntries(searchParams.entries())`
(`db/queries/data-table.ts:62`) keeps the **last** value for a repeated key, so a duplicated
`?filters=` silently discards the earlier list with no `onDropped` call — the one discard path
the strict-filter contract does not cover.

**34. A regression test that asserts nothing about the thing it names.**
`tests/integration/session-role-field.test.ts:130-148` — `test('hasRole in an update response is
true, not always false')` contains only `expect(response.status).not.toBe(403)`, and the
observed status is **422**, not 200. The PUT targets a _different_ user, so the request routes
to `handleAdminEdit`, whose `actor` parameter has no `hasRole` field at all; the only reader is
`handleSelfEdit`. Reintroducing the original defect leaves this test green. The file's own
header calls itself "a class sweep… so a future `fieldName` cannot restore the outage quietly
on the four nobody checked" — this is the fifth site, and it is the unchecked one.

**35. Dead code and one type lie.** `app/api/dash/users/messages.ts:2` `notDashboardUser` and
`:5` `cannotModifyOwnPermissions` — zero references repo-wide;
`cannotModifyOwnPermissions` is the one that matters, because it reads as an authorization rule
that exists and does not. `app/api/dash/permissions/messages.ts:8`
`customRoleRequiresPermissions` — zero references; the live message is an exact duplicate
string. `utils/error-class.ts:13` — `CustomError`'s third parameter `code` has **zero**
three-argument call sites among 172 `new CustomError(` occurrences and no reader, so a future
`new CustomError(msg, status, CODE)` would be silently dropped by the response builder.
`db/queries/data-table.ts:44,158` `applySorting` is declared on the result interface and
returned but never read. `lib/data-table/config.ts:87-90` `sortOrders` is unreferenced _and_
asserts `'asc'`/`'desc'` into the 15-member filter-operator union — `tsc` permits the
assertion, so the wrong type is not caught anywhere, in a value presented as the shared
client/server source of truth. `utils/otp.ts:371-374,573-578,613`
`ProcessOtpSendResult` is computed inside the send transaction and discarded by all five
callers, and the `as ProcessOtpSendResult` cast is what keeps the return contract from being
type-checked. `app/api/auth/otp/messages.ts:15-16` `otpMsg.identifierNotFound` is the
pre-privacy-collapse message and would be an enumeration oracle if rewired.
`bunx knip` reports 1 unused export: `lib/r2/client.ts:389` `getR2ConfigStatus`. (It reported a
second, `tests/helpers/object-store.ts:91` `failObjectStoreKey`, earlier in this audit — a live
coverage gap rather than dead code, being the documented fixture for the retention sweep's
partial-failure branch. It was wired up by concurrent work while the audit was running.)

**36. Repo hygiene, tooling, and dependency placement.**
`page.out` is tracked in git — 1 327 209 bytes of a scraped documentation page (inspected: no
credential material). `prompt.md` is tracked; `.gitignore:64`'s `/prompt-*.md` matches
`prompt-fix.md` but not `prompt.md`. A `.tmp-probe/` directory of leftover probe scripts was
present at the start of this audit, untracked _and_ un-ignored — one `git add -A` from being
committed, and the only unused files `bunx knip` could see. It has since been removed, but
nothing stops the next one: the pattern belongs in `.gitignore`.
`@tanstack/react-table` is in `dependencies` for exactly one type-only
import (`types/data-table.ts:3` `import type { ColumnSort }`) — installed by a production
install of a headless API server with no React. `bun dedupe --check` reports three removable
duplicate versions (`@types/node` 26.2.0→24.13.3, `get-tsconfig`, `undici-types`) even though
`package.json` pins `"@types/node": "24"`. The CI JUnit report (`ci.yml:150-164`) is written and
thrown away — no step uploads or parses it, GitHub does not read JUnit XML on its own, and
`.gitignore:14` keeps it out of the repo, so the comment's claim that "a failure becomes a check
annotation" does not hold. `knip` is excluded from CI on the recorded grounds that it "reports
85 unused exports"; it now reports 2, so `package.json:17`'s `find:unused-files` fails today
while the CI step passes — two commands with almost the same name giving opposite verdicts.
`scripts/find-non-null-assertions.ts:148-161` creates a `/g` regex once outside the loop and
calls `.test()` per line, so `lastIndex` carries across lines and roughly half of all
`@ts-ignore` / `@ts-expect-error` comments are missed — a false negative, contained because the
script is advisory and not wired into CI.
Verified _not_ a problem, for the record: `.env` and `.env.test` are correctly gitignored and
untracked; `data/` (SQLite files keyed on IP addresses and contact destinations) is gitignored
and `git ls-files data/` is empty; no credential literal appears anywhere under `bench/`, and
`bench/s3/live-r2.ts` refuses to touch anything outside its own run-token prefix; `sharp` is
correctly a devDependency (only `bench/**` imports it) and `jsdom` correctly a runtime one.

---

## Test coverage gaps that matter

Only gaps where a _security-critical invariant_ is currently unverified. Established by reading
all 14 unit, 7 integration and 1 process file, then grepping `tests/` for each symbol.

1. **No test covers the login account lockout.** The only matches for
   `lockedUntil|locked_until|failedLoginAttempts|MAX_FAILED_ATTEMPTS` under `tests/` are
   `verificationSessions.blockedUntil` (OTP), not the login counter. Finding 1.1 — a completely
   inert brute-force control — would have been caught by one test.
2. **No test covers `formatCursor` / `parseCursor`.** Zero matches repo-wide outside the three
   application files. This matters twice: Finding 1.4 would have been caught, and the comment at
   `app/api/dash/users/[id]/sessions/pagination.ts:46` — "the round trip is asserted in the
   tests" — is **false**.
3. **No test pins the process timezone.** The entire class in Finding 1 is invisible on a UTC
   host. A regression test must force a non-UTC `TZ`, or CI (almost certainly UTC) will keep
   passing while production is broken.
4. **Hostile SVG sanitisation is untested.** `upload-auth-gate.test.ts:197-207` uploads a benign
   `<svg><rect/></svg>` and asserts 200, explicitly deferring the pipeline. Nothing feeds
   `<script>`, `onload=`, `<foreignObject>`, an XML entity or a `javascript:` href. Findings 2,
   12, 13 and 14 all live in that gap, and the output lands in a public bucket behind a CDN.
5. **`validateMagicBytes` has zero coverage.** No test declares `image/png` over non-PNG bytes.
   The SVG fixture was chosen _because_ it is exempt from the check.
6. **`own`-scope row filtering is untested at the SQL level.** `resolveActionScope` is well
   covered as a pure function; no test asserts that an actor holding only `viewOwn` receives
   _only_ rows whose `created_by` is themselves. `tests/helpers/session.ts:80` exposes
   `createdBy` for exactly this and no test passes it.
7. **`validID` has no test** — yet `should-ignore.md` #50 and #51 both accept a real risk on the
   grounds that "`validID` always matches session ID format". Finding 4 is what that unasserted
   property costs.
8. **`ipIdentifier` / `ipBucket` have no test.** `should-ignore.md` #64 declares the manual IPv6
   `/64` expansion "verified correct" and rules out _changing_ it; it does not rule out testing
   it. A `/64` collapse that stops collapsing turns every per-IP limiter into no limiter for an
   IPv6 client with a routed prefix.
9. **`getClientIp` / `TRUSTED_IP_HEADERS` have no test.** Nothing asserts that
   `x-forwarded-for` is ignored, nor the fail-closed 503 when the trusted header is absent — and
   the harness always sends the trusted header, so the branch is structurally unreachable from
   the current suite.
10. **Turnstile rejection is untested.** No test asserts that a `{ success: false }` siteverify
    answer blocks a request; the fake defaults to `{ success: true }`.
11. **Cookie attributes are unasserted.** `tests/helpers/session.ts:185` documents `setCookie` as
    "for assertions about attributes", and no test makes one — `HttpOnly`, `Secure`, `SameSite`
    and `Path` on the session cookie are all unchecked.
12. **`maintenanceTokenMatches`' accept path is untested, and `timingSafeEqual` is never
    executed by any test** — the single wrong-token test sends a 13-character value against a
    25-character configured token, so the length short-circuit fires first.
    `tests/helpers/preload-base.ts:117-127` was added to make the authorised path reachable and
    nothing uses it.
13. **The CSP _value_ is unasserted.** `scripts/smoke.ts:104-107` checks only
    `content-security-policy !== null`; a regression to `default-src *` passes. Nothing touches
    `access-control-allow-origin`, HSTS, `X-Frame-Options` or `Referrer-Policy`.
14. **No test asserts an audit row is written by an actual route mutation.** Existing tests call
    `auditLog()` directly or insert rows by hand.
15. **Nothing in CI can see rot inside `tests/`.** `scripts/find-unused-files.ts:65` treats
    `tests/` as an entry directory, so no file under it can ever be reported unreachable, and
    knip — the tool that would see it — is excluded from CI.
16. **No test asserts that the sign-in path bounds its outbound captcha call.** The four handlers
    that get the ordering right state the invariant in comments only. A test counting outbound
    siteverify calls for N unauthenticated sign-in attempts would lock Finding 3 shut.

Items 1–5, 8, 9 and 10 are each a single-line regression away from a real bypass, and each is
invisible to the current suite by construction rather than by oversight — the fixtures were
chosen to route around them.

---

## Bun 1.4 assessment

Every item was checked against the installed runtime (`Bun.version === '1.4.0'`), not against
the release post. Availability alone is not a recommendation; each entry says whether it is
worth adopting _here_.

### Worth adopting

**`Bun.cron` retires the recorded objection to an in-process sweep.**
`lib/sqlite/maintenance.ts:9-27` records the decision _not_ to adopt an in-process cron, with
three reasons. Reason 1 is load-bearing: "It is another Elysia coupling while the
Elysia-versus-Hono question is open, and the trigger would have to be rewritten with the
framework" — written about `@elysia/cron`. `Bun.cron` is a _runtime_ API, so that reason no
longer applies. Reason 2 (the single-process assumption) is already resolved by
`reusePort: false`. Reason 3 was about a specific defect, already fixed. Verified on 1.4.0:

```
Bun.cron.parse("*/15 * * * *") -> 2026-08-21T18:00:00.000Z
Bun.cron.parse("0 3 * * MON")  -> 2026-08-24T00:00:00.000Z
Bun.cron.parse("@daily")       -> 2026-08-21T21:00:00.000Z
Bun.cron("* * * * *", fn)      -> { cron, ref, stop, unref }   (no OS cron involved)
Bun.cron(expr, fn, { tz })     -> accepted
```

Caveat found while testing: **`Bun.cron` takes five fields — seconds are rejected**
(`TypeError: Invalid cron expression: too many fields`). Irrelevant for an hourly or daily
sweep. Note also that the string-path form (`Bun.cron("./worker.ts", …)`) registers a real OS
job in crontab or Task Scheduler; only the function form is in-process.

The gain is concrete and it now compounds with three findings: it would remove
`POST /api/internal/sqlite-sweep` and `POST /api/internal/db-sweep` — the two endpoints behind
Finding 9 and the edge-rule half of Finding 8 — along with `SQLITE_MAINTENANCE_TOKEN`, a gate
and an edge rule. The trade is losing the external scheduler's own failure alerting, which the
current design deliberately relies on. The decision is recorded as re-opened, with the two
`Bun.cron` caveats an adopter must not miss, in `reports/coolify-deployment.md` → "Settled
decisions".

**`jest.useFakeTimers()`.** Verified working on 1.4.0 (`setSystemTime`, `advanceTimersByTime`,
`useRealTimers`). This is the single most useful Bun 1.4 feature for this codebase, because it
makes the tests in coverage gaps 1 and 3 cheap to write: a lockout-expiry or OTP-block-expiry
test currently needs a real five-minute wait or a hand-written clock.

**`bun test --shard` / `--timings` / `--changed`.** The harness in `tests/helpers/run.ts` is
already 1.4-aware — it passes `--isolate`, `--parallel=N`, `--no-isolate`, `--no-env-file` and
`--preload`, with a recorded reason for each. Not yet used: `--shard=M/N` (CI could split the
integration tier across runners), `--timings` / `--update-timings` (balances shards by wall time
and doubles as a slow-test report), and `--changed` for the lefthook pre-commit hook. All
verified present. Speed, not correctness.

**`--cpu-prof-md` / `--heap-prof-md`.** Several values in this codebase are explicitly
unmeasured placeholders — `IDLE_TIMEOUT_SECONDS = 60` ("a deliberate placeholder, not a
measurement", `server.ts:178`), the upload route's `timeoutSeconds: 120` ("NOT measured on the
target host yet", `routes.ts:266-268`), and `TODO.md` PG-1, which blocks `statement_timeout` on
"a measured p99 for the slowest legitimate query". These flags produce grep-friendly Markdown
profiles directly on the target host, which is what those three TODOs are waiting for. Finding 7
is also a profiling target.

**`bun dedupe --check` in CI.** Verified: currently reports three removable duplicates. One line
in the verify job keeps the lockfile from drifting.

**`bun pm diff` for dependency review.** Verified working (`bun pm diff zod` → "No differences
(718 files)"). It un-minifies, skips formatting-only changes, and summarises new install scripts
and new imports of `child_process`/`fs`/`net`/`vm`. For a repo that already pins scanner
versions in `mise.toml`, curates `trustedDependencies` and takes Renovate PRs, this is a real
supply-chain gate at the moment a bump lands — and it is directly relevant to Finding 24, where
untrusted PyPI code runs beside a persisted token.

### Worth knowing, small gain

**`--no-env-file` on the production start command.** Measured precedence (a real process
variable wins over a `.env` entry, under `NODE_ENV=production` too) and the residual risk it
leaves — a stray `.env` can still _supply_ a variable the platform deliberately left unset,
`SQLITE_MAINTENANCE_TOKEN` being the obvious one — moved in full to
`reports/coolify-deployment.md` §2, since the change is to the deployment's start command and
to nothing in this repository.

**`--no-orphans`.** `tests/helpers/run.ts` and `tests/process/*` spawn real child processes.
`--no-orphans` makes Bun SIGKILL descendants on exit, a cheap improvement over the manual
`SIGINT`/`SIGTERM` forwarding at `run.ts:211-213`, which covers the runner's own child but not
grandchildren.

### Verified available and deliberately not recommended

- **`Bun.Image`** — available. Not applicable as a replacement: `sharp` is correctly a
  devDependency used only by `bench/image/**`, and the production pipeline is svgo + DOMPurify +
  jsdom, which `Bun.Image` does not replace. (`Bun.Image` _is_ already used by
  `lib/r2/optimize-image.ts`, which is where Finding 7 lives.)
- **`URLPattern`** — now a global. Could replace the hand-rolled `compile()` in
  `lib/http/route-manifest.ts:149-160`, but that is ten audited lines with escaped literals and
  `[^/]+` params, and `URLPattern`'s matching semantics are not identical. No reason to swap a
  correct, reviewed matcher for a differently-behaving one. (Note this is _not_ the offset bug in
  Finding 8, which is inside Elysia's own dispatcher.)
- **HTTP/3** (`Bun.serve({ http3: true })`, `fetch(url, { protocol: 'http3' })`) — the release
  post says explicitly not to ship it to production, and `server.upgrade()` returns false over
  H3. Do not adopt.
- **`Bun.markdown`, `Bun.XML`, `Bun.JSON5`, `Bun.JSONL`, `Bun.JSONC`, `Bun.TOML.stringify`,
  `Bun.Archive`, `Bun.sliceAnsi`/`wrapAnsi`/`stringWidth`, `Bun.WebView`, `Bun.Terminal`,
  `Bun.spawn({ cgroup })`, ML-DSA/ML-KEM in `crypto.subtle`** — all verified present; none
  replaces a dependency or a hand-rolled implementation here. `Bun.markdown` in particular does
  **not** sanitise its HTML output, so it must not be reached for if user-supplied Markdown ever
  appears.
- **`process.on('memoryPressure')`** — real, and there is no memory-pressure handling to
  improve; the server holds no large caches in JS. Findings 2 and 7 are better fixed at the
  source than observed.
- **Native streams, zlib-ng, the RegExp and `new URL()` speedups, the 13–48 % HTTP-server memory
  reduction** — free on the pinned version, no code change.

### Already correct, no change needed

`bun:sql` transaction isolation is the reason `server.ts:102-123` refuses a Bun _minor_
mismatch, and the recorded reason is accurate: Bun #32772 (a simple-protocol query concurrent
with a not-yet-prepared parameterized query on one connection could cross rows, and
`BEGIN`/`COMMIT`/`ROLLBACK` are simple-protocol) was fixed in 1.4.0. `lib/id.ts` already
migrated to `Bun.randomUUIDv7()` on the strength of the 1.4.0 counter-exhaustion change, with
the measurement recorded. `package.json` already uses the 1.4 `ignoreScripts` field alongside
`trustedDependencies`. `tests/helpers/run.ts` already uses `--no-env-file`, `--isolate` and
`--parallel`. This part of the codebase is up to date.

---

## Verified correct (checked, and reported so it is not re-checked)

**The data-table filter DSL cannot inject an identifier or raw text.** This is the highest-risk
component in the codebase — a client-supplied filter and sort DSL straight off the query string
— and it holds. Every client-controlled component either resolves to a server-owned object or is
rejected before SQL is built: `filter.id` passes `Object.hasOwn(specs, id)` _then_
`Object.hasOwn(table, id)` plus a `'dataType' in col` check; `filter.operator` and `variant` are
closed sets; `sort[].desc` must be a boolean; `joinOperator` selects the `and`/`or` **function**;
`filter.value` always becomes a bound parameter; and there is no join-alias or JSON-path
surface at all. Executed, printing the generated SQL:

```
quote in value (eq)     where "users"."email" = $1          params: ["a' OR '1'='1"]
quote in value (iLike)  where "users"."email" ilike $1       params: ["%a' OR '1'='1%"]
LIKE wildcards          where "users"."email" ilike $1       params: ["%\\%\\_\\\\x%"]
NUL + bidi in value     where "users"."name" ilike $1        params: ["%a\u0000b‮c%"]
or join, two filters    where ("users"."email" ilike $1 or "users"."name" ilike $2)

col id: 'name"; DROP TABLE users; --'  REJECTED 422
col id: constructor / __proto__ / hasOwnProperty  REJECTED 422
col id: deletedAt / roleId (real columns, no descriptor)  REJECTED 422
boolean column + text operator  REJECTED 422
sort id: 'name"; --' / 'constructor' / '_'  dropped -> order by "users"."id" desc
```

`Object.getOwnPropertyNames(users)` is exactly the declared columns plus `enableRLS` (a
function, rejected by the `typeof` check); `_` is symbol-keyed and unreachable by string key.
Repo-wide, `sql.raw` occurs only in `db/schema.ts` with compile-time constants, and
`client.unsafe()` only in `scripts/migrate.ts` over in-repo files. The `or` filter group is
always parenthesised inside the handler's `and(isNull(deletedAt), nonSystemRoleFilter(),
scopeFilter, where)`, so an `or` filter cannot escape the authorization predicate.

**Route conformance, all 30 routes, executed in-process.** Every route returns
`application/json`; every one carries `Content-Security-Policy`, `X-Content-Type-Options`,
`Referrer-Policy`, `X-Frame-Options` and `Cache-Control` (0 of 30 missing any); every route
returns the `{success, message, data}` envelope except the three documented `apiRaw` endpoints
and `/openapi.json`. 404-vs-405 is correct (`PUT /api/dash/users` → `405 Allow: GET, HEAD, POST,
OPTIONS`), the trailing-slash 308 is correct and cannot become an open redirect
(`canonicalRedirect` only emits a target that already resolves in the manifest;
`/api/dash/users//` → 404), and route-aware `OPTIONS` returns 404 on an unknown path while the
CORS plugin answers 204 on a known one.

**CORS is not permissive.** `Origin: https://evil.example` and `Origin: null` both get 204 with
**no** `Access-Control-Allow-Origin` and `Vary: Origin`; only `PUBLIC_ORIGIN` is echoed.

**The body-policy gate holds.** A `multipart/form-data` body sent to a `json` route is never
parsed: `readFormData()` is a constant `null` for that policy, and the route's own captcha gate
rejects first. Every JSON route runs a session check or a per-IP limiter _plus_ a captcha before
`readJson()`, so an unauthenticated client cannot make the server parse a large body at all.

**The login timing guard works.** Measured rather than assumed, because
`Server-Timing: app;dur=…` publishes the server's own processing time on every response
including `/api/auth/sign-in/email`, which would strip network noise from any residual
asymmetry. 60 paired sign-in attempts against a real user and 60 against unknown emails:

```
unknown-email    min 95.6  p05 102.2  p10 104.2  p25 109.9  p50 134.0
known-badpass    min 96.2  p05 103.1  p10 106.2  p25 114.9  p50 137.1
paired diff (known − unknown): mean −2.6 ms, median +6.2 ms
```

`runPasswordTimingGuard` equalises the dominant Argon2id cost, and the residual DB-work
difference is 1–5 ms at the low percentiles, inside this host's noise. **No user-enumeration
oracle could be demonstrated on this path, so none is reported.** (Finding 20 is a different
mechanism on different endpoints, where the gap is seconds, not milliseconds.)

**The maintenance-token comparison itself.** `lib/sqlite/maintenance-token.ts:20-26` uses
`timingSafeEqual` behind a length check, and an unset configured token never matches — so both
`/api/internal/*` routes and `?deep=1` fail closed on a deploy that forgot the variable.
Unauthenticated requests are rejected in ~0.05 ms without reading a body (`body: 'none'` in
`routes.ts` is load-bearing and is set). Finding 9 is about the absence of a limiter in front of
it, not about the comparison.

**The dev-only endpoints are properly gated.** `/api/dev/sign-up` returns 403 and
`/api/dev/email-test/fixed` returns 404 whenever `NODE_ENV !== 'development'`, checked at handler
entry before any work.

**Rate-limit and SQLite fundamentals.** `SQL_CONSUME` admits exactly `limit` per window, performs
no write on denial, and resets correctly on rollover. Multi-process atomicity: 4 processes × 250
attempts on one key with limit 200 → `admitted 200 / denied 800 / degraded 0`, stored count
exactly 200. Migration race: 8 processes racing a fresh file → all succeeded, `user_version = 1`.
Better Auth's `customStorage.consume` is genuinely used on 1.7.1 (310 `/get-session` requests
from one IP → exactly 300×200 and 10×429). The fail-closed contract holds on every path.
`preAuthScope` produces exactly six scopes across the route table with no collisions, and no
percent-encoding or path-normalisation variant reachable through the _normal_ ingress produces a
different bucket — Finding 8 is the only way to inject one.

**Migration fidelity.** `drizzle-kit generate` against `db/schema.ts` reports "No schema changes,
nothing to migrate". The live migrated database matches exactly: 10 FKs with the declared
`ON DELETE` actions, all 25 CHECK constraints, all 36 indexes, all 8 enums in declared order, the
`contact_kind` generated column. Transaction semantics over `bun:sql` are correct — one backend
PID per transaction, `serializable` applied, nested transactions become savepoints, and no
`withTransaction` block anywhere uses the pooled `db` inside its callback.

**OTP correctness apart from the findings above.** No code reuse after consumption (two
concurrent verifies of the same correct code → one 200, one 400, `onVerified` invoked exactly
once). No attempt-counter races (eight simultaneous wrong codes → exactly five charged, three
refused, zero lost updates). No purpose, identifier or user confusion — every crossing refused.
Advisory-lock scope and `ON CONFLICT` inference are correct, including for the generated
`contact_kind` column. Hash-envelope parsing is constant-time behind a length check and rejects a
malformed stored value as `false` rather than throwing.

**SVG script XSS.** 26 payloads through the real pipeline — `<script>`, comment-spliced
`<sc<!--x-->ript>`, `onload`/`onbegin`/mixed-case `ONMOUSEDOWN`,
`<animate attributeName="xlink:href">`, `<set>`, `<foreignObject>`, XML-Events `<handler>`,
namespace-prefixed `<h:script>`, `xlink:href="javascript:"`, `data:text/html` — all stripped or
rejected. XXE and billion-laughs both rejected (nested entity expansion resolves exactly one
level, which is why Finding 2 is quadratic and not exponential). Path traversal and key collision
in object keys are impossible: `sanitizeFilename`'s allowlist is
`[\p{L}\p{N}\p{Zs}_\-()]`, and keys are `temp/<8 crypto-random bytes>_<stem>.<literal ext>`.
`Content-Disposition` header injection is already covered and passing in
`tests/unit/content-disposition.test.ts`.

**Suppression hygiene.** All 11 `eslint-disable` comments in application code were checked against
their justification; each holds. The `security/detect-unsafe-regex` suppression on `colorRegex` is
a linter false positive — `/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/` is fully bounded. ReDoS was
measured across the validation regexes at 50 K–1 M character inputs: all linear.

**Audit-trail integrity, apart from Finding 17.** Every `auditLog` call site takes a transaction
handle and writes inside the mutation's transaction, so a committed mutation cannot lack its row.
`isSensitiveAuditKey` matches normalised key _fragments_ rather than exact names, exempts booleans
by construction, and takes a per-event `safeFields` allowlist.

**Environment validation.** `NODE_ENV` is validated against an exact three-member set in
`server.ts` _before_ the dynamic import of `app.ts`, so `lib/env.server.ts` never evaluates under
an unrecognised value — confirmed that Bun 1.4.0 does not default `NODE_ENV`. `lib/env.js`
rejects a missing origin, two disagreeing names, a relative URL, a non-http(s) scheme, embedded
credentials, a path, a query and a fragment.

**Workflow supply chain, apart from Finding 24.** All actions pinned by SHA, no
`pull_request_target`, `contents: read` only, no `secrets.*` references, no `${{ }}` inside any
`run:` block, no swallowed exit codes. `bun audit` is a real gate (verified: a scratch project
pinned to `lodash@4.17.20` exits 1). `bun test` already exits 1 on a zero-match filter, so the
stale-selector hole `bunfig.toml` describes is closed by the runtime.

---

## Examined and deliberately not reported

Recorded so the next reader does not spend the time again.

- **A `Server-Timing` timing oracle on the sign-in path.** The exposure is real and measured; the
  exploitable asymmetry is not. Not a finding.
- **The 8 MiB `MAX_REQUEST_BODY_BYTES` ceiling applying to JSON routes.** Traced every JSON
  route: each runs a session check or a limiter _plus_ a captcha before `readJson()`. The one
  amplification through this door — `zodIssueMessage` reflecting an unbounded list of
  unrecognized key names into the 422 body (100 000 keys → 176 ms and an ~889 KB message) — is
  gated behind a session and a 10–20/min limiter. A nuisance, not a lever.
- **`positiveInt` truncating with `| 0`** (`utils/index.ts:425-429`): wraps negative above 2³¹
  (`positiveInt(2**31+5, 2**32) === -2147483643`). Its only callers pass `MAX_PER_PAGE = 100` and
  `MAX_PAGE = 10 000`, so it is unreachable. Worth knowing, not a defect.
- **Extended Arabic-Indic digits rejected as a _missing_ phone number.**
  `normalizeArabicDigits` (`utils/index.ts:6-9`) covers U+0660–U+0669 but not U+06F0–U+06F9, and
  `phoneCleanupRegex = /[^\d]/g` (ASCII `\d`) then deletes them, so
  `phoneSchema("۰۵۱۲۳۴۵۶۷۸")` fails with "رقم الهاتف مطلوب". A real localisation bug with no
  security consequence; one extra range fixes it. Reported here rather than as a finding because
  the repo's phone policy is explicitly scoped to a Saudi launch (`should-ignore.md` #56).
- **OPTIONS requests produce no access-log line.** Both OPTIONS answers short-circuit in an
  `onRequest` hook, so preflight volume and OPTIONS-based path scanning are invisible in the log.
  The code documents this accurately at `lib/http/after-response.ts:129-136` — a stated
  limitation, not a defect.
- **`lib/http/after-response.ts`'s queue and settle loop** have no caller and no test. The file
  says so itself. Insurance, not a defect.
- **`routeMiss` returning 405 without re-checking the method** (`app.ts:192-201`). Unreachable
  except through Finding 8, where it is the useful tell that the router and the manifest
  disagreed. Folded into that finding rather than reported separately.
- **Whether mass session revocation should emit its own `sessions` audit row.** The cause is
  recorded on the `roles`/`users` event; no forensic question could be shown to become
  unanswerable. Hypothesis only.
- **`utils/images/config.ts` `MAX_IMAGE_SIZE = 1` versus the 0.4 MB SVG cap.** The handler admits
  up to 1 MiB and its message promises 1 MB, while `sanitizeSvg` refuses at 0.4 MB and
  `processImage` replaces the accurate message with a generic `invalidSvg` — so a 0.5 MB SVG the
  API said was in range is rejected as _malformed_, with the real reason only `console.error`'d.
  A UX defect; noted here because 0.4 MB, not 1 MB, is the real attacker budget for Finding 2.
- **A latent filename → R2 key sink** at `lib/r2/upload-helper.ts:253`
  (`file.name.split('.').pop()`), in a branch the code documents as unreachable with the current
  `ALLOWED_IMAGE_TYPES`. Confirmed unreachable. It activates the moment a MIME type is added that
  `shouldOptimizeImage` excludes — `image/gif` already is — so it is worth deleting rather than
  keeping.
- **The "single definition" of target-user visibility has three implementations.**
  `app/api/dash/users/[id]/target-user.ts:32-54` documents itself as "The single definition…
  Every check lives here because the parent resource and its subresources have to agree", while
  `handleAdminEdit` (`:356-368`) reimplements all three clauses inline and `DELETE` (`:788-803`)
  expresses the protected-role clause as raw SQL. The three copies are currently semantically
  equivalent — each clause was compared — so the drift the comment describes is not prevented,
  only absent. The raw-SQL copy is the most exposed: no change to the TypeScript predicate can
  reach it.

---

## Appendix — reproducing the environment, and artifacts

```bash
# 1. a scratch database with the real schema
psql -c 'CREATE DATABASE audit_probe_tmp'
DATABASE_URL=<scratch> NODE_ENV=development bun --no-env-file scripts/migrate.ts

# 2. seed a role + permissions + user + credential account with the project's own helpers
#    (roles.scope = 'system', accounts.issuer = 'local:credential', providerId = 'credential')

# 3. drive real routes in-process, from a script OUTSIDE the repo, cwd = repo
#    so Bun auto-loads .env for the remaining secrets
process.env.DATABASE_URL = '<scratch>';
globalThis.fetch = stub_for('challenges.cloudflare.com', 'pwnedpasswords.com');
const { app } = await import('<repo>/app.ts');
await app.handle(new Request('http://localhost:3000/api/...', { ... }));

# run with:  NODE_ENV=development SQLITE_DIR=<scratchpad>/data bun <scratchpad>/probe.ts
# prefix TZ=UTC to obtain the counterfactual for every part of Finding 1.

# 4. for anything that depends on the Host header (Finding 8), a real listener is required:
DATABASE_URL=<scratch> NODE_ENV=development PORT=39701 SQLITE_DIR=<scratchpad>/data bun server.ts
#    then drive it with Bun.connect() and hand-written request lines.
```

`SQLITE_DIR` must point outside the repository, or the probes write into the real
`data/rate-limit.db`.

**Artifacts.** All cleaned up. The scratch database (`audit_probe_tmp`) was dropped and verified
gone. Every probe script lived outside the repository and was deleted. Three things this audit
created inside the working tree were removed: `reports/junit-integration-AUDIT.xml` (from running
the verbatim CI integration command), a 15 MB file literally named `nul` (a Windows
`> /dev/null` redirect spilling a bundle into the repo root — worth knowing, since any
`2>/dev/null` in a script run on Windows does this), and the leftover `.tmp-probe/` scripts. The
only file this audit leaves behind is this report, and it passes
`prettier --check`.
