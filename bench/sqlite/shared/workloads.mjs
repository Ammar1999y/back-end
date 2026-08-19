// Driver-agnostic workloads. Each returns { name, unit, group, setup(ctx), op(i, ctx) }
// where op() performs exactly one logical application operation.

import {
  makePayload,
  NO_LIMIT,
  SQL_AUTH_CONSUME,
  SQL_AUTH_GET,
  SQL_AUTH_SET,
  SQL_AUTH_SWEEP,
  SQL_CACHE_DELETE_PREFIX,
  SQL_CACHE_GET,
  SQL_CACHE_PUT,
  SQL_CACHE_STATS,
  SQL_CACHE_SWEEP,
  SQL_RL_CONSUME,
  SQL_RL_SWEEP,
  SWEEP_BATCH_SIZE,
  SWEEP_MAX_BATCHES,
} from './schema.mjs';

const WINDOW_MS = 60_000;
// Keeps every seeded dataset within a fixed byte budget: 20k keys of 64KB would
// be 1.3GB, which measures the page cache and the disk, not the driver.
const DATASET_BUDGET_BYTES = 64 * 1024 * 1024;

function keyCountFor(bytes, requested) {
  return Math.max(
    500,
    Math.min(requested, Math.floor(DATASET_BUDGET_BYTES / bytes))
  );
}

// Big payloads move far more bytes per op, so fewer ops still give a stable
// percentile while keeping the suite to minutes.
function iterationsFor(bytes) {
  if (bytes >= 65_536) return 4000;
  if (bytes >= 8192) return 12_000;
  return undefined;
}

const LIMIT = 100;

// A hot key models one IP hammering a login route; spread models many distinct IPs.
function keyFor(i, spread) {
  if (spread === 1) return 'ip:203.0.113.7';
  return `ip:10.${((i / 65_536) | 0) % 256}.${((i / 256) | 0) % 256}.${i % 256}`;
}

export function rateLimitConsume({ spread }) {
  return {
    name: spread === 1 ? 'rl_consume_hot_key' : `rl_consume_spread_${spread}`,
    tier: 'core',
    schemaScope: 'rate-limit',
    unit: 'consume',
    group: 'rate-limit',
    setup(ctx) {
      ctx.stmt = ctx.db.prepare(SQL_RL_CONSUME);
    },
    op(i, ctx) {
      const now = Date.now();
      const windowStart = now - (now % WINDOW_MS);
      const row = ctx.stmt.get(
        keyFor(i % spread, spread),
        windowStart,
        windowStart + WINDOW_MS,
        NO_LIMIT
      );
      // A row is always returned under NO_LIMIT; a miss would mean the max-aware
      // WHERE refused, which at this ceiling can only be a harness bug.
      return Boolean(row) && row.count <= LIMIT;
    },
  };
}

/**
 * The refusal path: one exhausted key, hammered.
 *
 * This is a distinct production shape, not a variation. Since admission became
 * max-aware, a request over the limit updates nothing — so this measures a read
 * against the primary key where `rl_consume_hot_key` measures a write. It is the
 * path an attacker actually drives, and it is the one the limiter's own storage
 * has to survive, so its cost is a security property rather than a nicety.
 */
export function rateLimitDenied() {
  return {
    name: 'rl_consume_denied_hot_key',
    tier: 'core',
    schemaScope: 'rate-limit',
    unit: 'consume',
    group: 'rate-limit',
    setup(ctx) {
      ctx.stmt = ctx.db.prepare(SQL_RL_CONSUME);
      // A window far in the past would roll over and be admitted, so the seeded
      // row has to sit in the same window every op() binds.
      ctx.windowStart = Date.now() - (Date.now() % WINDOW_MS);
      ctx.stmt.get(
        'ip:203.0.113.9',
        ctx.windowStart,
        ctx.windowStart + WINDOW_MS,
        1
      );
    },
    op(_i, ctx) {
      const row = ctx.stmt.get(
        'ip:203.0.113.9',
        ctx.windowStart,
        ctx.windowStart + WINDOW_MS,
        1
      );
      // Denial is the expected outcome; a returned row means the seeded row's
      // window rolled and the workload stopped measuring refusal.
      return !row;
    },
  };
}

// The read-modify-write shape the Better Auth adapter uses today: two round trips.
export function authGetSet() {
  return {
    name: 'auth_get_then_set',
    tier: 'core',
    schemaScope: 'rate-limit',
    unit: 'check',
    group: 'rate-limit',
    setup(ctx) {
      ctx.get = ctx.db.prepare(SQL_AUTH_GET);
      ctx.set = ctx.db.prepare(SQL_AUTH_SET);
    },
    op(i, ctx) {
      const now = Date.now();
      const windowStart = now - (now % WINDOW_MS);
      const key = keyFor(i % 5000, 5000);
      const existing = ctx.get.get(key, now);
      const count = existing ? existing.count + 1 : 1;
      ctx.set.run(
        key,
        count,
        windowStart,
        windowStart,
        windowStart + WINDOW_MS
      );
      return count <= LIMIT;
    },
  };
}

