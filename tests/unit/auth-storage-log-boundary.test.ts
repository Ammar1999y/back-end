/**
 * The Better Auth rate-limit storage log boundary.
 *
 * Better Auth builds its key with `createRateLimitKey(ip, path)` = `${ip}|${path}`,
 * so a failure that logs the key puts the requester's IP address in the log on
 * every failing request. What an outage needs is which operation failed and the
 * error's class; neither is derived from the key.
 *
 * ## Two things this file used to get wrong
 *
 * - **It asserted a manufactured error class.** A local
 *   `class LeakyDriverError extends Error { override name = 'SqliteError' }` and
 *   then `expect(errorClass).toBe('SqliteError')` — a tautology that would pass
 *   for any invented spelling. `bun:sqlite` says `SQLiteError`; the class is now
 *   read off an error the driver threw.
 * - **It only ever tested the boundary FUNCTION.** The TODO it carried said the
 *   blocker was gone: the `better-sqlite3` NAPI panic that made importing the
 *   real storage impossible under Bun disappeared with the driver swap. The last
 *   describe below drives the real `authRateLimitStorage` into a real failure and
 *   asserts the same containment through the actual
 *   `catch → sanitizeForLog → console.error` wiring, which is the half no unit
 *   call on `describeAuthStoreFailure` can reach.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { serializeForLog } from '@/utils';
import { authRateLimitStorage } from '@/lib/rate-limit/auth-storage';
import { describeAuthStoreFailure } from '@/lib/rate-limit/store-failure';

import {
  REAL_SQLITE_ERROR_NAME,
  realMissingTableError,
  realUniqueViolation,
} from '../helpers/real-sqlite-error';
import { resetSqliteStores } from '../helpers/sqlite';

const IP = '203.0.113.42';
const PATH = '/sign-in/email';
/** Exactly what Better Auth passes to `customStorage.consume`. */
const BETTER_AUTH_KEY = `${IP}|${PATH}`;

/**
 * A driver error that embeds the bound key. Neither real driver does this; the
 * fixture is hostile on purpose, and its `name` comes from a real error so it
 * cannot be what decides the assertion below.
 */
function leakyError(): Error {
  const error = new Error(
    `constraint failed, statement was: ${JSON.stringify([
      'SELECT * FROM auth_rate_limit WHERE key = ?',
      BETTER_AUTH_KEY,
    ])}`
  );
  // eslint-disable-next-line unicorn/no-error-property-assignment -- deliberate shape fidelity: the real bun:sqlite error IS a plain Error with `.name` reassigned (`constructor.name === 'Error'`), so a subclass would be a LESS accurate fixture than this
  error.name = REAL_SQLITE_ERROR_NAME;
  return error;
}

describe('the boundary function withholds the key', () => {
  test.each(['get', 'set', 'consume'] as const)(
    'the requester IP never reaches the log via %s',
    (op) => {
      const line = serializeForLog(describeAuthStoreFailure(leakyError(), op));

      expect(line).not.toContain(IP);
      expect(line).not.toContain(BETTER_AUTH_KEY);
      expect(line).not.toContain(PATH);
      expect(line).not.toContain('statement was');
    }
  );

  test('only the operation and the error class are reported', () => {
    const d = describeAuthStoreFailure(leakyError(), 'consume');

    expect(d.msg).toBe('auth rate-limit store error');
    expect(d.op).toBe('consume');
    expect(Object.keys(d).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'errorClass',
      'msg',
      'op',
    ]);
  });

  test('the class is the one the real driver reports', () => {
    // Not `'SqliteError'`, which is what a hand-written fixture used to assert
    // against itself. Two real failure shapes, both classified the same way.
    expect(
      describeAuthStoreFailure(realUniqueViolation(), 'consume').errorClass
    ).toBe('SQLiteError');
    expect(
      describeAuthStoreFailure(realMissingTableError(), 'consume').errorClass
    ).toBe('SQLiteError');
  });

  test('a non-Error throwable degrades to a safe class', () => {
    const d = describeAuthStoreFailure(BETTER_AUTH_KEY, 'get');

    expect(d.errorClass).toBe('Unknown');
    expect(serializeForLog(d)).not.toContain(IP);
  });
});

describe('the real storage, through the real wiring', () => {
  const logged: unknown[] = [];
  let spy: ReturnType<typeof spyOn> | null = null;

  beforeEach(() => {
    logged.length = 0;
    resetSqliteStores();
    // `spyOn`, not a `mock.module`: the target is a method on `console`, so there
    // is no shared module to replace and nothing to leak into the next file.
    spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(...args);
    });
  });

  afterEach(() => {
    spy?.mockRestore();
    resetSqliteStores();
  });

  test('a real store failure logs no IP, no key and no path', async () => {
    // The cheapest reliable way to make the real storage fail: drop the table it
    // consumes from, out from under the prepared statement. That produces a
    // genuine `no such table: auth_rate_limit` from `bun:sqlite`, through the
    // production `catch`, rather than a thrown fixture.
    const { getRateLimitStore } = await import('@/lib/rate-limit/store');
    getRateLimitStore().db.exec('DROP TABLE auth_rate_limit');

    // Fail-closed: the storage rethrows after logging, which is the contract.
    await expect(
      authRateLimitStorage.consume(BETTER_AUTH_KEY, {
        window: 60,
        max: 5,
      })
    ).rejects.toThrow();

    expect(logged.length).toBeGreaterThan(0);
    const line = logged.map((entry) => serializeForLog(entry)).join('\n');
    expect(line).not.toContain(IP);
    expect(line).not.toContain(BETTER_AUTH_KEY);
    expect(line).not.toContain(PATH);
    // The class does survive, because that is what an outage needs.
    expect(line).toContain('SQLiteError');
  });
});
