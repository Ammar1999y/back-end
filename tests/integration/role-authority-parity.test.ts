/**
 * `PUT` and `DELETE` on a role that outranks the caller must answer the SAME
 * thing, through the real route table.
 *
 * The distinction is a disclosure boundary, not a style choice: every
 * neighbouring unreachable-target gate answers `404 MSG_NOT_FOUND`, so answering
 * `403 "you cannot GRANT permissions you don't own"` instead tells a caller who
 * holds no `permissions.view` that a role EXISTS and that it outranks them — an
 * exact, authenticated oracle over the role table, from an account that cannot
 * list it.
 *
 * `DELETE` had that divergence: it read `role_permissions` `FOR SHARE` for its
 * own audit payload and then called `validatePermissionScope` directly, skipping
 * the helper that makes the reachability-versus-grant decision, while the
 * neighbouring `PUT` on the same role answered 404.
 *
 * `tests/unit/permission-scope.test.ts` covers `collapseToNotFound` in
 * isolation, which is not the same statement: reverting the handler to the bare
 * `validatePermissionScope` call leaves every one of those cases green, because
 * they never touch the handler. What only a request can show is that BOTH routes
 * still route through it.
 *
 * The PUT deliberately carries NO `permissions` array. With one, the handler
 * runs the `grant` check before the transaction and 403 is the correct answer;
 * the reachability gate this file is about is the in-transaction one, and a body
 * that renames the role is the shortest way to reach it.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SeededUser, SignedInSession } from '../helpers/session';

import { app } from '@/app';

import { HTTP_STATUS, MSG_NOT_FOUND } from '@/utils/api-messages';

import { resetTables } from '../helpers/database';
import { authedRequest, seedUser, signedInUser } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const state: {
  actor: SignedInSession | null;
  outranking: SeededUser | null;
  reachable: SeededUser | null;
} = { actor: null, outranking: null, reachable: null };

function actor(): SignedInSession {
  if (!state.actor) throw new Error('actor was not seeded');
  return state.actor;
}

function roleOf(key: 'outranking' | 'reachable'): string {
  const seeded = state[key];
  if (!seeded) throw new Error(`${key} role was not seeded`);
  return seeded.roleId;
}

interface Observed {
  status: number;
  message: string;
}

async function observe(response: Response): Promise<Observed> {
  const body = (await response.json()) as { message?: string };
  return { status: response.status, message: body.message ?? '' };
}

function put(roleId: string): Promise<Response> {
  return app.handle(
    authedRequest(actor(), `/api/dash/permissions/${roleId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      // No `permissions` key: see the header.
      body: JSON.stringify({
        roleName: `renamed-${roleId.replaceAll('-', '')}`,
        isActive: true,
      }),
    })
  );
}

function remove(roleId: string): Promise<Response> {
  return app.handle(
    authedRequest(actor(), `/api/dash/permissions/${roleId}`, {
      method: 'DELETE',
    })
  );
}

beforeAll(async () => {
  await resetTables();
  resetSqliteStores();

  // Holds every action on `permissions` — so BOTH routes are authorised at the
  // action level and the only thing that can refuse is the scope check — and
  // nothing at all on `users`.
  state.actor = await signedInUser({
    permissions: { permissions: { view: true, edit: true, delete: true } },
  });

  // Holds `users` actions the actor does not, so its matrix outranks the actor's.
  state.outranking = await seedUser({
    permissions: { users: { view: true, delete: true } },
  });

  // Holds nothing the actor lacks, so it is genuinely reachable. Without this
  // the file is satisfied by a route that answers 404 for every role.
  state.reachable = await seedUser({
    permissions: { permissions: { view: true } },
  });
});

describe('a role that outranks the caller', () => {
  test('answers 404 identically on PUT and on DELETE', async () => {
    const roleId = roleOf('outranking');

    const edited = await observe(await put(roleId));
    const deleted = await observe(await remove(roleId));

    expect(edited).toEqual(deleted);
    // Positively the unreachable-target answer, not a 403 both happen to give.
    expect(edited).toEqual({
      status: HTTP_STATUS.NOT_FOUND,
      message: MSG_NOT_FOUND,
    });
  });

  test('a nonexistent role is indistinguishable from it', async () => {
    // The comparison that makes the collapse mean something: the same pair of
    // requests against an id that names no role at all.
    const absent = '01860f1c-0000-7000-8000-00000000dead';

    expect(await observe(await put(absent))).toEqual({
      status: HTTP_STATUS.NOT_FOUND,
      message: MSG_NOT_FOUND,
    });
    expect(await observe(await remove(absent))).toEqual({
      status: HTTP_STATUS.NOT_FOUND,
      message: MSG_NOT_FOUND,
    });
  });
});

describe('a role within the caller authority', () => {
  test('is reachable, so the 404 above is about authority and not about the route', async () => {
    const edited = await put(roleOf('reachable'));

    expect(edited.status).toBe(HTTP_STATUS.OK);
  });
});
