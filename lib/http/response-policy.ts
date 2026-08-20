/**
 * The last thing that touches a response.
 *
 * Why this exists as a separate step from the `onRequest` hook that also writes
 * the security headers: the hook writes into the FRAMEWORK's mutable header bag
 * (`set.headers` on Elysia), and every application handler returns a native
 * `Response`. Measured on the pinned `elysia@1.4.29`: when both carry the same
 * header key, the native response's value wins and the global policy is
 * silently dropped for that route. A route that sets its own
 * `Content-Security-Policy` — or a dependency that sets one — therefore
 * overrides the application-wide policy with no error and no log.
 *
 * So the policy is applied twice, and the two placements cover different paths:
 *
 * - the `onRequest` hook covers what never reaches a route: the CORS preflight
 *   short-circuit and the unmatched-path 404, neither of which runs
 *   `mapResponse` (measured).
 * - this function covers everything that does produce a native `Response`,
 *   including thrown errors, and it OVERWRITES rather than fills in.
 *
 * Framework-independent by construction: it takes a `Response` and returns a
 * `Response`. A Hono move rewires one line in the server file.
 */
import { DEFAULT_CACHE_CONTROL } from './response';
import { SECURITY_HEADERS } from './security-headers';

export interface ResponsePolicyOptions {
  /**
   * Wall-clock milliseconds from request admission to response, emitted as
   * `Server-Timing`. Omitted when the caller has no measurement, rather than
   * reported as zero.
   */
  durationMs?: number;
}

/**
 * Writes the response policy onto `response`, returning a response that carries
 * it.
 *
 * Mutates in place where the header guard allows it (verified: a `Response`
 * built with `new Response()` / `Response.json()` accepts `headers.set`, and
 * repeated `Set-Cookie` values survive). A response whose headers are immutable
 * — `Response.redirect()` produces one — is rebuilt instead of being silently
 * left unpoliced.
 */
export function applyResponsePolicy(
  response: Response,
  options: ResponsePolicyOptions = {}
): Response {
  try {
    write(response.headers, options);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    write(headers, options);
    // `getSetCookie` is the only way to carry repeated `Set-Cookie` values
    // through a copy; `new Headers(headers)` folds them into one comma-joined
    // line, which browsers reject.
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) {
      headers.delete('set-cookie');
      for (const cookie of cookies) headers.append('set-cookie', cookie);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

function write(headers: Headers, options: ResponsePolicyOptions): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS))
    headers.set(key, value);

  // Fill in, don't overwrite: a handler that deliberately serves a cacheable
  // body sets its own directive, and `toWebResponse` has already applied the
  // same default to everything on the envelope path.
  if (!headers.has('cache-control'))
    headers.set('cache-control', DEFAULT_CACHE_CONTROL);

  if (options.durationMs !== undefined)
    headers.set('server-timing', `app;dur=${options.durationMs.toFixed(1)}`);
}
