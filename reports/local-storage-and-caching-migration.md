# Replacing Upstash Redis with Local Storage — Rate Limiting and Caching on Bun and Coolify

**Date:** 2026-08-16 **Status:** analysis only. No code changed. **Scope
reviewed:** `lib/rate-limit/client.ts`, `lib/rate-limit/index.ts`,
`lib/rate-limit/store-failure.ts`, `lib/rate-limit/auth-storage.ts`,
`lib/rate-limit/api.ts`, `package.json`, `next.config.js`

> This document merges two independent analyses of the same question. Where the
> two agreed, the material is stated once. Where they disagreed, the
> disagreement is shown explicitly in
> [section 10](#10-where-the-two-analyses-disagree) rather than resolved
> silently.

**Target environment (as clarified):**

- One privately managed VPS, deployed through Coolify.
- Bun is the runtime.
- Next.js will be removed in favour of Hono or ElysiaJS.
- Vertical scaling only (more cores on one box); several Bun processes on the
  same VPS are possible later.
- Horizontal scaling explicitly out of scope.
- The chosen local technology may also serve GET/response caching.

---

## 0. Executive summary

**Use `bun:sqlite` in WAL mode as the authoritative rate-limit store**, with a
hand-rolled approximate sliding window, behind a framework-agnostic storage
module on a Coolify persistent volume. Keep rate-limit state in its own SQLite
file, separate from cached data. Add a shared cache tier and a local
Valkey/Redis service only when measurement — not anticipation — justifies them.

| Concern                                | Initial storage                       | Later optional tier                         |
| -------------------------------------- | ------------------------------------- | ------------------------------------------- |
| Security-sensitive rate limits         | Dedicated file-backed SQLite database | Local Valkey if contention becomes material |
| GET / response cache                   | Second SQLite database (see §10.1)    | Bounded per-process memory L1 once measured |
| Expensive cache worth keeping warm     | Shared SQLite cache file              | Memory L1 in front of it                    |
| Business data required for correctness | Primary application database          | Backups and normal durability controls      |

Five settings must be in place **from the start, not retrofitted**: WAL mode,
`synchronous = NORMAL`, `busy_timeout`, `expires_at` filtering on every read,
and the expiry sweeper running as a Coolify Scheduled Task rather than an
in-process `setInterval`. Retrofitting `busy_timeout` after fanning out to
multiple processes means debugging intermittent fail-open events under load.

**Two questions to resolve before or alongside this work:**

1. **Does Postgres stay on Neon?** The project uses `@neondatabase/serverless`.
   If the database stays hosted while the app moves to the VPS, that network hop
   dominates request latency far more than any choice in this document, and
   "reduce load on the database" changes meaning entirely. This is a bigger
   decision than the cache.
2. **Do Coolify's scheduled backups cover arbitrary persistent volumes, or only
   managed database resources?** If only the latter — which appears to be the
   case — the SQLite file gets no automatic backup, and a backup scheduled task
   must be budgeted into the same work. This is the single biggest operational
   gap in the SQLite path. _Verify before committing._

---

## 1. What the clarifications settle

Three previously open questions are now closed, and they simplify the decision
considerably.

**Bun is guaranteed to be the server runtime.** Dropping Next.js removes the
only reason to doubt whether `bun:sqlite` and `Bun.redis` would be importable at
runtime. Both are built into Bun with no npm dependency. This was the largest
uncertainty in the original analysis and it resolves favourably.

**Anything Next.js-specific is a dead end.** `unstable_cache`, `use cache`,
`revalidateTag`, and custom `cacheHandler` implementations all disappear with
the framework. Do not invest there. Whatever is built must be a plain module
with no framework import in it — then the Hono/Elysia migration touches routing
only and never touches storage.

**Horizontal scaling is out, but multi-process is not.** "One VPS" does not mean
"one process". This distinction does most of the work in
[section 5](#5-vertical-scaling-and-multiple-bun-processes).

### The constraint that rules out pure memory

`OTP_GLOBAL_SEND_CAP_PER_DAY = 2000` (`lib/rate-limit/api.ts:119`) is a global
money cap on sends, not a per-user limit. A store that resets on restart resets
this cap on every redeploy: ten deploys in a day means twenty thousand sends
available. A restart of a memory-only store turns a daily budget into a
per-process-lifetime budget. This single line rules out a pure in-memory store
as the authoritative one.

---

## 2. What the current code actually depends on

The migration is broader than replacing one client import.

- **`lib/rate-limit/client.ts`** is the only production module that imports
  `@upstash/redis` directly.
- **`lib/rate-limit/index.ts`** also depends on `@upstash/ratelimit`. That
  library executes Redis server-side scripts, so a non-Redis backend is not a
  simple client swap — the limiter integration must be replaced or rewritten
  regardless of which substrate is chosen.
- **`lib/rate-limit/auth-storage.ts`** is another real consumer of the shared
  Redis client, even though it was not in the original list.
- **`lib/rate-limit/store-failure.ts`** performs no storage operations. Its
  Upstash-specific justification will become obsolete, but its privacy rule
  remains important.

### The current algorithm

The API limiter uses `Ratelimit.slidingWindow` — an atomic, _approximate_
two-bucket sliding window (current window plus weighted previous window), not an
exact request log and not a plain expiring counter. Upstash documents the
weighting and approximation in its
[rate-limiting algorithm documentation](https://upstash.com/docs/redis/sdks/ratelimit-ts/algorithms).

This matters because swapping libraries can silently change traffic behaviour:

- An approximate sliding window is the existing behaviour.
- A fixed window is simpler but permits larger bursts near boundaries.
- A token bucket or GCRA controls bursts differently.
- An exact sliding log is precise but creates more rows, writes and cleanup.

Preserving the approximate sliding window during the storage migration is the
lowest-risk choice; an algorithm change can be evaluated separately afterwards.

### Atomicity is not optional

The main limiter protects sign-in, OTP delivery, verification, user mutations,
and the global daily OTP budget. The current Better Auth storage performs a
separate GET followed by SET. The installed Better Auth version supports an
optional atomic `consume` operation, but the current adapter does not provide
it. A new storage implementation should fix this rather than port the
read-modify-write race forward.

---

## 3. Effect of replacing Next.js with Hono or ElysiaJS

Removing Next.js makes the decision simpler:

- Next.js-specific server caches and cache handlers become irrelevant.
- The storage layer should expose a small framework-independent API so Hono and
  Elysia handlers use it identically.
- Both frameworks run on Bun's HTTP server, so Bun's process and storage
  behaviour — not the framework choice — determines the important trade-offs.
- Hono officially supports Bun through its fetch handler model; Elysia's
  production guide documents multi-core execution and states that Elysia on Bun
  uses `SO_REUSEPORT` by default. See the
  [Hono Bun guide](https://hono.dev/docs/getting-started/bun) and the
  [Elysia deployment guide](https://elysiajs.com/patterns/deploy).

Neither framework changes the central conclusion: process memory is private to
one Bun process, while SQLite or a local service can coordinate several
processes.

---

## 4. Storage substrate options

|                                               | Survives restart   | Survives multi-process | Atomic read-modify-write | Latency                          | Ops burden       | New deps   |
| --------------------------------------------- | ------------------ | ---------------------- | ------------------------ | -------------------------------- | ---------------- | ---------- |
| **A.** In-process `Map` / LRU / TTL cache     | ✗                  | ✗                      | ✓ (single-threaded JS)   | ~0                               | none             | 0–1        |
| **B.** `bun:sqlite` (WAL)                     | ✓                  | ✓                      | ✓ (transaction)          | ~0.05–0.3 ms                     | volume + sweeper | 0          |
| **C.** Valkey/Redis container + `Bun.redis`   | ✓                  | ✓                      | ✓ (Lua)                  | ~0.1–0.5 ms                      | +1 container     | 0          |
| **D.** Postgres (already yours)               | ✓                  | ✓                      | ✓                        | ~1–5 ms local, far worse on Neon | none             | 0          |
| **E.** LMDB (`lmdb-js`)                       | ✓                  | ✓                      | ✓                        | ~0.01 ms                         | volume           | 1 (native) |
| **F.** Keyv + `@keyv/sqlite` (+ Cacheable)    | ✓                  | ✓                      | ✗ (plain get/set)        | ~SQLite                          | volume           | 2–3        |
| **G.** `rate-limiter-flexible`                | depends on backend | depends                | ✓                        | depends                          | depends          | 1          |
| **H.** Plain files (`Bun.file` / `Bun.write`) | ✓                  | ✗ (for counters)       | ✗                        | varies                           | none             | 0          |

### A — In-process memory

Correct as a _hot-path optimisation_, wrong as the _only_ layer. Its real roles
are a non-authoritative read cache in front of a durable store, and possibly a
fallback when the durable store is unavailable.

- Fastest reads and writes, no disk or service.
- LRU/TTL libraries (`lru-cache`, `@isaacs/ttlcache`) provide bounded memory,
  per-entry expiry and eviction policy. `lru-cache` documents its size and TTL
  safety controls in its [repository](https://github.com/isaacs/node-lru-cache).

But: each Bun process has an independent heap; state disappears on restart,
deploy or crash; total memory is roughly per-process allowance × process count;
other processes do not see invalidations. Critically, **ordinary LRU eviction is
unsafe for security counters** — an attacker who forces a live rate-limit key
out of the cache effectively resets that quota.

### B — SQLite via `bun:sqlite` — recommended

Bun includes a native SQLite driver with prepared statements, transactions, BLOB
support, and file-backed or in-memory databases; Bun recommends WAL mode for
typical applications with concurrent readers. See
[Bun's SQLite documentation](https://bun.com/docs/runtime/sqlite).

**Advantages:** no npm storage dependency, no separate daemon or container,
atomic transactions give a strict check-and-consume operation, state survives
restarts when the directory is mounted persistently, several Bun processes on
the same VPS can open the same file, and it is easy to inspect and operate
compared with a specialist embedded KV store.

**Specifics that decide whether it works well:**

- **WAL mode is mandatory.** Without it every read blocks on every write and the
  whole API serialises. See the
  [SQLite WAL documentation](https://sqlite.org/wal.html).
- **`synchronous = NORMAL`** under WAL is the right durability/throughput trade.
  An OS-level crash may lose the last few writes; for rate-limit counters that
  is acceptable.
- **`busy_timeout` must be set** (a few seconds). Without it, concurrent writers
  get `SQLITE_BUSY` immediately instead of waiting — and the existing code would
  treat that as a store failure and fail open. This is a real, reachable bug if
  the setting is missed, and it becomes essential rather than optional once
  multiple Bun processes exist.
- **One writer at a time.** WAL allows readers to continue while a writer is
  active, but SQLite still permits only one writer per database file. SQLite's
  guidance is explicit about the
  [one-writer rule and high-concurrency boundary](https://www.sqlite.org/whentouse.html).
  For sub-millisecond counter rows this is fine at any traffic level a single
  VPS will see.
- **Local disk only.** WAL requires the `-shm` shared-memory file, which
  requires all processes on the same machine with real `mmap`. Never NFS or CIFS
  — SQLite's file locking is unreliable over network filesystems and the result
  is silent corruption, not an error.
- **`bun:sqlite` is synchronous.** A write blocks that process's event loop for
  its duration. Sub-millisecond and irrelevant for small counter rows; worth
  measuring before assuming it is free for large cached response bodies. Slow
  storage, long transactions, lock waits, checkpoints or maintenance can occupy
  a worker's event loop, so transactions must stay very short and p95/p99
  latency and `SQLITE_BUSY` events should be monitored.
- **Expired rows do not self-delete.** SQLite has no Redis-style automatic TTL
  or cache eviction. Expiry timestamps, read-time expiry checks, periodic
  deletion and disk budgets are all application policy. Without a sweeper the
  file grows forever.
- **Needs a Coolify persistent volume.** A container's writable layer is not
  deployment persistence. The mounted directory must contain the database and
  its WAL/shared-memory sidecars.
- **Rolling deploys briefly run two containers** against the same file. Safe on
  one host with WAL — this is exactly SQLite's designed multi-process case.

`Bun.SQL` with its SQLite adapter is an alternative built-in interface with the
same persistence and concurrency characteristics; it does not turn SQLite into a
multi-writer server. See [Bun.SQL](https://bun.com/docs/runtime/sql).

### C — Valkey or Redis as a second Coolify container

"Local" in the intended sense: on the VPS, no hosted service, no bill. Bun ships
a native RESP client (`Bun.redis`, Bun ≥ 1.2.9, including `VALKEY_URL` support),
so this adds zero npm dependencies — but it is only a client; a server must
still run. See
[Bun's Redis client documentation](https://bun.com/docs/runtime/redis).

**Advantages:** native TTL and active expiry, atomic increments and server-side
scripts, natural coordination across all Bun processes, strong eviction policies
(`maxmemory-policy allkeys-lru`) and shared locks, and — importantly —
**pub/sub**, which is the only clean way to invalidate a per-process memory
cache across processes. Persistence can be disabled for a disposable cache or
enabled via snapshots/AOF. See the
[Valkey introduction](https://valkey.io/topics/introduction/) and
[persistence documentation](https://valkey.io/docs/topics/persistence/).

**Cost:** another container to run, patch, monitor, secure and back up. Against
a stated preference for a small surface, that is a real cost, not a nominal one.
Note also that `@upstash/ratelimit` is built around the Upstash REST client, so
moving to a local RESP server still requires replacing that limiter integration.

**The condition under which this becomes the right answer** is specific and
worth writing down: _multiple Bun processes + an in-memory cache tier + a need
to invalidate that tier on write._ SQLite has no cross-process notification
mechanism; you would have to poll a version table. Valkey pub/sub solves it
directly. Until all three hold at once, SQLite is enough.

### D — Postgres

Already present, with Drizzle. Unlogged tables with
`INSERT … ON CONFLICT … RETURNING` give correct atomic counters across many
processes with no new infrastructure at all.

Two problems: the stated caching goal is _"reduce load on the database"_, so
putting the cache in the database inverts it; and if Postgres stays on Neon,
every rate-limit check becomes a network round-trip — re-creating the exact
problem being migrated away from.

Reasonable as a home for the **OTP global daily budget** specifically, since it
is low-volume, money-related, and benefits from living in the same transaction
as the send record. Not reasonable as the response cache.

### E — LMDB

The [`lmdb` package](https://github.com/kriszyp/lmdb-js) explicitly supports Bun
and provides embedded ACID storage, synchronous memory-mapped reads, async
batched writes, transactions, optimistic versioning, backups and multi-process
coordination. Faster than SQLite for pure key-value work.

But it is a native dependency (friction with the project's `ignoreScripts` /
`trustedDependencies` setup), less familiar operationally, has no query layer
for the sweeper, and still leaves TTL, cleanup and eviction as application
concerns. Only worth revisiting if SQLite writes are _measured_ as an actual
bottleneck.

### F — Keyv with `@keyv/sqlite`, optionally with Cacheable

The current `@keyv/sqlite` adapter supports Bun and prefers the built-in
`bun:sqlite` driver. It provides TTL metadata, lazy expiry, scheduled or manual
expired-row cleanup, namespaces, WAL options, busy-timeout configuration and
bulk operations. See the
[`@keyv/sqlite` documentation](https://keyv.org/docs/storage-adapters/sqlite/).
[`cacheable`](https://cacheable.org/docs/cacheable/) adds memory L1, a
Keyv-backed L2, memoisation, stampede protection, TTL propagation, statistics
and tag invalidation.

**Verdict:** a reasonable optional convenience layer for GET caching — it
removes custom cache lifecycle code. But Keyv's get/set/delete API is **not** an
atomic consume primitive and must never carry the limiter's concurrent
read-modify-write sequence. It also adds dependencies for storage Bun already
provides.

### G — `rate-limiter-flexible`

[`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible)
provides rate-limit algorithms, atomic counters, expiry cleanup and several
storage backends, plus mature result metadata. Its `insuranceLimiter` feature —
automatic fallback to memory when the primary store fails — is a cleaner
expression of the `degraded: true` fail-open at `lib/rate-limit/index.ts:89-95`.

**Unresolved discrepancy:** the two source analyses disagree on whether it has a
usable SQLite backend. One reports a documented SQLite adapter that uses
`sqlite3`, `better-sqlite3` or Knex rather than `bun:sqlite`; the other reports
no SQLite driver at all. Either way it does not document `bun:sqlite` support,
so it needs a focused Bun compatibility experiment before it can be paired with
option B. Its fixed-window behaviour also differs from the current approximate
sliding window, and it does not address GET caching.

### H — Plain files

`Bun.file` and `Bun.write` are useful for immutable or very large response
bodies, but plain files provide no key index, no automatic expiry, no safe
atomic counters, no transactions and no eviction. They must not be the
authoritative rate-limit store. SQLite metadata with file-backed large bodies is
a possible specialised design, but unnecessary until response sizes justify it.

---

## 5. Vertical scaling and multiple Bun processes

This is the question that most changes the analysis.

### First, a caveat on the premise

Vertical scaling does not automatically mean multi-process. Bun's JS execution
is single-threaded but its I/O is not, and a mostly I/O-bound API (DB queries,
S3, SMTP) frequently saturates several cores from one process. Adding cores may
well raise throughput with no process changes at all. **Measure before fanning
out** — the complexity below is worth accepting only once a single process is
demonstrably CPU-bound. `argon2` hashing is the most likely thing to make that
true, since it is deliberately CPU-expensive.

### The mechanism

Bun's documented multi-process approach is `Bun.serve({ reusePort: true })` —
`SO_REUSEPORT`, where the kernel load-balances connections across N independent
processes listening on the same port. (`node:cluster` also works in Bun but is
only partially supported; `reusePort` is the idiomatic path.) The kernel
distributes by connection hash, so the split is approximately even, not exactly
even. See Bun's [HTTP cluster guide](https://bun.com/docs/guides/http/cluster)
and Coolify's
[Bun/Node multi-core guide](https://coolify.io/docs/knowledge-base/nodejs-multi-core-scaling)
(note: application containers have no CPU cap by default unless one is
configured).

Every Bun process remains independent. There is no shared JavaScript heap.

### Which options survive

| Approach                        | Survives multiple Bun processes? | Important limitation                                                     |
| ------------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| Memory-only rate limiter        | **No — breaks silently**         | Each process enforces its own counter                                    |
| Per-process memory GET cache    | Yes, as L1 only                  | Duplicate entries, multiplied memory, delayed cross-process invalidation |
| File-backed SQLite rate limiter | Yes                              | One writer per file; transactions must be short                          |
| SQLite persistent/shared cache  | Yes                              | Good for read-heavy use; write contention and cleanup must be monitored  |
| Keyv SQLite L2                  | Yes                              | Its optional memory L1 remains process-local                             |
| LMDB                            | Yes                              | Native dependency and specialist operations                              |
| Local Valkey                    | Yes, naturally                   | Requires an additional service                                           |
| Postgres                        | Yes                              | Heavier; poor fit as a cache meant to reduce DB load                     |
| Plain files                     | Not safely for counters          | No transactional read-modify-write                                       |

**Memory breaks, and breaks silently — this is the worst failure mode in the
document.** N processes means N independent `Map`s. A limit of 5 requests per
minute becomes 20 per minute with 4 workers, because each worker enforces 5
independently and the kernel spreads the attacker's requests across all of them.
`OTP_GLOBAL_SEND_CAP_PER_DAY` becomes `N × 2000`. Nothing errors, nothing logs,
the limiter reports success, and protection is quietly divided by the number of
cores added. **Adding CPU cores would weaken the security posture.**

**SQLite survives — this is its designed case.** Multiple processes on one host
sharing one file with WAL is precisely what SQLite's locking model exists for.
Practical notes: writes serialise across all processes (fine for tiny counter
rows); `busy_timeout` becomes essential; the sweeper should run **once**, not
once per process — Coolify's Scheduled Tasks handles this, an in-process
`setInterval` does not; and because `bun:sqlite` is synchronous, a slow write
blocks one worker but not the others, so multi-process actually _mitigates_ that
particular weakness.

So vertical scaling costs three configuration items — WAL, `busy_timeout`, and
moving the sweeper out of the app process — and nothing architectural, provided
those three are in place from the start.

### Choosing the worker count

Base it on measurement, not on core count:

- More workers help when one Bun event loop is CPU-bound or has blocking
  synchronous work.
- Each worker consumes its own memory and owns its own L1 cache.
- More workers increase the number of potential SQLite writers.
- Database latency, storage IOPS and external API latency may be the real
  bottlenecks rather than CPU.

Useful measurements: CPU saturation, per-worker RSS, request p95/p99, SQLite
lock-wait time, `SQLITE_BUSY` frequency, cache hit rate, cache bytes, evictions,
and source-database queries per request.

### Concrete triggers for moving to local Valkey

- Repeated `SQLITE_BUSY` errors or measurable lock-wait latency despite short
  transactions.
- Rate-limit writes becoming a sustained hot path.
- A requirement for immediate cache invalidation across all Bun processes.
- Cross-process locks or pub/sub becoming common.
- Rolling-deployment overlap becoming operationally fragile.
- WebSocket or background-job coordination requiring shared ephemeral state.

None of these is implied merely by increasing the VPS from, say, two cores to
eight.

---

## 6. What Coolify actually provides

Coolify has **no caching, KV or rate-limiting feature of its own.** It is a
deployment and operations layer.

| Coolify feature                         | How it helps                                                                    | What it does not solve                                      |
| --------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Persistent volume or bind mount         | Keeps SQLite files across deployments                                           | Does not add TTL, eviction, or SQLite-aware backups         |
| Private Docker destination/network      | Lets the app reach a local Valkey/Redis service without a public port           | Does not remove the need to operate that service            |
| Bun multi-core deployment guidance      | Documents multiple Bun processes with `reusePort`                               | Processes still have separate memory                        |
| Health checks                           | Routes traffic only to healthy containers                                       | Does not verify cache correctness by itself                 |
| Rolling updates                         | Starts a healthy new container before stopping the old one                      | Temporarily creates two containers and shared-state overlap |
| Scheduled tasks                         | Runs the expiry sweeper, `VACUUM`, checkpoints, or a backup command — **once**  | Cleanup must not be the only expiry correctness check       |
| Monitoring and notifications            | Reports disk pressure, container state, deployment and scheduled-task failures  | Does not enforce an application cache disk budget           |
| One-click databases and custom services | Can run Redis, KeyDB, Dragonfly, or an arbitrary Valkey Compose service locally | Adds a separate service rather than embedded storage        |

### Persistent storage

Coolify supports Docker named volumes and host bind mounts. Both preserve SQLite
files between deployments; named volumes are more Docker-managed, bind mounts
expose an explicit host path and are simpler to inspect or migrate. Coolify
warns that sharing files across containers requires correct locking. See
[Coolify persistent storage](https://coolify.io/docs/knowledge-base/persistent-storage).
The mounted directory must hold the database _and_ its WAL/shm sidecars, on the
VPS's real local filesystem — this is the one Coolify feature option B strictly
depends on.

### Local Valkey-compatible service

Coolify's one-click database catalogue includes PostgreSQL, Redis, KeyDB,
Dragonfly, MongoDB, MySQL, MariaDB and ClickHouse. **Valkey specifically does
not appear to be in the catalogue** — but Coolify supports arbitrary
user-defined Docker Compose services, so it can still be run. Redis, KeyDB and
Dragonfly are all RESP-compatible and work with `Bun.redis`; KeyDB and Dragonfly
are multi-threaded, which is incidentally a better fit for vertical scaling than
single-threaded Redis. See
[Coolify databases](https://coolify.io/docs/databases/) and
[user-defined services](https://coolify.io/docs/services/introduction).

If a local service is used, place it and the Bun application in the same Coolify
destination/private Docker network and never expose its port publicly — the
store should not be internet-reachable at all. See
[Coolify destinations](https://coolify.io/docs/knowledge-base/destinations/create).

### Scheduled work

Coolify supports standard cron schedules and predefined hourly/daily schedules —
the clean place for expired-row deletion, cache-size enforcement, periodic
`VACUUM`, SQLite backup/checkpoint commands and maintenance metrics. With
multiple app processes it also solves the "N processes each running their own
sweeper" problem for free, since Coolify runs the task once. See
[Coolify cron syntax](https://coolify.io/docs/knowledge-base/cron-syntax).

**Expiry must still be checked on read.** If an hourly cleanup job is delayed or
fails, an expired-but-unswept row must remain logically unavailable.

### Backups

A persistent mount is not a backup. Coolify's documented managed-database backup
feature covers server databases such as PostgreSQL, MySQL/MariaDB and MongoDB;
it does not document automatic SQLite application-volume backups. See
[Coolify database backups](https://coolify.io/docs/databases/backups).

For this design:

- An ordinary GET cache should normally not be backed up — it must be
  rebuildable.
- Rate-limit state should survive routine deploys and restarts, but an off-host
  backup is usually not worth restoring because the values expire quickly.
- Anything that must survive loss of the VPS is business data, not cache, and
  belongs in the primary database and its backup plan.
- If SQLite volume backup is nevertheless required, use a SQLite-consistent
  process (`sqlite3 … .backup` or `VACUUM INTO`, shipped off-host) or stop the
  application. **Never copy only the main `.db` file while ignoring an active
  WAL.** Coolify's
  [volume migration guide](https://coolify.io/docs/knowledge-base/how-to/migrate-apps-different-host)
  recommends stopping the application for a clean volume backup.

### Reverse-proxy caching

Coolify's default proxy is **Traefik v3** (Caddy is an option). Traefik's
open-source build has **no HTTP response cache** — caching is an enterprise
feature or a community plugin (`souin`), and Caddy's equivalent needs a custom
`xcaddy` build. "Just cache at the reverse proxy" is therefore meaningfully more
friction under Coolify than it first appears. It remains the cheapest option
_if_ running a plugin-enabled proxy is acceptable; it is not a free default.

### Health checks and rolling updates

Coolify health checks can be configured through the UI or Dockerfile, and
Traefik routes only to healthy instances — so a container with a corrupt or
unmountable SQLite volume fails its check instead of silently serving a degraded
limiter. See
[Coolify health checks](https://coolify.io/docs/knowledge-base/health-checks).

Rolling updates start the new container while the old one is still running. Good
for availability, but two application containers may briefly access shared state
— a second, independent reason not to make memory authoritative, since the new
container starts cold. Rolling updates are not supported for Docker Compose
deployments. See
[Coolify rolling updates](https://coolify.io/docs/knowledge-base/rolling-updates).

For SQLite this implies: both containers must see the same persistent local
volume for counters to remain continuous; file locking and WAL must be
configured correctly; schema migrations must be compatible with old and new
application versions and must not race at startup. If this overlap is
undesirable, use a non-overlapping deployment or move shared transient state to
a local Valkey service.

**What Coolify does not solve:** none of the correctness questions. Atomicity,
TTL, eviction, invalidation and the fail-open/fail-closed policy are all still
application concerns.

---

## 7. Caching strategy

### The right axis to split on

The question to ask about each piece of data is not _how fast_ or _does it
persist_, but **what does losing it cost?**

| Data                                        | Cost of losing it                      | Therefore               |
| ------------------------------------------- | -------------------------------------- | ----------------------- |
| OTP global daily budget                     | Real money; cap resets on every deploy | Durable + authoritative |
| Auth rate-limit counters                    | Credential-stuffing window reopens     | Durable + authoritative |
| API rate-limit counters                     | Abuse window reopens                   | Durable + authoritative |
| OTP codes / sessions                        | Users logged out, flows break mid-way  | Durable                 |
| GET response cache                          | One extra database query               | Ephemeral is free       |
| Config / feature flags / permission lookups | One extra query, but read constantly   | Ephemeral, high value   |

A second axis appears once multi-process: **how many processes must agree on
this value?** Counters must agree — that is what makes per-process memory unsafe
for them. A cached response body does not need to agree; the worst case is a
lower hit rate.

### One interface, policy chosen per key

Expose a store module with `get` / `set` / `delete` / `increment`, where each
call site declares its durability requirement and the module routes accordingly.
Not two separate APIs sprinkled through handlers, and not a single rigid store
either. The benefits:

- Call sites never change when a memory tier is added or removed.
- The durability decision is visible at each call site instead of being an
  emergent property of which file was imported.
- The whole thing is framework-agnostic, so the Hono/Elysia migration does not
  touch it.

### Category 1 — ephemeral cache

Frequently read database results that are cheap to rebuild, short-lived
reference data, small computed values, safe negative results with very short
TTLs, endpoint data where bounded staleness is acceptable. Hard entry or byte
limit, TTL plus eviction, loss on restart acceptable.

### Category 2 — persistent / shared cache

Expensive deterministic aggregates, large computations that cause an undesirable
cold-start spike, results from slow or rate-limited external systems where
storage is permitted, and shared warm data that avoids every Bun process
querying the source independently.

Characteristics: separate SQLite cache database; values remain logically
disposable and rebuildable; expiry timestamp checked on every read; hard
disk/row budget plus periodic cleanup; shared across local Bun processes.

**Do not automatically persist every entry** — that converts every cache write
into disk work and complicates cleanup without necessarily improving
performance.

### Category 3 — durable application data

If losing a value causes incorrect balances, permissions, inventory, audit
history, job state or unrecoverable user data, it is not cache. It belongs in
the primary database with transactions and backups.

Likewise, secrets, bearer tokens, one-time credentials, `Set-Cookie`,
unrestricted personalised responses and authorisation truth must never go into a
generic shared response cache.

### Rate limits are their own category

Rate limits are temporary operational/security state, not ordinary cache:

- They need atomic consumption.
- Active records must not be evicted early.
- Some paths fail closed if the store fails.
- They contain sensitive identifiers.
- Their cleanup policy is TTL-based, not LRU-based.

**Keep rate limits and the GET cache in separate SQLite files.** Large cached
payloads and high-churn counters in one file compete for the same WAL and the
same write lock. A separate, disposable cache file — possibly on tmpfs, since
losing it is free — sidesteps this entirely and costs nothing. It also gives
each concern its own writer lock, so cache maintenance cannot delay a security
decision.

### Multi-process cache coherence

With several Bun processes, every memory tier is independent. A mutation handled
by one worker cannot directly clear another worker's memory. For this project's
expected scale, avoid building a distributed invalidation system prematurely.
Prefer:

- Short memory TTLs.
- Versioned cache keys when schemas or representations change.
- Invalidating the shared tier only after the source-of-truth transaction
  commits.
- Clearing the current worker's memory on local mutations.
- Bypassing memory for data that requires immediate freshness.
- Including every response-varying dimension in the cache key: normalised query,
  tenant/user/role where applicable, locale, and representation version.

If immediate cross-worker invalidation later becomes a genuine requirement, that
is a strong reason to add local Valkey pub/sub rather than inventing
SQLite-based messaging or polling a version table.

### Preventing cache stampedes

When an item expires, several requests or workers can try to rebuild it
simultaneously. Where measurement shows this happening — not indiscriminately on
every endpoint — apply:

- Per-process request coalescing for concurrent misses.
- Small TTL jitter so many hot entries do not expire at the same moment.
- Stale-while-revalidate for expensive data where bounded staleness is safe.
- A short expiring lease in the shared store if cross-process duplicate
  rebuilding becomes expensive.
- A hard timeout on loaders and leases so a crashed refresher cannot block a key
  indefinitely.

---

## 8. The rate-limit algorithm layer

Whatever substrate is chosen, the sliding-window logic that `@upstash/ratelimit`
provided still has to come from somewhere.

**1. Hand-rolled sliding window — recommended.** Roughly 40–60 lines. The public
surface is already tiny and well-fenced: one `rateLimit()` function and one
`BetterAuthRateLimitStorage` object. The standard two-bucket weighted
approximation (current window + weighted previous window) is what Upstash does
internally and is straightforward to verify with tests. **This is the only
option that works with SQLite**, and given the narrow interface the maintenance
cost is genuinely low. It also preserves the deliberate design decision recorded
at `lib/rate-limit/index.ts:98-104` — no refund primitive — rather than
inheriting a library that offers one.

**2. `rate-limiter-flexible`.** Mature and backend-agnostic, with a useful
`insuranceLimiter` fallback. But its SQLite story is unverified (see §4-G) and
its fixed-window behaviour differs from the current approximate sliding window.
Worth a focused compatibility experiment only if minimising custom limiter logic
matters more than a pure Bun-native stack.

**3. Framework middleware** (`hono-rate-limiter`, `elysia-rate-limit`).
Convenient, but does not express the specific semantics already in place: the
fail-closed auth path, the global daily budget, and the scope-prefixed
identifier scheme. Reasonable for simple public endpoints later; not a
replacement for `lib/rate-limit/`.

**4. Better Auth's built-in limiter.** Memory-backed by default;
`auth-storage.ts` would be deleted entirely. Simplest, but non-durable and
multi-process-unsafe, and it loses the fail-closed guarantee documented at
`lib/rate-limit/auth-storage.ts:43-46`. Memory never throws, so a restart
silently reads as "no prior record" — exactly the behaviour that comment says
was refused.

**On algorithm choice:** preserving the approximate sliding window is the
lowest-risk migration. Afterwards, consider fixed-window where it is adequate —
it is a fraction of the complexity, and for a 2000/day cost cap or a login
limiter the boundary-burst weakness is largely irrelevant. Keep sliding-window
for per-IP API limits where burst smoothing actually matters.

---

## 9. What changes in the existing code, regardless of choice

These are consequences of leaving Upstash that apply to every option above.

- **`store-failure.ts`'s justification evaporates.** The header comment explains
  that `@upstash/redis` interpolates the Redis key — containing IPs and
  destinations — into its error messages. A local store does not do that. Keep
  the boundary (it is cheap and still correct), but the "why" block must be
  rewritten or it becomes a lie about a dependency that no longer exists. The
  regression test referenced at `store-failure.ts:73` also loses its subject.
  The underlying privacy rule remains: raw storage errors and keys must not
  expose IP addresses, routes, email addresses, phone numbers or user
  identifiers.

- **`degraded` / fail-open becomes near-dead code.** An in-process SQLite call
  has no transient network failures. The retry loop at
  `lib/rate-limit/index.ts:65-87` and the 3-attempt backoff at
  `lib/rate-limit/auth-storage.ts:28-40` are shaped for HTTP. Locally, a failure
  means the disk or schema is broken — retrying twice with 50 ms backoff will
  not help, and failing open on a genuinely broken store is a worse default than
  it was against a flaky network. **Reconsider both policies rather than porting
  them verbatim.** The one exception is `SQLITE_BUSY` under multi-process
  contention, which _is_ transient and _is_ worth retrying — but the correct fix
  there is `busy_timeout` in the driver, not a retry loop in application code.

- **`RateLimitEntry` serialisation becomes yours.**
  `lib/rate-limit/auth-storage.ts:50` relies on Upstash auto-parsing JSON on
  `get`. SQLite and Valkey both return a string.

- **TTL stops being automatic.** The `ex: 3600` at
  `lib/rate-limit/auth-storage.ts:62` has no SQLite equivalent. It needs an
  explicit `expires_at` column, filtering on read (not just on sweep — an
  expired-but-unswept row must not be returned), and the sweeper itself.

- **Better Auth gains an atomic consume path**, replacing the current
  GET-then-SET race.

- **Environment cleanup:** remove `UPSTASH_REDIS_REST_URL` and
  `UPSTASH_REDIS_REST_TOKEN` from `lib/env.server.ts`, from Coolify's
  environment, and from `.github/workflows/ci.yml`, along with any
  Upstash-specific startup probes.

- **Dependency removal:** `@upstash/ratelimit` and `@upstash/redis` from
  `package.json`.

---

## 10. Where the two analyses disagree

Both source documents reach the same substrate conclusion — `bun:sqlite`, WAL,
separate files, Coolify volume, Valkey only on measured need. Two substantive
disagreements remain, and both are worth an explicit decision rather than a
silent default.

### 10.1 Should a memory cache tier exist on day one?

**Position A — memory first.** Make a bounded per-process in-memory cache the
_default_ GET cache tier, and add shared SQLite caching only for selected
expensive data. Rationale: it is the fastest path, needs no disk work, and most
cached GET data is cheap to rebuild.

**Position B — SQLite first.** Start unified on SQLite and add memory later,
only where measurement shows it matters. Rationale: SQLite reads served from the
OS page cache are already in the microsecond range, so a memory tier in front
buys little for the common case; and it introduces a coherence problem the
moment there is more than one process, since a write in worker 1 does not
invalidate worker 3's copy.

**Recommendation:** take position B as the default, with one carve-out from
position A. Start unified on SQLite for GET caching, because it avoids the
coherence problem entirely and keeps day-one complexity low. Then add a memory
tier deliberately for the one shape where it clearly pays: **small, very hot,
rarely-changing data** — feature flags, role and permission lookups, config —
read thousands of times per second and changed once a day. There a 30-second
memory TTL is a large win and staleness is a non-issue.

Needing a memory tier _and_ real invalidation _and_ multiple processes at the
same time is the trigger to revisit Valkey. Not before.

### 10.2 How much convenience library to adopt

**Position A** treats Keyv/Cacheable as a reasonable optional layer for GET
caching — it removes custom cache lifecycle code and provides stampede
protection and tag invalidation for free.

**Position B** does not raise them at all, implying a preference for zero added
dependencies over a runtime feature that is already built in.

**Recommendation:** default to no library. The cache surface here is small and
the project's stated preference is a minimal dependency surface. Revisit
Cacheable only if stampede protection and tag invalidation are actually needed
and hand-rolling them starts to look substantial. Under no circumstances should
Keyv carry the limiter's counters — its get/set API is not atomic.

---

## 11. Staged plan

### Stage 1 — one Bun process

- Build a framework-independent rate-limit storage boundary (no framework
  imports).
- Use direct file-backed `bun:sqlite` for atomic rate-limit consumption, with a
  hand-rolled approximate sliding window preserving current behaviour.
- Give Better Auth an atomic consume path.
- Configure from the start: WAL, `synchronous = NORMAL`, `busy_timeout`,
  `expires_at` filtering on read.
- Store the SQLite file on a Coolify persistent local mount.
- Run the sweeper and periodic `VACUUM` as a Coolify Scheduled Task, not
  `setInterval`.
- Add the GET cache on a **separate** SQLite file (possibly tmpfs).
- Reconsider — do not port verbatim — the retry/fail-open policies, and rewrite
  `store-failure.ts`'s rationale while keeping its privacy boundary.
- Add a backup scheduled task if Coolify's backups do not cover the volume.

### Stage 2 — vertical multi-process Bun

- Only after measuring that one process is CPU-bound.
- Run several Bun processes via `reusePort` / the framework's Bun integration.
- Continue sharing the rate-limit SQLite file across processes.
- Confirm `busy_timeout` and the single-instance sweeper are already in place.
- Add a bounded memory tier only for small, hot, rarely-changing data; account
  for multiplied memory.
- Monitor SQLite contention, `SQLITE_BUSY` frequency and request tail latency.
- Ensure migrations and rolling-update overlap are safe.

### Stage 3 — measured transition to local Valkey

Introduce it only when observed contention or coordination needs justify it —
concretely, when multiple processes, a memory cache tier, and a need to
invalidate that tier on write all hold at once. Coolify can then run
Redis/KeyDB/Dragonfly as a one-click resource, or Valkey as a private custom
Compose service on the same VPS, and Bun's built-in Redis client removes the
need for a JavaScript Redis package. This transition remains local and does not
imply horizontal scaling.

---

## 12. Final decision

- **Rate limiting:** direct `bun:sqlite`, WAL, `synchronous = NORMAL`,
  `busy_timeout`, atomic consumption, TTL-based cleanup, its own database file
  on a persistent Coolify mount, with a hand-rolled approximate sliding window.
- **GET caching:** a second, separate SQLite database (possibly tmpfs), unified
  from day one; a bounded memory tier added later only for small, hot,
  rarely-changing data.
- **Convenience libraries:** none by default; Cacheable/Keyv only if stampede
  protection and tag invalidation prove necessary, and never as the limiter's
  counter layer.
- **Vertical scaling:** multiple Bun processes remain compatible with SQLite,
  subject to its single-writer boundary — but measure before fanning out, since
  memory-based limiting fails silently and dangerously once fanned out.
- **Upgrade path:** local Valkey when cross-process invalidation or SQLite
  contention becomes real.
- **Coolify:** use persistent storage, private networking, health checks,
  scheduled maintenance and monitoring; do not assume it supplies SQLite TTL,
  eviction, response caching at the proxy, or volume backups.
- **Resolve independently:** whether Postgres stays on Neon. It affects more
  than this decision does.

This design stays simple for one VPS, survives the Hono/Elysia migration
untouched, and leaves a clear transition path without building horizontal-scale
infrastructure prematurely.

---

## Primary references

- [Bun SQLite](https://bun.com/docs/runtime/sqlite)
- [Bun SQL](https://bun.com/docs/runtime/sql)
- [Bun HTTP clustering with `reusePort`](https://bun.com/docs/guides/http/cluster)
- [Bun Redis/Valkey client](https://bun.com/docs/runtime/redis)
- [SQLite WAL](https://sqlite.org/wal.html)
- [When to use SQLite](https://www.sqlite.org/whentouse.html)
- [Upstash rate-limiting algorithms](https://upstash.com/docs/redis/sdks/ratelimit-ts/algorithms)
- [Hono on Bun](https://hono.dev/docs/getting-started/bun)
- [Elysia deployment and clustering](https://elysiajs.com/patterns/deploy)
- [Coolify persistent storage](https://coolify.io/docs/knowledge-base/persistent-storage)
- [Coolify Bun/Node multi-core scaling](https://coolify.io/docs/knowledge-base/nodejs-multi-core-scaling)
- [Coolify health checks](https://coolify.io/docs/knowledge-base/health-checks)
- [Coolify rolling updates](https://coolify.io/docs/knowledge-base/rolling-updates)
- [Coolify cron syntax](https://coolify.io/docs/knowledge-base/cron-syntax)
- [Coolify databases](https://coolify.io/docs/databases/)
- [Coolify database backups](https://coolify.io/docs/databases/backups)
- [Coolify services](https://coolify.io/docs/services/introduction)
- [Coolify destinations](https://coolify.io/docs/knowledge-base/destinations/create)
- [Coolify volume migration](https://coolify.io/docs/knowledge-base/how-to/migrate-apps-different-host)
- [`@keyv/sqlite`](https://keyv.org/docs/storage-adapters/sqlite/)
- [Cacheable](https://cacheable.org/docs/cacheable/)
- [`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible)
- [`lru-cache`](https://github.com/isaacs/node-lru-cache)
- [LMDB for JavaScript/Bun](https://github.com/kriszyp/lmdb-js)
- [Valkey](https://valkey.io/topics/introduction/)
- [Valkey persistence](https://valkey.io/docs/topics/persistence/)
