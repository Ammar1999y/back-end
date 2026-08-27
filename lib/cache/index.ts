/**
 * Disposable response/GET cache on its own SQLite database.
 *
 * Deliberately a SEPARATE file from the rate limiter, not a second table:
 *
 * - One writer lock per database file. Sharing one file would let a large cache
 *   write hold the lock while a login rate-limit check waits behind it. A 64MB
 *   transaction was measured to block the event loop for ~1.25 seconds.
 * - Different durability. Losing this file is free, so it runs with
 *   `synchronous = OFF`; the limiter needs crash-safety and runs with `NORMAL`.
 * - Different blast radius. Corrupt or oversized cache? Delete the file and
 *   restart. In one shared file that would take the security counters with it.
 * - Different maintenance. This one can be dropped wholesale; the limiter needs a
 *   TTL sweep that must never be blocked by cache work.
 *
 * Values are OPAQUE BLOBs. Do not switch them to SQLite's JSONB: for a cache
 * whose dominant operation is "give me this whole value by key", JSONB measured
 * clearly slower on BOTH read and write, to save a modest amount of disk on data
 * that is free to lose. JSONB wins only when reading a small field out of a large
 * document, which is not this access pattern. If that pattern ever appears, add a
 * JSONB column for that namespace only. (Ratios in bench/sqlite/FINAL-REPORT.md;
 * measured on Windows, so directional rather than exact.)
 *
 * ## Status: SCAFFOLD — no call site uses this yet
 *
 * It exists so call sites have one interface to adopt, and so the durability
 * decision is visible at each call site rather than being an emergent property of
 * which module was imported. Before the FIRST caller adopts it, decide and write
 * down: the namespace grammar for keys, the total on-disk budget and what enforces
 * it, the invalidation trigger, and whether the decoded value needs schema
 * validation rather than a bare `JSON.parse` cast. A per-value size cap is already
 * enforced below; a total-size cap and an eviction policy are NOT.
 */
import type { Migration } from '@/lib/sqlite/database';
import type { SqliteConnection, SqliteStatement } from '@/lib/sqlite/driver';
import type { SweepResult } from '@/lib/sqlite/sweep';

import { CACHE_DB_PATH } from '@/lib/env.server';
import { openDatabase } from '@/lib/sqlite/database';
import { sweepInBatches } from '@/lib/sqlite/sweep';

import { prefixUpperBound } from './prefix';

const MIGRATIONS: readonly Migration[] = [
  (db) => {
    db.exec(`CREATE TABLE cache (
      key        TEXT    NOT NULL PRIMARY KEY,
      value      BLOB    NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID`);
    db.exec(`CREATE INDEX cache_expires_at ON cache (expires_at)`);
  },
];

const SQL_GET = `SELECT value FROM cache WHERE key = ? AND expires_at > ?`;
/** Binds, in order: key, value, expiresAt, createdAt. */
const SQL_SET = `
  INSERT INTO cache (key, value, expires_at, created_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    value      = excluded.value,
    expires_at = excluded.expires_at,
    created_at = excluded.created_at`;
const SQL_DELETE = `DELETE FROM cache WHERE key = ?`;
/**
 * Range delete, not `GLOB`. `GLOB` treats `*`, `?` and `[` as metacharacters, so a
 * namespace prefix containing any of them would silently delete unrelated keys —
 * and the earlier comment claiming only `_`/`%` mattered was wrong: those are
 * LIKE's metacharacters, not GLOB's. A half-open range has no metacharacters at
 * all and still uses the primary-key index.
 *
 * Binds, in order: prefix, prefix upper bound.
 */
const SQL_DELETE_PREFIX = `DELETE FROM cache WHERE key >= ? AND key < ?`;
/** Used when the prefix has no successor — every key at or after it matches. */
const SQL_DELETE_FROM = `DELETE FROM cache WHERE key >= ?`;
const SQL_SWEEP = `DELETE FROM cache WHERE expires_at <= ? LIMIT ?`;
/**
 * Existence probe, not a count. `COUNT(*)` / `SUM(length(value))` over the whole
 * table is an unbounded scan that grows with the cache, so a maintenance job must
 * not run it every hour. It also measured only payload length, never the
 * database, WAL or filesystem bytes actually consumed — monitor those from the
 * filesystem instead.
 */
const SQL_ANY_EXPIRED = `SELECT 1 AS present FROM cache WHERE expires_at <= ? LIMIT 1`;

interface CacheStore {
  readonly db: SqliteConnection;
  readonly read: SqliteStatement;
  readonly write: SqliteStatement;
  readonly del: SqliteStatement;
  readonly delPrefix: SqliteStatement;
  readonly delFrom: SqliteStatement;
  readonly sweep: SqliteStatement;
  readonly anyExpired: SqliteStatement;
}

