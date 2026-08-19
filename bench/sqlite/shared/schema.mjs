// Schema and statements mirroring the intended production shape:
// one dedicated rate-limit database, one disposable cache database.

// DDL variants. Table design is part of the config matrix: WITHOUT ROWID and
// STRICT change both the storage layout and the write path.
const VARIANTS = {
  default: { withoutRowid: true, strict: true },
  rowid: { withoutRowid: false, strict: true },
  no_strict: { withoutRowid: true, strict: false },
};

function suffix({ withoutRowid, strict }) {
  const parts = [];
  if (strict) parts.push('STRICT');
  if (withoutRowid) parts.push('WITHOUT ROWID');
  return parts.length ? ` ${parts.join(', ')}` : '';
}

export function ddlFor(variantName = 'default', scope = 'all') {
  const variant = VARIANTS[variantName];
  if (!variant) throw new Error(`unknown schema variant: ${variantName}`);
  if (!['all', 'rate-limit', 'cache'].includes(scope))
    throw new Error(`unknown schema scope: ${scope}`);
  const tail = suffix(variant);

  // A rowid table cannot make `key` the primary key without losing the implicit
  // rowid, so it gets an explicit unique index to keep lookups equivalent.
  const rateLimitKey = variant.withoutRowid
    ? 'key TEXT NOT NULL PRIMARY KEY'
    : 'key TEXT NOT NULL';
  const cacheKey = variant.withoutRowid
    ? 'key TEXT NOT NULL PRIMARY KEY'
    : 'key TEXT NOT NULL';

  const ddl = [];

  if (scope === 'all' || scope === 'rate-limit') {
    ddl.push(
      `CREATE TABLE IF NOT EXISTS rate_limit (
       ${rateLimitKey},
       window_start INTEGER NOT NULL,
       count        INTEGER NOT NULL,
       expires_at   INTEGER NOT NULL
     )${tail}`,
      `CREATE INDEX IF NOT EXISTS rate_limit_expires_at ON rate_limit (expires_at)`,
      `CREATE TABLE IF NOT EXISTS auth_rate_limit (
       ${rateLimitKey},
       count        INTEGER NOT NULL,
       window_start INTEGER NOT NULL,
       last_request INTEGER NOT NULL,
       expires_at   INTEGER NOT NULL
     )${tail}`,
      `CREATE INDEX IF NOT EXISTS auth_rate_limit_expires_at ON auth_rate_limit (expires_at)`
    );
  }

  if (scope === 'all' || scope === 'cache') {
    ddl.push(
      `CREATE TABLE IF NOT EXISTS cache (
       ${cacheKey},
       value      BLOB    NOT NULL,
       expires_at INTEGER NOT NULL,
       created_at INTEGER NOT NULL
     )${tail}`,
      `CREATE INDEX IF NOT EXISTS cache_expires_at ON cache (expires_at)`
    );
  }

  if (!variant.withoutRowid) {
    if (scope === 'all' || scope === 'rate-limit') {
      ddl.push(
        `CREATE UNIQUE INDEX IF NOT EXISTS rate_limit_key ON rate_limit (key)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS auth_rate_limit_key ON auth_rate_limit (key)`
      );
    }
    if (scope === 'all' || scope === 'cache')
      ddl.push(`CREATE UNIQUE INDEX IF NOT EXISTS cache_key ON cache (key)`);
  }

  return ddl;
}

// Verbatim from `lib/rate-limit/store.ts` (SQL_CONSUME). The trailing WHERE is
// what makes admission max-aware, and it changes the measurement, not only the
// semantics: a request that is already at the limit inside the current window
// updates nothing, so an exhausted key costs a read rather than a write. A
// benchmark without it measures a write path production does not have.
//
// Binds, in order: key, windowStart, expiresAt, limit.
// Returns NO ROW when the request is denied.
export const SQL_RL_CONSUME = `
  INSERT INTO rate_limit (key, window_start, count, expires_at)
  VALUES (?, ?, 1, ?)
  ON CONFLICT(key) DO UPDATE SET
    count        = CASE WHEN rate_limit.window_start = excluded.window_start
                        THEN rate_limit.count + 1 ELSE 1 END,
    window_start = excluded.window_start,
    expires_at   = excluded.expires_at
  WHERE rate_limit.window_start <> excluded.window_start
     OR rate_limit.count < ?
  RETURNING count, window_start`;

// Approximate sliding window: two weighted buckets, so two rows per identifier.
export const SQL_RL_SLIDING_UPSERT = `
  INSERT INTO rate_limit (key, window_start, count, expires_at)
  VALUES (?, ?, 1, ?)
  ON CONFLICT(key) DO UPDATE SET count = rate_limit.count + 1
  RETURNING count`;

