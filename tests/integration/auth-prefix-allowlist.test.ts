/**
 * The Better Auth wildcard prefix, judged from outside the process.
 *
 * `app.ts` decides three things for every `/api/auth/*` request before Better
 * Auth is reached: whether the sub-path is on `BETTER_AUTH_ENDPOINTS`, which
 * limiter budget it draws on, and which limiter KEY it draws it from. Only the
 * first has ever been asserted, and the third is the one with no natural bound —
 * a path-derived scope on a wildcard mints a new `rate_limit` row per invented
 * path, so a client rotating `/api/auth/<random>` gets an unlimited budget out
 * of an unbounded keyspace.
 *
 * Randomised rather than a fixed list on purpose: a hand-written list of
 * unknown paths is a list of the paths someone already thought of, and the
 * property here is about every path that is NOT on the allowlist.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { app } from '@/app';
import { ROUTES } from '@/routes';
import { BETTER_AUTH_ENDPOINTS } from '@/lib/auth/allowed-paths';
import { PRE_AUTH_LIMIT } from '@/lib/http/pre-auth';
import { getRateLimitStore } from '@/lib/rate-limit/store';

import { HTTP_STATUS, MSG_PAGE_NOT_FOUND } from '@/utils/api-messages';

import { egressCallsTo } from '../helpers/egress';
import { baseHeaders } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const TURNSTILE_HOST = 'challenges.cloudflare.com';

/** Locale-independent ordering, so an `Allow` comparison is stable. */
const byText = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

/**
 * What `Allow` must name for a path serving `methods`.
 *
 * `OPTIONS` because the CORS layer answers it on every known path, and `HEAD`
 * wherever `GET` is served — derived here the same way `createRouteLookup`
 * derives it, so the two cannot disagree.
 */
function advertised(methods: readonly string[]): string[] {
  const all = new Set<string>([...methods, 'OPTIONS']);
  if (all.has('GET')) all.add('HEAD');
  return [...all].toSorted(byText);
}

/**
 * Deterministic, so a failure names a path that can be replayed. Seeded LCG
 * rather than `Math.random`, which would make a red run unreproducible.
 */
function randomSubPaths(count: number): string[] {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789-_';
  let seed = 0x9e_37_79_bb;
  const next = () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed;
  };

  const paths = new Set<string>();
  while (paths.size < count) {
    let segment = '';
    for (let i = 3 + (next() % 12); i > 0; i--)
      segment += alphabet[next() % alphabet.length];
    paths.add(`/${segment}`);
  }
  return [...paths];
}

function callAuth(subPath: string, method: string = 'POST') {
  return app.handle(
    new Request(`http://localhost/api/auth${subPath}`, {
      method,
      headers: baseHeaders({ 'content-type': 'application/json' }),
      ...(method === 'POST' && { body: '{}' }),
    })
  );
}

function rateLimitKeys(): string[] {
  const statement = getRateLimitStore().db.prepare(
    'SELECT key FROM rate_limit'
  );
  try {
    return statement.all<{ key: string }>().map((row) => row.key);
  } finally {
    statement.finalize();
  }
}

beforeEach(() => {
  resetSqliteStores();
});

