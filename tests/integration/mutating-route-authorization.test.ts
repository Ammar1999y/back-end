/**
 * Every mutating route, judged from the route table rather than from a list.
 *
 * `routes.ts` declares each route's `auth` policy, and `lib/http/session.ts`'s
 * `requirePermission` runs FIRST in every permission-gated handler — before its
 * limiter, before its body is read. Two actors drive every non-public mutating
 * route: nobody at all, and a signed-in user whose role grants nothing (with the
 * re-authentication window open, so the re-auth gate cannot stand in for the
 * permission decision). A route added to the table is in this walk the moment it
 * exists; a route that declares itself public and mutates has to be named in
 * `PUBLIC_MUTATING` on purpose.
 *
 * The body flag is asserted too: `readJson`/`readFormData` consume the request,
 * so `bodyUsed` after a refusal says whether the refusal was an admission
 * decision or a late one. `PUT /api/dash/users/:id` is the one route that reads
 * first, deliberately — a user without `edit` may still edit THEMSELVES, and
 * only the body says which edit this is.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';

import { app } from '@/app';
import { ROUTES } from '@/routes';
import { generateUuidV7 } from '@/lib/id';

import {
  HTTP_STATUS,
  MSG_INSUFFICIENT_PERMISSIONS,
  MSG_LOGIN_REQUIRED,
} from '@/utils/api-messages';

import { resetTables } from '../helpers/database';
import { authedRequest, baseHeaders, signedInUser } from '../helpers/session';

const MUTATING = ROUTES.filter((route) => route.method !== 'GET');

/**
 * The mutating routes that answer with no session at all. Each one carries its
 * own admission (captcha, per-IP limiter, OTP proof) and every one of them is a
 * deliberate decision — so the list is explicit, and a new public mutating route
 * fails this file until it is added here on purpose.
 */
const PUBLIC_MUTATING = [
  'POST /api/auth/forgot-password/reset',
  'POST /api/auth/forgot-password/second-factor/send',
  'POST /api/auth/forgot-password/complete',
  'POST /api/auth/forgot-password/send',
  'POST /api/auth/otp/send',
  'POST /api/auth/otp/verify',
  'POST /api/auth/passwordless/send',
  'POST /api/dev/sign-up',
];

/** Routes whose refusal legitimately comes after the body is read, and why. */
const READS_BODY_BEFORE_REFUSING = new Set([
  // Self-edit needs no grant; only the body says whether this is one.
  'PUT /api/dash/users/:id',
]);

const GUARDED = MUTATING.filter((route) => route.auth !== 'public');
const PERMISSION_GATED = GUARDED.filter((route) => route.auth === 'permission');

function label(route: { method: string; path: string }): string {
  return `${route.method} ${route.path}`;
}

/** Locale-independent ordering, so the comparison is stable. */
const byText = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

/**
 * Query strings a route needs before its permission check can even be named.
 * The upload route checks the grant on the page `?resource=` points at, so the
 * page has to be supplied for the refusal to be a permission decision rather
 * than a 400 on the missing parameter.
 */
const QUERY_FOR: Readonly<Record<string, string>> = {
  'POST /api/upload/image': '?resource=users',
};

/** A concrete URL: every `:id` becomes a well-formed id that names nothing. */
function targetUrl(route: { method: string; path: string }): string {
  const path = route.path.replaceAll(/:[a-zA-Z]+/g, () => generateUuidV7());
  return `${path}${QUERY_FOR[label(route)] ?? ''}`;
}

function bodyFor(route: (typeof ROUTES)[number]): {
  body?: BodyInit;
  headers: Record<string, string>;
} {
  if (route.body === 'json')
    return { body: '{}', headers: { 'content-type': 'application/json' } };
  if (route.body === 'multipart') {
    const form = new FormData();
    form.append('probe', '1');
    return { body: form, headers: {} };
  }
  return { headers: {} };
}

const state: { nobody: SignedInSession | null } = { nobody: null };

beforeAll(async () => {
  await resetTables();
  // A role with NO grants, and the re-authentication window OPEN: the only gate
  // left to refuse is the permission decision.
  state.nobody = await signedInUser({ permissions: {} });
}, 30_000);

describe('the route table', () => {
  test('every public mutating route is a named decision', () => {
    const publicMutating = MUTATING.filter(
      (route) => route.auth === 'public'
    ).map(label);
    expect(publicMutating.toSorted(byText)).toEqual(
      PUBLIC_MUTATING.toSorted(byText)
    );
  });

  test('the walk below is not empty', () => {
    expect(GUARDED.length).toBeGreaterThan(5);
    expect(PERMISSION_GATED.length).toBeGreaterThan(3);
  });
});

describe.each(GUARDED.map((route) => [label(route), route] as const))(
  '%s',
  (_name, route) => {
    test('with no session is refused 401 before the body is read', async () => {
      const { body, headers } = bodyFor(route);
      const request = new Request(`http://localhost${targetUrl(route)}`, {
        method: route.method,
        headers: baseHeaders(headers),
        body,
      });

      const response = await app.handle(request);

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(await response.json()).toMatchObject({
        success: false,
        message: MSG_LOGIN_REQUIRED,
      });
      expect(request.bodyUsed).toBe(false);
    });
  }
);

describe.each(PERMISSION_GATED.map((route) => [label(route), route] as const))(
  '%s',
  (name, route) => {
    test('with a session that holds no grant is refused 403', async () => {
      if (!state.nobody) throw new Error('fixture not seeded');
      const { body, headers } = bodyFor(route);
      const request = authedRequest(state.nobody, targetUrl(route), {
        method: route.method,
        headers,
        body,
      });

      const response = await app.handle(request);

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(await response.json()).toMatchObject({
        success: false,
        message: MSG_INSUFFICIENT_PERMISSIONS,
      });
      expect(request.bodyUsed).toBe(READS_BODY_BEFORE_REFUSING.has(name));
    });
  }
);
