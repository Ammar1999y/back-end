# Replacing Upstash Redis with Local Storage — Options and Trade-offs

**Date:** 2026-08-16 **Scope reviewed:** `lib/rate-limit/client.ts`,
`lib/rate-limit/index.ts`, `lib/rate-limit/store-failure.ts`,
`lib/rate-limit/auth-storage.ts`, `lib/rate-limit/api.ts`, `package.json`,
`next.config.js` **Status:** analysis only. No code changed.

**Target environment (as clarified):** single VPS, Coolify, Bun runtime, Next.js
to be dropped in favour of Hono or ElysiaJS, vertical scaling only (more cores
on one box), horizontal scaling explicitly out of scope.

---

## 0. What the clarifications settle

Three questions that were open in the first pass are now closed, and they
simplify the decision considerably:

1. **Bun is guaranteed to be the server runtime.** Dropping Next.js removes the
   only reason to doubt whether `bun:sqlite` and `Bun.redis` would be importable
   at runtime. Both are built into Bun, no npm dependency. This was the largest
   uncertainty in the original analysis and it resolves in your favour.

2. **Anything Next.js-specific is a dead end.** `unstable_cache`, `use cache`,
   `revalidateTag`, and custom `cacheHandler` implementations all disappear with
   the framework. Do not invest there. Whatever you build must be a plain module
   with no framework import in it — then the Hono/Elysia migration touches
   routing only, and never touches storage.

3. **Horizontal scaling is out, but multi-process is not.** This distinction
   does most of the work in section 3. "One VPS" does not mean "one process".

Two constraints from the original analysis still stand unchanged:

- **`OTP_GLOBAL_SEND_CAP_PER_DAY = 2000`** (`lib/rate-limit/api.ts:119`) is a
  global money cap on sends, not a per-user limit. A store that resets on
  restart resets this cap on every redeploy. Ten deploys in a day means twenty
  thousand sends available. This single line rules out a pure in-memory store as
  the authoritative one.

- **Is Postgres staying on Neon?** You use `@neondatabase/serverless`. If the
  database stays hosted while the app moves to your VPS, that network hop will
  dominate request latency far more than any choice in this document, and
  "reduce load on the database" changes meaning entirely. Resolve this first —
  it is a bigger decision than the cache.

---

## 1. Storage substrate options

|                                             | Survives restart | Survives multi-process | Atomic read-modify-write | Latency         | Ops burden       | New deps   |
| ------------------------------------------- | ---------------- | ---------------------- | ------------------------ | --------------- | ---------------- | ---------- |
| **A.** In-process `Map` + TTL               | ✗                | ✗                      | ✓ (single-threaded JS)   | ~0              | none             | 0          |
| **B.** `bun:sqlite` (WAL)                   | ✓                | ✓                      | ✓ (transaction)          | ~0.05–0.3 ms    | volume + sweeper | 0          |
| **C.** Valkey/Redis container + `Bun.redis` | ✓                | ✓                      | ✓ (Lua)                  | ~0.1–0.5 ms     | +1 container     | 0          |
| **D.** Postgres (already yours)             | ✓                | ✓                      | ✓                        | ~1–5 ms (local) | none             | 0          |
| **E.** LMDB (`lmdb-js`)                     | ✓                | ✓                      | ✓                        | ~0.01 ms        | volume           | 1 (native) |

### A — In-process memory

Correct as a _hot path optimisation_, wrong as the _only_ layer. Its real roles
are: a non-authoritative read cache in front of a durable store, and a fallback
when the durable store is unavailable. It cannot own the OTP budget and it
cannot own a login limiter — see section 3 for why multi-process makes this
worse than it first appears.

### B — SQLite via `bun:sqlite`

The strongest fit for your constraints. Specifics that decide whether it works
well:

- **WAL mode is mandatory.** Without it every read blocks on every write and you
  serialise the whole API.
- **`synchronous = NORMAL`** under WAL is the right durability/throughput trade.
  An OS-level crash may lose the last few writes — for rate-limit counters that
  is acceptable.
