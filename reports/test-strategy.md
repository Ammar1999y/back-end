# Test Strategy — Decisions, Evidence, and Open Questions

**Date:** 2026-08-15 **Reviewed:** `reports/engineering-hardening-plan.md`
(current), commit `c583d82`, `scripts/probe/`, `db/index.ts`, `db/ws.ts`,
`lib/rate-limit/*` **Status:** reasoning and evidence only. Nothing implemented.

---

## 0. What changed since the previous review

`c583d82` landed lefthook, CI, mise, Renovate, Semgrep and gitleaks. Relevant
here:

- `.github/workflows/ci.yml` exists with three jobs on `ubuntu-24.04`. There is
  **no test job** — the plan defers it explicitly: _"A `bun run test` CI step
  would fail on a missing script. Phase 1 is deferred; add that step together
  with the tests."_
- Two open items are gated on tests existing: the branch-protection
  required-checks list, and the Renovate automerge revisit. Both are already
  named in the plan.

**Contradiction to flag.** Plan §3 still prescribes
`bun add -D vitest @vitest/coverage-v8` and `@testcontainers/postgresql`. That
contradicts the Bun-first rule. `bun test` covers both and `--coverage` is built
in. The plan needs editing whichever way the decisions below land.

---

## 1. "Real services already, so the tests are implementation-independent"

The premise is sound. The inference is not.

The property wanted is _implementation-independence_: the same results
regardless of which Postgres, which key-value store. A suite run against **one**
implementation cannot demonstrate independence. It demonstrates that the code
works on Neon + Upstash. Independence is a minimum-two-point property.

This is not pedantry, because the coupling is not at the SQL layer — where "Neon
is Postgres" is basically true — but at the **driver**, which is the most
Neon-specific thing in the repository.

### a. `db/index.ts` — `neon-http`

One HTTP request per query, each its own implicit transaction, zero session
continuity. Nothing session-scoped works: `SET LOCAL`, session advisory locks,
`FOR UPDATE` held across statements, temp tables, cursors, `LISTEN`/`NOTIFY`.
That limitation is _why_ `db/ws.ts` exists. On local Postgres via `postgres-js`
or `Bun.sql`, queries share a pooled session and none of it is true. There are
two clients in this repo precisely because the two drivers do not have the same
semantics.

### b. `db/ws.ts` — the one that actually bites

`withTransaction` creates a **new `Pool` per transaction** and `pool.end()`s it
in `finally`. On Neon serverless WebSocket that is the normal pattern. On local
Postgres it means a fresh TCP + TLS handshake and a fresh backend process fork
**per transaction** — the single most expensive thing that can be done to a
local server. Every transactional invariant currently under test
(`processOtpVerify`, `verifyLoginAttempt`, the OTP daily budget) runs through
it. This function must change on the VPS, so today's tests certify the shape
that is going to be deleted.

The comment on line 23 already says
`// To switch to a local DB later, replace the body of this function`. The
instinct is right; the point is only that the tests validate the pre-swap body.

### c. Latency changes which races are observable

Neon RTT is tens of milliseconds; local Postgres is sub-millisecond. The OTP
probes run 15+ sequential verify attempts, each a transaction holding a row
lock, with `300_000` ms timeouts. Race windows scale with RTT. A TOCTOU that
Neon's latency masks can surface locally, and lock contention that only appears
at local speed will never appear on Neon. Timing is not an edge case here — the
budget logic is concurrency-sensitive by design.

### Bottom line

Keep testing against real services; that part is right. But state the claim
accurately: _these tests prove the invariants hold on the stack they run
against._ To get the property actually wanted, run them against the target stack
— which is exactly what the §3 decision achieves.

---

## 2. Docker-free Postgres, and what CI actually is

Verified on this machine: `docker` absent, `psql` absent, `pg_ctl` absent. Bun
1.3.14, scoop 0.5.3, mise 2026.8.6 present.

### 2a. The four options

| Option                        | Docker locally | Solves the driver problem | Notes                                                                              |
| ----------------------------- | -------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| **CI service container**      | No             | Yes                       | GitHub's runner supplies Docker. Recommended primary. See 2b.                      |
| **Native Postgres via scoop** | No             | Yes                       | `scoop install postgresql` — verified available, `postgresql 18.6-1`, main bucket. |
| **Neon branching**            | No             | **No**                    | Works, but entrenches the stack being left.                                        |
| Docker Desktop / WSL2         | Yes            | Yes                       | Supported on Windows 10 Pro. Declined.                                             |

**On Neon branching.** Neon does support it: `neonctl branches create` or the
API produces a copy-on-write branch with its own connection string in a couple
of seconds, deleted after the run. It is a legitimate isolation mechanism, and
it is the wrong tool here for three reasons:

1. It isolates against infrastructure that is being left. It solves the
   shared-state problem while entrenching the wrong-stack problem.
2. Branch creation is seconds, not milliseconds — per-run isolation only, never
   per-file. `CREATE DATABASE … TEMPLATE` on a local server is the faster
   primitive.
3. Plan branch limits and API rate limits apply. **The Neon plan on this account
   was not inspected**, so the ceiling is unknown — checkable in the console.

Worth it only if the VPS move is 6+ months out and isolation is needed now.

### 2b. What "hosted service" means

**What runs the tests.** GitHub Actions, already wired up. On every push and PR,
GitHub allocates a **fresh virtual machine** (`ubuntu-24.04`, 4 vCPU / 16 GB on
the public-repo runner), clones the repo, runs the steps, and **destroys the
VM**. Nothing persists between runs.

**Where the database comes from.** A `services:` block. The runner VM has Docker
preinstalled, so it starts a Postgres container alongside the job — Docker is
needed on _their_ machine, not on this one:

```yaml
test:
  runs-on: ubuntu-24.04
  services:
    postgres:
      image: postgres:18-alpine
      env:
        POSTGRES_PASSWORD: test
        POSTGRES_DB: app_test
      ports: ['5432:5432']
      options: >-
        --health-cmd pg_isready --health-interval 5s --health-timeout 5s
        --health-retries 10
```

The job connects to `postgres://postgres:test@localhost:5432/app_test`, runs
`drizzle-kit migrate`, runs `bun test`. When the job ends, container and VM both
evaporate.

Facts that matter to the decision:

- Service containers are **Linux-runner only**. `ubuntu-24.04` qualifies.
- The repo is **still public** (plan, "Still open" item 1), so Actions minutes
  are **free and unlimited**. Going private drops to 2000 min/month free; an
  integration job is ~2–3 min.
- **The strategy works there, better than locally.** "Tests fully own the
  database" is free when the database is destroyed 90 seconds later. No cleanup
  logic, no `PROBE_STAMP`, no ordering constraints, no risk.
- Pin the Postgres major in the service container to match the VPS, or one
  fidelity gap is simply traded for a smaller one.
- **Cost: the feedback loop.** Integration tests only run on push, ~2 min
  round-trip. Mitigations: keep unit tests local and fast, and use
  `bun test --changed` (verified present) locally. Local Postgres via scoop can
  be added later without touching the harness — only `DATABASE_URL` differs.

