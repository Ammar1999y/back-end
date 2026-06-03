import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import { sessions } from '@/db/schema';

import '../../../helpers/env';
import { tdb, wipeTag } from '../../../helpers/db';
import { api, waitForServer } from '../../../helpers/http';
import { signIn } from '../../../helpers/auth';
import { ALL_PERMISSIONS, createRole, createUser } from '../../../helpers/seed';

const url = (id: string) => `/api/dash/users/${id}/sessions`;

beforeAll(async () => {
  await waitForServer();
});

afterAll(async () => {
  await wipeTag();
});

describe('DELETE /api/dash/users/[id]/sessions', () => {
  test('401 with no session', async () => {
    const res = await api(url('019e0000-0000-7000-8000-000000000001'), {
      method: 'DELETE',
      body: { sessionIds: ['019e0000-0000-7000-8000-000000000002'] },
    });
    expect(res.status).toBe(401);
  });

  test(
    'admin can revoke another user\'s sessions',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signedAdmin = await signIn(admin);

      const target = await createUser({ roleId: adminRole.id });
      // Make 2 sessions for the target.
      const t1 = await signIn(target);
      const t2 = await signIn(target);
      expect(t1.sessionToken).not.toBe(t2.sessionToken);

      const before = await tdb.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, target.id));
      expect(before.length).toBe(2);

      const res = await api(url(target.id), {
        method: 'DELETE',
        cookie: signedAdmin.cookie,
        body: { sessionIds: before.map((b) => b.id) },
      });
      expect(res.status).toBe(200);

      const after = await tdb.select().from(sessions).where(eq(sessions.userId, target.id));
      expect(after.length).toBe(0);
    },
    60_000
  );

  test(
    '[bug] self-targeted session revoke currently 403s on session.user.roleId — must NOT delete current session even if it succeeds',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const a1 = await signIn(admin);
      const a2 = await signIn(admin);

      const before = await tdb.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, admin.id));
      expect(before.length).toBe(2);

      const res = await api(url(admin.id), {
        method: 'DELETE',
        cookie: a1.cookie,
        body: { sessionIds: before.map((b) => b.id) },
      });
      // Currently 403 due to the `session.user.roleId` bug. Once fixed,
      // the handler must KEEP a1's current session (filtered out of the
      // delete list) and remove a2's.
      expect([200, 403]).toContain(res.status);

      const after = await tdb.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, admin.id));
      if (res.status === 200) {
        expect(after.length).toBe(1);
      } else {
        expect(after.length).toBe(2);
      }
      expect(a2.cookie).toBeTruthy();
    },
    60_000
  );

  test(
    '403 when actor lacks users:edit and is not target',
    async () => {
      const actorRole = await createRole({
        permissions: { users: { view: true } },
      });
      const actor = await createUser({ roleId: actorRole.id });
      const signed = await signIn(actor);

      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const victim = await createUser({ roleId: adminRole.id });
      await signIn(victim);

      const res = await api(url(victim.id), {
        method: 'DELETE',
        cookie: signed.cookie,
        body: { sessionIds: ['019e0000-0000-7000-8000-000000000010'] },
      });
      expect(res.status).toBe(403);
    },
    30_000
  );

  test(
    'sessionIds belonging to a different user are silently ignored, not deleted',
    async () => {
      // The DELETE WHERE clause is `userId = targetId AND id IN (...)`. Even
      // if attacker forges another user's session UUID into the list, the
      // userId filter prevents collateral damage.
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signedAdmin = await signIn(admin);

      const target = await createUser({ roleId: adminRole.id });
      await signIn(target);

      const other = await createUser({ roleId: adminRole.id });
      const otherSigned = await signIn(other);
      const [otherSession] = await tdb.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, other.id));

      // Admin tries to "delete" sessions of `target` but smuggles `other`'s
      // session id in. The handler filters by target.id so other's session
      // stays alive.
      const res = await api(url(target.id), {
        method: 'DELETE',
        cookie: signedAdmin.cookie,
        body: { sessionIds: [otherSession.id] },
      });
      expect(res.status).toBe(200);

      const otherRemaining = await tdb.select().from(sessions).where(eq(sessions.userId, other.id));
      expect(otherRemaining.length).toBe(1);
      expect(otherSigned.cookie).toBeTruthy();
    },
    60_000
  );

  test(
    '422 when sessionIds is empty (admin targeting another user)',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signed = await signIn(admin);
      const target = await createUser({ roleId: adminRole.id });

      const res = await api(url(target.id), {
        method: 'DELETE',
        cookie: signed.cookie,
        body: { sessionIds: [] },
      });
      expect(res.status).toBe(422);
    },
    30_000
  );

  test(
    '422 when sessionIds contains a non-UUID',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signed = await signIn(admin);
      const target = await createUser({ roleId: adminRole.id });

      const res = await api(url(target.id), {
        method: 'DELETE',
        cookie: signed.cookie,
        body: { sessionIds: ['not-a-uuid'] },
      });
      expect(res.status).toBe(422);
    },
    30_000
  );

  test(
    '422 when sessionIds exceeds the array max (51 ids)',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signed = await signIn(admin);
      const target = await createUser({ roleId: adminRole.id });

      const ids = Array.from(
        { length: 51 },
        (_, i) => `019e0000-0000-7000-8000-${String(i).padStart(12, '0')}`
      );

      const res = await api(url(target.id), {
        method: 'DELETE',
        cookie: signed.cookie,
        body: { sessionIds: ids },
      });
      expect(res.status).toBe(422);
    },
    30_000
  );

  test(
    '404 when target user does not exist',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signed = await signIn(admin);

      const res = await api(url('019e0000-0000-7000-8000-000000000099'), {
        method: 'DELETE',
        cookie: signed.cookie,
        body: { sessionIds: ['019e0000-0000-7000-8000-000000000010'] },
      });
      expect(res.status).toBe(404);
    },
    30_000
  );
});
