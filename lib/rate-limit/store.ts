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
export const RATE_LIMIT_SCHEMA_VERSION = 2;

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

  (db) => {
    db.exec(`DROP TABLE IF EXISTS auth_rate_limit`);
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
 * `cost` is how many units this admission spends, so a request whose work is
 * known to be N times an ordinary one can be charged as such (the image upload
 * charges its megapixels). At `cost = 1` the statement is exactly what it was:
 * `count + 1 <= max` is `count < max`. The caller must reject `cost > max`
 * BEFORE calling — neither the INSERT nor the window-rollover branch can refuse,
 * so a cost over the whole budget would be admitted and stored.
 *
 * Binds, in order: key, windowStart, cost, expiresAt, limit.
 */
const SQL_CONSUME = `
  INSERT INTO rate_limit (key, window_start, count, expires_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    count        = CASE WHEN rate_limit.window_start = excluded.window_start
                        THEN rate_limit.count + excluded.count
                        ELSE excluded.count END,
    window_start = excluded.window_start,
    expires_at   = excluded.expires_at
  WHERE rate_limit.window_start <> excluded.window_start
     OR rate_limit.count + excluded.count <= ?
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
 * Bounded, not a single unbounded DELETE. After a missed run or a
 * high-cardinality attack the backlog can be large, and one DELETE would hold the
 * sole writer lock for its whole duration — making the security path wait on
 * `busy_timeout` or fail. `LIMIT` needs SQLITE_ENABLE_UPDATE_DELETE_LIMIT, which
 * both current builds have; see the driver's swap notes.
 */
const SQL_SWEEP_RATE_LIMIT = `DELETE FROM rate_limit WHERE expires_at <= ? LIMIT ?`;
/**
 * Cheap existence probe; avoids a COUNT over the table.
 *
 * `EXISTS` short-circuits on the first matching row and uses the `expires_at`
 * index. One row is ALWAYS returned, so the caller must read `present` rather
 * than test the row for existence.
 *
 * Binds: cutoff.
 */
const SQL_ANY_EXPIRED = `
  SELECT EXISTS(SELECT 1 FROM rate_limit WHERE expires_at <= ?) AS present`;

export interface ConsumeRow {
  count: number;
  window_start: number;
}

interface RateLimitStore {
  readonly db: SqliteConnection;
  readonly consume: SqliteStatement;
  readonly sweepRateLimit: SqliteStatement;
  readonly anyExpired: SqliteStatement;
}

/**
 * Held on an object rather than in a bare `let`: the getter and the closer are
 * both functions, and assigning a module-level binding from inside one is what
 * `unicorn/no-top-level-assignment-in-function` forbids. A single-field record
 * says the same thing without the lint suppression.
 */
const singleton: { store: RateLimitStore | null } = { store: null };

/**
 * Opened on first use, not at import: a build step that evaluates the module
 * graph has no writable data volume, so opening at import time would fail it.
 *
 * Statements are prepared once and reused: better-sqlite3 caches nothing, and
 * re-preparing on every call measured meaningfully slower. (bun:sqlite's
 * `query()` caches by SQL string, so this stays correct after the driver swap.)
 */
export const getRateLimitStore: () => RateLimitStore = (() => {
  return () => {
    if (singleton.store) return singleton.store;

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
        sweepRateLimit: db.prepare(SQL_SWEEP_RATE_LIMIT),
        anyExpired: db.prepare(SQL_ANY_EXPIRED),
      };
      singleton.store = candidate;
      return candidate;
    } catch (error) {
      db.close();
      throw error;
    }
  };
})();

/**
 * Closes the limiter database if this process ever opened it.
 *
 * Deliberately does NOT open one: called from the shutdown path, where opening
 * a database in order to close it would create the file (and its WAL) on a
 * container that never used it.
 */
export function closeRateLimitStore(): void {
  const { store } = singleton;
  if (!store) return;
  singleton.store = null;
  store.db.close();
}

/**
 * Deletes expired rows, in bounded batches, yielding between them.
 * Invoked by `runMaintenanceSweep` (lib/sqlite/maintenance.ts), which the
 * `sqlite-expiry-sweep` job in `lib/schedule.ts` drives.
 *
 * Must run as ONE scheduled job, not per process: N app processes each running
 * their own interval would multiply writes against the store most sensitive to
 * write contention.
 *
 * Not a correctness boundary. Expiry is filtered on every read, so a delayed or
 * failed sweep can never make an expired row readable — it only reclaims disk.
 */
export async function sweepExpired(
  now = Date.now()
): Promise<{ rateLimit: SweepResult }> {
  const { sweepRateLimit } = getRateLimitStore();
  return { rateLimit: await sweepInBatches(sweepRateLimit, now) };
}

/** Cheap backlog probe for readiness/monitoring; no full-table scan. */
export function hasExpiredRows(now = Date.now()): boolean {
  const row = getRateLimitStore().anyExpired.get<{ present: number }>(now);
  return Boolean(row?.present);
}
