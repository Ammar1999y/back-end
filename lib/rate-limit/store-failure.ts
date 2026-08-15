/**
 * Log boundaries for rate-limit store failures.
 *
 * Its own module, not helpers inside `index.ts`, because the barrel is
 * `mock.module`-ed by a probe and because a containment boundary is easier to
 * trust when it is the only thing in its file.
 *
 * Why a boundary is needed at all: `@upstash/redis` formats an HTTP error
 * response as `` `${body.error}, command was: ${JSON.stringify(req.body)}` ``,
 * and the command body is the Redis key. Both key spaces here embed data worth
 * withholding — the API limiter's key ends in the destination, and Better
 * Auth's ends in `${ip}|${path}`. `sanitizeForLog` keeps free-text messages by
 * policy, so the raw error must never reach it.
 */

/**
 * `name` on an Error is the class name (`UpstashError`, `TypeError`). Observed
 * values from this dependency are fixed identifiers, not formatted text.
 */
function errorClassOf(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : 'Unknown';
}

export interface StoreFailureLog {
  msg: 'rate-limit store error';
  attempt: number;
  scope: string;
  errorClass: string;
}

/**
 * Summarize an API-limiter failure without the raw store error.
 *
 * `scope` is the identifier's prefix. That is safe rather than merely
 * convenient: `enforceRateLimit` is the only caller of `rateLimit`, it builds
 * `${scope}:${identifier}`, and every scope in the codebase is a compile-time
 * constant or an interpolation of a closed union. Enumerating all 14 routes that
 * enable `preAuthIpLimit` — the one request-derived producer — yields exactly
 * five static values (`preauth.auth.forgot-password`, `preauth.auth.passwordless`,
 * `preauth.dash.{permissions,roles,users}`); dynamic path segments never survive
 * its two-segment slice, and no scope contains a colon. There is deliberately no
 * runtime validation here, because no reachable path needs one.
 */
export function describeStoreFailure(
  error: unknown,
  opts: { identifier: string },
  attempt: number
): StoreFailureLog {
  return {
    msg: 'rate-limit store error',
    attempt,
    scope: opts.identifier.split(':', 1)[0] ?? '',
    errorClass: errorClassOf(error),
  };
}

export interface AuthStoreFailureLog {
  msg: 'auth rate-limit store error';
  op: 'get' | 'set';
  errorClass: string;
}

/**
 * Summarize a Better Auth limiter-storage failure.
 *
 * No key, deliberately. Better Auth builds it with
 * `createRateLimitKey(ip, path)` = `` `${ip}|${path}` `` (`@better-auth/core`
 * `utils/ip`), so logging the key — or the raw Upstash error that quotes it —
 * puts the requester's IP address in the log on every retry of every failing
 * request. Reproduced against the installed client; see the regression test.
 *
 * Which operation failed and the error's class are what an outage actually
 * needs, and neither is derived from the key.
 */
export function describeAuthStoreFailure(
  error: unknown,
  op: 'get' | 'set'
): AuthStoreFailureLog {
  return {
    msg: 'auth rate-limit store error',
    op,
    errorClass: errorClassOf(error),
  };
}
