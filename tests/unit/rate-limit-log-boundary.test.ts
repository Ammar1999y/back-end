/**
 * The rate-limit store-failure log boundary.
 *
 * ## What this proves, and what changed
 *
 * The original demonstrated leak belonged to `@upstash/redis`, which built its
 * message as `` `${body.error}, command was: ${JSON.stringify(req.body)}` `` —
 * the command body being the limiter key, and this app's keys end in the
 * destination. That dependency is gone, and `bun:sqlite` does NOT embed bound
 * parameters in its messages (asserted below against a real violation).
 *
 * So this asserts the PROPERTY rather than reproducing a live leak: the boundary
 * must emit no key content even when handed an error whose message contains the
 * whole key. That is the durable requirement — the driver has already changed
 * once, and `sanitizeForLog` keeps free-text messages by policy.
 *
 * ## Two test defects this file used to carry
 *
 * - **The manufactured error class.** It declared
 *   `class LeakyDriverError extends Error { override name = 'SqliteError' }` and
 *   then asserted `errorClass === 'SqliteError'`, which passed because the
 *   fixture set that exact string and would have passed for any invented
 *   spelling. The real driver says `SQLiteError`. Both halves are covered now: a
 *   hostile fixture for containment, and a REAL driver error for the class.
 * - **A hand-copied production list.** `REAL_SCOPES` listed five of the six
 *   scopes the route table produces, under a comment claiming 14 routes where
 *   there are 22 — it was missing `preauth.upload.image`, added when the upload
 *   route gained `preAuth: 'ip-limit'`. The set is now derived from `ROUTES`
 *   through the production `preAuthScope`, and the OTP scopes are read out of the
 *   real limiter table after the real quota functions have charged it.
 */
import { beforeAll, describe, expect, test } from 'bun:test';

import { ROUTES } from '@/routes';
import { serializeForLog } from '@/utils';
import { preAuthScope } from '@/lib/http/pre-auth';
import { getRateLimitStore } from '@/lib/rate-limit/store';
import { describeStoreFailure } from '@/lib/rate-limit/store-failure';

import {
  REAL_SQLITE_ERROR_NAME,
  realUniqueViolation,
} from '../helpers/real-sqlite-error';
import { resetSqliteStores } from '../helpers/sqlite';

const EMAIL_SENTINEL = 'victim-sentinel@example.com';
const PHONE_SENTINEL = '966500000001';

/**
 * A driver that behaves WORSE than either real one: it embeds the bound key in
 * its message. Deliberately hostile, so the assertions prove containment rather
 * than inherit the real driver's good manners.
 *
 * `name` is taken from a real error rather than written out, so this fixture
 * cannot be the thing that decides what `errorClass` reports.
 */
function leakyError(key: string): Error {
  const error = new Error(
    `constraint failed, statement was: ${JSON.stringify([
      'INSERT INTO rate_limit VALUES (?)',
      key,
    ])}`
  );
  // eslint-disable-next-line unicorn/no-error-property-assignment -- deliberate shape fidelity: the real bun:sqlite error IS a plain Error with `.name` reassigned (`constructor.name === 'Error'`), so a subclass would be a LESS accurate fixture than this
  error.name = REAL_SQLITE_ERROR_NAME;
  return error;
}

/**
 * Every scope the application can produce, derived rather than listed.
 *
 * Pre-auth scopes come from walking the route table through the production
 * function. OTP scopes come from charging the real limiter and reading the keys
 * back — the store is the only place that sees the final `${scope}:${identifier}`
 * string, so it is the only honest source for it.
 */
const realKeys: string[] = [];

beforeAll(async () => {
  resetSqliteStores();
  const api = await import('@/lib/rate-limit/api');

  for (const surface of [
    'verify_contact',
    'recovery',
    'passwordless',
    'contact_change',
  ] as const)
    for (const channel of ['email', 'sms', 'whatsapp'] as const)
      await api.enforceOtpSendQuota({
        channel,
        destination: channel === 'email' ? EMAIL_SENTINEL : PHONE_SENTINEL,
        surface,
      });

  for (const channel of ['email', 'sms', 'whatsapp'] as const) {
    await api.enforceOtpGlobalSendBudget({ channel });
    await api.enforceOtpVerifyQuota({
      channel,
      identifier: channel === 'email' ? EMAIL_SENTINEL : PHONE_SENTINEL,
    });
  }

  realKeys.push(
    ...getRateLimitStore()
      .db.prepare('SELECT key FROM rate_limit ORDER BY key')
      .all<{ key: string }>()
      .map((row) => row.key)
  );
});

