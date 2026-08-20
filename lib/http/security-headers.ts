/**
 * Response security headers, ported from the `headers()` block that used to
 * live in `next.config.js`.
 *
 * Two deliberate differences from that block, both because this server now
 * serves ONLY a JSON API:
 *
 * 1. **The CSP is `default-src 'none'`.** The Next CSP enumerated `script-src`
 *    (with an inline hash), `style-src`, `font-src`, `img-src`, `frame-src`,
 *    `worker-src` and friends for a front-end this repository does not contain.
 *    On a JSON API those directives grant nothing and hide the one thing that
 *    matters — that a response should never be treated as a document. Denying
 *    every fetch directive by default says exactly that, and keeps
 *    `frame-ancestors` / `base-uri` / `form-action` locked as before.
 *
 * 2. **They apply in development too.** The Next block emitted NOTHING outside
 *    production, so every local request exercised a different response than the
 *    deployed one and no header bug could surface until deploy. HSTS is the one
 *    exception and stays production-only, because a `Strict-Transport-Security`
 *    header on `http://localhost` pins the whole host to HTTPS in the
 *    developer's browser — including unrelated projects on other ports.
 *
 * Also dropped, deliberately: the static `Access-Control-Allow-Origin` header.
 * A hand-written ACAO answers no preflight and carries no `Vary: Origin`, so it
 * was never a working CORS configuration. `@elysia/cors` in `app.ts` does
 * that job now. The `Cache-Control` rules for `/_next/static`, `/pwa`, `/public`
 * and friends are gone with the asset routes they described — this server has
 * no static files.
 */

const isProduction = process.env.NODE_ENV === 'production';

const CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze(
  {
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    // Not for PDF responses — see the note this replaces in next.config.js.
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
    // Disables the legacy, buggy XSS auditor rather than enabling it.
    'X-XSS-Protection': '0',
    'Origin-Agent-Cluster': '?1',
    'X-DNS-Prefetch-Control': 'off',
    'X-Permitted-Cross-Domain-Policies': 'none',
    ...(isProduction && {
      'Strict-Transport-Security':
        'max-age=63072000; includeSubDomains; preload',
    }),
  }
);

/**
 * Writes the header set onto a framework's mutable header bag.
 *
 * Assign, don't overwrite the bag: the CORS plugin and the route handler have
 * already written to it by the time this runs, and replacing it would drop
 * `Access-Control-Allow-Origin` and `Vary`.
 */
export function applySecurityHeaders(
  target: Record<string, string | number | undefined>
): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS))
    target[key] = value;
}
