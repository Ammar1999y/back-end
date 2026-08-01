import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import { sessions } from '@/db/schema';

import '../../helpers/env';
import { tdb, tagEmail, wipeTag } from '../../helpers/db';
import { api, waitForServer } from '../../helpers/http';
import { signIn } from '../../helpers/auth';
import { createRole, createUser, seedOtp } from '../../helpers/seed';

const SEND = '/api/auth/forgot-password/send';
const RESET = '/api/auth/forgot-password/reset';
const NEW_PASSWORD = 'FreshReset9$xZ';

beforeAll(async () => {
  await waitForServer();
});

afterAll(async () => {
  await wipeTag();
});

describe('POST /api/auth/forgot-password/send', () => {
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
      body: { channel: 'email', email: tagEmail('nobody') },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ nextAllowedIn: 30 });
  });

  test('422 on malformed input', async () => {
    const res = await api(SEND, {
      method: 'POST',
      body: { channel: 'email', email: 'not-an-email' },
    });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/auth/forgot-password/reset', () => {
  test(
    '200 sets the new password (old one stops working) and revokes sessions',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id });
      // Pre-existing session that must be revoked by the reset.
      await signIn(user);

      const { plaintextCode } = await seedOtp({
        userId: user.id,
        channel: 'email',
        purpose: 'forgot_password',
        identifier: user.email,
        code: '424242',
      });

      const res = await api(RESET, {
        method: 'POST',
        body: {
          channel: 'email',
          email: user.email,
          code: plaintextCode,
          newPassword: NEW_PASSWORD,
        },
      });
      expect(res.status).toBe(200);

      // All prior sessions revoked.
      const rows = await tdb
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, user.id));
      expect(rows.length).toBe(0);

      // New password works; old one no longer does.
      const ok = await signIn({ ...user, password: NEW_PASSWORD });
      expect(ok.cookie).toBeTruthy();
      const bad = await api('/api/auth/sign-in/email', {
        method: 'POST',
        ip: '10.222.0.1',
        body: { email: user.email, password: user.password },
      });
      expect(bad.status).toBe(401);
    },
    90_000
  );

  test(
    'wrong code returns 400 and leaves the password unchanged',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id });
      await seedOtp({
        userId: user.id,
        channel: 'email',
        purpose: 'forgot_password',
        identifier: user.email,
        code: '999999',
      });

      const res = await api(RESET, {
        method: 'POST',
        body: {
          channel: 'email',
          email: user.email,
          code: '000000',
          newPassword: NEW_PASSWORD,
        },
      });
      expect(res.status).toBe(400);

      // Original password still valid.
      const ok = await signIn(user);
      expect(ok.cookie).toBeTruthy();
    },
    60_000
  );
});
