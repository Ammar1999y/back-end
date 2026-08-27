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
 * puts an old release — which never called this — beside a new one, and the
 * contention is exactly the fail-closed-limiter outage below. External writers
 * are prohibited operationally, because they cannot be prohibited here.
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
        'This deployment assumes ONE writer: a second one stalls every ' +
        'fail-closed limiter into a 503 rather than degrading. Check for a ' +
        'second app container mounting the same volume, a leftover process, or ' +
        'a script pointed at the production SQLITE_DIR. ' +
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
