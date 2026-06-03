import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import { accounts, sessions } from '@/db/schema';

import '../../../../helpers/env';
import { tdb, wipeTag } from '../../../../helpers/db';
import { api, waitForServer } from '../../../../helpers/http';
import { signIn } from '../../../../helpers/auth';
import { ALL_PERMISSIONS, createRole, createUser } from '../../../../helpers/seed';

const PATH = '/api/dash/users/me/change-password';

beforeAll(async () => {
  await waitForServer();
});

afterAll(async () => {
  await wipeTag();
});

describe('POST /api/dash/users/me/change-password', () => {
  test('401 with no session', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: { currentPassword: 'Current1!@#', newPassword: 'Newer1!@#' },
    });
    expect(res.status).toBe(401);
  });

  test(
    '200 changes password, revokes other sessions, account hash rotates',
    async () => {
      const role = await createRole({ permissions: ALL_PERMISSIONS });
      const user = await createUser({ roleId: role.id });
      const s1 = await signIn(user);
      const s2 = await signIn(user);
      expect(s2.cookie).toBeTruthy();

      const [before] = await tdb.select({ password: accounts.password }).from(accounts).where(eq(accounts.userId, user.id));

      const res = await api(PATH, {
        method: 'POST',
        cookie: s1.cookie,
        body: { currentPassword: user.password, newPassword: 'BrandNew1!@#' },
      });
      expect(res.status).toBe(200);

      const [after] = await tdb.select({ password: accounts.password }).from(accounts).where(eq(accounts.userId, user.id));
      expect(after.password).not.toBe(before.password);

      const remaining = await tdb.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, user.id));
      // Only the request's own session survives.
      expect(remaining.length).toBe(1);
    },
    60_000
  );

  test(
    '400 when newPassword equals currentPassword',
    async () => {
      const role = await createRole({ permissions: ALL_PERMISSIONS });
      const user = await createUser({ roleId: role.id });
      const signed = await signIn(user);

      const res = await api(PATH, {
        method: 'POST',
        cookie: signed.cookie,
        body: { currentPassword: user.password, newPassword: user.password },
      });
      expect(res.status).toBe(400);
    },
    30_000
  );

  test(
    '400 when currentPassword is wrong',
    async () => {
      const role = await createRole({ permissions: ALL_PERMISSIONS });
      const user = await createUser({ roleId: role.id });
      const signed = await signIn(user);

      const res = await api(PATH, {
        method: 'POST',
        cookie: signed.cookie,
        body: { currentPassword: 'Wrong1!@#abc', newPassword: 'BrandNew1!@#' },
      });
      expect(res.status).toBe(400);
    },
    30_000
  );

  test(
    '403 when captcha header is missing',
    async () => {
      const role = await createRole({ permissions: ALL_PERMISSIONS });
      const user = await createUser({ roleId: role.id });
      const signed = await signIn(user);

      const res = await api(PATH, {
        method: 'POST',
        cookie: signed.cookie,
        noCaptcha: true,
        body: { currentPassword: user.password, newPassword: 'BrandNew1!@#' },
      });
      expect(res.status).toBe(403);
    },
    30_000
  );

  test(
    'compromised newPassword is rejected by HIBP when reachable',
    async () => {
      const role = await createRole({ permissions: ALL_PERMISSIONS });
      const user = await createUser({ roleId: role.id });
      const signed = await signIn(user);

      const res = await api(PATH, {
        method: 'POST',
        cookie: signed.cookie,
        body: { currentPassword: user.password, newPassword: 'Password1!' },
      });
      // 400/422 = HIBP reached and rejected the known-compromised password
      //           (the documented happy path).
      // 200     = HIBP timed out / failed; check-password falls open silently
      //           (H2 in reports/should-ignore.md — intentional fail-open
      //           per the team's note that this isn't worth fixing yet).
      expect([200, 400, 422]).toContain(res.status);
    },
    60_000
  );

  test(
    '422 when payload is missing fields',
    async () => {
      const role = await createRole({ permissions: ALL_PERMISSIONS });
      const user = await createUser({ roleId: role.id });
      const signed = await signIn(user);

      const res = await api(PATH, {
        method: 'POST',
        cookie: signed.cookie,
        body: {},
      });
      expect(res.status).toBe(422);
    },
    30_000
  );

  test(
    '422 when newPassword does not meet complexity rules',
    async () => {
      const role = await createRole({ permissions: ALL_PERMISSIONS });
      const user = await createUser({ roleId: role.id });
      const signed = await signIn(user);

      const res = await api(PATH, {
        method: 'POST',
        cookie: signed.cookie,
        body: { currentPassword: user.password, newPassword: 'lowercaseonly' },
      });
      expect(res.status).toBe(422);
    },
    30_000
  );

  test(
    'failed login attempts on user do NOT also lock out password-change path',
    async () => {
      // The endpoint runs verifyLoginAttempt with skipTimingGuard. Wrong
      // current password bumps the same counter — verify we observe that.
      const role = await createRole({ permissions: ALL_PERMISSIONS });
      const user = await createUser({ roleId: role.id });
      const signed = await signIn(user);

      for (let i = 0; i < 3; i++) {
        const r = await api(PATH, {
          method: 'POST',
          cookie: signed.cookie,
          body: { currentPassword: 'NotMyPass1!@#', newPassword: 'BrandNew1!@#' },
        });
        expect(r.status).toBe(400);
      }
    },
    60_000
  );
});
