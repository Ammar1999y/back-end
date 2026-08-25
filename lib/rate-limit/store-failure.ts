/**
 * Log boundaries for rate-limit store failures.
 *
 * Its own module, not helpers inside `index.ts`, because the barrel is
 * `mock.module`-ed by a probe and because a containment boundary is easier to
 * trust when it is the only thing in its file.
 *
 * ## Why the boundary is kept now that the store is local
 *
 * The original justification was specific to `@upstash/redis`, which formatted an
 * HTTP error as `` `${body.error}, command was: ${JSON.stringify(req.body)}` `` —
 * the command body being the Redis key. That dependency is gone, and the local
 * driver was tested against exactly this concern: a UNIQUE violation on a key
 * containing `ip:203.0.113.77|user:victim@example.com` produced only
 * `UNIQUE constraint failed: cache.key`, with no key content in the message or
 * the stack. So the demonstrated leak no longer exists.
 *
 * The boundary stays anyway, for reasons that do not depend on the old client:
 *
 * 1. Both key spaces still embed data worth withholding — the API limiter's key
 *    ends in the destination (email address or phone number), and Better Auth's
 *    is `${ip}|${path}`. The sensitivity of the input is unchanged.
 * 2. `sanitizeForLog` keeps free-text messages by policy, so any future driver or
 *    driver version that does interpolate a bound parameter into its message
 *    would reach the log unfiltered. The store is scheduled to change again — from
 *    better-sqlite3 to `bun:sqlite` at the framework migration — and that is
 *    exactly the kind of change that reintroduces such a message.
 * 3. What an outage actually needs is which operation failed and the error class.
 *    Neither is derived from the key, so withholding it costs no diagnostic value.
 *
 * In other words this is now a precaution rather than a fix for an observed leak,
 * and the accompanying probes assert the property rather than reproducing a
 * specific client's message format.
 */

/**
 * `name` on an Error is a fixed identifier, not formatted text.
 *
 * Under `bun:sqlite` that identifier is `SQLiteError` — capital L, capital E.
 * `better-sqlite3` spelled it `SqliteError`, and this comment named the old
 * spelling after the driver had already changed. Nothing in production compares
 * against either string (audited), so the drift was documentary only. The suite
 * now asserts it against an error the real driver threw rather than a
 * hand-authored one, so a further rename cannot pass unnoticed.
 */
function errorClassOf(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : 'Unknown';
}

export interface StoreFailureLog {
  msg: 'rate-limit store error';
  scope: string;
  errorClass: string;
}

/**
 * Summarize an API-limiter failure without the raw store error.
 *
 * `scope` is the identifier's prefix. That is safe rather than merely
 * convenient: `enforceRateLimit` is the only caller of `rateLimit`, it builds
 * `${scope}:${identifier}`, and every scope in the codebase is a compile-time
 * constant or an interpolation of a closed union. The 22 routes that declare
 * `preAuth: 'ip-limit'` — the one request-derived producer — collapse to exactly
 * six static values (`preauth.auth.forgot-password`, `preauth.auth.passwordless`,
 * `preauth.dash.{permissions,roles,users}`, `preauth.upload.image`); dynamic path
 * segments never survive `preAuthScope`'s two-segment slice, and no scope
 * contains a colon. There is deliberately no runtime validation here, because no
 * reachable path needs one — and the counts above are no longer maintained by
 * hand: `tests/unit/rate-limit-log-boundary.test.ts` derives the set from
 * `ROUTES` and asserts the property over every member.
 *
 * There is no `attempt` field any more: the retry loop it counted was shaped for
 * transient HTTP failures. A local store failure means a broken disk or schema,
 * and `SQLITE_BUSY` — the one transient case — is absorbed by `busy_timeout`.
 */
export function describeStoreFailure(
  error: unknown,
  opts: { identifier: string }
): StoreFailureLog {
  return {
    msg: 'rate-limit store error',
    scope: opts.identifier.split(':', 1)[0] ?? '',
    errorClass: errorClassOf(error),
  };
}

export interface AuthStoreFailureLog {
  msg: 'auth rate-limit store error';
  op: 'get' | 'set' | 'consume';
  errorClass: string;
}

/**
 * Summarize a Better Auth limiter-storage failure.
 *
 * No key, deliberately. Better Auth builds it with `createRateLimitKey(ip, path)`
 * = `` `${ip}|${path}` `` (`@better-auth/core` `utils/ip`), so logging the key
 * would put the requester's IP address in the log on every failing request.
 *
 * Which operation failed and the error's class are what an outage actually
 * needs, and neither is derived from the key.
 */
export function describeAuthStoreFailure(
  error: unknown,
  op: 'get' | 'set' | 'consume'
): AuthStoreFailureLog {
  return {
    msg: 'auth rate-limit store error',
    op,
    errorClass: errorClassOf(error),
  };
}