// Same logical check as the deployed one-statement Better Auth consume.
export function authAtomic() {
  return {
    name: 'auth_atomic_consume',
    tier: 'core',
    schemaScope: 'rate-limit',
    unit: 'check',
    group: 'rate-limit',
    setup(ctx) {
      ctx.stmt = ctx.db.prepare(SQL_AUTH_CONSUME);
    },
    op(i, ctx) {
      const now = Date.now();
      const windowStart = now - (now % WINDOW_MS);
      const row = ctx.stmt.get(
        keyFor(i % 5000, 5000),
        windowStart,
        now,
        now + 3_600_000,
        NO_LIMIT
      );
      return Boolean(row) && row.count <= LIMIT;
    },
  };
}

export function cacheWrite({ bytes, keys = 20_000 }) {
  return {
    name: `cache_write_${bytes >= 1024 ? `${bytes / 1024}kb` : `${bytes}b`}`,
    tier: 'core',
    schemaScope: 'cache',
    unit: 'write',
    group: 'cache',
    iterations: iterationsFor(bytes),
    setup(ctx) {
      ctx.stmt = ctx.db.prepare(SQL_CACHE_PUT);
      ctx.payload = makePayload(bytes);
      ctx.keys = keyCountFor(bytes, keys);
    },
    op(i, ctx) {
      const now = Date.now();
      ctx.stmt.run(`c:${i % ctx.keys}`, ctx.payload, now + 300_000, now);
      return true;
    },
  };
}

export function cacheRead({ bytes, keys = 20_000, hit = true, parse = true }) {
  const size = bytes >= 1024 ? `${bytes / 1024}kb` : `${bytes}b`;
  return {
    name: `cache_read_${hit ? 'hit' : 'miss'}_${size}${parse ? '' : '_noparse'}`,
    tier: 'core',
    schemaScope: 'cache',
    unit: 'read',
    group: 'cache',
    iterations: iterationsFor(bytes),
    setup(ctx) {
      const count = keyCountFor(bytes, keys);
      if (ctx.seed) {
        const put = ctx.db.prepare(SQL_CACHE_PUT);
        const payload = makePayload(bytes);
        const now = Date.now();
        ctx.db.transaction(() => {
          for (let i = 0; i < count; i++)
            put.run(`c:${i}`, payload, now + 3_600_000, now);
        })();
      }
      ctx.stmt = ctx.db.prepare(SQL_CACHE_GET);
      ctx.decoder = new TextDecoder();
      ctx.keys = count;
    },
    op(i, ctx) {
      const key = hit ? `c:${i % ctx.keys}` : `absent:${i}`;
      const row = ctx.stmt.get(key, Date.now());
      if (!row) return !hit;
      if (!parse) return true;
      JSON.parse(ctx.decoder.decode(row.value));
      return true;
    },
  };
}

/**
 * Drains one bounded delete statement, exactly like `sweepInBatches`.
 *
 * The deployed sweeper never issues an unbounded `DELETE`: one would hold the
 * sole writer lock for its whole duration and make every limiter write wait on
 * `busy_timeout` behind it. Measuring an unbounded delete here would report a
 * maintenance cost the application does not pay, and would hide the per-statement
 * commit overhead it does.
 *
 * It does not yield between batches. The production helper does, but yielding is
 * an event-loop property, not a storage one, and awaiting inside `op()` would put
 * timer latency into the measured interval.
 */
function drain(statement, cutoff) {
  let removed = 0;
  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
    const { changes } = statement.run(cutoff, SWEEP_BATCH_SIZE);
    removed += changes;
    if (changes < SWEEP_BATCH_SIZE) return removed;
  }
  return removed;
}

// Sweeper: bounded batched delete of expired rows, the maintenance path.
export function cacheSweep({ rows = 20_000, iterations = 10 } = {}) {
  return {
    name: `cache_sweep_${rows / 1000}k_expired`,
    tier: 'core',
    schemaScope: 'cache',
    unit: 'sweep',
    group: 'maintenance',
    iterations,
    setup(ctx) {
      ctx.put = ctx.db.prepare(SQL_CACHE_PUT);
      ctx.sweep = ctx.db.prepare(SQL_CACHE_SWEEP);
      ctx.stats = ctx.db.prepare(SQL_CACHE_STATS);
      ctx.payload = makePayload(512);
      ctx.rows = rows;
    },
    beforeEach(ctx) {
      const now = Date.now();
      ctx.db.transaction(() => {
        for (let i = 0; i < ctx.rows; i++)
          ctx.put.run(`s:${i}`, ctx.payload, now - 1000, now);
      })();
    },
    op(_i, ctx) {
      drain(ctx.sweep, Date.now());
      return Number(ctx.stats.get().rows) === 0;
    },
  };
}

