/**
 * The rate-limit database. Replaces the former Upstash `client.ts`.
 *
 * Its own file, separate from the response cache, on purpose. Both concerns in
 * one database would share one write lock and one WAL, so a large cache write
 * could delay a login rate-limit check — and a 64MB transaction was measured to
 * block the event loop for ~1.25s. Separate files give each concern its own
 * writer lock, and let the cache be disposable while this one is crash-safe.
 *
 * Placeholders are anonymous `?`, never `?1` — see `lib/sqlite/driver.ts`.
 */
import type { Migration } from '@/lib/sqlite/database';
import type { SqliteConnection, SqliteStatement } from '@/lib/sqlite/driver';
import type { SweepResult } from '@/lib/sqlite/sweep';

import { RATE_LIMIT_DB_PATH } from '@/lib/env.server';
import { openDatabase } from '@/lib/sqlite/database';
import { sweepInBatches } from '@/lib/sqlite/sweep';

/**
 * `STRICT` so a wrong type fails loudly instead of storing text in a timestamp
 * column; `WITHOUT ROWID` because the row IS the index for a key-value table.
 * Both measured faster than the alternatives, and both were verified enforced.
 */
/** Readiness compares the file's `user_version` against this. */
export const RATE_LIMIT_SCHEMA_VERSION = 1;

const MIGRATIONS: readonly Migration[] = [
  (db) => {
    db.exec(`CREATE TABLE rate_limit (
      key          TEXT    NOT NULL PRIMARY KEY,
      window_start INTEGER NOT NULL,
      count        INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID`);
    db.exec(`CREATE INDEX rate_limit_expires_at ON rate_limit (expires_at)`);

    // `last_request` is redundant for `consume`, which anchors on `window_start`.
    // It exists because Better Auth's `get`/`set` contract is shaped around it,
    // and that path stays reachable on any version that does not call `consume`.
    db.exec(`CREATE TABLE auth_rate_limit (
      key          TEXT    NOT NULL PRIMARY KEY,
      count        INTEGER NOT NULL,
      window_start INTEGER NOT NULL,
      last_request INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID`);
    db.exec(
      `CREATE INDEX auth_rate_limit_expires_at ON auth_rate_limit (expires_at)`
    );
  },
];

/** Guards the constant above against drifting from the actual migration list. */
if (RATE_LIMIT_SCHEMA_VERSION !== MIGRATIONS.length)
  throw new Error(
    'RATE_LIMIT_SCHEMA_VERSION does not match the migration list'
  );

/**
 * Fixed-window admission as ONE statement, so no explicit transaction is needed.
 *
 * This shape was verified atomic across processes: four concurrent processes
 * performing 500 consumes each against one key produced a stored count of exactly
 * 2000 with zero lost updates. The `CASE` handles window rollover, so an expired
 * window resets to 1 without a separate read or delete.
 *
 * The `WHERE` on `DO UPDATE` is what makes it max-aware, and it matters for more
 * than tidiness. Without it every REJECTED request still performed a synchronous
 * write, so an attacker hammering an exhausted key generated write-lock
 * contention on the one database the security path depends on — the limiter
 * protected downstream work but not its own storage. With it, a request that is
 * already at the limit inside the same window updates nothing: verified at 4
 * writes across 20 calls where 16 were denied.
 *
 * Consequence for callers: a denied request returns NO row (nothing was updated).
 * That is unambiguous — the `WHERE` can only fail when the row exists, is in the
 * current window, and is already at `max` — so the caller computes `retryAfter`
 * from the `windowStart` it bound, with no follow-up read.
 *
 * Binds, in order: key, windowStart, expiresAt, limit.
 */
const SQL_CONSUME = `
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

/**
 * Denial deliberately has NO follow-up read.
 *
 * A no-row result already proves the stored row matched the `windowStart` the
 * caller bound and was at `max` — otherwise the `WHERE` would have updated it.
 * So the caller's own `windowStart` is the anchor, and reading it back was both
 * redundant and racy: another process can roll the row into the next window
 * between the denied UPSERT and the read, which made `retryAfter` overstate by a
 * full window (measured 61s where 1s was correct).
 */

/**
 * Max-aware for the same reason as `SQL_CONSUME`: the login limiter is precisely
 * where a rejected request must not buy the attacker a write.
 *
 * Binds, in order: key, windowStart, now, expiresAt, max.
 */
const SQL_AUTH_CONSUME = `
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

const SQL_AUTH_GET = `
  SELECT key, count, last_request FROM auth_rate_limit
  WHERE key = ? AND expires_at > ?`;

/** Binds, in order: key, count, windowStart, lastRequest, expiresAt. */
const SQL_AUTH_SET = `
  INSERT INTO auth_rate_limit (key, count, window_start, last_request, expires_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    count        = excluded.count,
    window_start = excluded.window_start,
    last_request = excluded.last_request,
    expires_at   = excluded.expires_at`;

