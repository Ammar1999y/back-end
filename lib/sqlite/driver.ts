/**
 * The ONLY module in this codebase that knows which SQLite driver is in use.
 *
 * ============================================================================
 * WHY bun:sqlite
 * ============================================================================
 * The driver and the server framework are one decision, not two. `better-sqlite3`
 * is built against the V8 C++ API, which Bun (JavaScriptCore) only partially
 * emulates — see https://github.com/oven-sh/bun/issues/4290, open since August
 * 2023. Under Bun it either throws `ERR_DLOPEN_FAILED` or hard-panics the process
 * with `NAPI FATAL ERROR`. The reverse also held: Next route handlers executed
 * under Node regardless of `bun --bun`, so `bun:sqlite` was unreachable there
 * (`ERR_UNSUPPORTED_ESM_URL_SCHEME`).
 *
 * The server runs under Bun, so `bun:sqlite` is the driver. Everything
 * driver-specific lives inside this file; no caller sees it.
 *
 * ============================================================================
 * WHAT TO RE-CHECK IF THE DRIVER EVER MOVES
 * ============================================================================
 * 1. `new Database(path, { create: true })` — bun:sqlite does not create the
 *    file unless asked.
 * 2. PRAGMA is a statement, not a method: `db.run('PRAGMA journal_mode = WAL')`,
 *    and reading one back goes through `db.query`.
 * 3. A missing row is `null` here and `undefined` under better-sqlite3.
 *    `SqliteStatement.get` is typed `Row | null` for that reason; every caller
 *    tests falsiness, which covers both.
 * 4. BLOB columns come back as `Uint8Array`, not `Buffer`. Everything here reads
 *    them through `new TextDecoder().decode(...)`, which accepts both.
 * 5. `prepare()` over `query()`, deliberately. `query()` caches compiled
 *    statements by SQL string with a bounded cache (20), and every statement in
 *    this codebase is prepared once at module scope and held for the process —
 *    a cache eviction finalising one of them would be a latent failure. `prepare`
 *    hands back a statement this code owns outright.
 * 6. Integers past 2^53 lose precision. `safeIntegers` would
 *    fix it but returns EVERY integer as a bigint, which breaks `JSON.stringify`.
 *    Do not enable it: the largest value stored here is a millisecond timestamp
 *    (~1.7e12) against a ~9e15 ceiling.
 * 7. The bounded sweep uses `DELETE ... LIMIT`, which requires SQLite compiled
 *    with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`. Bun's build has it (verified in
 *    bench/sqlite/bun-sqlite). If a future build does not, rewrite as
 *    `DELETE FROM t WHERE key IN (SELECT key FROM t WHERE ... LIMIT ?)`.
 *
 * ============================================================================
 * PORTABILITY RULE THAT APPLIES TO EVERY CALLER
 * ============================================================================
 * Use anonymous `?` placeholders, never `?1` / `?2`. bun:sqlite accepts both,
 * better-sqlite3 rejects numbered placeholders when binding positionally with
 * `RangeError: Too many parameter values were provided`. Writing `?1` would
 * silently make the rollback to better-sqlite3 impossible.
 */

import { Database } from 'bun:sqlite';
import type { SQLQueryBindings } from 'bun:sqlite';

export interface SqliteStatement {
  /** `null`, not `undefined`, when no row matched — see the driver notes. */
  get<Row>(...params: readonly SqliteBindValue[]): Row | null;
  all<Row>(...params: readonly SqliteBindValue[]): Row[];
  /** `changes` is what lets the bounded sweep know when a batch came up short. */
  run(...params: readonly SqliteBindValue[]): { changes: number };
  /**
   * Releases the native statement.
   *
   * Idempotent, and safe to skip: `close()` finalizes everything this
   * connection prepared. Call it only for a statement with a lifetime shorter
   * than the connection's — the deep health check's `quick_check` is the one
   * such case, and without it every readiness poll leaked a statement.
   *
   * A driver without an explicit per-statement release would have to implement
   * this by dropping the reference and letting GC collect it — which is exactly
   * the unbounded growth the `quick_check` caller exists to avoid, so check for
   * one before swapping.
   */
  finalize(): void;
}

