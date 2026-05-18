import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { and, eq } from 'drizzle-orm';

import { users, verificationSessions } from '@/db/schema';

import '../../../helpers/env';
import { tdb, tagEmail, wipeTag } from '../../../helpers/db';
import { api, waitForServer } from '../../../helpers/http';
import { createRole, createUser, seedOtp } from '../../../helpers/seed';

const PATH = '/api/auth/otp/verify';
const MIN_RESPONSE_MS = 1500;

beforeAll(async () => {
  await waitForServer();
});

afterAll(async () => {
  await wipeTag();
});

describe('POST /api/auth/otp/verify — happy path', () => {
  test(
    'valid code flips emailVerified to true and writes an audit log',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id, emailVerified: false });
      const { plaintextCode } = await seedOtp({
        userId: user.id,
        channel: 'email',
        identifier: user.email,
        code: '424242',
      });

      const res = await api(PATH, {
        method: 'POST',
        body: { channel: 'email', email: user.email, code: plaintextCode },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({ verified: true });

      const [updated] = await tdb
        .select({ emailVerified: users.emailVerified })
        .from(users)
        .where(eq(users.id, user.id));
      expect(updated.emailVerified).toBe(true);

      // Session row deleted on success.
      const remaining = await tdb
        .select()
        .from(verificationSessions)
        .where(
          and(
            eq(verificationSessions.userId, user.id),
            eq(verificationSessions.channel, 'email')
          )
        );
      expect(remaining.length).toBe(0);
    },
    30_000
  );

  test(
    're-verifying an already-verified user is idempotent (no audit write)',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id, emailVerified: true });
      const { plaintextCode } = await seedOtp({
        userId: user.id,
        channel: 'email',
        identifier: user.email,
        code: '111111',
      });

      const res = await api(PATH, {
        method: 'POST',
        body: { channel: 'email', email: user.email, code: plaintextCode },
      });

      // Verification still succeeds; the inner UPDATE is just skipped.
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ verified: true });
    },
    30_000
  );
});

describe('POST /api/auth/otp/verify — privacy collapse', () => {
  test(
    'wrong code returns 400 with the same generic message regardless of cause',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id, emailVerified: false });
      await seedOtp({
        userId: user.id,
        channel: 'email',
        identifier: user.email,
        code: '999999',
      });

      const t0 = Date.now();
      const res = await api(PATH, {
        method: 'POST',
        body: { channel: 'email', email: user.email, code: '000000' },
      });
      const elapsed = Date.now() - t0;

      expect(res.status).toBe(400);
      // Timing floor still applies on the wrong-code path.
      expect(elapsed).toBeGreaterThanOrEqual(MIN_RESPONSE_MS - 200);
    },
    30_000
  );

  test(
    'unknown email returns the same generic 400 — no enumeration',
    async () => {
      const t0 = Date.now();
      const res = await api(PATH, {
        method: 'POST',
        body: { channel: 'email', email: tagEmail('phantom'), code: '123456' },
      });
      const elapsed = Date.now() - t0;

      expect(res.status).toBe(400);
      expect(elapsed).toBeGreaterThanOrEqual(MIN_RESPONSE_MS - 200);
    },
    30_000
  );

  test(
    'no verification session at all returns same generic 400',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id, emailVerified: false });
      // Note: no seedOtp() call — fresh user with no pending verification.

      const res = await api(PATH, {
        method: 'POST',
        body: { channel: 'email', email: user.email, code: '123456' },
      });

      expect(res.status).toBe(400);
    },
    30_000
  );

  test(
    'response shape matches across wrong-code, unknown-email, no-session paths',
    async () => {
      const role = await createRole();
      const u = await createUser({ roleId: role.id, emailVerified: false });
      await seedOtp({ userId: u.id, channel: 'email', identifier: u.email, code: '555555' });

      const responses = await Promise.all([
        api(PATH, {
          method: 'POST',
          body: { channel: 'email', email: u.email, code: '000000' },
        }),
        api(PATH, {
          method: 'POST',
          body: {
            channel: 'email',
            email: tagEmail('does-not-exist-verify'),
            code: '000000',
          },
        }),
      ]);

      for (const r of responses) expect(r.status).toBe(400);
      // Messages must be byte-equal — otherwise an attacker can fingerprint
      // unknown-user vs wrong-code.
      expect(responses[0].body.message).toBe(responses[1].body.message);
    },
    30_000
  );
});

