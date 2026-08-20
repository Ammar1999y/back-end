/**
 * Regression test for the rate-limit store-failure log boundary (C-05).
 *
 * ## What changed, and what this test now proves
 *
 * The original demonstrated leak belonged to `@upstash/redis`, which built its
 * message as `` `${body.error}, command was: ${JSON.stringify(req.body)}` `` —
 * the command body being the limiter key, and this app's keys embed the
 * destination. That dependency is gone. The local driver was checked against the
 * same concern and does NOT embed bound parameters in its messages: a UNIQUE
 * violation on a key containing an email address produced only
 * `UNIQUE constraint failed: cache.key`.
 *
 * So this no longer reproduces a live leak. It asserts the PROPERTY instead: the
 * boundary must emit no key content even when handed an error whose message
 * contains the whole key. That is the durable requirement: the driver has already
 * changed once (better-sqlite3 -> `bun:sqlite`, at the Elysia migration) and
 * `sanitizeForLog` keeps free-text messages by policy — so a future driver that
 * does interpolate a parameter must not be able to reach the log through this
 * path.
 *
 * The hostile fixture below is deliberate: a driver that behaves WORSE than
 * either real one, to prove containment rather than luck.
 *
 * Local: no database, no network.
 */
import { serializeForLog } from '@/utils';
import { expect, test } from 'bun:test';
// Imported from the boundary module, not the barrel: a sibling probe
// `mock.module`s `@/lib/rate-limit/index`, which would replace this function.
import { describeStoreFailure } from '@/lib/rate-limit/store-failure';

const EMAIL_SENTINEL = 'victim-sentinel@example.com';
const PHONE_SENTINEL = '966500000001';

/**
 * A driver error that embeds the bound key in its message. Neither better-sqlite3
 * nor bun:sqlite does this today; the point is that the boundary holds if one
 * ever starts.
 */
class LeakyDriverError extends Error {
  override name = 'SqliteError';
}

function leakyError(key: string): Error {
  return new LeakyDriverError(
    `constraint failed, statement was: ${JSON.stringify([
      'INSERT INTO rate_limit VALUES (?)',
      key,
    ])}`
  );
}

test('the raw store message never reaches the log', () => {
  const key = `otp.send.dest.email:${EMAIL_SENTINEL}`;
  const line = serializeForLog(
    describeStoreFailure(leakyError(key), { identifier: key })
  );

  expect(line).not.toContain(EMAIL_SENTINEL);
  expect(line).not.toContain('statement was');
  expect(line).not.toContain('constraint failed');
  expect(line).not.toContain(key);
});

test('a phone destination is not leaked either', () => {
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
  expect(d.errorClass).toBe('SqliteError');
  // No field carries the message or the identifier. `attempt` is gone with the
  // retry loop: a local failure means a broken disk or schema, and SQLITE_BUSY is
  // absorbed by busy_timeout rather than retried in application code.
  expect(Object.keys(d).toSorted((a, b) => a.localeCompare(b))).toEqual([
    'errorClass',
    'msg',
    'scope',
  ]);
});

test('a scope-shaped prefix followed by a value keeps only the prefix', () => {
  const d = describeStoreFailure(leakyError('x'), {
    identifier: `preauth.dash.users:ip:203.0.113.9`,
  });

  expect(d.scope).toBe('preauth.dash.users');
});

test('every real scope survives the prefix split intact', () => {
  // The complete set produced by the app: five from `preAuthScope` over the 14
  // routes that enable `preAuthIpLimit`, plus the OTP scopes, which interpolate
  // only closed unions. None contains a colon, so the prefix IS the scope.
  const REAL_SCOPES = [
    'preauth.auth.forgot-password',
    'preauth.auth.passwordless',
    'preauth.dash.permissions',
    'preauth.dash.roles',
    'preauth.dash.users',
    'otp.send.surface.verify_contact.email',
    'otp.send.surface.recovery.phone',
    'otp.send.dest.recovery.email',
    'otp.send.dest.phone',
    'otp.send.global.email',
    'otp.verify.dest.phone',
    'auth.signin.ip',
    'users.id.sessions.delete',
  ];

  for (const scope of REAL_SCOPES) {
    const d = describeStoreFailure(leakyError('x'), {
      identifier: `${scope}:${EMAIL_SENTINEL}`,
    });
    expect(d.scope).toBe(scope);
    expect(serializeForLog(d)).not.toContain(EMAIL_SENTINEL);
  }
});

test('a non-Error throwable degrades to a safe class', () => {
  const d = describeStoreFailure('boom', {
    identifier: 'otp.send.global:email',
  });

  expect(d.errorClass).toBe('Unknown');
  expect(d.scope).toBe('otp.send.global');
});
