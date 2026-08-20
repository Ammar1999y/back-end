/**
 * Regression test for the Better Auth rate-limit storage log boundary.
 *
 * ## Why this no longer drives the real storage
 *
 * The previous version exercised the full production path: it stood up a local
 * server returning Upstash's `401 {"error": ...}` shape and drove the real
 * `authRateLimitStorage` through it, because `@upstash/redis` quoted the command
 * — and therefore the key, `${ip}|${path}` — in its message.
 *
 * That stopped being possible when the store became local. At the time the
 * driver was `better-sqlite3`, which cannot be loaded under Bun at all — it is
 * built against the V8 C++ API that Bun only partially emulates
 * (https://github.com/oven-sh/bun/issues/4290) — so importing
 * `@/lib/rate-limit/auth-storage` here would hard-panic the test runner with
 * `NAPI FATAL ERROR`, and this file had to stay clear of the driver.
 *
 * What that costs, stated plainly: this asserts the boundary FUNCTION, not the
 * `catch -> sanitizeForLog -> console.error` wiring inside `auth-storage.ts`. The
 * wiring is verified by reading it, not by this test.
 *
 * TODO: the blocker is GONE. The Elysia migration swapped the driver to
 * `bun:sqlite`, so importing the real `authRateLimitStorage` here is safe now.
 * Restore this to driving the real storage — make the store fail with an
 * unwritable `SQLITE_DIR`, which is the cheapest way, rather than faking an HTTP
 * endpoint. Left as-is here because it is a test improvement, not part of the
 * framework migration.
 *
 * The property under test is unchanged and is the one that matters: nothing
 * derived from the key may reach the log.
 *
 * Local: no database, no network.
 */
import { serializeForLog } from '@/utils';
import { expect, test } from 'bun:test';
import { describeAuthStoreFailure } from '@/lib/rate-limit/store-failure';

const IP = '203.0.113.42';
const PATH = '/sign-in/email';
/** Exactly what Better Auth passes to `customStorage.get/set/consume`. */
const BETTER_AUTH_KEY = `${IP}|${PATH}`;

/**
 * A driver error that embeds the bound key. Neither real driver does this today;
 * the fixture is hostile on purpose, so the test proves containment rather than
 * inheriting a driver's good manners.
 */
class LeakyDriverError extends Error {
  override name = 'SqliteError';
}

function leakyError(): Error {
  return new LeakyDriverError(
    `constraint failed, statement was: ${JSON.stringify([
      'SELECT * FROM auth_rate_limit WHERE key = ?',
      BETTER_AUTH_KEY,
    ])}`
  );
}

for (const op of ['get', 'set', 'consume'] as const) {
  test(`the requester IP never reaches the log via ${op}`, () => {
    const line = serializeForLog(describeAuthStoreFailure(leakyError(), op));

    expect(line).not.toContain(IP);
    expect(line).not.toContain(BETTER_AUTH_KEY);
    expect(line).not.toContain(PATH);
    expect(line).not.toContain('statement was');
  });
}

test('only the operation and the error class are reported', () => {
  const d = describeAuthStoreFailure(leakyError(), 'consume');

  expect(d.msg).toBe('auth rate-limit store error');
  expect(d.op).toBe('consume');
  expect(d.errorClass).toBe('SqliteError');
  expect(Object.keys(d).toSorted((a, b) => a.localeCompare(b))).toEqual([
    'errorClass',
    'msg',
    'op',
  ]);
});

test('a non-Error throwable degrades to a safe class', () => {
  const d = describeAuthStoreFailure(BETTER_AUTH_KEY, 'get');

  expect(d.errorClass).toBe('Unknown');
  expect(serializeForLog(d)).not.toContain(IP);
});
