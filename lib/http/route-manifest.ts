/**
 * The route table as DATA, and everything derived from it.
 *
 * Three separate defects shared one root cause — a route table that existed
 * only as a sequence of framework calls:
 *
 * 1. The security-relevant `preAuthIpLimit` option was an optional argument
 *    repeated at every call site, so a new dashboard route was one forgotten
 *    argument away from losing pre-auth protection, with no type error and no
 *    test failure.
 * 2. Nothing could answer "is this path registered under a different method?",
 *    so a wrong method on a known path returned 404 where the App Router
 *    returned 405.
 * 3. The route inventory was hand-counted, and the counts were wrong.
 *
 * A route is now a record with REQUIRED policy fields. Omitting `preAuth` or
 * `body` does not compile. The framework file iterates this list instead of
 * carrying it, so the same table survives a move to Hono, and the manifest
 * below is derived from the registrations themselves rather than maintained
 * alongside them.
 */
import type { BodyPolicy, Handler } from './contract';

/**
 * Methods this application registers. Deliberately not `string`: the 405
 * boundary advertises this set in `Allow`, and a typo would advertise a method
 * that routes nowhere.
 */
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * What `Allow` may name: the registered methods, plus `HEAD` where the runtime
 * actually serves it.
 *
 * A separate type from `HttpMethod` because `HEAD` is never registered — it is
 * derived — and a route table entry must not be able to declare it.
 */
export type AdvertisedMethod = HttpMethod | 'HEAD';

/**
 * Whether the coarse per-IP admission limit runs before the handler.
 *
 * Required on every route, and named rather than boolean, so the reader of a
 * route line sees which of the two it is instead of inferring it from a missing
 * argument. `none` is a decision; a missing option was an accident.
 */
type PreAuthPolicy = 'ip-limit' | 'none';

/**
 * A query-string parameter a route reads, for the OpenAPI contract.
 *
 * Declared here rather than inferred, because a query parameter is invisible to
 * every other artefact: the path carries `:params`, `body` carries the payload,
 * and a value read from `ctx.query` appeared in no contract at all. That was
 * tolerable while every such parameter was optional — `limit`, `cursor`, `deep`
 * only refine a request that works without them — and stopped being tolerable
 * when the upload route grew a REQUIRED one. A client cannot guess a parameter it
 * must send.
 */
interface RouteQueryParam {
  name: string;
  required: boolean;
  /** One line, shown in the generated document. */
  description: string;
  /** Closed value set, when there is one. */
  enum?: readonly string[];
}

export interface RouteDefinition {
  method: HttpMethod;
  /** Framework-neutral path with `:name` params, e.g. `/api/dash/users/:id`. */
  path: string;
  handler: Handler;
  preAuth: PreAuthPolicy;
  body: BodyPolicy;
  /**
   * Query parameters this route reads. Optional, and absent means "none that can
   * be enumerated" rather than "none": the data-table routes consume the whole
   * query string as an open filter DSL (`db/queries/data-table.ts` reads
   * `searchParams.entries()` wholesale), so their surface is not a fixed list and
   * is deliberately left undeclared.
   */
  query?: readonly RouteQueryParam[];
  /**
   * Raises this request's idle timeout above the server-wide ceiling.
   *
   * Optional, unlike the two policies above, because it is a capacity knob and
   * not a security control: forgetting it costs a dropped connection on one
   * slow route, not a missing check. Only routes that legitimately outlast the
   * global ceiling set it — see the upload route.
   */
  timeoutSeconds?: number;
}

/** The policy half of a route — everything except the handler function. */
export interface RouteManifestEntry {
  method: HttpMethod;
  path: string;
  preAuth: PreAuthPolicy;
  body: BodyPolicy;
  query?: readonly RouteQueryParam[];
}

/**
 * A path prefix served by a handler that owns its own sub-routing.
 *
 * Better Auth is the only one. It is not a `RouteDefinition` because it is not
 * a project `Handler`: it takes the raw `Request` and routes internally. It
 * still has to appear in the manifest, or the 405 boundary would answer 404 for
 * a wrong method under `/api/auth/*`.
 */
