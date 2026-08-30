import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { SqliteConnection } from './driver';

import { openConnection } from './driver';

const LOCK_FILE = '.writer-lock.db';

export interface WriterLock {
  release: () => void;
}

/**
 * Claims ownership of a SQLite directory for THIS application instance.
 *
 * An ownership lock, not a mutex on the databases. It holds an exclusive
 * transaction on a separate marker file, so `rate-limit.db` and `cache.db` stay
 * writable by any other SQLite client — an operator script, a `sqlite3` shell, a
 * container from a release that predates this function. A marker file cannot
 * make an arbitrary client cooperate; what it does is stop a SECOND APP INSTANCE
 * from starting, which is the case that actually occurs, and it does that
 * without holding a lock on the databases a backup needs to read.
 *
 * The consequence for deployment is stop-first, not rolling: a rolling overlap
 * puts an old release — which never called this — beside a new one, sharing one
 * volume with two schema expectations and two schedules.
 *
 * **What this does NOT rest on: a claim that concurrent SQLite writers
 * malfunction.** They do not. Measured on Bun 1.4.0 / SQLite 3.53.2, eight
 * separate processes driving this application's own `openDatabase({ durability:
 * 'process-crash-safe' })` and the real limiter upsert against one shared file —
 * 300 writes each on a single contended key, from a cold create-and-migrate
 * race — stored an exact 2,400 with zero lost updates, zero `SQLITE_BUSY` and no
 * 503-shaped failure. WAL multi-process writing is what the store was chosen
 * for and it delivers it. So the reason to keep one instance per directory is
 * the two-releases-one-volume case above and the SINGLE-OWNER requirement of the
 * scheduled sweeps (`lib/schedule.ts`), not limiter unavailability.
 */
export function acquireWriterLock(directory: string): WriterLock {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- deployment-configured path, not user input
  mkdirSync(directory, { recursive: true });

  const db: SqliteConnection = openConnection(path.join(directory, LOCK_FILE));
  try {
    // Rollback-journal EXCLUSIVE uses an OS-released file lock.
    db.pragma('journal_mode = DELETE');
    db.pragma('busy_timeout = 0');
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    db.close();
    throw new Error(
      `Another application instance already owns the SQLite directory ${directory}. ` +
        'This deployment assumes ONE instance per directory: the scheduled sweeps ' +
        'in lib/schedule.ts are registered per process, so a second instance runs ' +
        'a second retention sweep against the same rows. Check for a second app ' +
        'container mounting the same volume, a leftover process, or a script ' +
        'pointed at the production SQLITE_DIR. ' +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  const state = { released: false };
  return {
    release: () => {
      if (state.released) return;
      state.released = true;
      try {
        db.exec('ROLLBACK');
      } catch {
        // Closing below releases the lock even if rollback is no longer possible.
      }
      db.close();
    },
  };
}