- **`busy_timeout`** must be set (a few seconds). Without it, concurrent writers
  get `SQLITE_BUSY` immediately instead of waiting. This matters much more once
  you run multiple Bun processes.
- **Needs a Coolify persistent volume**, on real local disk. Never on NFS or
  CIFS — SQLite's file locking is unreliable over network filesystems and you
  get silent corruption, not an error.
- **Expired rows do not self-delete.** You need a sweeper, or the file grows
  forever. See section 2 for where to run it.
- **`bun:sqlite` is synchronous.** A write blocks that process's event loop for
  its duration. For small counter rows this is sub-millisecond and irrelevant.
  For large cached response bodies it is worth measuring before assuming it's
  free.
- **Rolling deploys briefly run two containers** against the same file. Safe on
  one host with WAL — this is exactly SQLite's designed multi-process case.

### C — Valkey or Redis as a second Coolify container

"Local" in the sense you meant: on your VPS, no hosted service, no bill. Bun
ships a native RESP client (`Bun.redis`, Bun ≥ 1.2.9), so this adds zero npm
dependencies. You get real TTL eviction, `maxmemory-policy allkeys-lru` for the
response cache, atomicity via Lua, and — importantly — **pub/sub**, which is the
only clean way to invalidate a per-process memory cache across processes.

Cost is one more thing to run, patch, monitor and back up. Against your stated
preference for a small surface, that is a real cost, not a nominal one.

**The condition under which this becomes the right answer** is specific and
worth writing down: _multiple Bun processes + an in-memory cache tier + a need
to invalidate that tier on write._ SQLite has no cross-process notification
mechanism; you would have to poll a version table. Valkey pub/sub solves it
directly. Until you need all three at once, SQLite is enough.

### D — Postgres

You already have it, plus Drizzle. Unlogged tables with
`INSERT … ON CONFLICT … RETURNING` give correct atomic counters with no new
infrastructure at all. Two problems: your stated caching goal is _"reduce load
on the database"_, so putting the cache in the database inverts it; and if
Postgres stays on Neon, every rate-limit check becomes a network round-trip —
you would have re-created the exact problem you are migrating away from.

Reasonable as a home for the **OTP global daily budget** specifically, since
that is low-volume, money-related, and benefits from living in the same
transaction as the send record. Not reasonable as the response cache.

### E — LMDB

Faster than SQLite for pure key-value work, memory-mapped, ACID. But it is a
native dependency (friction with your `ignoreScripts` / `trustedDependencies`
setup), less familiar, and has no query layer for the sweeper. Only worth
revisiting if you measure SQLite writes as an actual bottleneck.

---

## 2. Coolify — what it actually gives you

Coolify has **no caching, KV, or rate-limiting feature of its own.** It is a
deployment and operations layer. What it does provide that is relevant:

**Genuinely useful here:**

- **Persistent Storage** — named volumes or file mounts attached to a resource.
  This is what the SQLite file lives on, and it is the one Coolify feature
  option B strictly depends on.
- **One-click databases** — PostgreSQL, Redis, KeyDB, Dragonfly, MongoDB, MySQL,
  MariaDB, ClickHouse are provisioned as first-class resources. If you choose
  option C, this is a few clicks rather than hand-written Compose. _I am not
  certain Valkey specifically is in the catalog_ — Redis, KeyDB and Dragonfly I
  am confident about. All three are RESP-compatible and work with `Bun.redis`;
  Dragonfly and KeyDB are both multi-threaded, which is incidentally a better
  fit for vertical scaling than single-threaded Redis.
- **Scheduled Tasks** — per-resource cron that runs a command in the container.
  This is the clean place to run the SQLite sweeper and periodic `VACUUM`,
  rather than a `setInterval` inside the app. With multiple app processes it
  also solves the "N processes each running their own sweeper" problem for free,
  since Coolify runs the task once.
- **Internal Docker networking** — a Valkey/Redis container is reachable by
  service name and never needs a public port. Given your security posture, this
  matters: the store is not internet-reachable at all.
- **Health checks** — so a container with a corrupt or unmountable SQLite volume
  fails its check instead of silently serving a degraded limiter.

**Worth knowing about, with caveats:**