export interface RoutePrefix {
  /** Prefix WITHOUT the trailing wildcard, e.g. `/api/auth`. */
  prefix: string;
  methods: readonly HttpMethod[];
  /**
   * The exact sub-paths the prefix handler actually serves, relative to
   * `prefix` (e.g. `/sign-out`).
   *
   * Required, and it is the difference between an accurate boundary and a
   * misleading one. Treating the whole prefix as registered made
   * `PUT /api/auth/does-not-exist` answer `405 Allow: GET, POST` while
   * `GET` on the same path answered `404` — the boundary claimed a path existed
   * that the handler itself rejects. Better Auth's reachable surface is a fixed
   * allowlist, so the boundary can and should be exact.
   */
  paths: readonly string[];
}

export function toManifest(
  routes: readonly RouteDefinition[]
): RouteManifestEntry[] {
  return routes.map(({ method, path, preAuth, body, query }) => ({
    method,
    path,
    preAuth,
    body,
    query,
  }));
}

/**
 * Compiles a `:param` path into an anchored matcher.
 *
 * A param matches one segment and never a `/`, so `/api/dash/users/:id` cannot
 * match `/api/dash/users/a/b`. Everything else in the path is escaped, so a
 * literal `.` in a future path is not a wildcard.
 */
function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? '[^/]+'
        : segment.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
    )
    .join('/');
  // eslint-disable-next-line security/detect-non-literal-regexp -- `path` comes from the route table in routes.ts, never from a request, and every non-param segment is escaped above
  return new RegExp(`^${source}$`);
}

/**
 * Answers "which methods does this pathname actually answer?" for the 404-vs-405
 * boundary and for route-aware OPTIONS handling.
 *
 * Elysia does not distinguish the two cases itself — measured on the pinned
 * version, a wrong method on a registered path and a genuinely unknown path
 * both arrive as `NOT_FOUND` — so the answer has to come from here.
 *
 * `HEAD` is decided HERE rather than in `allowHeader`, because only this function
 * knows which kind of registration matched, and the runtime treats the two
 * differently. Measured: Elysia derives `HEAD` from a `GET` route in the table
 * (`HEAD /api/health/storage` → 200) but NOT from the Better Auth wildcard
 * (`HEAD /api/auth/get-session` → 404 while `GET` → 200). Synthesising `HEAD`
 * from `GET` unconditionally therefore made `Allow: GET, POST, HEAD, OPTIONS` on
 * every auth path advertise a method the handler answers 404 for — the same
 * over-claiming boundary that `RoutePrefix.paths` fixed in the PATH dimension,
 * surviving in the METHOD dimension.
 */
export function createRouteLookup(
  routes: readonly RouteDefinition[],
  prefixes: readonly RoutePrefix[] = []
): (pathname: string) => Set<AdvertisedMethod> {
  const compiled = routes.map((route) => ({
    matcher: compile(route.path),
    method: route.method,
  }));

  return (pathname: string) => {
    const methods = new Set<AdvertisedMethod>();
    for (const entry of compiled)
      if (entry.matcher.test(pathname)) {
        methods.add(entry.method);
        if (entry.method === 'GET') methods.add('HEAD');
      }
    for (const entry of prefixes)
      if (entry.paths.some((path) => pathname === `${entry.prefix}${path}`))
        for (const method of entry.methods) methods.add(method);
    return methods;
  };
}

/**
 * The `Allow` header value for a path that has registrations.
 *
 * `OPTIONS` is added because the CORS layer answers it on every known path.
 * `HEAD` is not added here — see `createRouteLookup`, which is the only place
 * that can tell whether the runtime really serves it for this path.
 */
export function allowHeader(methods: ReadonlySet<AdvertisedMethod>): string {
  const advertised = new Set<string>(methods);
  advertised.add('OPTIONS');
  return [...advertised].join(', ');
}