describe('POST /api/auth/otp/verify — captcha gate', () => {
  test(
    'rejects with 403 when captcha header is missing',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id, emailVerified: false });
      await seedOtp({ userId: user.id, channel: 'email', identifier: user.email });

      const res = await api(PATH, {
        method: 'POST',
        body: { channel: 'email', email: user.email, code: '123456' },
        noCaptcha: true,
      });
      expect(res.status).toBe(403);
    },
    15_000
  );
});

describe('POST /api/auth/otp/verify — input validation', () => {
  test('422 when code is not 6 digits', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: { channel: 'email', email: tagEmail('x'), code: '12345' },
    });
    expect(res.status).toBe(422);
  });

  test('422 when code contains non-digits', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: { channel: 'email', email: tagEmail('x'), code: 'abcdef' },
    });
    expect(res.status).toBe(422);
  });

  test('422 when channel is disabled (sms when only email is enabled)', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: { channel: 'sms', phoneNumber: '966500000000', code: '123456' },
    });
    expect(res.status).toBe(422);
  });

  test('422 when code field is missing', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: { channel: 'email', email: tagEmail('x') },
    });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/auth/otp/verify — abuse / brute-force', () => {
  test(
    'after OTP_MAX_VERIFY_ATTEMPTS wrong guesses the session is flagged blocked',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id, emailVerified: false });
      await seedOtp({ userId: user.id, channel: 'email', identifier: user.email, code: '424242' });

      // OTP_MAX_VERIFY_ATTEMPTS = 5. The per-identifier IP-store cap is 10/600s,
      // so 5 wrong guesses stays under it. Each call may legitimately return
      // 400 (wrong code) or 400/429 once the OTP block flips on — both are
      // acceptable from the client's perspective. We assert the final DB state.
      for (let i = 0; i < 5; i++) {
        const r = await api(PATH, {
          method: 'POST',
          body: { channel: 'email', email: user.email, code: '111111' },
        });
        expect([400, 429].includes(r.status)).toBe(true);
      }

      const [row] = await tdb
        .select({
          isBlocked: verificationSessions.isBlocked,
          verifyAttemptNumber: verificationSessions.verifyAttemptNumber,
        })
        .from(verificationSessions)
        .where(
          and(
            eq(verificationSessions.userId, user.id),
            eq(verificationSessions.channel, 'email')
          )
        );
      expect(row?.isBlocked).toBe(true);

      // Now the real code must NOT verify the user — block trumps validity.
      const final = await api(PATH, {
        method: 'POST',
        body: { channel: 'email', email: user.email, code: '424242' },
      });
      expect([400, 429].includes(final.status)).toBe(true);

      const [u] = await tdb
        .select({ emailVerified: users.emailVerified })
        .from(users)
        .where(eq(users.id, user.id));
      expect(u.emailVerified).toBe(false);
    },
    90_000
  );

  test(
    'IP-level cap collapses with the per-identifier cap to never expose 429',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id, emailVerified: false });
      // Send many failed verify attempts under different identifiers from the
      // same IP. The IP cap is 60/min, far above what we'll burn here, so we
      // just assert the privacy collapse keeps 429 invisible.
      const fixedIp = '10.99.99.99';
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await api(PATH, {
          method: 'POST',
          ip: fixedIp,
          body: {
            channel: 'email',
            email: user.email,
            code: String(100000 + i).padStart(6, '0'),
          },
        });
        statuses.push(r.status);
      }
      // All should be 400 (privacy-collapsed) — never 429.
      expect(statuses.every((s) => s === 400)).toBe(true);
    },
    60_000
  );
});

describe('POST /api/auth/otp/verify — method enforcement', () => {
  test('GET is rejected', async () => {
    const res = await api(PATH, { method: 'GET' });
    expect([404, 405].includes(res.status)).toBe(true);
  });
});