/** Same shape as the limiter store's singleton — see the note there. */
const singleton: { store: CacheStore | null } = { store: null };

const getStore: () => CacheStore = (() => {
  return () => {
    if (singleton.store) return singleton.store;

    const db = openDatabase({
      path: CACHE_DB_PATH,
      migrations: MIGRATIONS,
      durability: 'disposable',
    });

    // See the note in lib/rate-limit/store.ts: a prepare failure must not leave
    // the native handle open, so the singleton is published only once every
    // statement has compiled.
    try {
      const candidate: CacheStore = {
        db,
        read: db.prepare(SQL_GET),
        write: db.prepare(SQL_SET),
        del: db.prepare(SQL_DELETE),
        delPrefix: db.prepare(SQL_DELETE_PREFIX),
        delFrom: db.prepare(SQL_DELETE_FROM),
        sweep: db.prepare(SQL_SWEEP),
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
 * Closes the cache database if this process ever opened it. Same rule as the
 * limiter store: never opens one just to close it.
 */
export function closeCacheStore(): void {
  const { store } = singleton;
  if (!store) return;
  singleton.store = null;
  store.db.close();
}

const decoder = new TextDecoder();

/** Ceiling on a single cached value; see the note in `cacheSet`. */
const MAX_VALUE_BYTES = 512 * 1024;

/**
 * Returns null on a miss, on an expired entry, or on any store failure.
 *
 * A cache that throws is worse than a cache that misses: every call site would
 * need a try/catch to preserve behaviour the cache was supposed to be invisible
 * to. Losing this data costs one rebuild, which is the definition of this tier.
 *
 * @knipignore
 */
export function cacheGet<Value>(key: string): Value | null {
  try {
    const row = getStore().read.get<{ value: Uint8Array }>(key, Date.now());
    if (!row) return null;
    return JSON.parse(decoder.decode(row.value)) as Value;
  } catch {
    return null;
  }
}

/**
 * `ttlSeconds` is required: an entry with no expiry is not a cache entry.
 */
export function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number
): void {
  try {
    const encoded = Buffer.from(JSON.stringify(value));
    // Both drivers are synchronous, so a large write blocks the whole worker's
    // event loop — a 64MB transaction was measured at over a second. No cache
    // entry is worth that, so an oversized value is dropped rather than written.
    if (encoded.byteLength > MAX_VALUE_BYTES) {
      console.warn(
        JSON.stringify({
          msg: 'cache value rejected: over size cap',
          bytes: encoded.byteLength,
          capBytes: MAX_VALUE_BYTES,
        })
      );
      return;
    }
    const now = Date.now();
    getStore().write.run(key, encoded, now + ttlSeconds * 1000, now);
  } catch {
    // A failed write is a future miss, not a request failure.
  }
}

/** @knipignore */
export function cacheDelete(key: string): void {
  try {
    getStore().del.run(key);
  } catch {
    // See cacheSet.
  }
}

/**
 * Invalidates a whole namespace.
 *
 * An empty prefix is rejected rather than treated as "everything": a caller that
 * accidentally passes an unset variable would otherwise flush the entire cache,
 * which looks like a performance problem rather than a bug.
 *
 * @knipignore
 */
export function cacheDeletePrefix(prefix: string): void {
  if (prefix.length === 0)
    throw new Error('cacheDeletePrefix requires a non-empty prefix');
  try {
    // The bound is the prefix's lexicographic SUCCESSOR, not the prefix with a
    // large character appended. No appended character can be correct: the bound
    // is exclusive, so whatever is appended, a key can contain that character and
    // continue past it. Appending U+FFFF missed every supplementary character;
    // appending U+10FFFF still missed keys equal to or extending past it. See
    // lib/cache/prefix.ts.
    //
    // `null` means the prefix is already maximal, so every key at or after it
    // starts with the prefix and no upper bound applies.
    const upper = prefixUpperBound(prefix);
    const store = getStore();
    if (upper === null) store.delFrom.run(prefix);
    else store.delPrefix.run(prefix, upper);
  } catch {
    // See cacheSet.
  }
}

/**
 * Deletes expired rows, bounded and yielding, exactly like the limiter sweep.
 * This is the table most likely to hold a large backlog, so leaving it as one
 * unbounded DELETE would have defeated the batching done everywhere else.
 */
export function cacheSweepExpired(now = Date.now()): Promise<SweepResult> {
  return sweepInBatches(getStore().sweep, now);
}

/** Cheap backlog probe. Deliberately not a row/byte count — see `SQL_ANY_EXPIRED`. */
export function cacheHasExpiredRows(now = Date.now()): boolean {
  return Boolean(getStore().anyExpired.get(now));
}
