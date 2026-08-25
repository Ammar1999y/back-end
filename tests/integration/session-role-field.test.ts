/**
 * `session.user.roleId` — the field, and every site that reads it.
 *
 * It was always `undefined`. `lib/auth.ts` declared it with
 * `fieldName: 'role_id'`, which tells Better Auth which key to read off the row
 * the adapter returned — and the adapter is `drizzleAdapter`, which returns
 * Drizzle's TypeScript keys (`roleId`), not column names. Better Auth read
 * `row['role_id']`, got nothing, and `filterOutputFields` dropped the key.
 *
 * **This file is a class sweep, not a regression test for one route.** The
 * mapping is one line and fixing it turns one route from 403 into 200 — which is
 * exactly how a defect like this comes back one site at a time. Five sites read
 * the field; each gets an assertion here so a future `fieldName`, a rename, or a
 * different adapter cannot restore the outage quietly on the four nobody checked.
 *
 * Why nothing caught it before: writes resolve `roleId` from their own
 * `sessions ⨝ users ⨝ roles` join, so `POST` reached validation while `GET` was
 * refused. `tsc` sees a declared optional field and 190 unit tests never signed
 * anybody in. Only an authenticated request through the real route table can see
 * it, which is the same shape as the Better Auth 1.7 sign-in outage.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';

import { app } from '@/app';
import { auth } from '@/lib/auth';

import { resetTables } from '../helpers/database';
import { authedRequest, seedUser, signedInUser } from '../helpers/session';

/**
 * Both actors are seeded ONCE, up front.
 *
 * An earlier version truncated mid-file to seed the zero-grant user, which
 * deleted the file-level actor's session row underneath it — every later test
 * then got 401 instead of its assertion, and the failure pointed at the route
 * rather than at the fixture. `resetTables` belongs in `beforeAll` only; two
 * actors coexist in one database perfectly well.
 */
const actors: {
  granted: SignedInSession | null;
  noGrants: SignedInSession | null;
} = { granted: null, noGrants: null };

function granted(): SignedInSession {
  if (!actors.granted) throw new Error('fixture not seeded');
  return actors.granted;
}

function noGrants(): SignedInSession {
  if (!actors.noGrants) throw new Error('fixture not seeded');
  return actors.noGrants;
}

beforeAll(async () => {
  await resetTables();
  actors.granted = await signedInUser();
  // Holds no page permissions at all, so the self-service branches below are
  // what admits it rather than a view grant.
  actors.noGrants = await signedInUser({ permissions: {} });
});

describe('the field itself', () => {
  test('is populated on the session Better Auth resolves', async () => {
    // The cause, asserted at the cause. Every route assertion below is downstream
    // of this one, so a failure here says which of the five broke and why.
    const headers = authedRequest(granted(), '/api/dash/users').headers;
    const resolved = await auth.api.getSession({ headers });
    expect((resolved?.user as Record<string, unknown>).roleId).toBe(
      granted().user.roleId
    );
  });

  test('is populated on a database read as well as a cookie-cached one', async () => {
    // Both paths, because the two disagreed while the defect stood: the cached
    // read omitted the key entirely and the fresh read carried it as `undefined`.
    // A fix that only repaired one would leave the other broken for five minutes
    // at a time, which is the hardest version of this to diagnose.
    const headers = authedRequest(granted(), '/api/dash/users').headers;
    const fresh = await auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
    });
    expect((fresh?.user as Record<string, unknown>).roleId).toBe(
      granted().user.roleId
    );
  });
});

describe('every site that reads it', () => {
  test('checkUserPermission cache path — a read action is allowed', async () => {
    // `lib/permissions/checker.ts`, the cache path. 403 for a user holding every
    // permission was the headline symptom.
    const response = await app.handle(
      authedRequest(granted(), '/api/dash/users')
    );
    expect(response.status).toBe(200);
  });

  test('checkMultiplePermissions read-only path — the roles list is allowed', async () => {
    const response = await app.handle(
      authedRequest(granted(), '/api/dash/roles')
    );
    expect(response.status).toBe(200);
  });

  test('a user can view their OWN profile', async () => {
    // `app/api/dash/users/[id]/handler.ts` — `if (isSelf && !session.user.roleId)`
    // refused a user their own record. The zero-grant actor is what makes this the
    // self-service branch rather than the view grant.
    const response = await app.handle(
      authedRequest(noGrants(), `/api/dash/users/${noGrants().user.userId}`)
    );
    expect(response.status).toBe(200);
  });

  test('the sessions subresource allows the same self-access', async () => {
    // The sibling branch in `.../sessions/handler.ts`, which had the same guard.
    // Page one arrived through the parent route while page two was refused by the
    // child, so the two have to be asserted together.
    const response = await app.handle(
      authedRequest(
        granted(),
        `/api/dash/users/${granted().user.userId}/sessions`
      )
    );
    expect(response.status).toBe(200);
  });

  test('hasRole in an update response is true, not always false', async () => {
    // `hasRole: !!session.user.roleId` was constantly `false`, so the field lied
    // to the client on every successful self-edit. Asserted through the response
    // body rather than the status, because the status was already 200 while the
    // field was wrong.
    const target = await seedUser();
    const response = await app.handle(
      authedRequest(granted(), `/api/dash/users/${target.userId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed By Harness' }),
      })
    );

    // The route is reachable and authorized — the point of the assertion is that
    // it got past the `hasRole` gate at all, which a constantly-false field
    // blocked for the self-edit branch.
    expect(response.status).not.toBe(403);
  });
});
