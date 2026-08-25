/**
 * Uppercase UUID spellings still name the same PostgreSQL row. These route
 * checks keep identity guards independent from the spelling a client used.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { permissionMsg } from '@/app/api/dash/permissions/messages';
import { userMsg } from '@/app/api/dash/users/messages';
import { db } from '@/db';
import { accounts, roles, users } from '@/db/schema';

import { HTTP_STATUS } from '@/utils/api-messages';

import { resetTables } from '../helpers/database';
import { authedRequest, signedInUser } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

interface Fixture {
  selfEdit: SignedInSession;
  ownRoleEdit: SignedInSession;
  selfDelete: SignedInSession;
}

const state: { fixture: Fixture | null } = { fixture: null };

function fx(): Fixture {
  if (!state.fixture) throw new Error('fixture not seeded');
  return state.fixture;
}

function uppercaseOneHexLetter(id: string): string {
  const index = id.search(/[a-f]/);
  if (index === -1)
    throw new Error(`fixture id has no hex letter to uppercase: ${id}`);
  return `${id.slice(0, index)}${id.charAt(index).toUpperCase()}${id.slice(index + 1)}`;
}

async function responseResult(response: Response) {
  return { status: response.status, body: await response.json() };
}

async function accountState(userId: string) {
  return db
    .select({
      id: accounts.id,
      password: accounts.password,
      providerId: accounts.providerId,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId));
}

async function roleState(roleId: string) {
  const [row] = await db
    .select({
      roleName: roles.roleName,
      description: roles.description,
      isActive: roles.isActive,
    })
    .from(roles)
    .where(eq(roles.id, roleId));
  if (!row) throw new Error(`role fixture missing: ${roleId}`);
  return row;
}

async function userState(userId: string) {
  const [row] = await db
    .select({
      email: users.email,
      roleId: users.roleId,
      isActive: users.isActive,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) throw new Error(`user fixture missing: ${userId}`);
  return row;
}

beforeAll(async () => {
  await resetTables();
  resetSqliteStores();

  state.fixture = {
    selfEdit: await signedInUser(),
    ownRoleEdit: await signedInUser(),
    selfDelete: await signedInUser(),
  };
});

describe('case-variant path ids keep identity guards closed', () => {
  test('PUT dispatch treats an uppercase own id as self-edit', async () => {
    const actor = fx().selfEdit;
    const upperId = uppercaseOneHexLetter(actor.user.userId);
    const before = await accountState(actor.user.userId);
    const body = {
      name: 'Harness User',
      email: actor.user.email,
      roleId: actor.user.roleId,
      isActive: true,
      password: 'CaseVariant!Passw0rd2',
    };
    const expected = {
      status: HTTP_STATUS.UNPROCESSABLE,
      body: {
        success: false,
        message: 'حقول غير معروفة في الطلب: email، roleId، isActive، password',
        data: null,
      },
    };

    const lowercase = await responseResult(
      await app.handle(
        authedRequest(actor, `/api/dash/users/${actor.user.userId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      )
    );
    const uppercase = await responseResult(
      await app.handle(
        authedRequest(actor, `/api/dash/users/${upperId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      )
    );

    expect(lowercase).toEqual(expected);
    expect(uppercase).toEqual(expected);
    expect(await accountState(actor.user.userId)).toEqual(before);
  });

  test('PUT rejects an uppercase spelling of the actor own role', async () => {
    const actor = fx().ownRoleEdit;
    const upperRoleId = uppercaseOneHexLetter(actor.user.roleId);
    const before = await roleState(actor.user.roleId);
    const body = {
      roleName: `case-variant-${actor.user.userId.replaceAll('-', '')}`,
      description: 'must not be written through the own-role guard',
      isActive: false,
    };
    const expected = {
      status: HTTP_STATUS.FORBIDDEN,
      body: {
        success: false,
        message: permissionMsg.cannotEditOwnRole,
        data: null,
      },
    };

    const lowercase = await responseResult(
      await app.handle(
        authedRequest(actor, `/api/dash/permissions/${actor.user.roleId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      )
    );
    const uppercase = await responseResult(
      await app.handle(
        authedRequest(actor, `/api/dash/permissions/${upperRoleId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      )
    );

    expect(lowercase).toEqual(expected);
    expect(uppercase).toEqual(expected);
    expect(await roleState(actor.user.roleId)).toEqual(before);
  });

  test('DELETE rejects an uppercase spelling of the actor own user id', async () => {
    const actor = fx().selfDelete;
    const upperId = uppercaseOneHexLetter(actor.user.userId);
    const beforeUser = await userState(actor.user.userId);
    const beforeAccounts = await accountState(actor.user.userId);
    const expected = {
      status: HTTP_STATUS.BAD_REQUEST,
      body: {
        success: false,
        message: userMsg.cannotDeleteSelf,
        data: null,
      },
    };

    const lowercase = await responseResult(
      await app.handle(
        authedRequest(actor, `/api/dash/users/${actor.user.userId}`, {
          method: 'DELETE',
        })
      )
    );
    const uppercase = await responseResult(
      await app.handle(
        authedRequest(actor, `/api/dash/users/${upperId}`, {
          method: 'DELETE',
        })
      )
    );

    expect(lowercase).toEqual(expected);
    expect(uppercase).toEqual(expected);
    expect(await userState(actor.user.userId)).toEqual(beforeUser);
    expect(await accountState(actor.user.userId)).toEqual(beforeAccounts);
  });
});
