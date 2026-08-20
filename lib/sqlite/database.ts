/**
 * Opening, configuring and migrating a local SQLite database.
 *
 * Driver-agnostic: everything driver-specific is in `./driver`.
 *
 * The PRAGMA set below is deliberately small. It was chosen by measuring 38
 * configurations against this application's own workloads — see
 * `bench/sqlite/FINAL-REPORT.md` for the method and the numbers. Two findings
 * drove it: `journal_mode` and `synchronous` dominate everything else by orders
 * of magnitude, and several conventionally-recommended settings (`mmap_size`,
 * `cache_size`, `temp_store`, a larger `page_size`) produced no measurable gain
 * individually and were measurably WORSE stacked together.
 *
 * Those measurements were taken on Windows, not on the Linux target, so treat the
 * ordering as established and the exact ratios as indicative only. Do not add a
 * setting here without a measurement on the target host showing a gain.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { SqliteConnection } from './driver';

import { openConnection } from './driver';

/** Each migration runs once, in order, under the migration lock. */
export type Migration = (db: SqliteConnection) => void;

export type Durability = 'process-crash-safe' | 'disposable';

export interface OpenOptions {
  path: string;
  migrations: readonly Migration[];
  /**
   * `process-crash-safe` is WAL + `synchronous = NORMAL`. Named for exactly what
   * it was verified to provide and no more — see the note on `applyPragmas`.
   */
  durability?: Durability;
}

const BASE_PRAGMAS = [
  // Without WAL every read blocks on every write and the whole API serialises.
  // Persisted in the file header, so this is idempotent.
  'journal_mode = WAL',
  // Both drivers default this to -1 (unbounded), so one large transaction would
  // inflate the WAL permanently.
  //
  // Read what this does and does not do, precisely: it bounds the size the WAL is
  // TRUNCATED TO once a checkpoint completes. It is NOT a ceiling on WAL growth.
  // While checkpointing is blocked — by a long-lived read snapshot, or by writers
  // that never leave a gap — the WAL grows without limit regardless of this value.
  // Measured: 1.36 GB against this 64 MiB setting with one reader holding an open
  // snapshot, dropping to 0 the moment a TRUNCATE checkpoint could run. Peak WAL
  // is therefore an operational concern (disk monitoring, a periodic
  // `wal_checkpoint(TRUNCATE)`), not something this line solves.
  'journal_size_limit = 67108864',
  // Defaults to ON; nothing here uses schema-defined functions.
  'trusted_schema = OFF',
] as const;

/**
 * 2000ms.
 *
 * NOT a reduction from a driver default, which is what the previous version of
 * this comment claimed: a fresh `bun:sqlite` connection reads back
 * `PRAGMA busy_timeout = 0` (measured on Bun 1.3.14), so without this line
 * every lock conflict fails instantly. `better-sqlite3` is the driver that
 * defaults to 5000ms, and it is not the driver in use.
 *
 * 2000 rather than more because both drivers are SYNCHRONOUS: a busy wait blocks
 * the entire worker's event loop rather than one request, and a five-second
 * stall on a login rate-limit check is worse than failing it. If this ceiling is
 * ever reached in practice the answer is a shared store, not a longer timeout —
 * multi-process contention was measured to starve a worker completely regardless
 * of this value.
 */
export const BUSY_TIMEOUT_MS = 2000;

/** `PRAGMA synchronous` reports an integer; NORMAL is 1 and OFF is 0. */
export const SYNCHRONOUS_VALUE: Record<Durability, number> = {
  'process-crash-safe': 1,
  disposable: 0,
};

/**
 * On durability, precisely:
 *
 * WAL + `synchronous = NORMAL` is **process-crash-safe**. A SIGKILL
 * mid-transaction was verified to leave `integrity_check = ok`, roll the
 * in-flight transaction back, and recover every committed row. That is what was
 * tested and that is all it claims.
 *
 * It is NOT the same as surviving host power loss. Under NORMAL, SQLite does not
 * fsync the WAL on every commit, so a power cut or host-level crash can lose the
 * most recently committed transactions. The database stays consistent; recent
 * commits may be gone.
 *
 * That trade is accepted here because the values are short-lived counters, and
 * because NORMAL costs nothing at the median versus OFF. If a counter ever needs
 * a zero power-loss RPO — the daily paid-OTP budget is the candidate — it needs
 * `synchronous = FULL` or a durable shared authority, not this default. Recorded
 * as an open decision in TODO.md.
 */
