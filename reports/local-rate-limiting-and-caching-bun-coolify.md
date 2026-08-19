# Local Rate Limiting and Caching on Bun and Coolify

Updated: 2026-08-16

## Scope

This report evaluates local replacements for the current Upstash-based
rate-limit storage, taking the following decisions and constraints into account:

- Next.js will eventually be removed.
- The server will use Hono or ElysiaJS directly on Bun.
- The application will run on one privately managed VPS through Coolify.
- Horizontal scaling is out of scope.
- Vertical scaling, including several Bun processes on the same VPS, may be used
  later.
- The selected local technology may also support caching GET data or responses.

## Executive recommendation

The best default for this project is:

1. Use a file-backed `bun:sqlite` database as the authoritative rate-limit
   store.
2. Mount its directory as persistent local storage in Coolify.
3. Keep rate-limit state in its own SQLite file, separate from ordinary cached
   data.
4. Start GET caching with a bounded, per-process in-memory cache.
5. Add a second SQLite file as a persistent/shared cache tier only for selected
   expensive data where surviving restarts or sharing warm entries across Bun
   processes has measurable value.
6. Move the shared rate-limit/cache coordination to a local Valkey-compatible
   service only if SQLite write contention, immediate cross-process
   invalidation, or operational requirements justify the additional service.

This means using one general technology family now—Bun plus SQLite—without
forcing every kind of temporary state into one physical store.

The recommended architecture is therefore:

| Concern                                | Initial storage                       | Later optional tier                         |
| -------------------------------------- | ------------------------------------- | ------------------------------------------- |
| Security-sensitive rate limits         | Dedicated file-backed SQLite database | Local Valkey if contention becomes material |
| Fast disposable GET cache              | Bounded memory in each Bun process    | None required initially                     |
| Expensive cache worth keeping warm     | Memory L1                             | Separate shared SQLite L2                   |
| Business data required for correctness | Primary application database          | Backups and normal durability controls      |

## Important findings from the current project

The migration is broader than replacing one client import:

- [`client.ts`](../lib/rate-limit/client.ts) is the only production module that
  imports `@upstash/redis` directly.
- [`index.ts`](../lib/rate-limit/index.ts) also depends on `@upstash/ratelimit`.
  That library executes Redis scripts, so a non-Redis backend is not a simple
  client swap.
- [`auth-storage.ts`](../lib/rate-limit/auth-storage.ts) is another real
  consumer of the shared Redis client even though it was not in the original
  list.
- [`store-failure.ts`](../lib/rate-limit/store-failure.ts) performs no storage
  operations. Its Upstash-specific explanation will become obsolete, but its
  privacy rule remains important: raw storage errors and keys must not expose IP
  addresses, routes, email addresses, phone numbers, or user identifiers.
- Upstash environment requirements, packages, and Upstash-specific probes will
  also eventually need to be adjusted.