- **Rolling / zero-downtime deploys** are a toggle. When on, two app containers
  overlap briefly. SQLite handles this; in-memory state does not (the new
  container starts cold). This is a second, independent reason not to make
  memory authoritative.
- **Scheduled backups** exist, but _I believe they cover the managed database
  resources only, not arbitrary persistent volumes._ If that is right, a SQLite
  file gets **no automatic backup** and you would add a scheduled task that runs
  `sqlite3 … .backup` (or `VACUUM INTO`) and ships the result to S3 yourself.
  Verify this before relying on it — it is the single biggest operational gap in
  the SQLite path.
- **The default proxy is Traefik v3** (Caddy is an option). This is a correction
  to the first pass: **Traefik's open-source build has no HTTP response cache.**
  Caching is an enterprise feature or a community plugin (`souin`), and Caddy's
  equivalent needs a custom `xcaddy` build. So the "just cache at the reverse
  proxy" suggestion is meaningfully more friction under Coolify than I implied.
  It is still the cheapest option _if_ you are willing to run a plugin-enabled
  proxy; it is not a free default.

**What Coolify does not solve:** none of the correctness questions. Atomicity,
TTL, eviction, invalidation and the fail-open/fail-closed policy are all still
yours.

---

## 3. Vertical scaling: which options survive multiple Bun processes

This is the question that most changes the analysis, so it deserves the detail.

**First, a caveat on the premise.** Vertical scaling does not automatically mean
multi-process. Bun's JS execution is single-threaded but its I/O is not, and a
mostly I/O-bound API (DB queries, S3, SMTP) frequently saturates several cores
from one process. Adding cores may well raise throughput with no process changes
at all. **Measure before you fan out** — the multi-process complexity below is
worth accepting only once a single process is demonstrably CPU-bound. Your
`argon2` hashing is the most likely thing to make that true, since it is
deliberately CPU-expensive.

**If you do fan out**, the Bun-native mechanism is
`Bun.serve({ reusePort: true })` — `SO_REUSEPORT`, where the kernel
load-balances connections across N independent processes listening on the same
port. (`node:cluster` also works in Bun but is only partially supported;
`reusePort` is the idiomatic path.) Note the kernel distributes by connection
hash, so the split is approximately even, not exactly even.

Now, per option:

### A — In-process memory: **breaks, and breaks silently**

N processes means N independent `Map`s. A limit of 5 requests per minute becomes
20 per minute with 4 workers, because each worker enforces 5 independently and
the kernel spreads the attacker's requests across all of them. The
`OTP_GLOBAL_SEND_CAP_PER_DAY` becomes `N × 2000`.

This is the worst failure mode in the whole document: nothing errors, nothing
logs, the limiter reports success, and your protection is quietly divided by the
number of cores you added. **Adding CPU cores would weaken your security
posture.** Memory can still serve as a non-authoritative read cache — it just
cannot own a counter.

### B — SQLite: **survives, and this is its designed case**

Multiple processes on one host sharing one file with WAL is precisely what
SQLite's locking model exists for. Practical notes:

- WAL allows many concurrent readers but **one writer at a time**. Writes
  serialise across all processes. For rate-limit counters (sub-millisecond, tiny
  rows) this is fine at any traffic level a single VPS will see.
- **`busy_timeout` becomes essential**, not optional. Without it, contention
  surfaces as `SQLITE_BUSY` exceptions, which your code would then treat as a
  store failure and fail open. That is a real, reachable bug if the setting is
  missed.
- WAL requires the `-shm` shared-memory file, which requires all processes on
  the same machine with real `mmap`. True for you. It is also exactly why NFS is
  forbidden.
- The sweeper should run **once**, not once per process. Coolify's Scheduled
  Tasks handles this; an in-process `setInterval` does not.
- Because `bun:sqlite` is synchronous, a slow write blocks one worker but not
  the others — multi-process actually mitigates this particular weakness.

### C — Valkey: **survives trivially**

This is what it is built for. No caveats. It also gains relative value here,
because pub/sub gives you the cross-process cache invalidation that SQLite
cannot.

### D — Postgres: **survives**