**Recommendation.** CI service container as the integration environment. Local
Postgres as an optional convenience, decided later, not a prerequisite.

---

## 3. Contract tests — decision accepted, premise corrected

The rejection is accepted. Switching to the target implementations now and
testing those directly is simpler and is the better call. Contract tests exist
to manage a swap where both sides are kept; that is not the situation.

The premise about the layer being thin is half right.

**Correct about `lib/rate-limit/auth-storage.ts:50` and `:62`.**
`redis.get<T>(key)` and `redis.set(key, value, { ex })`. Plain key-value. Ports
to `lru-cache` in about ten lines.

**Not correct about `lib/rate-limit/index.ts:33-45`.** `getLimiter` constructs
`new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(limit, window) })`.
`@upstash/ratelimit` is not a key-value wrapper — it ships **Lua scripts
executed server-side on Redis**. Verified in
`node_modules/@upstash/ratelimit/dist/index.mjs`:

```lua
local requestsInCurrentWindow  = redis.call("GET", currentKey)
local requestsInPreviousWindow = redis.call("GET", previousKey)
local percentageInCurrent = ( now % window ) / window
requestsInPreviousWindow = math.floor(( 1 - percentageInCurrent ) * requestsInPreviousWindow)
```

Two fixed buckets, the previous one linearly weighted by position within the
current window, the whole thing atomic under `EVALSHA`. The constructor requires
an Upstash-compatible client; there is no store-adapter seam.

So this is not a swap — **it is reimplementing the rate-limiting algorithm the
project currently rents.** Not hard (the script above is the entire algorithm,
roughly 30 lines of TypeScript), but it is not "point the layer at lru-cache".
That is the real cost, and it is what made contract tests look attractive.

The conclusion still holds: one implementation, owned and tested directly, beats
two implementations plus a conformance harness. And owning the algorithm makes
it _more_ testable than today — `now` is a client-supplied argument, so
window-boundary behaviour becomes directly drivable with `setSystemTime`, which
is not meaningfully possible against Upstash today.

Same verdict for the database: pick the driver, test that one.

---

## 4. Per-process rate limiting

Accepted as deferred. One item carries forward into §5 rather than being
re-argued: the deferral is safe against _concurrency_, not against _eviction and
restart_. Both apply at single-process scale.

---

## 5. What actually changes underneath, and the VPS test database

### 5a. Redis → lru-cache: the specifics

Three of the four differences are minor or favourable. One is not.

**Eviction is not expiry — this is the one.** `lru-cache` evicts by `max` entry
count in LRU order, independent of TTL. A rate-limit entry can be dropped
**before its window expires**, silently resetting the counter to zero. Redis
does not do this on a sized instance with default `noeviction`.

That is an attack, not a quirk. An attacker generates traffic against many
distinct identifiers — fresh IPs, fresh destinations, fresh addresses — pushing
their own counter out of the LRU tail, then resumes. The key space is
attacker-influenced by construction: `otp.send.dest.email:<destination>` embeds
a value taken from the request body. Sizing `max` high enough to be safe means
sizing for the attacker's key cardinality, which is unbounded. The honest fix is
a store that expires by TTL only and fails closed when full — a different data
structure from an LRU.

**Durability.** A process restart wipes every counter. **Every deploy resets the
OTP global breaker** (`otp.send.global`, 2000/day), better-auth's login limiter,
and every per-destination cap. Not attacker-triggerable, but the daily budget
becomes "per deploy" rather than "per day".

**Atomicity.** Upstash's Lua is atomic server-side. In-process, a purely
synchronous read-modify-write is atomic in JavaScript, but the store interface
returns Promises and any `await` between read and write reopens the race.
Solvable, and easier than it sounds, but it becomes an invariant to maintain.

**Clock — in your favour.** The previous version of this document said Upstash
uses the Redis server clock. That is wrong: `now` is `ARGV[2]`, supplied by the
client. Moving in-process changes nothing here, and either way `setSystemTime`
can drive it.

Net: durability, atomicity and clock are manageable or improvements. **Eviction
is a genuine new security hole** that has to be designed around rather than
inherited.

### 5b. "Should tests fully own the database?"

Yes. That is the standard expectation and the correct one. The standard
formulation has a second half:

> Tests own the database **because the database is disposable** — not because
> they have been granted permission on a durable one.

The industry answer to "how do I safely let a destructive suite loose" is never
"carefully". It is "make the target worthless". Full ownership plus ephemeral is
the norm; full ownership plus persistent-and-shared is the anti-pattern the
current probes are in. The instinct is right; the shape it should take is
ephemeral, not permissioned.

### 5c. The options

**A. Separate database, same Postgres instance, same VPS** (`app`, `app_test`).
Cheapest. Specific risks: a wrong `DATABASE_URL` points a destructive-by-design
suite at production; shared `shared_buffers`, WAL and connection slots mean a
test run competes with live traffic; one careless superuser connection crosses
the boundary. Survivable only with all three of — a dedicated `app_test` role
holding **zero** privileges on `app`; a boot-time assertion in the harness that
`current_database()` ends in `_test` and hard-exits otherwise; a separate
`.env.test`. Without those it is one typo from data loss on the box serving
users.

**B. Separate Postgres instance on the same VPS** (second port, own data
directory). Better blast radius, no buffer or WAL contention, ~200 MB extra RAM.
Still one machine, still one bad env var away — but the separation is enforced
by the server rather than by grants.

**C. Separate staging VPS.** What teams with budget do. Costs another box, and
gives somewhere to rehearse migrations.

**D. No test database on the VPS at all — CI is the integration environment.** ←
recommended. Production VPS runs production only. Integration tests run in CI
against a throwaway service container (§2b). Nothing can point at production by
accident because production credentials never exist in the environment that runs
destructive tests. Requirement: pin the same Postgres major in CI and on the
VPS.

**E. Post-deploy smoke tests against production.** A small, strictly
**read-only** set: health endpoint, auth reachable, migrations at the expected
version, one known-good login. A different category from integration tests.
Serious teams run both D and E, and keep them in separate harnesses — the day
someone adds a `DELETE` to the smoke suite is the day D's guarantees stop
applying.

**How this is done at larger scale:** an ephemeral database per CI job; a
per-developer local database via docker-compose; one long-lived staging
environment refreshed from anonymised production dumps for manual and e2e
testing; production touched only by migrations and read-only smoke checks.
Nobody points a destructive suite at a machine serving traffic. The separation
is environmental, not procedural — precisely because procedural discipline fails
eventually.

**Verdict: D, plus E later. Do not create a test database on the production
VPS.** A local loop belongs on the developer machine, not the server.

---

## 6. Target structure

Unchanged, with one amendment from §3: `tests/contract/` is dropped. With a
single implementation, its tests are simply `tests/unit/` (the algorithm, driven
by `setSystemTime`) and `tests/integration/`.