The current API limiter uses `Ratelimit.slidingWindow`. This is an atomic,
approximate two-bucket sliding-window algorithm rather than an exact request log
or a basic expiring counter. Upstash describes the weighting and approximation
in its
[rate-limiting algorithm documentation](https://upstash.com/docs/redis/sdks/ratelimit-ts/algorithms).

That distinction matters because choosing a library can silently change traffic
behavior:

- An approximate sliding window is close to the existing behavior.
- A fixed window is simpler but permits larger bursts near boundaries.
- A token bucket or GCRA controls bursts differently.
- An exact sliding log is precise but creates more rows, writes, and cleanup
  work.

Preserving the existing approximate sliding-window behavior during the storage
migration is the lowest-risk choice. An algorithm change can be evaluated
separately later.

Atomic consumption is important. The main limiter protects sign-in, OTP
delivery, verification, user mutations, and a global OTP budget of 2,000
attempts per day. A restart of a memory-only store would turn that daily budget
into a per-process-lifetime budget.

The current Better Auth storage performs a separate GET followed by SET. The
installed Better Auth version supports an optional atomic `consume` operation,
but the current adapter does not provide it. A new storage implementation should
improve this rather than preserve the read-modify-write race.

## Effect of replacing Next.js with Hono or ElysiaJS

Removing Next.js makes the decision simpler:

- Next.js-specific server caches and cache handlers are no longer relevant.
- The storage layer should expose a small framework-independent API so Hono and
  Elysia handlers can use it identically.
- Both frameworks can run on Bun's HTTP server, so Bun's process and storage
  behavior—not the framework choice—determines the important trade-offs.
- Hono officially supports Bun through its fetch handler model. Elysia's
  production guide documents multi-core execution and states that Elysia on Bun
  uses `SO_REUSEPORT` by default. See the official
  [Hono Bun guide](https://hono.dev/docs/getting-started/bun) and
  [Elysia deployment guide](https://elysiajs.com/patterns/deploy).

Neither framework changes the central conclusion: process memory is private to
one Bun process, while SQLite or a local service can coordinate several
processes.

## Storage options and trade-offs

### 1. File-backed `bun:sqlite` — recommended default

Bun includes a native SQLite driver with prepared statements, transactions, BLOB
support, and file-backed or in-memory databases. Bun recommends WAL mode for
typical applications with concurrent readers. See
[Bun's SQLite documentation](https://bun.com/docs/runtime/sqlite).

Advantages:

- No npm storage dependency.
- No separate daemon or container.
- Atomic transactions can implement a strict check-and-consume operation.
- State survives application restarts when the directory is mounted
  persistently.
- Several Bun processes on the same VPS can open the same local database file.
- Suitable for structured cache values, response metadata, expiry timestamps,
  and invalidation versions.
- Easy to inspect and operate compared with a specialized embedded key-value
  database.

Trade-offs:

- SQLite has no Redis-style automatic TTL or cache eviction. Expiry timestamps,
  read-time expiry checks, periodic deletion, and disk budgets are application
  policy.
- WAL allows readers to continue while a writer is active, but SQLite still
  allows only one writer per database file at a time. SQLite's guidance is
  explicit about the
  [one-writer rule and high-concurrency boundary](https://www.sqlite.org/whentouse.html).
- `bun:sqlite` is synchronous. Slow storage, long transactions, lock waits,
  checkpoints, or maintenance can occupy a worker's event loop. Transactions
  should remain very short, and p95/p99 latency and `SQLITE_BUSY` events should
  be monitored.
- WAL must remain on local storage shared by the processes on the same host. It
  is not appropriate for a network filesystem. See the
  [SQLite WAL documentation](https://sqlite.org/wal.html).
- The database directory must be a Coolify volume or bind mount; a container's
  writable layer is not deployment persistence.

`Bun.SQL` with its SQLite adapter is an alternative built-in interface, but it
has the same underlying persistence and concurrency characteristics. It does not
turn SQLite into a multi-writer server. See
[Bun.SQL](https://bun.com/docs/runtime/sql).

### 2. In-process memory: `Map`, `lru-cache`, or `@isaacs/ttlcache`

Advantages:

- Fastest reads and writes.
- No disk access or service.
- Very good for frequently read GET results.
- LRU or TTL libraries provide bounded memory, per-entry expiry, and eviction
  policies. The `lru-cache` project documents its size and TTL safety controls
  in its [official repository](https://github.com/isaacs/node-lru-cache).

Trade-offs:

- Each Bun process has an independent heap.
- State disappears on restart, deployment, or crash.
- Total memory is approximately the per-process cache allowance multiplied by
  the process count.
- Other processes do not see invalidations immediately.
- It is unsuitable as the authoritative rate-limit store once more than one Bun
  process exists.
- Ordinary LRU eviction is unsafe for security counters: an attacker who forces
  a live rate-limit key out of the cache effectively resets that quota.

Verdict: use it as the default GET cache tier, not as the sole security limiter.

### 3. Keyv with `@keyv/sqlite`, optionally with Cacheable

The current `@keyv/sqlite` adapter supports Bun and prefers the built-in
`bun:sqlite` driver. It provides TTL metadata, lazy expiry, scheduled or manual
expired-row cleanup, namespaces, WAL options, busy-timeout configuration, and
bulk operations. See the official
[`@keyv/sqlite` documentation](https://keyv.org/docs/storage-adapters/sqlite/).

[`cacheable`](https://cacheable.org/docs/cacheable/) can add a memory L1, a
Keyv-backed L2, memoization, stampede protection, TTL propagation, statistics,
and tag invalidation.

Advantages:

- A convenient cache-oriented API.
- Less custom cache lifecycle code.
- Can use memory as L1 and SQLite as L2.
- Good for GET caching after the framework migration.

Trade-offs:

- Adds dependencies even though the underlying storage is Bun's SQLite.
- Keyv's normal get/set/delete API is not an atomic rate-limit consume
  primitive.
- It should not perform the limiter's concurrent read-modify-write sequence.

Verdict: a strong optional caching layer, while the rate limiter continues to
use direct atomic SQLite operations in a separate file or table.

### 4. `rate-limiter-flexible` with SQLite

[`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible)
provides rate-limit algorithms, atomic counters, expiry cleanup, and several
storage backends, including SQLite.

Advantages:

- Avoids implementing all limiter behavior from scratch.
- Mature rate-limit-specific concepts and result metadata.
- Can use an embedded SQLite database.

Trade-offs:

- Its documented SQLite adapter uses `sqlite3`, `better-sqlite3`, or Knex rather
  than directly documenting `bun:sqlite`. This weakens the built-in-only
  advantage and requires a Bun compatibility check.
- Its flexible fixed-window behavior differs from the current approximate
  sliding window.
- It does not solve GET caching.

Verdict: worth a focused compatibility experiment if minimizing custom limiter
logic matters more than keeping a pure Bun-native stack. It is not the cleanest
default for this project.

### 5. LMDB through the `lmdb` package

The [`lmdb` project](https://github.com/kriszyp/lmdb-js) explicitly supports Bun
and provides embedded ACID storage, synchronous memory-mapped reads,
asynchronous batched writes, transactions, optimistic versioning, backups, and
multi-process coordination.

Advantages:

- Extremely fast embedded key-value access.
- Strong multi-process and transactional support.
- Good for structured cached values.

Trade-offs:

- Adds a native dependency.
- TTL, cleanup, and cache eviction remain application concerns.
- Operational tools and team familiarity are usually weaker than SQLite.
- It adds complexity before profiling has shown SQLite to be insufficient.

Verdict: a specialist alternative if measured SQLite overhead becomes important,
not the first choice.

### 6. A local Valkey or Redis-compatible service

Bun provides a native Redis/Valkey client, including support for `VALKEY_URL`,
but it is only a client. A server must still run. See
[Bun's Redis client documentation](https://bun.com/docs/runtime/redis).

Advantages:

- Native TTL and active expiry.
- Atomic increments, transactions, and server-side scripts.
- Natural coordination across all Bun processes on the VPS.
- Strong cache eviction policies and shared locks.
- Immediate cross-process invalidation and pub/sub are available if later
  needed.
- Persistence can be disabled for a disposable cache or enabled through
  snapshots/AOF when useful. See the
  [Valkey introduction](https://valkey.io/topics/introduction/) and
  [persistence documentation](https://valkey.io/docs/topics/persistence/).

Trade-offs:

- Another container/daemon, memory budget, health check, security boundary, and
  operational lifecycle.
- More infrastructure than the project currently needs.
- The current `@upstash/ratelimit` package is designed around the Upstash REST
  client; moving to a local RESP server still requires replacing or rewriting
  that limiter integration.

Verdict: the clean upgrade target if several Bun processes make SQLite
contention or cache coherence material. It is not necessary merely because the
VPS has several CPU cores.

### 7. PostgreSQL

Better Auth supports database-backed rate limits, and PostgreSQL can perform
atomic conditional updates across many processes.

However, the current application uses Neon-specific access, and caching through
the same database that the cache is intended to protect adds load and connection
overhead. PostgreSQL remains appropriate for primary durable data; it is a
weaker fit for this local transient state unless a local PostgreSQL deployment
is already planned for other reasons.

### 8. Plain files

`Bun.file` and `Bun.write` are useful for immutable or very large response
bodies, but plain files do not provide a key index, automatic expiry, safe
atomic counters, transactions, or eviction. They should not be the authoritative
rate-limit store. A possible specialized design is SQLite metadata with
file-backed large bodies, but that is unnecessary until response sizes justify
it.

## What Coolify provides

Coolify helps with deployment and operations, but it is not itself a rate-limit
or cache engine.

| Coolify feature                         | How it helps                                                                                      | What it does not solve                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Persistent volume or bind mount         | Keeps SQLite files across deployments                                                             | Does not add TTL, eviction, or SQLite-aware backups         |
| Private Docker destination/network      | Lets the app reach a local Valkey/Redis-compatible service without a public port                  | Does not remove the need to operate that service            |
| Bun multi-core deployment guidance      | Documents multiple Bun processes with `reusePort`                                                 | Processes still have separate memory                        |
| Health checks                           | Routes traffic only to healthy containers and supports safer deployments                          | Does not verify cache correctness by itself                 |
| Rolling updates                         | Starts a healthy new container before stopping the old one                                        | Temporarily creates two containers and shared-state overlap |
| Scheduled tasks                         | Can run expiry cleanup, checkpoints, cache maintenance, or an application-specific backup command | Cleanup must not be the only expiry correctness check       |
| Monitoring and notifications            | Can report disk pressure, container state, deployment failures, and scheduled-task failures       | Does not enforce an application cache disk budget           |
| One-click databases and custom services | Can run Redis, Dragonfly, KeyDB, or an arbitrary Valkey Compose service locally                   | Adds a separate service rather than embedded storage        |

### Persistent storage

Coolify supports Docker named volumes and host bind mounts for applications.
Both can preserve SQLite files between deployments. Named volumes are more
Docker-managed; bind mounts expose an explicit host path and can be simpler to
inspect or migrate. Coolify documents both options and warns that sharing files
across containers requires correct locking. See
[Coolify persistent storage](https://coolify.io/docs/knowledge-base/persistent-storage).

For SQLite, the mounted directory must contain the database and its
WAL/shared-memory sidecars. It should be backed by the VPS's local filesystem.

### Local Valkey-compatible service

Coolify's documented one-click database list includes Redis, Dragonfly, and
KeyDB. Valkey is not currently listed as a one-click database, but Coolify
supports arbitrary user-defined Docker Compose services. See
[Coolify databases](https://coolify.io/docs/databases/) and
[user-defined services](https://coolify.io/docs/services/introduction).

If a local service is used, place it and the Bun application in the same Coolify
destination/private Docker network and do not expose its database port publicly.
Coolify destinations provide inter-container networking; see
[Coolify destinations](https://coolify.io/docs/knowledge-base/destinations/create).

### Scheduled work

Coolify supports standard cron schedules and predefined hourly/daily schedules.
This is useful for expired-row deletion, cache-size enforcement, SQLite
backup/checkpoint commands, or maintenance metrics. See
[Coolify cron syntax](https://coolify.io/docs/knowledge-base/cron-syntax).

Expiry still must be checked when a value is read. If an hourly cleanup job is
delayed or fails, an expired item must remain logically unavailable.

### Backups

A persistent mount is not a backup. Coolify's documented managed database backup
feature covers server databases such as PostgreSQL, MySQL/MariaDB, and MongoDB;
it does not document automatic SQLite application-volume backups. See
[Coolify database backups](https://coolify.io/docs/databases/backups).

For this design:

- An ordinary GET cache should normally not be backed up because it must be
  rebuildable.
- Rate-limit state should survive routine deploys and restarts, but an off-host
  backup is usually not worth restoring because the values expire quickly.
- Any data that must survive loss of the VPS is business data, not cache, and
  belongs in the primary database and backup plan.
- If SQLite volume backup is nevertheless required, use a SQLite-consistent
  backup/checkpoint process or stop the application. Do not copy only the main
  `.db` file while ignoring an active WAL. Coolify's
  [volume migration guide](https://coolify.io/docs/knowledge-base/how-to/migrate-apps-different-host)
  recommends stopping the application for a clean volume backup.

### Health checks and rolling updates

Coolify health checks can be configured through the UI or Dockerfile, and
Traefik routes only to healthy instances. See
[Coolify health checks](https://coolify.io/docs/knowledge-base/health-checks).

Rolling updates start the new container while the old container is still
running. This is good for availability but means two application containers may
briefly access shared state. Coolify documents the rollout conditions and notes
that rolling updates are not supported for Docker Compose deployments. See
[Coolify rolling updates](https://coolify.io/docs/knowledge-base/rolling-updates).

For SQLite this implies:

- Both containers must see the same persistent local volume if counters are to
  remain continuous.
- SQLite file locking and WAL must be configured correctly.
- Schema migrations must be compatible with old and new application versions and
  must not race at startup.
- If this overlap is undesirable, use a non-overlapping deployment for the
  application or move shared transient state to a local Valkey service.

## Vertical scaling and several Bun processes

Vertical scaling does not require horizontal-scale infrastructure, but it
changes which local approaches remain correct.

Bun's documented multi-process approach is to run several processes that share
one listening port through `reusePort`; Linux distributes incoming connections
between them. See Bun's
[HTTP cluster guide](https://bun.com/docs/guides/http/cluster). Coolify also has
a
[Bun/Node multi-core guide](https://coolify.io/docs/knowledge-base/nodejs-multi-core-scaling)
and notes that application containers have no CPU cap by default unless one is
configured.

Every Bun process remains independent. There is no shared JavaScript heap.

| Approach                        | Works with multiple Bun processes on one VPS? | Important limitation                                                     |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| Memory-only rate limiter        | No                                            | Each process enforces a different counter                                |
| Per-process memory GET cache    | Yes, as L1 only                               | Duplicate entries, multiplied memory, delayed cross-process invalidation |
| File-backed SQLite rate limiter | Yes                                           | One writer per database file; transactions must be short                 |
| SQLite persistent/shared cache  | Yes                                           | Good for read-heavy use; write contention and cleanup must be monitored  |
| Keyv SQLite L2                  | Yes                                           | Its optional memory L1 remains process-local                             |
| LMDB                            | Yes                                           | Native dependency and specialist operations                              |
| Local Valkey                    | Yes, naturally                                | Requires an additional service                                           |
| PostgreSQL                      | Yes                                           | Heavier and not ideal as a cache solely to reduce DB load                |
| Plain files                     | Not safely for counters                       | No transactional read-modify-write                                       |

SQLite therefore remains applicable under vertical scaling. Adding CPU cores
does not remove SQLite's single-writer boundary, but moderate short-lived
rate-limit writes and a read-heavy cache are a reasonable single-VPS workload.
Splitting rate limits and cache into separate database files gives each concern
its own writer lock and prevents cache eviction or maintenance from delaying
security decisions.

The number of workers should be based on measurements rather than automatically
matching every core:

- More workers help when one Bun event loop is CPU-bound or has blocking
  synchronous work.
- Each worker consumes its own memory and owns its own L1 cache.
- More workers increase the number of potential SQLite writers.
- Database latency, storage IOPS, and external API latency may be the real
  bottlenecks rather than CPU.

Useful measurements include CPU saturation, per-worker RSS, request p95/p99,
SQLite lock-wait time, `SQLITE_BUSY` frequency, cache hit rate, cache bytes,
evictions, and source-database queries per request.

Concrete triggers for moving from SQLite to local Valkey are:

- Repeated SQLite busy errors or measurable lock-wait latency despite short
  transactions.
- Rate-limit writes becoming a sustained hot path.
- A requirement for immediate cache invalidation across all Bun processes.
- Cross-process locks or pub/sub becoming common.
- Rolling deployment overlap becoming operationally fragile.
- WebSocket or background-job coordination requiring shared ephemeral state.

None of these triggers is implied merely by increasing the VPS from, for
example, two cores to eight cores.

## Caching strategy: split the policies, unify the interface

The clearest answer is: split caching by durability and cost, but present it
through one framework-neutral cache interface.

Do not force all cached values into one store and do not create unrelated cache
APIs throughout handlers. Instead, assign a policy to each cache namespace or
use case.

### Category 1: memory-only L1

Use for:

- Frequently read database results that are cheap enough to rebuild.
- Short-lived reference data.
- Small computed values.
- Safe negative results with very short TTLs.
- Endpoint data where bounded staleness is acceptable.

Characteristics:

- Fastest path.
- Hard entry or byte limit.
- TTL plus LRU/LFU-style eviction.
- Lost on restart, which is acceptable.
- Private to each process.

This should be the default GET cache category.

### Category 2: optional persistent/shared L2

Use selectively for:

- Expensive deterministic aggregates.
- Large computations that cause an undesirable cold-start spike.
- Results fetched from slow or rate-limited external systems when storage is
  permitted.
- Shared warm data that avoids every Bun process querying the source
  independently.
- Data whose performance value justifies disk serialization and cleanup.

Characteristics:

- Separate SQLite cache database.
- Values remain logically disposable and rebuildable.
- Expiry timestamp checked on every read.
- Hard disk/row budget plus periodic cleanup.
- Shared across local Bun processes.
- An in-memory L1 may sit in front of it.

Do not automatically persist every L1 entry. That converts every cache write
into disk work and complicates cleanup without necessarily improving
performance.

### Category 3: durable application data

If losing a value causes incorrect balances, permissions, inventory, audit
history, job state, or unrecoverable user data, it is not cache. It belongs in
the primary database with transactions and backups.

Similarly, secrets, bearer tokens, one-time credentials, `Set-Cookie`,
unrestricted personalized responses, and authorization truth should not be
placed in a generic shared response cache.

### Rate limits are a separate category

Rate limits are temporary operational/security state, not ordinary cache:

- They need atomic consumption.
- Active records must not be evicted early.
- Some paths fail closed if the store fails.
- They contain sensitive identifiers.
- Their cleanup policy is TTL-based, not LRU-based.

Keeping rate limits and GET cache in separate SQLite files preserves these
different policies while still using one local embedded technology.

## Multi-process cache coherence

With several Bun processes, every L1 is independent. A mutation handled by one
worker cannot directly clear another worker's memory.

For this project's expected scale, avoid building a distributed invalidation
system prematurely. Prefer:

- Short L1 TTLs.
- Versioned cache keys when schemas or representations change.
- Invalidating the shared L2 only after the source-of-truth transaction commits.
- Clearing the current worker's L1 on local mutations.
- Bypassing L1 for data that requires immediate freshness.
- Including every response-varying dimension in the cache key: normalized query,
  tenant/user/role where applicable, locale, and representation version.

If immediate invalidation across workers later becomes a genuine requirement,
that is a strong reason to add local Valkey pub/sub or client invalidation
rather than inventing SQLite-based messaging.

## Preventing cache stampedes

When an item expires, several requests or workers can try to rebuild it
simultaneously. A cache plan should include:

- Per-process request coalescing for concurrent misses.
- Small TTL jitter so many hot entries do not expire at exactly the same moment.
- Stale-while-revalidate for expensive data where serving bounded stale content
  is safe.
- A short expiring lease in the shared store if cross-process duplicate
  rebuilding becomes expensive.
- A hard timeout on loaders and leases so a crashed refresher cannot block a key
  indefinitely.

These controls should be introduced where measurements show stampedes, not
applied indiscriminately to every endpoint.

## Recommended staged plan

### Stage 1: one Bun process

- Build a framework-independent rate-limit storage boundary.
- Use direct file-backed `bun:sqlite` for atomic rate-limit consumption.
- Preserve the existing approximate sliding-window behavior initially.
- Give Better Auth an atomic consume path.
- Store the SQLite file on a Coolify persistent local mount.
- Use a bounded in-memory GET cache with explicit TTLs.
- Do not add persistent GET caching until a use case demonstrates value.
- Preserve the existing fail-open/fail-closed decisions and sanitized error
  logging.

### Stage 2: vertical multi-process Bun

- Run several Bun processes with the framework's Bun server integration and
  `SO_REUSEPORT` behavior.
- Continue sharing the rate-limit SQLite file across processes.
- Keep one bounded L1 cache per process and account for multiplied memory.
- Add a separate SQLite L2 only for selected expensive keys.
- Monitor SQLite contention and request tail latency.
- Ensure deployment migrations and rolling-update overlap are safe.

### Stage 3: measured transition to local Valkey

Only introduce local Valkey when observed contention or coordination needs
justify it. At that point Coolify can run it as a private custom service on the
same VPS, and Bun's built-in Redis client removes the need for a JavaScript
Redis client package.

This transition remains local and does not imply horizontal scaling.

## Final decision

For the stated scope, the balanced choice is:

- **Rate limiting:** direct `bun:sqlite`, persistent Coolify mount, WAL, atomic
  consumption, TTL-based cleanup, separate database file.
- **Default GET caching:** bounded memory per Bun process.
- **Persistent GET caching:** a second SQLite database, added only for selected
  expensive data.
- **Cache convenience library:** optionally Keyv/Cacheable for GET caching,
  never as the limiter's non-atomic counter layer.
- **Vertical scaling:** multiple Bun processes remain compatible with SQLite,
  subject to its single-writer boundary and measurement.
- **Upgrade path:** local Valkey when cross-process coordination or SQLite
  contention becomes real.
- **Coolify:** use persistent storage, private networking, health checks,
  scheduled maintenance, and monitoring; do not assume it supplies SQLite TTL,
  eviction, or backups.

This design stays simple for one VPS, works after the Hono/Elysia migration, and
leaves a clear transition path without building horizontal-scale infrastructure
prematurely.

## Primary references

- [Bun SQLite](https://bun.com/docs/runtime/sqlite)
- [Bun SQL](https://bun.com/docs/runtime/sql)
- [Bun HTTP clustering with `reusePort`](https://bun.com/docs/guides/http/cluster)
- [Bun Redis/Valkey client](https://bun.com/docs/runtime/redis)
- [SQLite WAL](https://sqlite.org/wal.html)
- [When to use SQLite](https://www.sqlite.org/whentouse.html)
- [Hono on Bun](https://hono.dev/docs/getting-started/bun)
- [Elysia deployment and clustering](https://elysiajs.com/patterns/deploy)
- [Coolify persistent storage](https://coolify.io/docs/knowledge-base/persistent-storage)
- [Coolify Bun/Node multi-core scaling](https://coolify.io/docs/knowledge-base/nodejs-multi-core-scaling)
- [Coolify health checks](https://coolify.io/docs/knowledge-base/health-checks)
- [Coolify rolling updates](https://coolify.io/docs/knowledge-base/rolling-updates)
- [Coolify cron syntax](https://coolify.io/docs/knowledge-base/cron-syntax)
- [Coolify databases](https://coolify.io/docs/databases/)
- [Coolify services](https://coolify.io/docs/services/introduction)
- [`@keyv/sqlite`](https://keyv.org/docs/storage-adapters/sqlite/)
- [Cacheable](https://cacheable.org/docs/cacheable/)
- [`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible)
- [LMDB for JavaScript/Bun](https://github.com/kriszyp/lmdb-js)
- [Valkey](https://valkey.io/topics/introduction/)