describe('the raw store message never reaches the log', () => {
  test('an email destination is withheld', () => {
    const key = `otp.send.dest.email:${EMAIL_SENTINEL}`;
    const line = serializeForLog(
      describeStoreFailure(leakyError(key), { identifier: key })
    );

    expect(line).not.toContain(EMAIL_SENTINEL);
    expect(line).not.toContain('statement was');
    expect(line).not.toContain('constraint failed');
    expect(line).not.toContain(key);
  });

  test('a phone destination is withheld', () => {
    const key = `otp.send.dest.phone:${PHONE_SENTINEL}`;
    const line = serializeForLog(
      describeStoreFailure(leakyError(key), { identifier: key })
    );

    expect(line).not.toContain(PHONE_SENTINEL);
    expect(line).not.toContain('statement was');
  });

  test('the fields an outage actually needs survive', () => {
    const key = `otp.send.dest.email:${EMAIL_SENTINEL}`;
    const d = describeStoreFailure(leakyError(key), { identifier: key });

    expect(d.msg).toBe('rate-limit store error');
    expect(d.scope).toBe('otp.send.dest.email');
    // No field carries the message or the identifier. `attempt` is gone with the
    // retry loop: a local failure means a broken disk or schema, and SQLITE_BUSY
    // is absorbed by `busy_timeout` rather than retried in application code.
    expect(Object.keys(d).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'errorClass',
      'msg',
      'scope',
    ]);
  });
});

describe('the error class comes from the real driver', () => {
  test('a genuine UNIQUE violation is classified, and its key is not echoed', () => {
    const key = `otp.send.dest.email:${EMAIL_SENTINEL}`;
    const real = realUniqueViolation(key);

    // The assertion the manufactured fixture could not make: the string is read
    // off an error `bun:sqlite` threw, so a driver rename fails here.
    expect(real.name).toBe('SQLiteError');
    expect(describeStoreFailure(real, { identifier: key }).errorClass).toBe(
      'SQLiteError'
    );

    // And the other half, worth pinning because it is the reason the boundary is
    // a precaution rather than a fix: this driver does not put the bound
    // parameter in its message.
    expect(real.message).not.toContain(EMAIL_SENTINEL);
    expect(
      serializeForLog(describeStoreFailure(real, { identifier: key }))
    ).not.toContain(EMAIL_SENTINEL);
  });

  test('a non-Error throwable degrades to a safe class', () => {
    const d = describeStoreFailure('boom', {
      identifier: 'otp.send.global:email',
    });

    expect(d.errorClass).toBe('Unknown');
    expect(d.scope).toBe('otp.send.global');
  });
});

describe('every scope the application can produce', () => {
  test('the pre-auth set is exactly what the route table yields', () => {
    const derived = [
      ...new Set(
        ROUTES.filter((route) => route.preAuth === 'ip-limit').map((route) =>
          preAuthScope(route.path)
        )
      ),
    ].toSorted((a, b) => a.localeCompare(b));

    // Not a hardcoded list of six strings: the assertion is that the mapping
    // COLLAPSES many routes onto few scopes and that no dynamic segment survives.
    expect(derived.length).toBeLessThan(
      ROUTES.filter((route) => route.preAuth === 'ip-limit').length
    );
    for (const scope of derived) {
      expect(scope.startsWith('preauth.')).toBe(true);
      expect(scope).not.toContain(':');
      expect(scope).not.toContain(':id');
    }
  });

  test('the OTP keys the real limiter recorded exist and are shaped as expected', () => {
    // Guards against a `beforeAll` that silently charged nothing, which would
    // make the containment assertion below vacuous.
    expect(realKeys.length).toBeGreaterThan(10);
    for (const key of realKeys) expect(key).toContain(':');
  });

  test('no real key can leak its identifier through the boundary', () => {
    // The whole class in one walk: for every key the application actually wrote,
    // the log line carries no part of the identifier half.
    for (const key of realKeys) {
      const line = serializeForLog(
        describeStoreFailure(leakyError(key), { identifier: key })
      );
      expect(line).not.toContain(EMAIL_SENTINEL);
      expect(line).not.toContain(PHONE_SENTINEL);
      expect(line).not.toContain(key);
    }
  });

  test('a scope-shaped prefix followed by a colon-bearing value keeps only the prefix', () => {
    const d = describeStoreFailure(leakyError('x'), {
      identifier: `preauth.dash.users:ip:203.0.113.9`,
    });

    expect(d.scope).toBe('preauth.dash.users');
  });
});