```
tests/unit/          pure, no IO, milliseconds     — run on every save
tests/integration/   real Postgres + real handlers + fake providers
scripts/probe/       retire once the above exists
```

---

## 7. Bun-first rule, applied

The rule: if Bun already provides something needed, use Bun's version instead of
adding a dependency. Applied only to what is actually needed:

| Need                            | Bun provides                        | Verdict                                                                                                                          |
| ------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Test runner                     | `bun test`                          | Use it. **Drop vitest from the plan.**                                                                                           |
| Coverage                        | `--coverage`, `--coverage-reporter` | Built in. `@vitest/coverage-v8` unnecessary.                                                                                     |
| Time control                    | `setSystemTime`                     | Verified working. Needed for OTP windows and DST.                                                                                |
| Postgres client for the harness | `Bun.sql`                           | Verified present. `CREATE`/`DROP DATABASE` without `pg`.                                                                         |
| Container orchestration         | `Bun.$`                             | Only if going local-Docker. On the CI path **neither `Bun.$` nor testcontainers is needed** — `services:` does it declaratively. |
| Fake SMS / email provider       | `Bun.serve`                         | Use it — real HTTP, exercises timeout and 5xx paths.                                                                             |

**One item relevant to step 6 of the ordering.** `drizzle-orm/bun-sql` exists in
the installed drizzle 0.45.2 (verified, alongside `node-postgres/` and
`postgres-js/`). If the VPS runs Bun, `Bun.sql` + `drizzle-orm/bun-sql` is a
zero-dependency driver that replaces `@neondatabase/serverless` entirely,
supports pooled sessions and interactive transactions, and collapses
`db/index.ts` and `db/ws.ts` into one client. **Not verified:** whether that
adapter is production-mature or supports everything `withTransaction` needs.
That is a concrete spike to run before committing. `postgres-js` is the
conservative alternative.

---

## 8. Empirical results — measured, not assumed

### Bun test-file parallelism — resolved

Default is **sequential in a single process**. Two files, 1.5 s sleep each:

```
b.test.ts: B start …099317  pid 11580
a.test.ts: A start …100842  pid 11580     ← same pid, strictly after B
Ran 2 tests across 2 files. [3.46s]        ← ≈ sum
```

But Bun 1.3.14 **does** ship `--parallel=N` (worker processes, implies
`--isolate`). Verified:

```
bun test --parallel=4     →  4x PARALLEL
A pid 6684   start …132079
B pid 10764  start …132239                 ← distinct pids, overlapping
Ran 2 tests across 2 files. [2.23s]        ← ≈ max
```

Flags missed in the previous document, all present in 1.3.14:

- `--randomize` + `--seed=N` — **the right tool for the order-dependence problem
  in the probes.** The previous document recommended `--rerun-each` for that,
  which was wrong: `--rerun-each` catches flakiness, `--randomize` catches
  ordering. Both are useful, for different things.
- `--shard=1/3` — split integration tests across parallel CI jobs.
- `--changed[=ref]` — only test files affected by the git diff. This is the
  local feedback-loop mitigation for §2b.
- `--isolate` — fresh global object per file; leaked handles cannot cross files.
- `--max-concurrency` (default 20), `--concurrent`, `--retry`.

### `setSystemTime` — verified

`setSystemTime(new Date('2030-01-01'))` → `new Date()` returns
`2030-01-01T00:00:00.000Z`; bare `setSystemTime()` restores. `Bun.sql`,
`Bun.SQL` and `Bun.$` are all present as functions.

### Testcontainers under Bun — partially resolved

`@testcontainers/postgresql@12.1.0` installs, imports and constructs cleanly
under Bun 1.3.14. `.start()` **could not be tested — no Docker.** A finding in
itself: with no Docker daemon it **hung past 120 s** rather than failing fast,
which is poor DX on a machine that does not have it. Moot on the CI path.

### `CREATE DATABASE … TEMPLATE` cost — not measured

Requires a Postgres server; there is none on this machine. Measuring against
Neon would produce a meaningless number — network RTT dominates, and Neon's
copy-on-write storage layer has entirely different characteristics from a local
data directory. The ~100 ms figure in the previous document was typical, not
observed, and remains unverified. It becomes a one-job measurement the moment CI
or a local install exists.

---

## 9. Updated ordering, with dependencies

### Decided already — nothing blocks these

1. **Edit `reports/engineering-hardening-plan.md` §3** — replace
   vitest/coverage-v8 with `bun test`, and drop `@testcontainers/postgresql`
   pending the §2 decision. It currently contradicts the Bun-first rule and
   would be followed by anyone reading it.
2. **Add `tests/unit/`** — pure logic, no IO, no infrastructure decision
   required. `lib/permissions/checker.ts` first, per the plan's own priority
   order: a bug there is a full auth bypass, and it needs no database. Unblocked
   today, and the highest-value work on the list.

### Blocked on §2 — where integration tests run

3. Add the `test` job to `.github/workflows/ci.yml` with a Postgres service
   container. This in turn unblocks the branch-protection required-checks list
   and the Renovate automerge revisit, both already open in the plan.
4. Build the harness: `Bun.sql` for `CREATE DATABASE … TEMPLATE`, drizzle
   migrations into the template, a database per test file. Identical code local
   or CI; only `DATABASE_URL` differs.
5. Measure the `TEMPLATE` cost. Falls out of step 4 for free.

### Blocked on §3 + §5 — which driver, which store

6. **Swap the database driver** to the one the VPS will run. `Bun.sql` +
   `drizzle-orm/bun-sql` versus `postgres-js`; needs the spike from §7.
7. **Rewrite `withTransaction`.** The per-transaction `Pool` creation must go.
   Cannot be validated before 6.
8. **Replace `@upstash/ratelimit`** with an owned sliding window over an
   in-process store, with the eviction problem from §5a designed for rather than
   inherited from `lru-cache` defaults.
9. **Port the two `dev-live` probes** onto the harness. They become real tests,
   intent unchanged. Only meaningful after 4 and 6 — porting them onto
   Neon-shaped infrastructure means porting them twice.
10. Handler-level integration tests through `lib/http/adapters/next.ts`.

### Critical path

**1 → 2 → (§2 decision) → 3 → 4.** Steps 6–9 need the §5 answer, but §5 does not
have to be settled now: nothing before step 6 depends on it, and step 2 is a
week of useful work that no decision blocks.

The one thing worth resolving soon is **§2**, because step 3 unblocks two items
the plan already lists as open, and the answer looks like "GitHub Actions
service container" at essentially zero cost while the repo is public.

---

## 10. Test work routed out of the Elysia-migration review

Everything below is new working-tree state, uncommitted and unreachable from
`git log` — `app.ts`, `routes.ts`, `server.ts`,
`lib/http/{request,response-policy,route-manifest,after-response}.ts` did not
exist when §0–§9 were written, and none of those sections name Elysia, the route
table, or the SQLite driver. Nothing here duplicates them.

