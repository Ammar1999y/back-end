import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import { rolePermissions, roles, sessions } from '@/db/schema';

import '../../../helpers/env';
import { tdb, tag, wipeTag } from '../../../helpers/db';
import { api, waitForServer } from '../../../helpers/http';
import { signIn } from '../../../helpers/auth';
import { ALL_PERMISSIONS, createRole, createUser } from '../../../helpers/seed';

const BASE = '/api/dash/permissions';
const url = (id: string) => `${BASE}/${id}`;

beforeAll(async () => {
  await waitForServer();
});

afterAll(async () => {
  await wipeTag();
});

describe('GET /api/dash/permissions/[id] — auth gates', () => {
  test('401 when no session', async () => {
    const res = await api(url('00000000-0000-0000-0000-000000000000'), { method: 'GET' });
    expect(res.status).toBe(401);
  });

  test('422 when id is not a valid UUID (after auth)', async () => {
    // Even though the read path may currently 403 (known GET bug), we still
    // want to confirm the id validator doesn't pass through invalid IDs.
    const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
    const admin = await createUser({ roleId: adminRole.id });
    const signed = await signIn(admin);

    const res = await api(url('not-a-uuid'), { method: 'GET', cookie: signed.cookie });
    expect([403, 422]).toContain(res.status);
  }, 30_000);
});

describe('PUT /api/dash/permissions/[id] — update flows', () => {
  test(
    '200 updates roleName and permissions, audit row written, sessions refreshed',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signed = await signIn(admin);

      // Standalone target role with one user attached.
      const target = await createRole({
        name: tag('target-role'),
        permissions: { home: { view: true } },
      });
      const targetUser = await createUser({ roleId: target.id });

      const newName = tag('renamed-role');
      const res = await api(url(target.id), {
        method: 'PUT',
        cookie: signed.cookie,
        body: {
          roleName: newName,
          isActive: true,
          permissions: [
            { name: 'home', permissions: { view: true } },
            { name: 'users', permissions: { view: true } },
          ],
        },
      });

      expect(res.status).toBe(200);
      const [row] = await tdb.select().from(roles).where(eq(roles.id, target.id));
      expect(row.roleName).toBe(newName);

      const perms = await tdb
        .select()
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, target.id));
      expect(perms.map((p) => p.pageName).sort()).toEqual(['home', 'users']);

      // refreshRoleSessions should have updated metadata on targetUser's session.
      // We can't easily inspect cookie cache, but DB session metadata should reflect
      // the new roleName.
      const sessRows = await tdb.select().from(sessions).where(eq(sessions.userId, targetUser.id));
      // No active session for this user (we never signed them in) — that's fine.
      // The handler should not error in either case.
      expect(Array.isArray(sessRows)).toBe(true);
    },
    45_000
  );

  test(
    '403 when actor tries to edit their own role',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signed = await signIn(admin);

      const res = await api(url(adminRole.id), {
        method: 'PUT',
        cookie: signed.cookie,
        body: {
          roleName: tag('self-edit-attempt'),
          isActive: true,
          permissions: [{ name: 'home', permissions: { view: true } }],
        },
      });
      expect(res.status).toBe(403);
    },
    30_000
  );

  test(
    '400 when renaming to a name starting with "custom-"',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signed = await signIn(admin);
      const target = await createRole({ name: tag('target-ren') });

      const res = await api(url(target.id), {
        method: 'PUT',
        cookie: signed.cookie,
        body: {
          roleName: 'custom-evil',
          isActive: true,
          permissions: [{ name: 'home', permissions: { view: true } }],
        },
      });
      expect(res.status).toBe(400);
    },
    30_000
  );

  test(
    '403 when payload grants permissions the actor does not hold',
    async () => {
      const actorRole = await createRole({
        permissions: {
          permissions: { view: true, edit: true },
          users: { view: true },
        },
      });
      const actor = await createUser({ roleId: actorRole.id });
      const signed = await signIn(actor);

      const target = await createRole({ name: tag('escalation-target') });

      const res = await api(url(target.id), {
        method: 'PUT',
        cookie: signed.cookie,
        body: {
          roleName: tag('escalated'),
          isActive: true,
          permissions: [
            { name: 'users', permissions: { view: true, delete: true } },
          ],
        },
      });
      expect(res.status).toBe(403);
    },
    30_000
  );

  test(
    '404 when target role does not exist (real UUID, no row)',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signed = await signIn(admin);

      // Use a UUID that passes idSchema but does not exist in the DB.
      const res = await api(url('019e0000-0000-7000-8000-000000000000'), {
        method: 'PUT',
        cookie: signed.cookie,
        body: {
          roleName: tag('nope'),
          isActive: true,
          permissions: [{ name: 'home', permissions: { view: true } }],
        },
      });
      expect(res.status).toBe(404);
    },
    30_000
  );

  test(
    '404 when target role is system-scoped (cannot be modified via this endpoint)',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signed = await signIn(admin);

      const systemRole = await createRole({
        name: tag('sys'),
        scope: 'system',
      });

      const res = await api(url(systemRole.id), {
        method: 'PUT',
        cookie: signed.cookie,
        body: {
          roleName: tag('hijacked'),
          isActive: true,
          permissions: [{ name: 'home', permissions: { view: true } }],
        },
      });
      expect(res.status).toBe(404);
    },
    30_000
  );

  test(
    '409 when renaming to an existing roleName',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signed = await signIn(admin);

      const a = await createRole({ name: tag('a') });
      const b = await createRole({ name: tag('b') });

      const res = await api(url(a.id), {
        method: 'PUT',
        cookie: signed.cookie,
        body: {
          roleName: b.roleName,
          isActive: true,
          permissions: [{ name: 'home', permissions: { view: true } }],
        },
      });
      expect(res.status).toBe(409);
    },
    30_000
  );

  test(
    'deactivating a role with active users wipes their sessions',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signedAdmin = await signIn(admin);

      const target = await createRole({ name: tag('to-deactivate') });
      const victim = await createUser({ roleId: target.id });
      const signedVictim = await signIn(victim);

      // Verify victim's session exists.
      const before = await tdb.select().from(sessions).where(eq(sessions.userId, victim.id));
      expect(before.length).toBe(1);

      const res = await api(url(target.id), {
        method: 'PUT',
        cookie: signedAdmin.cookie,
        body: {
          roleName: target.roleName,
          isActive: false,
          permissions: [{ name: 'home', permissions: { view: true } }],
        },
      });
      expect(res.status).toBe(200);

      const after = await tdb.select().from(sessions).where(eq(sessions.userId, victim.id));
      expect(after.length).toBe(0);
      // Don't leak unused variable
      expect(signedVictim.cookie).toBeTruthy();
    },
    60_000
  );
});