Standard transactional semantics; multi-process is a non-issue. The Neon latency
question is unchanged.

### E — LMDB: **survives**

Multi-process safe by design. Same caveats as before.

### Summary for your scaling plan

Options **B, C, D, E all survive vertical scaling with multiple processes.**
Only **A breaks**, and it breaks invisibly. Since B is your likely choice,
vertical scaling costs you three configuration items — `busy_timeout`, WAL, and
moving the sweeper out of the app process — and nothing architectural. That is
the answer to "will this still apply if we scale up": yes, provided those three
are in place from the start rather than retrofitted.

---

## 4. One cache or two tiers?

Short answer: **the split is real, but "fast vs persistent" is the wrong axis to
split on**, and you should not build the second tier yet.

### The right axis

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

The second axis, which only appears once you go multi-process: **how many
processes must agree on this value?** Counters must agree — that is what makes
per-process memory unsafe for them. A cached response body does not need to
agree; the worst case is a lower hit rate.

### The recommendation

**One interface, two backends, policy chosen per key.** Not two separate APIs
sprinkled through the codebase, and not a single rigid store either.

Concretely, that means a store module exposing `get` / `set` / `delete` /
`increment`, where each call site declares its durability requirement, and the
module routes to memory or SQLite accordingly. The benefits:

- Call sites never change when you add or remove the memory tier.
- The durability decision is visible at each call site instead of being an
  emergent property of which file you imported.
- The whole thing is framework-agnostic, so the Hono/Elysia migration does not
  touch it.

### But do not build the memory tier on day one

The instinct to put memory in front of SQLite is weaker than it looks:

- SQLite reads served from the OS page cache are already in the microsecond
  range. A memory tier in front of it buys very little for the common case.
- It introduces a coherence problem the moment you have more than one process: a
  write in worker 1 does not invalidate worker 3's copy. You would need pub/sub
  — which SQLite does not have — or accept stale reads with a short TTL.
- It is precisely the kind of over-engineering you said you want to avoid.

**Start unified on SQLite.** Add a memory tier later, only where measurement
shows it matters, and only for data where staleness is harmless. The place it
genuinely pays is small, very hot, rarely-changing data — feature flags, role
and permission lookups, config — read thousands of times per second and changed
once a day. There, a 30-second TTL in memory is a large win and staleness is a
non-issue.

If you later find yourself needing a memory tier _and_ real invalidation _and_
multiple processes, that is the trigger to revisit option C. Not before.

---

## 5. The rate-limit algorithm layer

Whatever substrate you pick, you still need the sliding-window logic that
`@upstash/ratelimit` was providing.

1. **Hand-rolled sliding window.** Roughly 40–60 lines. Your public surface is
   already tiny and well-fenced: one `rateLimit()` function and one
   `BetterAuthRateLimitStorage` object. The standard two-bucket weighted
   approximation (current window + weighted previous window) is what Upstash
   does internally and is straightforward to verify with tests. **This is the
   only option that works with SQLite**, and given the narrow interface the
   maintenance cost is genuinely low. It also lets you keep the deliberate
   design decision recorded at `lib/rate-limit/index.ts:98-104` — no refund
   primitive — rather than inheriting a library that offers one.

2. **`rate-limiter-flexible`.** Mature, backend-agnostic (Memory / Redis /
   Postgres / MySQL / Mongo). Its `insuranceLimiter` feature — automatic
   fallback to memory when the primary store fails — is a cleaner expression of
   the `degraded: true` fail-open at `lib/rate-limit/index.ts:89-95`. But it has
   **no SQLite driver**, so it pairs with option C or D, not B.

3. **Framework middleware** (`hono-rate-limiter`, `elysia-rate-limit`).
   Convenient, but you have specific semantics these do not express: the
   fail-closed auth path, the global daily budget, and the scope-prefixed
   identifier scheme. Reasonable for simple public endpoints later; not a
   replacement for `lib/rate-limit/`.