export function rateLimitSweep({ rows = 20_000, iterations = 10 } = {}) {
  return {
    name: `rate_limit_sweep_${rows / 1000}k_expired`,
    tier: 'core',
    schemaScope: 'rate-limit',
    unit: 'sweep',
    group: 'maintenance',
    iterations,
    setup(ctx) {
      ctx.rlPut = ctx.db.prepare(SQL_RL_CONSUME);
      ctx.authPut = ctx.db.prepare(SQL_AUTH_SET);
      ctx.rlSweep = ctx.db.prepare(SQL_RL_SWEEP);
      ctx.authSweep = ctx.db.prepare(SQL_AUTH_SWEEP);
      ctx.rows = rows;
    },
    beforeEach(ctx) {
      const now = Date.now();
      const windowStart = now - WINDOW_MS;
      ctx.db.transaction(() => {
        for (let i = 0; i < ctx.rows; i++) {
          if (i % 2 === 0) {
            ctx.rlPut.get(`s:rl:${i}`, windowStart, now - 1, NO_LIMIT);
          } else {
            ctx.authPut.run(
              `s:auth:${i}`,
              1,
              windowStart,
              windowStart,
              now - 1
            );
          }
        }
      })();
    },
    op(_i, ctx) {
      const now = Date.now();
      // Both tables, in the same order as `sweepExpired`.
      drain(ctx.rlSweep, now);
      drain(ctx.authSweep, now);
      return true;
    },
  };
}

/**
 * Namespace invalidation: one unbounded range delete over a whole prefix.
 *
 * `cacheDeletePrefix` is the one delete in the deployed code that is NOT batched,
 * so this exists to price it. It holds the cache writer lock — and, because the
 * driver is synchronous, the worker's event loop — for its entire duration. The
 * result decides whether it needs the same bounded treatment as the sweeps before
 * the first call site adopts the cache.
 */
export function cachePrefixInvalidate({ perNamespace = 5000 } = {}) {
  return {
    name: `cache_prefix_delete_${perNamespace / 1000}k_keys`,
    tier: 'core',
    schemaScope: 'cache',
    unit: 'invalidation',
    group: 'maintenance',
    iterations: 10,
    setup(ctx) {
      ctx.put = ctx.db.prepare(SQL_CACHE_PUT);
      ctx.delPrefix = ctx.db.prepare(SQL_CACHE_DELETE_PREFIX);
      ctx.stats = ctx.db.prepare(SQL_CACHE_STATS);
      ctx.payload = makePayload(1024);
      ctx.perNamespace = perNamespace;
    },
    beforeEach(ctx) {
      const now = Date.now();
      // A neighbouring namespace is seeded too, so the postcondition proves the
      // range deleted one namespace rather than the table.
      ctx.db.transaction(() => {
        for (let i = 0; i < ctx.perNamespace; i++) {
          ctx.put.run(`perm:${i}`, ctx.payload, now + 3_600_000, now);
          ctx.put.run(`other:${i}`, ctx.payload, now + 3_600_000, now);
        }
      })();
    },
    op(_i, ctx) {
      // `perm;` is the lexicographic successor of `perm:` — the same bound
      // `prefixUpperBound` computes, not a large character appended.
      ctx.delPrefix.run('perm:', 'perm;');
      return Number(ctx.stats.get().rows) === ctx.perNamespace;
    },
  };
}

// Statement handling: reusing a prepared statement vs re-preparing per call.
export function stmtReuse({ reuse }) {
  return {
    name: reuse ? 'stmt_cached_reuse' : 'stmt_prepare_each_call',
    tier: 'diagnostic',
    schemaScope: 'cache',
    unit: 'read',
    group: 'driver',
    setup(ctx) {
      const put = ctx.db.prepare(SQL_CACHE_PUT);
      const payload = makePayload(1024);
      const now = Date.now();
      ctx.db.transaction(() => {
        for (let i = 0; i < 2000; i++)
          put.run(`r:${i}`, payload, now + 3_600_000, now);
      })();
      if (reuse) ctx.stmt = ctx.db.prepare(SQL_CACHE_GET);
    },
    op(i, ctx) {
      const stmt = reuse ? ctx.stmt : ctx.db.prepareUncached(SQL_CACHE_GET);
      const row = stmt.get(`r:${i % 2000}`, Date.now());
      if (!reuse) stmt.finalize();
      return Boolean(row);
    },
  };
}

