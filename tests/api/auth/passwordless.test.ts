import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { and, eq } from 'drizzle-orm';

import { sessions, users } from '@/db/schema';

import '../../helpers/env';
import { tdb, tagEmail, wipeTag } from '../../helpers/db';
import { api, extractSessionCookie, waitForServer } from '../../helpers/http';
import { createRole, createUser, seedOtp } from '../../helpers/seed';

const SEND = '/api/auth/passwordless/send';
const VERIFY = '/api/auth/passwordless/verify';

beforeAll(async () => {
  await waitForServer();
});

afterAll(async () => {
  await wipeTag();
});

describe('POST /api/auth/passwordless/send', () => {
  test('200 generic for a known user', async () => {
    const role = await createRole();
    const user = await createUser({ roleId: role.id });
    const res = await api(SEND, {
      method: 'POST',
      body: { channel: 'email', email: user.email },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ nextAllowedIn: 30 });
  });

  test('200 generic for an unknown email (no enumeration)', async () => {
    const res = await api(SEND, {
      method: 'POST',
      body: { channel: 'email', email: tagEmail('ghost') },
    });
    expect(res.status).toBe(200);
  });

  test('422 on malformed input', async () => {
    const res = await api(SEND, {
      method: 'POST',
      body: { channel: 'email', email: 'nope' },
    });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/auth/passwordless/verify', () => {
  test(
    'valid code issues a session (cookie + DB row) and marks email verified',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id, emailVerified: false });

      const { plaintextCode } = await seedOtp({
        userId: user.id,
        channel: 'email',
        purpose: 'passwordless_login',
        identifier: user.email,
        code: '424242',
      });

      const res = await api(VERIFY, {
        method: 'POST',
        body: { channel: 'email', email: user.email, code: plaintextCode },
      });

      expect(res.status).toBe(200);
      expect(extractSessionCookie(res.cookies)).toBeTruthy();

      const rows = await tdb
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, user.id));
      expect(rows.length).toBeGreaterThanOrEqual(1);

      // OTP to email proved control → emailVerified flipped true.
      const [u] = await tdb
        .select({ emailVerified: users.emailVerified })
        .from(users)
        .where(eq(users.id, user.id));
      expect(u.emailVerified).toBe(true);
    },
    60_000
  );

  test(
    'wrong code returns 400 and creates no session',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id });
      await seedOtp({
        userId: user.id,
        channel: 'email',
        purpose: 'passwordless_login',
        identifier: user.email,
        code: '999999',
      });

      const res = await api(VERIFY, {
        method: 'POST',
        body: { channel: 'email', email: user.email, code: '000000' },
      });
      expect(res.status).toBe(400);

      const rows = await tdb
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.userId, user.id)));
      expect(rows.length).toBe(0);
    },
    60_000
  );
});