describe('a sub-path outside the allowlist', () => {
  /**
   * The first four are the shapes that defeat a substring match — the failure
   * better-auth 1.6.26's captcha plugin actually had, where any path CONTAINING
   * `sign-in/email` was treated as that endpoint and bought an outbound
   * siteverify. The rest are real Better Auth endpoints this deployment does not
   * enable; each is a live credential or account surface if the allowlist stops
   * being enforced here.
   */
  const CRAFTED = [
    '/zz/sign-in/email/zz',
    '/sign-in/email/extra',
    '/x/get-session',
    '/passwordless/verify/x',
    '/sign-up/email',
    '/callback/google',
    '/forget-password',
    '/reset-password',
    '/two-factor/verify',
    '/admin/list-users',
    '/organization/create',
    '/update-user',
    '/open-api/generate-schema',
    '/reference',
  ];

  test.each([...CRAFTED, ...randomSubPaths(8)])(
    '%s answers 404 in this API envelope and spends no captcha quota',
    async (subPath) => {
      const response = await callAuth(subPath);

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      expect(await response.json()).toEqual({
        success: false,
        message: MSG_PAGE_NOT_FOUND,
        data: null,
      });
      expect(egressCallsTo(TURNSTILE_HOST)).toEqual([]);
    }
  );

  test('every allowlisted path still resolves, so 404 is not the whole answer', async () => {
    for (const endpoint of BETTER_AUTH_ENDPOINTS)
      for (const method of endpoint.methods) {
        const response = await callAuth(endpoint.path, method);
        expect(
          response.status,
          `${method} ${endpoint.path} is declared and must reach Better Auth`
        ).not.toBe(HTTP_STATUS.NOT_FOUND);
        expect(
          response.status,
          `${method} ${endpoint.path} is declared and must not be refused as a wrong method`
        ).not.toBe(HTTP_STATUS.METHOD_NOT_ALLOWED);
      }
  });

  test('a method a path does NOT declare is a 405 with an accurate Allow', async () => {
    // The runtime half of the per-endpoint table. Declaring the methods once for
    // the whole prefix put `GET` in `Allow` for POST-only paths and published
    // three GET operations no client can make: measured against installed
    // better-auth, `GET /sign-out` and `GET /passwordless/verify` answer 404 and
    // `GET /sign-in/email` reaches the captcha plugin's processing before its
    // method is rejected.
    for (const endpoint of BETTER_AUTH_ENDPOINTS) {
      // The prefix is registered for these two and nothing else, so they are
      // the only methods that can reach the wildcard at all.
      const declared = new Set<string>(endpoint.methods);
      const undeclared = (['GET', 'POST'] as const).filter(
        (method) => !declared.has(method)
      );
      for (const method of undeclared) {
        const response = await callAuth(endpoint.path, method);
        expect(
          response.status,
          `${method} ${endpoint.path} is not declared`
        ).toBe(HTTP_STATUS.METHOD_NOT_ALLOWED);
        // The header names exactly what the table declares, plus OPTIONS.
        const allow = (response.headers.get('allow') ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
          .toSorted(byText);
        expect(allow).toEqual(advertised(endpoint.methods));
      }
    }
  });

  /**
   * The project's OWN routes under `/api/auth`, which are not Better Auth paths.
   *
   * Read from the table rather than listed, so a sixth one is covered the day it
   * is added.
   */
  const PROJECT_AUTH_ROUTES = [
    ...new Set(
      ROUTES.filter((route) => route.path.startsWith('/api/auth/')).map(
        (route) => route.path.slice('/api/auth'.length)
      )
    ),
  ];

  test('a project route under the prefix answers 405 on ANY wrong method', async () => {
    // Five real `ROUTES` entries sit under this prefix and are not Better Auth
    // paths, so a `GET` on one falls through the `GET /api/auth/*` wildcard and
    // was answered as UNKNOWN — 404 with no `Allow` — while a `PUT` on the same
    // path, which the wildcard is not mounted for, reached `onError` and got a
    // correct `405 Allow: POST, OPTIONS`. Same path, same wrong-method
    // condition, two answers depending on which method happened to be mounted.
    expect(PROJECT_AUTH_ROUTES.length).toBeGreaterThan(0);

    for (const subPath of PROJECT_AUTH_ROUTES) {
      const throughWildcard = await callAuth(subPath, 'GET');
      const throughRouter = await callAuth(subPath, 'PUT');

      expect(throughWildcard.status, `GET ${subPath}`).toBe(
        HTTP_STATUS.METHOD_NOT_ALLOWED
      );
      expect(throughRouter.status, `PUT ${subPath}`).toBe(
        HTTP_STATUS.METHOD_NOT_ALLOWED
      );
      expect(throughWildcard.headers.get('allow')).toBe(
        throughRouter.headers.get('allow')
      );
      expect(throughWildcard.headers.get('allow')).toBe('POST, OPTIONS');
    }
  });

  test('HEAD is served wherever GET is, and refused wherever it is not', async () => {
    // RFC 9110 §9.3.2 makes GET and HEAD both mandatory for a general-purpose
    // server, and `createRouteLookup` already derives HEAD from GET for every
    // table route — so the prefix branch answering `405 Allow: GET, OPTIONS` to
    // a HEAD was a response contradicting itself on one line. Elysia dispatches
    // HEAD to the GET registration and Better Auth answers 404 to a HEAD it
    // reaches (measured on 1.7.1), so `app.ts` hands it a GET.
    for (const endpoint of BETTER_AUTH_ENDPOINTS) {
      const response = await callAuth(endpoint.path, 'HEAD');
      const servesGet = endpoint.methods.includes('GET');

      expect(
        response.status,
        `HEAD ${endpoint.path} where GET is ${servesGet ? '' : 'not '}served`
      ).toBe(servesGet ? HTTP_STATUS.OK : HTTP_STATUS.METHOD_NOT_ALLOWED);

      if (servesGet) continue;
      const allow = (response.headers.get('allow') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .toSorted(byText);
      expect(allow).toEqual(advertised(endpoint.methods));
    }
  });
});

describe('the budget an unknown sub-path draws on', () => {
  test('rotating the path multiplies neither the budget nor the keyspace', async () => {
    // One more request than the coarse budget, each on a DIFFERENT invented
    // path. With a path-derived scope every one of these is its own key and
    // nothing ever reaches the limit; with the fixed `UNKNOWN_PREFIX_SCOPE`
    // they share one counter and the last is refused.
    const paths = randomSubPaths(PRE_AUTH_LIMIT + 1);
    const statuses: number[] = [];
    for (const subPath of paths) {
      const response = await callAuth(subPath);
      statuses.push(response.status);
    }

    expect(statuses.slice(0, PRE_AUTH_LIMIT)).toEqual(
      Array.from({ length: PRE_AUTH_LIMIT }, () => HTTP_STATUS.NOT_FOUND)
    );
    expect(statuses.at(-1)).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);

    // The keyspace half, stated separately: 121 paths from one IP must leave one
    // row behind, not 121. This is the property the sweep ceiling is sized on.
    expect(rateLimitKeys()).toHaveLength(1);
  }, 120_000);
});