function applyPragmas(db: SqliteConnection, durability: Durability) {
  // FIRST, before anything that can take a lock. `journal_mode = WAL` is a
  // lock-taking statement, and a fresh bun:sqlite connection starts at
  // `busy_timeout = 0` (measured — see the note on BUSY_TIMEOUT_MS), so setting
  // the timeout after it would leave the one statement most likely to contend
  // on a cold start with no wait at all.
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  for (const pragma of BASE_PRAGMAS) db.pragma(pragma);
  db.pragma(
    `synchronous = ${durability === 'process-crash-safe' ? 'NORMAL' : 'OFF'}`
  );
}

/**
 * `PRAGMA user_version` replaces a migrations table for a schema this small.
 *
 * The whole check-and-migrate runs inside ONE `BEGIN IMMEDIATE`, which is the
 * point. Reading `user_version` before opening the transaction is a race: two
 * processes starting together both read 0, both enter a deferred transaction, and
 * the one that loses the write lock then re-runs the same DDL. Reproduced with
 * eight concurrent processes against a fresh file — the loser failed with
 * `table rate_limit already exists`. `BEGIN IMMEDIATE` takes the write lock
 * first, so the second process blocks, then re-reads a `user_version` that is
 * already current and does nothing.
 *
 * A newer-than-supported schema is refused rather than written through. The limit
 * of that guard, stated honestly: it is evaluated when this function runs, i.e.
 * at first store use in a process. It stops a stale container from STARTING to
 * use a newer schema; it cannot stop one already running with an open connection.
 * Deploy ordering remains an operational concern.
 */
function migrate(db: SqliteConnection, migrations: readonly Migration[]): void {
  db.transactionImmediate(() => {
    const current = Number(db.pragmaValue('user_version') ?? 0);

    if (current > migrations.length) {
      throw new Error(
        `SQLite schema is at version ${current}, newer than this build supports (${migrations.length}). ` +
          'Refusing to run: an older build must not write through a newer schema.'
      );
    }

    for (let version = current; version < migrations.length; version++) {
      const step = migrations[version];
      if (!step) continue;
      step(db);
      // user_version cannot be parameterised. `version` is a loop index over a
      // literal array, never input.
      db.pragma(`user_version = ${version + 1}`);
    }
  })();
}

export function openDatabase(options: OpenOptions): SqliteConnection {
  // The path comes from SQLITE_DIR (deployment configuration), never from a
  // request. Creating the directory is required because a fresh Coolify volume is
  // mounted empty.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- deployment-configured path, not user input
  mkdirSync(path.dirname(options.path), { recursive: true });

  const db = openConnection(options.path);
  // A PRAGMA or migration failure would otherwise abandon an open native handle —
  // and its writer lock — until garbage collection. Callers that fail open retry
  // on the next request, so the leak would accumulate.
  try {
    applyPragmas(db, options.durability ?? 'process-crash-safe');
    migrate(db, options.migrations);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * Cheap configuration readback. Used by readiness to prove the file that got
 * opened is actually configured the way this module intends.
 */
export function describeDatabase(db: SqliteConnection): {
  journalMode: unknown;
  synchronous: unknown;
  busyTimeout: unknown;
  userVersion: unknown;
} {
  return {
    journalMode: db.pragmaValue('journal_mode'),
    synchronous: db.pragmaValue('synchronous'),
    busyTimeout: db.pragmaValue('busy_timeout'),
    userVersion: db.pragmaValue('user_version'),
  };
}

/**
 * Structural check, for the deep/manual path only.
 *
 * `quick_check` rather than `integrity_check`: it skips the expensive
 * index-versus-table cross-validation. Still far too costly to run on every
 * readiness poll — see the route.
 */
export function quickCheck(db: SqliteConnection): string {
  // Finalized here, not left to the connection's own cleanup: this runs on a
  // manual health poll, so one statement per call would accumulate for the
  // lifetime of the process.
  const statement = db.prepare('PRAGMA quick_check');
  try {
    const row = statement.get<Record<string, unknown>>();
    const value = row ? Object.values(row)[0] : undefined;
    return typeof value === 'string' ? value : 'unknown';
  } finally {
    statement.finalize();
  }
}
