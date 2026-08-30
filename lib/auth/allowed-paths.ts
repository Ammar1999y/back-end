import type { RoutePrefixPath } from '@/lib/http/route-manifest';

/**
 * The complete Better Auth surface this deployment exposes, per ENDPOINT.
 *
 * A leaf module (type-only import above), read by `lib/auth.ts` (which enforces
 * it in a `before` hook), `routes.ts` (which needs it to answer 404-versus-405
 * accurately), `app.ts` (which registers it and reads `preAuthLimit`) and
 * `lib/http/openapi.ts` (which publishes it). One table, every reader, so
 * enforcement, admission and advertisement cannot drift.
 *
 * **Methods are per path, and that is the point.** They used to be declared once
 * for the whole prefix as `['GET', 'POST']`, so the 405 boundary put `GET` in
 * `Allow` for POST-only paths and the document advertised three GET operations
 * no client can make. Measured against installed `better-auth@1.7.1`: a `GET` to
 * `/sign-out` and `/passwordless/verify` answered 404 and `GET /sign-in/email`
 * reached Better Auth's captcha processing before method rejection, while the
 * document listed `get` and `post` for all four. The values below are read from
 * the dependency's own endpoint definitions (`method:` in
 * `better-auth/dist/api/routes/*.mjs`) and from `lib/auth/passwordless.ts` for
 * the local plugin endpoint.
 *
 * ⚠️ WARNING that travels with this list: `lib/auth.ts` stubs Better Auth's
 * built-in `password.verify` to always return true because the before hook runs
 * the real `verifyLoginAttempt`. Adding a password-bearing path here without
 * wiring verification into that hook is a credential bypass. Read the note above
 * `ALLOWED_PATHS`' use in `lib/auth.ts` before extending this.
 */
export const BETTER_AUTH_ENDPOINTS: readonly RoutePrefixPath[] = [
  // GET only, and this is the case that proves the values have to be MEASURED
  // rather than read off the dependency's declaration. `getSession` declares
  // `method: ["GET", "POST"]`, but its own handler throws
  // `METHOD_NOT_ALLOWED` for a POST unless `session.deferSessionRefresh` is
  // enabled (`better-auth/dist/api/routes/session.mjs`), and `lib/auth.ts` does
  // not enable it — measured, `POST /api/auth/get-session` answers 405. Turning
  // that option on is what would make POST belong here.
  // Session reads need a separate budget from credential attempts for shared NATs.
  {
    path: '/get-session',
    methods: ['GET'],
    preAuthLimit: 300,
    captcha: false,
  },
  {
    path: '/sign-out',
    methods: ['POST'],
    preAuthLimit: 30,
    captcha: false,
  },
  {
    path: '/sign-in/email',
    methods: ['POST'],
    preAuthLimit: 20,
    captcha: true,
  },
  // Passwordless plugin endpoint — does its own captcha/rate-limit/OTP verify.
  {
    path: '/passwordless/verify',
    methods: ['POST'],
    preAuthLimit: 60,
    captcha: true,
  },
];

/** Membership test for the `before` hook, which decides on the PATH alone. */
export const BETTER_AUTH_ALLOWED_PATH_SET: ReadonlySet<string> = new Set(
  BETTER_AUTH_ENDPOINTS.map((endpoint) => endpoint.path)
);

/** Path -> the methods it answers, for the 405 boundary and the document. */
const SERVED_METHODS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  BETTER_AUTH_ENDPOINTS.map((endpoint) => [
    endpoint.path,
    new Set<string>(endpoint.methods),
  ])
);

/**
 * Does this deployment serve `path` under `method`? Drives the 405 boundary.
 *
 * `HEAD` is answered from the `GET` entry, because a resource that serves GET
 * serves HEAD — RFC 9110 §9.3.2 makes both mandatory for a general-purpose
 * server, `CORS_POLICY` advertises HEAD, and `createRouteLookup` already derives
 * it for every table route. Without this, `HEAD /api/auth/get-session` answered
 * `405` while advertising `Allow: GET` on the very path it was refusing — a
 * response that contradicts itself.
 */
export function betterAuthServes(path: string, method: string): boolean {
  const served = SERVED_METHODS.get(path);
  if (!served) return false;
  return served.has(method === 'HEAD' ? 'GET' : method);
}
