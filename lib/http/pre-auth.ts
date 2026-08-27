import type { HandlerRequestMeta } from './contract';

import { enforceRateLimit, ipIdentifier } from '@/lib/rate-limit';

// Coarse pre-auth limit so traffic without a valid session can't force
// repeated session lookups. Generous enough that a shared NAT egress isn't
// punished, tight enough to cap unauthenticated abuse.
export const PRE_AUTH_LIMIT = 120;
const PRE_AUTH_WINDOW_S = 60;
const PRE_AUTH_SURFACE_SEGMENTS = 2;
const PRE_AUTH_SEGMENT_MAX = 40;

/**
 * Derive a per-surface limiter scope from the request path.
 *
 * A single shared scope let unrelated workloads throttle each other: anonymous
 * forgot-password / passwordless traffic and authenticated dashboard traffic
 * from the same office NAT drew on one counter, so abuse of one surface
 * produced deterministic 429/503 on the other. Two segments after `/api` is
 * the surface granularity (`/api/dash/users/<id>` -> `preauth.dash.users`,
 * `/api/auth/forgot-password/send` -> `preauth.auth.forgot-password`) — narrow
 * enough to isolate surfaces, coarse enough that dynamic ids don't explode the
 * keyspace.
 *
 * Exported for the suite, which derives the complete set of scopes the route
 * table can produce by walking `ROUTES` through this function rather than
 * keeping a second copy of the list — a copy that had already drifted.
 */
export function preAuthScope(pathname: string): string {
  const segments = pathname
    .split('/')
    .filter(Boolean)
    .filter((segment) => segment !== 'api')
    .slice(0, PRE_AUTH_SURFACE_SEGMENTS)
    .map((segment) => segment.slice(0, PRE_AUTH_SEGMENT_MAX));
  return segments.length > 0 ? `preauth.${segments.join('.')}` : 'preauth.root';
}

/**
 * Coarse per-IP admission run before the handler on authenticated surfaces, so
 * unauthenticated traffic can't hammer the session layer.
 *
 * Fail-closed: this limiter exists specifically so unauthenticated traffic
 * can't hammer session lookup. Letting requests through on a degraded limiter
 * store would silently strip the protection it exists for, so a 503 is the
 * correct shape. Locally that now means a broken disk or schema rather than a
 * network outage, which makes failing closed more clearly right, not less.
 *
 * Lives outside any single adapter because every adapter needs it and a second
 * copy would let the two limits drift apart.
 *
 * Takes only the head of the request, deliberately: this is an ADMISSION check,
 * so it has to be callable before the body is parsed.
 */
export interface PreAuthLimitOptions {
  /**
   * Overrides `PRE_AUTH_LIMIT` for one path. Only the Better Auth prefix uses
   * it: those four paths need budgets an order of magnitude apart (a session
   * read on every dashboard navigation versus a credential submission), and
   * routing them through this function rather than a second limiter is what
   * keeps auth admission in ONE place — see `AUTH_PATH_LIMITS` in `app.ts`.
   */
  limit?: number;
  /**
   * Replaces the path-derived scope with a FIXED one.
   *
   * `preAuthScope` builds the key out of the request path, which is correct
   * only while the set of paths is bounded by the route table. It is not on a
   * wildcard prefix: an unauthenticated client rotating `/api/auth/<random>`
   * minted a NEW limiter key per request — measured, three invented paths gave
   * three distinct keys from one IP — so the limiter aggregated nothing and
   * every request wrote another row into `rate_limit`. That is the same
   * unbounded-keyspace failure the sweep ceiling is sized against.
   *
   * A caller serving a wildcard must therefore pass one fixed scope for
   * everything outside its own allowlist.
   */
  scope?: string;
}

export function enforcePreAuthIpLimit(
  ctx: Pick<HandlerRequestMeta, 'apiPath' | 'headers'>,
  options: PreAuthLimitOptions = {}
): Promise<void> {
  return enforceRateLimit({
    scope: options.scope ?? preAuthScope(ctx.apiPath),
    identifier: ipIdentifier(ctx.headers),
    limit: options.limit ?? PRE_AUTH_LIMIT,
    window: PRE_AUTH_WINDOW_S,
    failClosed: true,
  });
}

/**
 * The single bucket every unrecognised path under a wildcard prefix shares.
 *
 * Fixed, so path rotation cannot multiply either the budget or the keyspace.
 */
export const UNKNOWN_PREFIX_SCOPE = 'preauth.auth.unknown';