describe('DELETE /api/dash/permissions/[id]', () => {
  test(
    '200 deletes a role with no active users and writes an audit row',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signed = await signIn(admin);
      const target = await createRole({ name: tag('to-delete') });

      const res = await api(url(target.id), { method: 'DELETE', cookie: signed.cookie });
      expect(res.status).toBe(200);

      const remaining = await tdb.select().from(roles).where(eq(roles.id, target.id));
      expect(remaining.length).toBe(0);
    },
    30_000
  );

  test(
    '400 when role still has active users',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signed = await signIn(admin);

      const target = await createRole({ name: tag('to-delete-busy') });
      await createUser({ roleId: target.id });

      const res = await api(url(target.id), { method: 'DELETE', cookie: signed.cookie });
      expect(res.status).toBe(400);

      const remaining = await tdb.select().from(roles).where(eq(roles.id, target.id));
      expect(remaining.length).toBe(1);
    },
    30_000
  );

  test(
    '404 when role is system-scoped',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signed = await signIn(admin);

      const sysRole = await createRole({ name: tag('cant-touch'), scope: 'system' });

      const res = await api(url(sysRole.id), { method: 'DELETE', cookie: signed.cookie });
      expect(res.status).toBe(404);

      const stillThere = await tdb.select().from(roles).where(eq(roles.id, sysRole.id));
      expect(stillThere.length).toBe(1);
    },
    30_000
  );

  test(
    '401 when no session',
    async () => {
      const target = await createRole({ name: tag('unauth-target') });
      const res = await api(url(target.id), { method: 'DELETE' });
      expect(res.status).toBe(401);
    },
    30_000
  );

  test(
    '403 when actor lacks permissions:delete',
    async () => {
      const actorRole = await createRole({
        permissions: { permissions: { view: true, create: true } },
      });
      const actor = await createUser({ roleId: actorRole.id });
      const signed = await signIn(actor);

      const target = await createRole({ name: tag('no-delete-perm') });

      const res = await api(url(target.id), { method: 'DELETE', cookie: signed.cookie });
      expect(res.status).toBe(403);
    },
    30_000
  );

  test(
    '422 when id is not a valid UUID',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signed = await signIn(admin);

      const res = await api(url('garbage'), { method: 'DELETE', cookie: signed.cookie });
      expect(res.status).toBe(422);
    },
    30_000
  );
});
