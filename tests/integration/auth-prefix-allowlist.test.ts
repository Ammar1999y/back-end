/**
 * The Better Auth wildcard prefix, judged from outside the process.
 *
 * `app.ts` decides three things for every `/api/auth/*` request before Better
 * Auth is reached: whether the sub-path is on `BETTER_AUTH_ALLOWED_PATHS`, which
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
import { BETTER_AUTH_ALLOWED_PATHS } from '@/lib/auth/allowed-paths';
import { PRE_AUTH_LIMIT } from '@/lib/http/pre-auth';
import { getRateLimitStore } from '@/lib/rate-limit/store';

import { HTTP_STATUS, MSG_PAGE_NOT_FOUND } from '@/utils/api-messages';

import { egressCallsTo } from '../helpers/egress';
import { baseHeaders } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const TURNSTILE_HOST = 'challenges.cloudflare.com';

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

function callAuth(subPath: string, method: 'GET' | 'POST' = 'POST') {
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
    for (const subPath of BETTER_AUTH_ALLOWED_PATHS) {
      const response = await callAuth(
        subPath,
        subPath === '/get-session' ? 'GET' : 'POST'
      );
      expect(
        response.status,
        `${subPath} is on the allowlist and must reach Better Auth`
      ).not.toBe(HTTP_STATUS.NOT_FOUND);
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
