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
