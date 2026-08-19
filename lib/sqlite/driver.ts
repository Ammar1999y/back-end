/**
 * The ONLY module in this codebase that knows which SQLite driver is in use.
 *
 * ============================================================================
 * WHY better-sqlite3 AND NOT bun:sqlite
 * ============================================================================
 * `bun:sqlite` is the intended long-term driver, but it cannot be used yet:
 * Next.js route handlers execute under Node, not Bun. Verified on Next 16.3.1
 * in dev, in production (`next start`), and with `bun --bun` forcing the Bun
 * runtime for the CLI — every path reported `runtime: node` and
 * `import('bun:sqlite')` failed with `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
 * Next/Turbopack forks its own Node workers, so `--bun` never reaches them.
 *
 * The reverse also holds: better-sqlite3 CANNOT run under Bun. It is built
 * against the V8 C++ API, which Bun (JavaScriptCore) only partially emulates —
 * see https://github.com/oven-sh/bun/issues/4290, open since August 2023. Under
 * Bun it either throws `ERR_DLOPEN_FAILED` or hard-panics the process with
 * `NAPI FATAL ERROR`. So the driver MUST be swapped at the same time the server
 * stops being Next.js, not before and not after.
 *
 * ============================================================================
 * HOW TO SWAP TO bun:sqlite (do this with the Hono/Elysia migration)
 * ============================================================================
 * Everything below is contained in this file. No caller changes.
 *
 * 1. Replace the import:
 *      -  import Database from 'better-sqlite3';
 *      +  import { Database } from 'bun:sqlite';
 *
 * 2. Construct with `create` — bun:sqlite does not create the file by default:
 *      -  new Database(path)
 *      +  new Database(path, { create: true })
 *
 * 3. PRAGMA is `exec`, not a method:
 *      -  db.pragma('journal_mode = WAL')
 *      +  db.exec('PRAGMA journal_mode = WAL')
 *    and reading one back:
 *      -  db.pragma(name, { simple: true })
 *      +  Object.values(db.query(`PRAGMA ${name}`).get() ?? {})[0]
 *
 * 4. Prefer `db.query()` over `db.prepare()`: bun:sqlite caches compiled
 *    statements by SQL string (20 by default), better-sqlite3 caches nothing —
 *    which is why callers here prepare once at module scope. Either works.
 *
 * 5. BLOB columns come back as `Uint8Array`, not `Buffer`. Everything in this
 *    codebase already reads them through `new TextDecoder().decode(...)`, which
 *    accepts both, so no change is expected — but grep for `Buffer.isBuffer`
 *    and `.toString('utf8')` on a query result before trusting that.
 *
 * 6. A missing row is `null` in bun:sqlite and `undefined` in better-sqlite3.
 *    Callers here use `if (!row)`, which covers both. Keep it that way.
 *
 * 7. Statements hold native handles in bun:sqlite and should be `.finalize()`d
 *    when discarded. Module-scope statements live for the process, so this only
 *    matters if a future caller prepares statements per request.
 *
 * 8. `close()` takes an argument: `db.close(true)` finalizes outstanding
 *    statements immediately. better-sqlite3 takes none.
 *
 * 9. Integers past 2^53 lose precision in BOTH drivers (measured). bun:sqlite
 *    can fix it with `{ safeIntegers: true }`, but that returns EVERY integer as
 *    a bigint, which breaks `JSON.stringify` and forces conversions everywhere.
 *    Do not enable it: the largest value stored here is a millisecond timestamp
 *    (~1.7e12) against a ~9e15 ceiling.
 *
 * 10. `transactionImmediate` maps to `db.transaction(fn).immediate` here. In
 *     bun:sqlite the equivalent is `db.transaction(fn).immediate(...)` as well —
 *     same name, but verify it acquires the write lock eagerly before relying on
 *     it for the migration lock.
 *
 * 11. The bounded sweep uses `DELETE ... LIMIT`, which requires SQLite to be
 *     compiled with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`. Both current builds have
 *     it (verified). If a future build does not, rewrite as
 *     `DELETE FROM t WHERE key IN (SELECT key FROM t WHERE ... LIMIT ?)`.
 *
 * 12. Delete `better-sqlite3` and `@types/better-sqlite3` from package.json, and
 *     drop `better-sqlite3` from `serverExternalPackages` in next.config.js and
 *     from `ignoreScripts`.
 *
 * ============================================================================
 * PORTABILITY RULE THAT APPLIES TO EVERY CALLER
 * ============================================================================
 * Use anonymous `?` placeholders, never `?1` / `?2`. better-sqlite3 rejects
 * numbered placeholders when binding positionally with
 * `RangeError: Too many parameter values were provided`; bun:sqlite accepts
 * both. Writing `?1` would silently couple this codebase to Bun.
 */

// Types come from DefinitelyTyped at 9.x while the library is 13.x. The surface
// used here — Database, prepare, Statement.run/get/all, pragma, transaction,
// exec, close — is unchanged between those versions and matches the v13 docs.
// Both packages disappear at the bun:sqlite swap.
import Database from 'better-sqlite3';

export interface SqliteStatement {
  get<Row>(...params: readonly SqliteBindValue[]): Row | undefined;
  all<Row>(...params: readonly SqliteBindValue[]): Row[];
  /** `changes` is what lets the bounded sweep know when a batch came up short. */
  run(...params: readonly SqliteBindValue[]): { changes: number };
}

export type SqliteBindValue = string | number | bigint | Uint8Array | null;

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
  close(): void;
}

/**
 * A missing row is `undefined` here and `null` under bun:sqlite; callers must
 * test falsiness rather than compare against either literal.
 */
export function openConnection(path: string): SqliteConnection {
  const db = new Database(path);

  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        get: (...params) => statement.get(...params) as never,
        all: (...params) => statement.all(...params) as never,
        run: (...params) => ({ changes: statement.run(...params).changes }),
      };
    },
    exec: (sql) => {
      db.exec(sql);
    },
    pragma: (statement) => {
      db.pragma(statement);
    },
    pragmaValue: (name) => db.pragma(name, { simple: true }),
    transaction: (fn) => db.transaction(fn),
    transactionImmediate: (fn) => db.transaction(fn).immediate,
    close: () => {
      db.close();
    },
  };
}