/**
 * Bounded, not a single unbounded DELETE. After a missed run or a
 * high-cardinality attack the backlog can be large, and one DELETE would hold the
 * sole writer lock for its whole duration — making the security path wait on
 * `busy_timeout` or fail. `LIMIT` needs SQLITE_ENABLE_UPDATE_DELETE_LIMIT, which
 * both current builds have; see the driver's swap notes.
 */
const SQL_SWEEP_RATE_LIMIT = `DELETE FROM rate_limit WHERE expires_at <= ? LIMIT ?`;
const SQL_SWEEP_AUTH = `DELETE FROM auth_rate_limit WHERE expires_at <= ? LIMIT ?`;
/**
 * Cheap existence probe over BOTH limiter tables; avoids a COUNT over either.
 *
 * Both, not just `rate_limit`: a per-table `hasMore` only reports that the sweep
 * hit its own ceiling, so an `auth_rate_limit` backlog under that ceiling — rows
 * that expired while the run was in progress, for instance — would otherwise be
 * invisible while the equivalent cache backlog was reported.
 *
 * `EXISTS` short-circuits on the first matching row and uses the `expires_at`
 * index on each table. One row is ALWAYS returned, so the caller must read
 * `present` rather than test the row for existence.
 *
 * Binds, in order: cutoff, cutoff.
 */
const SQL_ANY_EXPIRED = `
  SELECT (EXISTS(SELECT 1 FROM rate_limit      WHERE expires_at <= ?)
       OR EXISTS(SELECT 1 FROM auth_rate_limit WHERE expires_at <= ?)) AS present`;

export interface ConsumeRow {
  count: number;
  window_start: number;
}

export interface AuthConsumeRow {
  count: number;
  window_start: number;
}

export interface AuthEntryRow {
  key: string;
  count: number;
  last_request: number;
}

interface RateLimitStore {
  readonly db: SqliteConnection;
  readonly consume: SqliteStatement;
  readonly authConsume: SqliteStatement;
  readonly authGet: SqliteStatement;
  readonly authSet: SqliteStatement;
  readonly sweepRateLimit: SqliteStatement;
  readonly sweepAuth: SqliteStatement;
  readonly anyExpired: SqliteStatement;
}

/**
 * Opened on first use, not at import. Module-scope side effects at import time
 * would run during `next build`, which has no writable data volume.
 *
 * Statements are prepared once and reused: better-sqlite3 caches nothing, and
 * re-preparing on every call measured meaningfully slower. (bun:sqlite's
 * `query()` caches by SQL string, so this stays correct after the driver swap.)
 */
export const getRateLimitStore: () => RateLimitStore = (() => {
  let store: RateLimitStore | null = null;

  return () => {
    if (store) return store;

    const db = openDatabase({
      path: RATE_LIMIT_DB_PATH,
      migrations: MIGRATIONS,
      durability: 'process-crash-safe',
    });

    // Every prepare happens inside the guard, and the singleton is published only
    // after all of them succeed. A prepare can fail on a database whose
    // `user_version` is current but whose tables are missing, and without this the
    // connection — and its native handle — stayed open until GC. Callers that fail
    // open retry on the next request, so the leak accumulated (reproduced: three
    // attempts, then Windows refused to rename the file with EBUSY).
    try {
      const candidate: RateLimitStore = {
        db,
        consume: db.prepare(SQL_CONSUME),
        authConsume: db.prepare(SQL_AUTH_CONSUME),
        authGet: db.prepare(SQL_AUTH_GET),
        authSet: db.prepare(SQL_AUTH_SET),
        sweepRateLimit: db.prepare(SQL_SWEEP_RATE_LIMIT),
        sweepAuth: db.prepare(SQL_SWEEP_AUTH),
        anyExpired: db.prepare(SQL_ANY_EXPIRED),
      };
      store = candidate;
      return candidate;
    } catch (error) {
      db.close();
      throw error;
    }
  };
})();

/**
 * Deletes expired rows, in bounded batches, yielding between them.
 * Invoked by `app/api/internal/sqlite-sweep/route.ts`.
 *
 * Must run as ONE scheduled job, not per process: N app processes each running
 * their own interval would multiply writes against the store most sensitive to
 * write contention.
 *
 * Not a correctness boundary. Expiry is filtered on every read, so a delayed or
 * failed sweep can never make an expired row readable — it only reclaims disk.
 */
export async function sweepExpired(now = Date.now()): Promise<{
  rateLimit: SweepResult;
  auth: SweepResult;
}> {
  const { sweepRateLimit, sweepAuth } = getRateLimitStore();
  return {
    rateLimit: await sweepInBatches(sweepRateLimit, now),
    auth: await sweepInBatches(sweepAuth, now),
  };
}

/** Cheap backlog probe for readiness/monitoring; no full-table scan. */
export function hasExpiredRows(now = Date.now()): boolean {
  const row = getRateLimitStore().anyExpired.get<{ present: number }>(now, now);
  return Boolean(row?.present);
}