4. **Better Auth's built-in limiter** — memory-backed by default; you would
   delete `lib/rate-limit/auth-storage.ts` entirely. Simplest, but non-durable
   and multi-process-unsafe, and you would lose the fail-closed guarantee
   documented at `lib/rate-limit/auth-storage.ts:43-46`. Memory never throws, so
   a restart silently reads as "no prior record" — the exact behaviour that
   comment says you refused to accept.

**Also consider fixed-window instead of sliding.** It is a fraction of the
complexity, and for a 2000/day cost cap or a login limiter the boundary-burst
weakness is largely irrelevant. Keep sliding-window for per-IP API limits where
burst smoothing actually matters.

---

## 6. What changes in the existing code, regardless of choice

These are consequences of leaving Upstash that apply to every option above.

- **`store-failure.ts`'s entire justification evaporates.** The header comment
  explains that `@upstash/redis` interpolates the Redis key — containing IPs and
  destinations — into its error messages. A local store does not do that. Keep
  the boundary (it is cheap and still correct), but the "why" block must be
  rewritten or it becomes a lie about a dependency you no longer have. The
  regression test referenced at `store-failure.ts:73` also loses its subject.

- **`degraded` / fail-open becomes near-dead code.** An in-process SQLite call
  has no transient network failures. The retry loop at
  `lib/rate-limit/index.ts:65-87` and the 3-attempt backoff at
  `lib/rate-limit/auth-storage.ts:28-40` are shaped for HTTP. Locally, a failure
  means the disk or schema is broken — retrying twice with 50 ms backoff will
  not help, and failing open on a genuinely broken store is a worse default than
  it was against a flaky network. **Reconsider both policies rather than porting
  them verbatim.** The one exception is `SQLITE_BUSY` under multi-process
  contention, which _is_ transient and _is_ worth retrying — but the correct fix
  there is `busy_timeout`, in the driver, not a retry loop in application code.

- **`RateLimitEntry` serialisation becomes yours.**
  `lib/rate-limit/auth-storage.ts:50` relies on Upstash auto-parsing JSON on
  `get`. SQLite and Valkey both return a string.

- **TTL stops being automatic.** The `ex: 3600` at
  `lib/rate-limit/auth-storage.ts:62` has no SQLite equivalent. You need an
  explicit `expires_at` column, filtering on read (not just on sweep — an
  expired-but-unswept row must not be returned), and the sweeper itself.

- **Environment cleanup:** remove `UPSTASH_REDIS_REST_URL` and
  `UPSTASH_REDIS_REST_TOKEN` from `lib/env.server.ts`, from Coolify's
  environment, and from `.github/workflows/ci.yml`.

- **Dependency removal:** `@upstash/ratelimit` and `@upstash/redis` from
  `package.json`.

---

## 7. Recommendation

**`bun:sqlite` in WAL mode, with a hand-rolled sliding window**, behind a
framework-agnostic store module.

Why it fits your constraints specifically:

- Zero new dependencies — it is built into the runtime you are committing to.
- Survives redeploys, which the OTP daily cap requires.
- Survives multiple Bun processes, so vertical scaling does not force a rewrite.
- One file on one Coolify volume; no extra container to operate or patch.
- Extends to the GET response cache later without new infrastructure.

**Configure these from the start, not later:** WAL mode, `synchronous = NORMAL`,
`busy_timeout`, `expires_at` filtering on read, and the sweeper as a Coolify
Scheduled Task rather than an in-process interval. Retrofitting `busy_timeout`
after you fan out to multiple processes means debugging intermittent fail-open
events under load, which is an unpleasant way to discover it.

**Consider separate database files** for the limiter and the response cache.
Large cached payloads and high-churn counters in one file means they compete for
the same WAL and the same write lock. A separate, disposable file for the cache
— possibly on tmpfs, since losing it is free — sidesteps this entirely and costs
nothing.

**Take Valkey instead** only when you have all three of: multiple processes, a
memory cache tier, and a need to invalidate it on write. Not before.

**Verify before committing:** whether Coolify's scheduled backups cover
arbitrary persistent volumes or only managed databases (section 2). If they do
not, budget for a backup scheduled task in the same work.

**Resolve first, independently:** whether Postgres stays on Neon. It affects
more than this decision does.
