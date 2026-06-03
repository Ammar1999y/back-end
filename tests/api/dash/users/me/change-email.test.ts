import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import { auditLogs, sessions, users } from '@/db/schema';

import '../../../../helpers/env';
import { tdb, tagEmail, wipeTag } from '../../../../helpers/db';
import { api, waitForServer } from '../../../../helpers/http';
import { signIn } from '../../../../helpers/auth';
import { ALL_PERMISSIONS, createRole, createUser } from '../../../../helpers/seed';

const PATH = '/api/dash/users/me/change-email';

beforeAll(async () => {
  await waitForServer();
});

afterAll(async () => {
  await wipeTag();
});

describe('POST /api/dash/users/me/change-email', () => {
  test('401 with no session', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: { currentPassword: 'X', newEmail: tagEmail('a') },
    });
    expect(res.status).toBe(401);
  });

  test(
    '200 changes email, revokes other sessions, writes audit',
    async () => {
      const role = await createRole({ permissions: ALL_PERMISSIONS });
      const user = await createUser({ roleId: role.id });
      // 2 sessions: only one survives.
      const s1 = await signIn(user);
      const s2 = await signIn(user);
      expect(s2.cookie).toBeTruthy();

      const newEmail = tagEmail('changed');
      const res = await api(PATH, {
        method: 'POST',
        cookie: s1.cookie,
        body: { currentPassword: user.password, newEmail },
      });

      expect(res.status).toBe(200);
      const [u] = await tdb.select().from(users).where(eq(users.id, user.id));
      expect(u.email).toBe(newEmail);

      // Only the request's own session is kept.
      const sessRows = await tdb.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, user.id));
      expect(sessRows.length).toBe(1);

      const audits = await tdb.select().from(auditLogs).where(eq(auditLogs.recordId, user.id));
      expect(audits.some((a) => a.action === 'UPDATE')).toBe(true);
    },
    60_000
  );

  test(
    '400 when newEmail equals current email',
    async () => {
      const role = await createRole({ permissions: ALL_PERMISSIONS });
      const user = await createUser({ roleId: role.id });
      const signed = await signIn(user);

      const res = await api(PATH, {
        method: 'POST',
        cookie: signed.cookie,
        body: { currentPassword: user.password, newEmail: user.email },
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
        body: { currentPassword: 'TotallyWrong1!@#', newEmail: tagEmail('new') },
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
        body: { currentPassword: user.password, newEmail: tagEmail('cap') },
      });
      expect(res.status).toBe(403);
    },
    30_000
  );

  test(
    '409 when newEmail collides with an existing user',
    async () => {
      const role = await createRole({ permissions: ALL_PERMISSIONS });
      const user = await createUser({ roleId: role.id });
      const other = await createUser({ roleId: role.id, email: tagEmail('owner') });
      const signed = await signIn(user);

      const res = await api(PATH, {
        method: 'POST',
        cookie: signed.cookie,
        body: { currentPassword: user.password, newEmail: other.email },
      });
      expect(res.status).toBe(409);
    },
    30_000
  );

  test(
    '422 when newEmail is malformed',
    async () => {
      const role = await createRole({ permissions: ALL_PERMISSIONS });
      const user = await createUser({ roleId: role.id });
      const signed = await signIn(user);

      const res = await api(PATH, {
        method: 'POST',
        cookie: signed.cookie,
        body: { currentPassword: user.password, newEmail: 'not-an-email' },
      });
      expect(res.status).toBe(422);
    },
    30_000
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
});