type SqliteBindValue = string | number | bigint | Uint8Array | null;

export interface SqliteConnection {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  /** e.g. `journal_mode = WAL`. Driver-specific dispatch lives here. */
  pragma(statement: string): void;
  /** Reads a pragma's current value, for startup verification. */
  pragmaValue(name: string): unknown;
  /**
   * Zero-argument by design. Every caller here closes over what it needs, and a
   * generic argument tuple cannot be passed through better-sqlite3's invariant
   * `Transaction<F>` type without casting. Widen this only if a caller genuinely
   * needs bound arguments.
   */
  transaction(fn: () => void): () => void;
  /**
   * `BEGIN IMMEDIATE`: takes the write lock before the body runs, instead of
   * lazily on first write like a deferred transaction. Required wherever two
   * processes could otherwise both read the same pre-state and then both act on
   * it — schema migration is exactly that case.
   */
  transactionImmediate(fn: () => void): () => void;
  /**
   * Finalizes every statement this connection prepared, then closes the handle
   * strictly. See the note on `openConnection`.
   */
  close(): void;
}

/**
 * `close(true)` is the only close here, and the argument is the whole point.
 *
 * `close(false)` — SQLite's `close_v2` — DEFERS the real close while any
 * prepared statement is still alive and reports success while doing it, so the
 * handle, its file lock and its memory stay held with nothing saying so.
 * `lib/rate-limit/store.ts` and `lib/cache/index.ts` close the connection when
 * one prepare in their batch fails, specifically to release the handle; under
 * that form the guard did not do what it was written to do. `close(true)`
 * finalizes the outstanding statements instead, and `Statement#finalize` is
 * idempotent natively, so tracking live statements here adds nothing over it.
 *
 * ⚠️ This rests on bun:sqlite. A driver swap must re-measure
 * close-with-outstanding-statements before trusting it: one that neither
 * finalizes nor tolerates them needs a registry of live statements here.
 */
export function openConnection(path: string): SqliteConnection {
  // The path comes from SQLITE_DIR (deployment configuration), never a request.
  const db = new Database(path, { create: true, readwrite: true });

  return {
    prepare(sql) {
      const statement = db.prepare<unknown, SQLQueryBindings[]>(sql);
      return {
        get: (...params) => statement.get(...params) as never,
        all: (...params) => statement.all(...params) as never,
        run: (...params) => ({ changes: statement.run(...params).changes }),
        finalize: () => statement.finalize(),
      };
    },
    exec: (sql) => {
      db.run(sql);
    },
    pragma: (statement) => {
      db.run(`PRAGMA ${statement}`);
    },
    pragmaValue: (name) => {
      // `prepare` + immediate finalize, not `query`. `query` caches the compiled
      // statement inside the Database, and this is a one-off read of a fixed set
      // of pragma names, so the cache is pure growth. (It used to be justified by
      // the cached statement making a strict `close(true)` throw; Bun 1.4.0
      // finalizes cached statements too, so that reason is retired — this one is
      // not.)
      const statement = db.prepare<Record<string, unknown>, []>(
        `PRAGMA ${name}`
      );
      try {
        const row = statement.get();
        return row ? Object.values(row)[0] : undefined;
      } finally {
        statement.finalize();
      }
    },
    transaction: (fn) => db.transaction(fn),
    transactionImmediate: (fn) => db.transaction(fn).immediate,
    // `true`, not `false`: `close(false)` is the form that leaves a prepared
    // statement live and the handle open (measured above), and this is the path
    // that has to actually release the file.
    close: () => db.close(true),
  };
}
