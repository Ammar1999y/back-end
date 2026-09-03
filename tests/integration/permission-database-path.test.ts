/**
 * The DATABASE branch of `checkUserPermission`, for the state the cookie cache
 * cannot see: a role deactivated after sign-in.
 *
 * Reads with the `better-auth.session_data` cookie present are answered from
 * the cache; every write, and every request without that cookie, re-reads the
 * role from the database. So the case is driven three ways — a write, a read
 * without the cache cookie, and a read with it — because the third is the
 * documented tradeoff (a cached grant survives until `cookieCache.maxAge`) and
 * the first two are the guarantee that bounds it.
 *
 * The checker's other database-path refusal, a user with NO role, depends on
 * the deployment: under `REQUIRE_ROLE_FOR_LOGIN` the schema carries
 * `chk_active_user_has_role` (db/schema.ts), so no live row can reach that
 * branch and it is defence in depth — asserted here as the constraint refusing
 * the removal. Without the flag the removal succeeds, and the branch is the
 * refusal itself. Both are covered; which one runs follows the flag.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { roles, users } from '@/db/schema';
import { REQUIRE_ROLE_FOR_LOGIN } from '@/lib/permissions/constants';

import {
  HTTP_STATUS,
  MSG_INSUFFICIENT_PERMISSIONS,
} from '@/utils/api-messages';

import { resetTables } from '../helpers/database';
import { authedRequest, signedInUser } from '../helpers/session';

const GRANTS = { users: { view: true, create: true } } as const;

/** The jar without the cookie-cache entry, which is what forces the database read. */
function withoutSessionCache(session: SignedInSession): SignedInSession {
  const cookie = session.cookie
    .split('; ')
    .filter((pair) => !pair.startsWith('better-auth.session_data='))
    .join('; ');
  expect(cookie).not.toBe(session.cookie);
  return { ...session, cookie };
}

function listUsers(session: SignedInSession): Promise<Response> {
  return app.handle(authedRequest(session, '/api/dash/users?perPage=5'));
}

function createUser(session: SignedInSession): Promise<Response> {
  return app.handle(
    authedRequest(session, '/api/dash/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
  );
}

interface Fixture {
  roleDeactivated: SignedInSession;
  control: SignedInSession;
}

const state: { fixture: Fixture | null } = { fixture: null };

function fx(): Fixture {
  if (!state.fixture) throw new Error('fixture not seeded');
  return state.fixture;
}

beforeAll(async () => {
  await resetTables();

  const roleDeactivated = await signedInUser({ permissions: GRANTS });
  const control = await signedInUser({ permissions: GRANTS });

  // AFTER sign-in, so the cookie cache the session carries still says the grant
  // exists. The sign-in gate would have refused the state up front.
  await db
    .update(roles)
    .set({ isActive: false })
    .where(eq(roles.id, roleDeactivated.user.roleId));

  state.fixture = { roleDeactivated, control };
}, 30_000);

describe('the control: the same grants on a live role', () => {
  test('read and write both proceed', async () => {
    const read = await listUsers(fx().control);
    expect(read.status).toBe(HTTP_STATUS.OK);
    // 422 on an empty body: the grant was honoured and the handler reached
    // validation. 403 or 401 here would make the rows below prove nothing.
    const write = await createUser(fx().control);
    expect(write.status).toBe(HTTP_STATUS.UNPROCESSABLE);
  });
});

describe('a role deactivated after sign-in', () => {
  test('a write re-reads the role and is refused 403', async () => {
    const response = await createUser(fx().roleDeactivated);

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(await response.json()).toMatchObject({
      success: false,
      message: MSG_INSUFFICIENT_PERMISSIONS,
    });
  });

  test('a read without the cookie cache re-reads the role and is refused 403', async () => {
    const response = await listUsers(withoutSessionCache(fx().roleDeactivated));

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(await response.json()).toMatchObject({
      success: false,
      message: MSG_INSUFFICIENT_PERMISSIONS,
    });
  });

  test('a read WITH the cookie cache is still answered from it — the bounded tradeoff', async () => {
    // Pinned so the bound is visible: the cached grant lives at most
    // `session.cookieCache.maxAge` (`lib/auth.ts`), and only reads honour it.
    // Tightening this to a database read is a deliberate contract change, not a
    // fix for a failing test.
    const response = await listUsers(fx().roleDeactivated);

    expect(response.status).toBe(HTTP_STATUS.OK);
  });
});

describe('a live user without a role', () => {
  test.if(REQUIRE_ROLE_FOR_LOGIN)(
    'cannot exist: the schema refuses to remove the role, so the checker branch is unreachable',
    async () => {
      const { userId } = fx().control.user;

      // `.execute()`: the query builder is a thenable, not a Promise, and
      // `rejects` accepts only the latter.
      await expect(
        db
          .update(users)
          .set({ roleId: null })
          .where(eq(users.id, userId))
          .execute()
      ).rejects.toThrow();

      const [row] = await db
        .select({ roleId: users.roleId })
        .from(users)
        .where(eq(users.id, userId));
      expect(row?.roleId).toBe(fx().control.user.roleId);
    }
  );

  test.if(!REQUIRE_ROLE_FOR_LOGIN)(
    'is refused 403 on the database path, write and cache-less read alike',
    async () => {
      const session = await signedInUser({ permissions: GRANTS });
      await db
        .update(users)
        .set({ roleId: null })
        .where(eq(users.id, session.user.userId));

      const write = await createUser(session);
      expect(write.status).toBe(HTTP_STATUS.FORBIDDEN);
      const read = await listUsers(withoutSessionCache(session));
      expect(read.status).toBe(HTTP_STATUS.FORBIDDEN);
    },
    30_000
  );
});