export const SQL_RL_SLIDING_PREV = `
  SELECT count FROM rate_limit WHERE key = ?`;

// Better Auth 1.6 fallback shape: read, then write back.
export const SQL_AUTH_GET = `SELECT key, count, last_request FROM auth_rate_limit WHERE key = ? AND expires_at > ?`;
export const SQL_AUTH_SET = `
  INSERT INTO auth_rate_limit (key, count, window_start, last_request, expires_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET count = excluded.count,
                                 window_start = excluded.window_start,
                                 last_request = excluded.last_request,
                                 expires_at = excluded.expires_at`;

// Verbatim from `lib/rate-limit/store.ts` (SQL_AUTH_CONSUME). Max-aware for the
// same reason as above; the login limiter is precisely where a rejected request
// must not buy the attacker a write.
//
// Binds, in order: key, windowStart, now, expiresAt, max.
export const SQL_AUTH_CONSUME = `
  INSERT INTO auth_rate_limit (key, count, window_start, last_request, expires_at)
  VALUES (?, 1, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    count        = CASE WHEN auth_rate_limit.window_start = excluded.window_start
                        THEN auth_rate_limit.count + 1 ELSE 1 END,
    window_start = excluded.window_start,
    last_request = excluded.last_request,
    expires_at   = excluded.expires_at
  WHERE auth_rate_limit.window_start <> excluded.window_start
     OR auth_rate_limit.count < ?
  RETURNING count, window_start`;

export const SQL_CACHE_PUT = `
  INSERT INTO cache (key, value, expires_at, created_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                 expires_at = excluded.expires_at,
                                 created_at = excluded.created_at`;

export const SQL_CACHE_GET = `SELECT value FROM cache WHERE key = ? AND expires_at > ?`;

/**
 * Namespace invalidation, verbatim from `lib/cache/index.ts` (SQL_DELETE_PREFIX).
 *
 * A half-open range rather than `GLOB`, because `GLOB` treats `*`, `?` and `[` as
 * metacharacters and would delete unrelated keys for any namespace containing
 * one. Unlike every other delete in the deployed code this one is UNBOUNDED —
 * measuring it is the point, since the deployed statement holds the cache writer
 * lock for its whole duration.
 *
 * Binds, in order: prefix, exclusive upper bound.
 */
export const SQL_CACHE_DELETE_PREFIX = `DELETE FROM cache WHERE key >= ? AND key < ?`;

/**
 * Sweeps are bounded, matching `sweepInBatches` in `lib/sqlite/sweep.ts`. An
 * unbounded `DELETE` holds the sole writer lock for its whole duration, so
 * measuring one would report a maintenance cost the deployed code does not pay.
 *
 * Binds, in order: cutoff, batch size. Each returns the rows it removed.
 */
export const SQL_CACHE_SWEEP = `DELETE FROM cache WHERE expires_at <= ? LIMIT ?`;
export const SQL_RL_SWEEP = `DELETE FROM rate_limit WHERE expires_at <= ? LIMIT ?`;
export const SQL_AUTH_SWEEP = `DELETE FROM auth_rate_limit WHERE expires_at <= ? LIMIT ?`;

/** Batch size and per-run ceiling, mirroring `lib/sqlite/sweep.ts`. */
export const SWEEP_BATCH_SIZE = 500;
export const SWEEP_MAX_BATCHES = 200;

/**
 * Admission limit for cases that are not about the limit.
 *
 * Both consume statements are max-aware, so any case that runs more than `max`
 * iterations on one key silently stops measuring admission and starts measuring
 * refusal. A ceiling no run can reach keeps a throughput or rollover case
 * measuring what it is named for; refusal has its own dedicated coverage.
 */
export const NO_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * Bench-only assertion helper. Deliberately NOT part of the deployed code: a
 * `COUNT(*)`/`SUM(length())` over the whole table is an unbounded scan that grows
 * with the cache, which is why the application probes existence instead. It is
 * acceptable here because a benchmark checks its own postconditions.
 */
export const SQL_CACHE_STATS = `SELECT COUNT(*) AS rows, COALESCE(SUM(length(value)), 0) AS bytes FROM cache`;

export function makePayload(bytes) {
  const item = {
    sku: 'SKU-000000',
    qty: 0,
    price: 0,
    note: 'lorem ipsum dolor sit amet consectetur',
  };
  const items = [];
  let json = '';
  do {
    items.push({
      ...item,
      sku: `SKU-${String(items.length).padStart(6, '0')}`,
      qty: items.length,
    });
    json = JSON.stringify({ id: 42, status: 'active', items });
  } while (json.length < bytes);
  return Buffer.from(json);
}