// Batching: N writes one-by-one vs the same N inside a single transaction.
export function writeBatching({ batch }) {
  const BATCH = 100;
  return {
    name: batch ? 'write_100_in_txn' : 'write_100_individually',
    tier: 'diagnostic',
    schemaScope: 'cache',
    unit: 'batch-of-100',
    group: 'driver',
    iterations: 200,
    setup(ctx) {
      const stmt = ctx.db.prepare(SQL_CACHE_PUT);
      ctx.stmt = stmt;
      ctx.payload = makePayload(1024);
      ctx.batched = ctx.db.transaction((base, payload, now) => {
        for (let k = 0; k < BATCH; k++)
          stmt.run(`b:${base + k}`, payload, now + 300_000, now);
      });
    },
    op(i, ctx) {
      const now = Date.now();
      const base = i * BATCH;
      if (batch) {
        ctx.batched(base, ctx.payload, now);
        return true;
      }
      for (let k = 0; k < BATCH; k++)
        ctx.stmt.run(`b:${base + k}`, ctx.payload, now + 300_000, now);
      return true;
    },
  };
}

// Production cache-file mix. Rate-limit state lives in a different database and
// is measured separately, so combining both concerns here would invent lock
// contention the deployed layout deliberately avoids.
export function cacheMixed({ keys = 20_000 } = {}) {
  return {
    name: 'cache_mixed_95read_5write',
    tier: 'core',
    schemaScope: 'cache',
    unit: 'request',
    group: 'cache',
    setup(ctx) {
      const payload = makePayload(4096);
      const put = ctx.db.prepare(SQL_CACHE_PUT);
      if (ctx.seed) {
        const now = Date.now();
        ctx.db.transaction(() => {
          for (let i = 0; i < keys; i++)
            put.run(`m:${i}`, payload, now + 3_600_000, now);
        })();
      }
      ctx.get = ctx.db.prepare(SQL_CACHE_GET);
      ctx.put = put;
      ctx.payload = payload;
      ctx.decoder = new TextDecoder();
      ctx.keys = keys;
    },
    op(i, ctx) {
      const now = Date.now();
      const bucket = i % 20;
      if (bucket === 19) {
        ctx.put.run(`m:${i % ctx.keys}`, ctx.payload, now + 300_000, now);
        return true;
      }
      const row = ctx.get.get(`m:${i % ctx.keys}`, now);
      if (row) JSON.parse(ctx.decoder.decode(row.value));
      return true;
    },
  };
}

export function buildSuite({ tier = 'core' } = {}) {
  const all = [
    // Security path: the hot single-IP case and the many-IP case.
    rateLimitConsume({ spread: 1 }),
    rateLimitConsume({ spread: 10_000 }),
    // The refusal path, which is what sustained abuse actually costs the store.
    rateLimitDenied(),
    // Decides the Better Auth adapter: current read-modify-write vs atomic.
    authGetSet(),
    authAtomic(),
    // Cache read path at the sizes this application actually serves.
    cacheRead({ bytes: 1024 }),
    cacheRead({ bytes: 8192 }),
    // Isolates driver cost from JSON.parse cost.
    cacheRead({ bytes: 8192, parse: false }),
    // Large aggregate probe; read-only, since we would not write these often.
    cacheRead({ bytes: 65_536 }),
    cacheRead({ bytes: 1024, hit: false }),
    cacheWrite({ bytes: 1024 }),
    cacheWrite({ bytes: 8192 }),
    // Inner work of the Coolify task; process startup is measured separately.
    cacheSweep({ rows: 20_000 }),
    rateLimitSweep({ rows: 20_000 }),
    // The one unbounded delete left in the deployed code.
    cachePrefixInvalidate({ perNamespace: 5000 }),
    // Each production database gets its own representative traffic pattern.
    cacheMixed(),
    // Diagnostic: settles "always reuse prepared statements" and "always batch".
    stmtReuse({ reuse: true }),
    stmtReuse({ reuse: false }),
    writeBatching({ batch: true }),
    writeBatching({ batch: false }),
  ];
  return tier === 'all' ? all : all.filter((w) => w.tier === tier);
}

// Workloads used by the multi-process concurrency test.
export const CONCURRENT_WORKLOADS = {
  rl_consume: () => rateLimitConsume({ spread: 10_000 }),
  // Under contention this is the interesting one: refusal takes no write lock, so
  // N processes hammering an exhausted key should NOT serialise on each other.
  // If they do, the max-aware WHERE is not buying what it was added for.
  rl_consume_denied: () => rateLimitDenied(),
  cache_read: () => cacheRead({ bytes: 4096 }),
  cache_mixed: () => cacheMixed(),
};

export const PRAGMA_WORKLOADS = {
  ...CONCURRENT_WORKLOADS,
  cache_sweep: () => cacheSweep({ rows: 5000, iterations: 5 }),
  rate_limit_sweep: () => rateLimitSweep({ rows: 5000, iterations: 5 }),
  cache_prefix_delete: () => cachePrefixInvalidate({ perNamespace: 2000 }),
};
