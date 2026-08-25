/**
 * Errors the real `bun:sqlite` driver threw, for tests about error handling.
 *
 * **A hand-authored fixture is the wrong tool here and had already been the
 * wrong answer twice.** Two probes declared
 * `class LeakyDriverError extends Error { override name = 'SqliteError' }` and
 * asserted `errorClass === 'SqliteError'` — which passed for the same reason any
 * invented spelling would have: the fixture set the exact string the assertion
 * looked for. Measured on Bun 1.4.0, the driver's actual shape is
 * `.name === 'SQLiteError'` (capital L and E), `.constructor.name === 'Error'`
 * — not a subclass at all — and `.code` like `SQLITE_CONSTRAINT_PRIMARYKEY`.
 * `better-sqlite3` was the driver that spelled it `SqliteError`, and it has not
 * been the driver since the framework migration.
 *
 * So the rule these helpers exist to enforce: **never assert against a
 * manufactured driver error where a real one is reachable.** Provoking one costs
 * an in-memory database and two statements.
 *
 * A hostile fixture still has a place — proving containment against a driver that
 * behaves WORSE than the real one — but it has to be paired with at least one
 * assertion whose error came from the driver, or the whole file is circular.
 */
import { Database } from 'bun:sqlite';

/** What `bun:sqlite` calls its errors. Read off a real one, never hardcoded. */
export const REAL_SQLITE_ERROR_NAME = realUniqueViolation().name;

/**
 * A genuine UNIQUE-constraint failure, with the key that violated it bound as a
 * parameter.
 *
 * The bound value is the point: this is the shape that would leak a limiter key
 * if the driver ever started interpolating parameters into its message. It does
 * not today — a violation on a key containing an email address produces only
 * `UNIQUE constraint failed: t.key` — and asserting that is what makes the
 * boundary's containment claim testable against reality rather than against a
 * guess.
 */
export function realUniqueViolation(
  key = 'otp.send.dest.email:victim-sentinel@example.com'
): Error {
  const db = new Database(':memory:');
  try {
    db.run('CREATE TABLE t (key TEXT PRIMARY KEY)');
    db.run('INSERT INTO t VALUES (?)', [key]);
    db.run('INSERT INTO t VALUES (?)', [key]);
    throw new Error('expected a UNIQUE violation and did not get one');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('expected a'))
      throw error;
    return error as Error;
  } finally {
    db.close();
  }
}

/** A genuine `no such table`, i.e. a schema failure rather than a constraint. */
export function realMissingTableError(): Error {
  const db = new Database(':memory:');
  try {
    db.run('SELECT * FROM does_not_exist');
    throw new Error('expected a missing-table error and did not get one');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('expected a'))
      throw error;
    return error as Error;
  } finally {
    db.close();
  }
}
