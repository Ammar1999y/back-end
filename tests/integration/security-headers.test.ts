/**
 * The security headers, asserted by VALUE on a real response.
 *
 * The gap this closes: `scripts/smoke.ts` checked
 * `content-security-policy !== null`, so a regression to `default-src *` passed
 * it, and nothing anywhere touched `X-Frame-Options`, `Referrer-Policy`,
 * `Strict-Transport-Security` or the cross-origin trio. A header that is present
 * and wrong is the failure mode a presence check cannot see, and it is the likely
 * one — nobody deletes a CSP, they weaken it.
 *
 * **Derived from `SECURITY_HEADERS`, never restated.** A copy of the expected
 * values here would drift from the module and keep passing; iterating the
 * production constant means a header added there is asserted here without anyone
 * remembering to, and a value changed there fails only if the change is wrong on
 * the wire rather than merely different from a stale copy.
 *
 * The one thing the constant cannot supply is whether the value SURVIVES to the
 * wire, which is the property that matters: `app.ts` writes these in `onRequest`,
 * the CORS plugin and the handler write to the same bag afterwards, and
 * `applyResponsePolicy` runs last and overwrites. Three layers can drop a header
 * between the constant and the response.
 */
import { describe, expect, test } from 'bun:test';

import { app } from '@/app';
import { SECURITY_HEADERS } from '@/lib/http/security-headers';

import { baseHeaders } from '../helpers/session';

/**
 * Paths chosen so every response-producing path in `app.ts` is covered: a route
 * response, the `onError` 404, the 405 boundary and the trailing-slash 308. The
 * headers are applied in different places for each — a route response goes
 * through `mapResponse`, while `onError` re-applies them itself — so asserting
 * only the happy path leaves the error paths free to drop them.
 */
const PATHS = [
  ['a real route', '/api/health/storage', 'GET'],
  ['an unknown path (404)', '/api/does-not-exist', 'GET'],
  ['a wrong method (405)', '/api/health/storage', 'DELETE'],
  ['a trailing slash (308)', '/api/health/storage/', 'GET'],
] as const;

async function respond(path: string, method: string): Promise<Response> {
  return app.handle(
    new Request(new URL(path, 'http://localhost'), {
      method,
      headers: baseHeaders(),
    })
  );
}

describe('every security header reaches the wire, with its exact value', () => {
  test.each([...PATHS])('%s', async (_label, path, method) => {
    const response = await respond(path, method);

    const wrong: string[] = [];
    for (const [name, expected] of Object.entries(SECURITY_HEADERS)) {
      const actual = response.headers.get(name);
      if (actual !== expected) wrong.push(`${name}: ${actual} !== ${expected}`);
    }

    expect(wrong, `on ${method} ${path} (status ${response.status})`).toEqual(
      []
    );
  });
});

describe('the CSP is restrictive, not merely present', () => {
  test('it denies by default and locks the document directives', async () => {
    // Spelled out deliberately, unlike the walk above. The walk proves the wire
    // matches the constant; it would keep passing if someone weakened the
    // CONSTANT to `default-src *`. This is the assertion that says what the value
    // has to mean, and it is the one that fails on that change.
    const response = await respond('/api/health/storage', 'GET');
    const csp = response.headers.get('Content-Security-Policy');

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    // The specific regression this guards: a wildcard anywhere in the policy.
    expect(csp).not.toContain('*');
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  test('nosniff and DENY are exact, not merely truthy', async () => {
    const response = await respond('/api/health/storage', 'GET');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin');
  });
});

describe('HSTS is production-only', () => {
  test('it is absent in this tier, which runs NODE_ENV=development', async () => {
    // Not a nice-to-have: a `Strict-Transport-Security` header served over
    // `http://localhost` pins the whole host to HTTPS in the developer's
    // browser, including unrelated projects on other ports. The POSITIVE case —
    // present under a real production boot — belongs to the process tier, since
    // `isProduction` is read at module load and cannot be changed from here.
    expect(process.env.NODE_ENV).toBe('development');
    expect(SECURITY_HEADERS['Strict-Transport-Security']).toBeUndefined();

    const response = await respond('/api/health/storage', 'GET');
    expect(response.headers.get('Strict-Transport-Security')).toBeNull();
  });
});