For each item: what to assert, the concrete failure it catches, and the seam —
in-process via `app.handle(new Request(...))` (no socket), a direct unit call
against an exported function, the existing boot smoke suite
(`scripts/smoke.ts`), or a spawned-process test that needs a real `Bun.serve`
socket or a real OS signal. No test code below; a separate pass implements it.

### 10.1 CORS preflight regression

**Assert.** An `OPTIONS` request against a registered path, carrying
`Access-Control-Request-Method` and
`Access-Control-Request-Headers: X-Captcha-Response`, gets back
`Access-Control-Allow-Headers` containing `X-Captcha-Response` (case-insensitive
membership in the comma-separated value). Also assert `Access-Control-Max-Age`
equals `600`.

**Why.** `@elysia/cors` (`node_modules/@elysia/cors/dist/cjs/index.js`) joins
`CORS_POLICY.allowedHeaders` into a fixed string once, at plugin construction,
and publishes it as a default header on every response via `app.headers(...)` —
it only mirrors the browser's own `Access-Control-Request-Headers` back when
`allowedHeaders` is left at its permissive `true` default, which this app does
not do. So the advertised list is exactly, and only, what `CORS_POLICY` names in
`app.ts`. A future edit that trims the array — as already happened once, per
`CORS_POLICY`'s own comment recording that the captcha header was missing from
both this file and `lib/http/adapters/hono.ts.disabled` — drops browser support
for that endpoint while every status-code check keeps passing, because the
preflight still answers `204` either way; only reading the header value catches
it. `maxAge` guards the same class of silent drift against the plugin's own
default (`maxAge = 5` in its source) — losing the override means the browser
re-preflights nearly every cross-origin request instead of caching for the
intended 10 minutes.

**Seam.** In-process via `app.handle(new Request(...))` against a real
`ROUTE_MANIFEST` path. The plugin answers `OPTIONS` from its own `onRequest`
hook unconditionally; no socket is needed.

### 10.2 Admission precedes body parsing

Three distinct properties; do not test them all the same way or through the same
seam.

**A. Oversized body rejected before buffering.** Assert a JSON POST and a
multipart POST, both past `MAX_REQUEST_BODY_BYTES` (8 MiB, exported from
`app.ts`), both return `413`. The limit is `maxRequestBodySize`, a `Bun.serve`
socket option (`app.ts`'s `serve: {...}`), not an Elysia route check — its
purpose is to stop Bun's own 128 MiB default from buffering an oversized body
before any per-route logic runs. Proving "before buffering," not merely
"eventually 413," requires the client to still be sending when the rejection
happens: a single `fetch` that awaits a fully-built oversized buffer and then
checks `status === 413` only proves the ceiling exists eventually. The stronger
version paces the write — a streaming/chunked request body, or a raw socket
write with a delay between chunks — and asserts the `413` (or a closed
connection) arrives while the client is still mid-write. Flag for the
implementer: confirm this Bun pin's `fetch` can pace an outgoing body before
committing to that shape; a raw `Bun.connect` socket is the fallback if not.
**Seam: spawned-process only.** `app.handle(new Request(...))` cannot observe
this at all — the `Request` handed to `.handle()` is already fully materialised
with no socket underneath, so the transport-level limit is never in the loop.

**B. A JSON-policy route sent `multipart/form-data` parses nothing.** Assert
that for a route declared `body: 'json'` in `routes.ts`, a POST with
`Content-Type: multipart/form-data` and a real multipart body yields
`await ctx.readJson() === null`, and that `await ctx.readFormData()` also
resolves `null` without the multipart parser ever running. This is
`withBodyPolicy`'s routing logic (`lib/http/request.ts`): each reader is gated
on `policy === … && essence === …`, and a forbidden reader is
`() => Promise.resolve(null)`, which never touches the request stream. Before
the reordering, the client's own `Content-Type` picked the parser — a JSON-only
dashboard route parsing attacker-chosen multipart data is exactly the defect
that closed. **Seam:** in-process via `app.handle(new Request(...))` against a
real `body: 'json'` route, or a direct unit call against the exported
`withBodyPolicy` — equally valid for this property, and cheaper.

**B2. Nothing is parsed before the handler runs.** This is the property that
distinguishes the current design from the first fix, which only reordered the
ADAPTER's own admission check. Both readers are lazy and `withBodyPolicy` is
synchronous, so a route whose only admission check lives inside its handler —
the OTP endpoints, `preAuth: 'none'` with their own per-identifier budgets —
also rejects before a byte is parsed. Assert it where it is observable: a
request to `POST /api/auth/otp/send` that the handler's own limiter rejects must
not have consumed the request body. **Seam:** a spy or an instrumented `Request`
whose `text()` records that it was called, driven through `app.handle(...)`.
Asserting this only against `withBodyPolicy` proves the reader is lazy, not that
the handler ordered its checks correctly — assert both.

**C. Both readers are memoised.** Assert that calling `readFormData` twice on a
`multipart` route, and `readJson` twice on a `json` route, returns the same
result both times (same `FormData` / same parsed value, or both `null` for a
malformed body) rather than throwing `Body has already been used` on the second
call — the guard is `memoise`'s `pending ??= read()`. **Seam:** direct unit call
against `withBodyPolicy` (`lib/http/request.ts`) with a real `Request` — no app
or route table needed.

### 10.3 Production launch smoke

**Assert**, booting the real production command with throwaway production-shaped
values (mirror `_env-secret-child.ts`'s `REQUIRED` map, plus
`NODE_ENV=production`):

- `Strict-Transport-Security` is present on a real response (value from
  `SECURITY_HEADERS`, `lib/http/security-headers.ts` — production-only).
- A relative `SQLITE_DIR` under `NODE_ENV=production` refuses to boot: no port
  ever binds, non-zero exit.
- A weak or absent `BETTER_AUTH_SECRET` refuses to boot: non-zero exit.
- `NODE_ENV=prodution` (misspelt) refuses to boot: non-zero exit.

**Why.** CI's "Boot smoke test" step (`.github/workflows/ci.yml`) sets
`NODE_ENV: development` explicitly, so none of the above four run today — the
whole production posture is unexercised by CI. The fourth case is the sharpest:
`lib/env.server.ts` only ever compares `NODE_ENV === 'production'`, so a
misspelling is silently treated as not-production and every guard it gates goes
slack. The rejection for an invalid `NODE_ENV` value lives only in `server.ts`'s
`requireNodeEnv()`, which runs _before_ `lib/env.server.ts` is even imported
(the dynamic `await import('./app')` happens after the checks). `server.ts`'s
own comment records this as a reproduced defect: a misspelt value "silently
disabled all four [guards] at once while the server still booted and served
traffic." A subprocess test that imports `lib/env.server.ts` directly — which is
all `scripts/probe/local/env-secret.test.ts` does — never goes through
`server.ts`'s gate and so cannot see this regression at all.

**Cross-reference, not a duplicate.** `env-secret.test.ts` already exhaustively
covers what makes a `BETTER_AUTH_SECRET` valid (length floor, whitespace, the
library default, `AUTH_SECRET`/`BETTER_AUTH_SECRETS` aliasing) via subprocess
against `lib/env.server.ts` directly. This item's job is narrower: confirm the
same floor still holds when reached through the real `bun run start` boot
sequence — one weak-secret case is enough here, not a re-derivation of the
individual rejection rules.

**Also assert** maintenance-token readiness: with a real
`SQLITE_MAINTENANCE_TOKEN` configured, `/api/health/storage`'s
`maintenanceTokenSet` field reports `true` — proving the production config
actually wired a token, which the development-mode smoke run has no reason to
exercise (a missing token 401s the sweep route regardless of environment, so
today's check is blind to whether a token was ever configured at all).

**Seam.** A second, sibling smoke run — spawned-process, same shape as
`scripts/smoke.ts` (spawn, poll, assert, kill) but spawning the real
`bun run start` command with production-shaped env, wired as a second CI step
alongside the existing one. The negative cases invert the existing suite's pass
condition — success means the process exits non-zero and a health fetch never
succeeds — flag that polarity difference so it isn't copied from
`scripts/smoke.ts` unchanged.

### 10.4 In-process conformance suite

Table-driven over `ROUTE_MANIFEST` (exported from `app.ts`), four assertions per
entry:

**Reachable.** A request satisfying the route's own `body`/`preAuth` policy
reaches the handler — the response is neither `404` nor `405`. "Reachable" means
the router dispatched to the intended handler, not that the handler succeeds.
This is the direct replacement for hand-verifying that every `routes.ts` entry
is actually wired into `app.ts`'s registration loop.

**Wrong method → `405` with a correct `Allow`.** A method not registered for the
path returns `405`, and `Allow` matches `allowHeader()`'s computed set
(`lib/http/route-manifest.ts` — `GET` implies `HEAD`, `OPTIONS` always
included). Elysia reports both "no such path" and "wrong method on a real path"
as the same `NOT_FOUND` (measured, per `app.ts`'s comment on `routeMiss`) —
nothing but the manifest can tell them apart.

**Trailing slash → `308`.** The same path with a trailing `/` returns `308` with
`Location` pointing at the canonical path. `strictPath: true` makes Elysia treat
the two as different resources; wrong canonicalisation here silently splits a
cache key and a security-rule match across two URLs for one resource.

**A case the manifest walk cannot reach on its own.** `ROUTE_MANIFEST` is
`toManifest(ROUTES)` — it does not include `ROUTE_PREFIXES` (Better Auth's
`/api/auth` prefix), even though `createRouteLookup(ROUTES, ROUTE_PREFIXES)`
folds prefixes in at runtime for the 405 boundary. The wrong-method-on-
`/api/auth/*` case (only `GET`/`POST` registered; `PUT`/`DELETE` must `405`)
needs one hand-written assertion against `ROUTE_PREFIXES`, not something
derivable from iterating the manifest.

**Manifest completeness.** Every `handler.ts` under `app/api/**` is imported by
`routes.ts`, and every `ROUTES` entry declares both `preAuth` and `body`. On the
first half: `scripts/find-unused-files.ts`'s `assertHandlersRegistered` already
performs exactly this check, but it is a standalone script
(`bun run find:unused-files`) wired into neither `.github/workflows/ci.yml` nor
`lefthook.yml` — today it only runs if invoked by hand. Folding the same
assertion into this suite is what actually makes it CI-enforced, since this
suite runs under `bun run test`. On the second half, stated honestly:
`preAuth`/`body` are required fields on `RouteDefinition` — omitting either is
already a compile error, so a runtime assertion here is cheap insurance against
a future loosening of the type (an optional field, an `as RouteDefinition` cast)
rather than something that catches anything reachable today. Keep it for the
price; don't oversell it.

**Seam.** Entirely in-process via `app.handle(new Request(...))` — the reason
`app.ts` was split from `server.ts` in the first place.

### 10.5 Response policy

**A. A route's own conflicting header loses.** Assert that a handler returning a
native `Response` carrying its own `Content-Security-Policy` still shows the
application's CSP (`SECURITY_HEADERS`, `lib/http/security-headers.ts`) on the
wire. Measured on the pinned `elysia@1.4.29` (`lib/http/response-policy.ts`'s
own comment): a header on a native `Response` a route returns wins over the same
key set into `set.headers`, so a route's own CSP silently replaced the global
one before `mapResponse` existed to overwrite it back. **A wrinkle for the
implementer:** no handler under `app/api/**` currently sets a custom CSP or any
`HandlerOutput.headers` at all (checked), so there is no existing route to
exercise this end-to-end. A direct unit call against `applyResponsePolicy` with
a `Response` carrying a conflicting header proves the function's own overwrite
logic, but says nothing about whether `app.ts`'s hook _registration order_ still
puts `mapResponse` where it needs to be — that needs a route dispatched through
the real pipeline. Do not mutate the shared `app` singleton exported from
`app.ts` to add a throwaway route for this: `bun test` runs test files
sequentially in one process by default (§8), so a route added to the shared
instance in one file leaks into every other file's `app.handle()` calls for the
rest of the run. Build a second, minimal Elysia instance in the test file, wired
with the same hook chain (`onRequest` → `cors` → `mapResponse` → `onError`), and
one throwaway route on that instead.

**B. `Cache-Control: no-store` on every response, including error paths.** The
`404`/`405` cases fall out of §10.4's manifest walk for free. For a genuine
`500`: composing `toWebResponse(handleApiError(new Error(...)))` through
`applyResponsePolicy` — the exact pipeline `app.ts` runs for an
application-level throw — is enough to prove the default holds, without needing
to provoke Elysia's own framework-level `onError` branch (which `handleApiError`
already intercepts almost everything before it reaches, by design).

**Seam.** In-process via `app.handle(new Request(...))` for the routing-level
cases; a direct unit call against `applyResponsePolicy` for the
header-precedence function itself; a purpose-built second Elysia instance (never
the shared `app`) for the end-to-end registration-order proof.

### 10.6 Cookie forwarding

**Assert.** A `HandlerOutput` with two or more cookies (at least one carrying
`extraFlags: ['Partitioned']`) survives `toWebResponse` → `applyResponsePolicy`
with every `Set-Cookie` value intact and distinct —
`response.headers.getSetCookie()` returns N separate values, not one
comma-joined line, and `Partitioned` (or any other `extraFlags`/`extra`
attribute) is still present on the value that carried it.

**Why.** `serializeSetCookie` (`lib/http/contract.ts`) is the one place that
renders a `HandlerCookie` back to a header line, including attributes neither
Next's nor Elysia's own cookie API models. `applyResponsePolicy`'s fallback path
— triggered when `response.headers.set(...)` throws on an immutable header bag —
rebuilds the `Headers` object and separately has to re-append every `Set-Cookie`
value via `getSetCookie()`, specifically because `new Headers(headers)` folds
repeated values into one comma-joined line, which browsers reject as a cookie
header. Two independent places two cookies can be silently merged into one
broken line; prove both survive.

**Two seams for two properties.** `serializeSetCookie` is the unit — feed it a
`HandlerCookie` with `extraFlags`/`extra` set and assert the rendered string
contains them; no app needed. The wire is the integration — the multi-cookie,
comma-join-proof property needs an actual `Response` to run `getSetCookie()`
against. The immutable-headers fallback branch specifically has no current
caller in this codebase that constructs an immutable-header `Response`
(`app.ts`'s own redirect deliberately avoids `Response.redirect()` for exactly
this reason) — exercise it with a direct unit call against `applyResponsePolicy`
fed a `Response.redirect(...)`-built response, since nothing in the live route
table produces one to catch this through `app.handle()`.

### 10.7 SQLite invariants — replacing what the current probes do not cover

**a. The migration "concurrency" test is not concurrent, and does not call the
production code.** `_sqlite-semantics-child.cjs`'s
`[runMigration(), runMigration(), runMigration()]` are three synchronous
function calls evaluated in array-literal order, in one process, one after
another — nothing about that is concurrent. It also builds its own `Database`,
runs its own PRAGMA sequence and its own `user_version` dance inline, rather
than calling `openDatabase` (`lib/sqlite/database.ts`) and a real migration list
— so a regression in `migrate()`'s actual `BEGIN IMMEDIATE` locking strategy
would not be caught, because the test never calls that function. **What a
genuine version needs:** real OS processes, not real function calls — spawn N
(3–8) separate `bun` child processes via `Bun.spawn`, each pointed at the same
file path through env (mirror the existing children's temp-directory pattern),
each calling the production path (`getRateLimitStore()` in
`lib/rate-limit/store.ts`, which calls `openDatabase` with the real
`MIGRATIONS`), started via `Promise.all` over the spawns rather than awaited one
at a time so their process starts and connection opens genuinely race. Assert
every child exits `0` (the historically reproduced failure was a loser process
throwing `table rate_limit already exists`, per `lib/sqlite/database.ts`'s own
comment on `migrate`), and that a fresh connection afterward reads
`user_version === RATE_LIMIT_SCHEMA_VERSION` with the schema applied exactly
once.

**b. `sqlite-semantics.test.ts` never exercises Better Auth's own statements.**
The child receives `SQL_CONSUME`, `SQL_SWEEP_RATE_LIMIT` and `SQL_ANY_EXPIRED`
(extracted from `lib/rate-limit/store.ts`) but never `SQL_AUTH_CONSUME`,
`SQL_AUTH_GET` or `SQL_AUTH_SET` — the three statements behind Better Auth's
login-limiter storage contract, against the separate `auth_rate_limit` table.
Assert `SQL_AUTH_CONSUME` is max-aware the same way `SQL_CONSUME` is already
proven to be (admits exactly the limit, zero writes on denial, correct window
rollover — the same three properties, run the same way, against the auth table).
Assert `SQL_AUTH_GET` excludes expired rows (`WHERE ... expires_at > ?`). Assert
`SQL_AUTH_SET` overwrites on conflict
(count/window_start/last_request/expires_at all replaced) rather than
accumulating.

**c. `auth-storage-log-boundary.test.ts` tests the boundary function, not the
storage.** The file's own header says so: it asserts `describeAuthStoreFailure`
in isolation because, when it was written, importing the real
`authRateLimitStorage` under Bun would hard-panic (`better-sqlite3`). That
blocker is gone — the driver is `bun:sqlite` now — and the file's own `TODO`
names the fix: force a real failure out of the real storage (an unwritable
`SQLITE_DIR` is the cheapest reliable way) and prove the same containment
property — no IP, no key, no path — holds through the actual
`catch → sanitizeForLog → console.error` wiring in
`lib/rate-limit/auth-storage.ts`, not just through the extracted function.

**d. The manufactured error name proves nothing, and the codebase already says
so.** Both `auth-storage-log-boundary.test.ts:49` and
`rate-limit-log-boundary.test.ts:42` hand-author
`class LeakyDriverError extends Error { override name = 'SqliteError'; }`.
Measured: `bun:sqlite` throws a plain `Error` whose `.name` is reassigned to
`'SQLiteError'` (capital L, capital E — not the fixture's spelling) and whose
`.constructor.name` is just `'Error'` — not a real subclass at all, unlike the
fixture. `errorClassOf` (`lib/rate-limit/store-failure.ts`) reads only
`error.name`, so every assertion of the shape
`expect(d.errorClass).toBe('SqliteError')` is circular: it passes because the
fixture set `.name` to that exact string, and would pass identically for any
invented spelling — it says nothing about what `errorClassOf` reports for a
_real_ driver error. `store-failure.ts`'s own comment names this precisely: "the
probe suite still manufactures the Node spelling, which is a test defect
recorded in reports/test-strategy.md" — this is that record. Fix both fixtures
to the real spelling, and add at least one assertion per file whose error comes
from an actual `bun:sqlite` failure (e.g. a real `SQLITE_CONSTRAINT_PRIMARYKEY`
from a duplicate-key insert against a real table through the production driver)
rather than a hand-authored class, so containment is proven against what the
driver actually throws.

**e. Statement finalisation.** `openConnection` (`lib/sqlite/driver.ts`) now
tracks every statement it prepares in a `live` set and, on `close()`, finalises
all of them before calling `db.close(true)`. Assert two things: a connection
with statements prepared through it (never explicitly finalised by the caller)
closes without throwing — proving the tracked statements are what get finalised;
and a statement handle obtained before `close()` genuinely stops working
afterward — calling `.get()`/`.run()` on it throws rather than silently
returning rows. The second is the regression proof: the module's own comment
records that before this fix, a statement prepared from a connection then
`db.close(false)`'d "still returned rows afterwards" — the handle, its file lock
and its memory were all still held. A test that only checks `close()` doesn't
throw would not catch that regression coming back; it has to reuse the pre-close
statement handle afterward and expect failure.

**f. `busy_timeout` before `journal_mode = WAL`.** `applyPragmas`
(`lib/sqlite/database.ts`) now sets `busy_timeout` first, specifically because a
fresh `bun:sqlite` connection reads back `busy_timeout = 0` and
`journal_mode = WAL` is itself lock-taking. Two separate assertions, not one:
the read-back value (`describeDatabase(db).busyTimeout === BUSY_TIMEOUT_MS` on a
fresh connection via the real `openDatabase`) proves the final state; it does
not prove the _order_. Proving the order needs a real lock to contend with —
hold a write lock on the same file from a second connection (e.g. an uncommitted
`BEGIN IMMEDIATE` via `openConnection` directly, bypassing migrations), then
open a fresh connection against that file through `openDatabase` and assert it
_waits_ for the lock to clear rather than failing `SQLITE_BUSY` immediately:
that wait is only possible if `busy_timeout` was already non-zero by the time
the lock-taking `journal_mode = WAL` pragma ran. Two connections to one file
within a single Bun process should reproduce SQLite's own locking correctly
(locking is file-level, not process-level), but this is worth the implementer
confirming rather than assuming, given this codebase's own standing rule of
measuring PRAGMA behaviour rather than trusting documentation
(`lib/sqlite/database.ts`'s header).

**Seam, all of 10.7.** Spawned child processes against the real `bun:sqlite`
driver throughout — same shape as the existing `_sqlite-semantics-child.cjs` /
`_cache-prefix-child.cjs` children (a separate process so a failed case cannot
leak an open file handle), extended to genuinely concurrent spawns for (a)
rather than same-process sequential calls.

### 10.8 Shutdown

**Assert.** A request already in flight when `SIGTERM` arrives completes
normally — its `fetch()` resolves with the real response, not a connection reset
— and the process exits within the bounded window (`SHUTDOWN_TIMEOUT_MS`, 15 s,
plus margin). Separately, sending the signal twice in quick succession (or
`SIGTERM` then `SIGINT`) runs the shutdown sequence exactly once: one
`"server stopping"` / `"server stopped"` log line each, no duplicate close
attempt on the rate-limit or cache store.

**Why.** `app.stop()` with no argument drains; `app.stop(true)` aborts —
`server.ts`'s comment records that the previous wiring
(`process.on('beforeExit')`, not a real signal handler) never fired on Coolify's
stop-first `SIGTERM` at all, so in-flight mutations, uploads and external calls
were simply terminated. The idempotency guard (`stopping` boolean) exists
because a container orchestrator's grace period is not a promise that exactly
one signal arrives.

**A gap worth naming.** No current route has a deliberate, controllable delay,
so catching a request reliably "in flight" at the moment the signal is sent is a
real scheduling problem, not just a matter of firing a request and a signal
close together. The more robust shape: fire a burst of concurrent requests
against an already-registered lightweight route, send the signal shortly after
the burst starts (before all of them can plausibly have finished), and assert
none of the in-flight ones error out — rather than depending on one request
timed precisely against the signal.

**Seam.** Spawned-process only — this is real OS signal delivery to a real
process; `app.handle()` has no process to signal, and the existing boot smoke
suite neither sends signals nor measures drain timing. A new suite, sibling to
`scripts/smoke.ts` in shape (spawn, interact over real HTTP, this time also
signal and measure).

### 10.9 Bun test-runner features: `--coverage` and `--coverage-threshold`

Short, by design. `--coverage`/`--coverage-reporter` are already named as
Bun-first in §7; `--coverage-threshold` is the new piece — a CI gate, not just a
report.

A blanket, repo-wide threshold would be theatre twice over. Most of the codebase
(`app/api/**` business logic, permission checking, most of `lib/`) has no tests
after this pass either, so a repo-wide number is either meaningless-low or an
immediate, expected failure. Sharper: coverage instrumentation only sees code
executed _inside_ the `bun test` process. `server.ts`, and every path this
section's own spawned-process tests exercise (§10.2's oversized-body case,
§10.3's production boot, §10.7's multi-process migration race, §10.8), run in a
_child_ process that `bun test --coverage` never instruments — a naive threshold
would report those lines as uncovered regardless of how thoroughly the
spawned-process suites actually exercise them, penalising exactly the code this
pass tests most rigorously.

Where a threshold is meaningful: scoped to what §10.4's conformance suite and
§10.7's SQL invariant tests exercise completely by construction —
`lib/http/route-manifest.ts`'s pure functions, `lib/http/request.ts`,
`lib/http/response-policy.ts`, `lib/http/contract.ts`. A high threshold there is
a real gate: a drop means a branch of the dispatch or admission logic escaped
the table-driven walk. Everywhere else, report coverage without gating on it
until tests exist to make the number mean something.

### Seam summary, for sequencing

In-process (`app.handle`) and direct-unit assertions — §10.1, most of §10.2,
§10.4, most of §10.5, the unit half of §10.6 — are cheap and belong in the
existing `bun run test` step with no CI change beyond new files. Spawned-
process assertions — §10.2's oversized-body case, all of §10.3, §10.7's
multi-process migration race, §10.8 — are slower and each owns a real socket, a
real child process, or a real signal; group them into their own step (or extend
the existing "Boot smoke test" step) rather than folding them into
`bun run test`, for the same reason `scripts/smoke.ts` is already a separate CI
step from the probes.

### 10.10 Regressions this section exists because of

Added after an external verification pass found six defects in the
implementation that the suites above would not have caught. Each is now a
required assertion, because each shipped once.

**A. `bun install --frozen-lockfile` must succeed.** `package.json` was edited
without regenerating `bun.lock`, so every CI install job would have failed while
every local command passed — `node_modules` was already populated. Assert it as
its own step, before anything else runs: no test that assumes an installed tree
can detect this.

**B. `auth.options.baseURL` must equal `PUBLIC_ORIGIN`.** The canonical-origin
parse was added to `lib/env.js` and `lib/auth.ts` was not switched over, so
Better Auth kept reading `process.env.NEXT_PUBLIC_URL` — and once CI moved to
the new `PUBLIC_URL` name, `baseURL` was `undefined`. Session cookies are signed
against that value. Assert the two are identical under an environment that sets
ONLY `PUBLIC_URL`; asserting under an environment that sets both hides exactly
this bug.

**C. Every route declaring a body policy must appear in the OpenAPI document
with a matching request body.** Two routes declared `body: 'json'` and had no
`requestBody` in the document because their schemas were module-private. Assert
it as a cross-check between `ROUTE_MANIFEST` and `openApiDocument(...)`, not by
inspecting the document alone.

**D. `operationId` must be unique across the whole document.** Four Better Auth
operations shared one object between `get` and `post`, which is invalid per
OpenAPI 3.1 §4.8.10 and breaks generators. A one-line uniqueness assertion over
every operation catches the whole class.

**E. Every route must be IN the route table.** `/openapi.json` was registered
directly on the framework instance, so it silently had no 405 boundary, no
trailing-slash redirect and no route-aware OPTIONS — the manifest could not see
it. Assert that the set of paths the server answers equals the set the manifest
declares; a route registered outside the table is invisible to every check that
walks the manifest.

**F. The 405 boundary must not claim paths that do not exist.** `ROUTE_PREFIXES`
matched the whole `/api/auth` prefix, so `PUT /api/auth/does-not-exist` answered
`405 Allow: GET, POST` while `GET` on the same path answered `404`. Assert both
halves for a path outside `BETTER_AUTH_ALLOWED_PATHS`: every method must be
`404`, and `OPTIONS` must not be `204`.

**G. The forced-shutdown bound must exceed the longest a request may run — BOTH
ceilings.** A flat 15 s bound would have aborted the 120 s upload the route
ceiling exists to permit. It is derived; assert the invariant rather than the
number, so raising a route's `timeoutSeconds` cannot silently invalidate it
again.

**Corrected after this entry shipped:** the invariant is
`SHUTDOWN_TIMEOUT_MS >= (max(IDLE_TIMEOUT_SECONDS, MAX_ROUTE_TIMEOUT_SECONDS) + 15) * 1000`,
not `MAX_ROUTE_TIMEOUT_SECONDS` alone. The per-route maximum is only the right
answer while it happens to be the larger of the two, and it is today (120 > 60)
purely by coincidence of the current table. Asserting the one-term version would
have passed while the two-term invariant was violated — which is exactly what
`reports/coolify-deployment.md` §12.2 tells the operator to do (lower the upload
ceiling to 30 s for a shorter deploy window), leaving a 45 s bound against a
global ceiling that still permits 60 s requests. **Assert the two-term form**,
and assert it against a route table where the global ceiling is the larger term,
or the test proves nothing that the one-term version did not.

---

## 10.11 Assertions from the verification-adjudication pass

Added after an independent adjudication of
`reports/elysia-migration-implementation-verification.md` against the response
to it. Everything here is either a defect that was found and fixed in that pass,
or a property that was measured by hand and is currently protected by nothing.
Same rule as §10.10: each one shipped, or could have.

**A. The OpenAPI consistency check must fire on every drift shape.**
`openApiConsistencyProblems(manifest)` (`lib/http/openapi.ts`) is exported for
this. Assert it returns empty for the real table, and non-empty for each of: a
route declaring `body: 'json'` with no `REQUEST_BODIES` entry; a
`REQUEST_BODIES` key matching no route; a `CREATED_ROUTES` key matching no
route; a route that keeps its schema after its body policy drops to `none`.
Assert separately that `openApiDocument` THROWS on each, because the CI gate is
the 500 that produces — `scripts/smoke.ts` asserts `GET /openapi.json` is 200.
Without the throw the check is decorative. This is the class of the
two-routes-with-no-request-body defect; adding the two schemas fixed the
instances and nothing else.

**B. Documented `required` must match runtime optionality.** For every request
body in the generated document, assert that a body omitting each listed-required
key is REJECTED by the corresponding Zod schema, and that a body omitting each
NOT-required key is not rejected for that reason. This is the sharpest form and
it catches the converter defect directly:
`z.toJSONSchema(schema, { io: 'input' })` reports `required: []` for
`createUserSchema` because `emailSchema` and `passwordSchema` are
`z.preprocess`, while the runtime rejects `{}` with a 422 — so
`POST /api/dash/users` advertised seven optional properties, all of which are
required. `io: 'output'` is not the fix and must not be substituted: it marks
defaulted keys (`isActive`, `phoneNumber`) required in a request where they are
optional. Cover a discriminated union too (`sendOtpSchema`), where every branch
listed only `channel`.

**C. Statuses the server actually produces must be documented.** Assert `400`
and `422` appear on the operations that can return them. Both are derivable from
the manifest — `400` from a non-`none` body policy (`requireJsonBody`), `422`
from that OR a path parameter, since every `:id` route validates it — and both
were absent while `422` is the standard validation failure of every JSON route.
`401`, `403` and `409` remain undocumented and are NOT derivable from the
manifest today; if they should be, that needs a new manifest field, which is a
design change rather than a test.

**D. The registration scanner must fail on each hole that was open.** Four
cases, each verified to exit non-zero: a `handler: NS.METHOD` reference present
in `routes.ts` but OUTSIDE the `ROUTES` array (a dead const satisfied the gate,
because the regex ran over the whole file); an unrouted `export function POST`;
an unrouted `export { x as POST }`. Plus one case that must exit ZERO:
`export { GET as legacyGet }` alongside a routed `GET`, since the exported name
is not a method and a false positive here would train someone to disable the
gate. Assert the exit codes, not the message text.

**E. `Allow` must never name a method the path answers 404 for.** For every path
the manifest knows, assert that each method in `Allow` returns something other
than 404. This catches the shape generically; the specific one it was written
for is `HEAD` — Elysia derives it from a `GET` route in the table but NOT from
the Better Auth wildcard, so `Allow: GET, POST, HEAD, OPTIONS` on `/api/auth/*`
named a method answering 404. That is `RoutePrefix.paths`' over-claiming defect
surviving in the method dimension after it was fixed in the path dimension.

**F. One URL shape, one answer, on every method.** For a real path, assert every
method on its trailing-slash form returns `308` with the same `Location` —
INCLUDING `OPTIONS`, which answered `404` while every other method redirected,
because the route-aware OPTIONS gate runs before the router and did not
canonicalise. For an unknown path, assert every method on the slash form returns
`404` and none returns `308`, so the redirect never becomes a path oracle.

**G. Forced shutdown must actually fire when the drain hangs.** The timer was
`unref`'d, so in the one shape it exists for — `app.stop()` resolved, listener
closed, nothing after it settling, no other ref'd handle — the process exited
**0** with no `forced shutdown` line and the store closes never ran. Assert a
non-zero exit and the log line for a hung drain. Note this needs a hang after
`stop()` resolves, not during it: a hang during `stop()` leaves a ref'd handle
and masks the defect.

**H. Record the real `app.stop()` semantics, and assert them.** Measured on
`elysia@1.4.29`: `stop()` DOES close the listener — a new connection is refused
as soon as it resolves — and what survives is an already-established keep-alive
connection, on which a further request is still served. Four in-repo comments
asserted the opposite, and the wrong version argued for a different fix. Assert
both halves: a new connection after `stop()` is refused, and a request written
on a pre-existing connection is answered.

**I. The access log's own claim.** It is not one line per request: `OPTIONS`
produces none, because both OPTIONS answers short-circuit in an `onRequest` hook
(the CORS plugin's 204 and the route-aware 404) and `onAfterResponse` never
fires for them. 404s, 405s and 308s DO appear. Assert exactly that set rather
than the slogan, so a future change that starts or stops logging preflights is
visible.

**J. The 413 needs a raw socket, not `fetch`.** Cross-reference to §10.2A, now
measured: the transport-level 413 is `HTTP/1.1 413 Request Entity Too Large`
with no body, no security headers, no envelope and no access-log line, and Bun's
own `fetch` surfaces it as a closed socket rather than as a status. A
`fetch`-based assertion of `status === 413` cannot pass. Use `Bun.connect`.

**K. `lib/http/adapters/hono.ts.disabled` is unverifiable by construction and
drifted.** It called `attachBody`, deleted three changes ago, and nothing caught
it because `.ts.disabled` matches no tsconfig include and no test. The same
file's CORS policy was extracted into `CORS_POLICY` precisely so it could not
drift again; the body contract — the security-relevant half — drifted anyway.
Either give it a check that can fail (a scanner rule that every identifier it
imports from `lib/http/*` still exists, which is cheap and static) or accept
that it is prose and stop describing it as "the working adapter". Do not leave
it as code that looks maintained and is not.

**L. What the probe count now proves.** `bun run test` runs **150 assertions
across 9 files**, up from 60 across 6. `log-serializer`, `permission-schema` and
`time-dst` were CLI-style probes without the `.test.ts` suffix and had never
executed in CI; they are converted, not merely renamed — a bare rename would
have been worse, because their explicit exit inside a test file ends the whole
run and silently skips every file after it. If another probe is added in the CLI
style, that trap is still open: a check that every file under
`scripts/probe/local/` either matches the test glob or is a `_`-prefixed fixture
would close it.
