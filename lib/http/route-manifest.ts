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
 * A route is now a record with REQUIRED policy fields. Omitting `preAuth`,
 * `auth` or `body` does not compile. The framework file iterates this list
 * instead of carrying it, so the same table survives a move to Hono, and the
 * manifest below is derived from the registrations themselves rather than
 * maintained alongside them.
 */
import type { BodyPolicy, Handler } from './contract';

/**
 * Methods this application registers. Deliberately not `string`: the 405
 * boundary advertises this set in `Allow`, and a typo would advertise a method
 * that routes nowhere.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

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
 * Which authentication refusals the handler can answer.
 *
 * Required and named for exactly the reason `preAuth` is. Nothing static can
 * derive it — the check lives inside the handler, several routes reach it
 * through a helper rather than calling `requirePermission` directly — so a route
 * that did not state it published no 401 and no 403 at all, and a generated
 * client cannot represent a refusal it was never told about.
 *
 * `permission` INCLUDES `session`: every permission check reads the session
 * first and answers 401 when there is none (`lib/permissions/checker.ts`), then
 * 403 when the grant is missing. `public` is a decision.
 */
type AuthPolicy = 'public' | 'session' | 'permission';

type ResponsePolicy = 'envelope' | 'openapi-document' | 'storage-health';

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
  auth: AuthPolicy;
  /**
   * Does the handler call `verifyTurnstileRequest`?
   *
   * Its own field rather than a fourth `auth` value, because it is a different
   * question with the same answer: a failed captcha is a 403, and it is
   * reachable on routes whose `auth` is `public` and on routes whose `auth` is
   * `session`. Folding it into `auth` would either publish 403 for routes that
   * cannot answer it or make a captcha-guarded route indistinguishable from one
   * that checks a grant.
   */
  captcha: boolean;
  /** Does the handler itself invoke the fail-closed rate limiter? */
  handlerRateLimit: boolean;
  body: BodyPolicy;
  response: ResponsePolicy;
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
   * Optional, unlike the required policies above, because it is a capacity knob and
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
  auth: AuthPolicy;
  captcha: boolean;
  handlerRateLimit: boolean;
  body: BodyPolicy;
  response: ResponsePolicy;
  query?: readonly RouteQueryParam[];
}

/** One sub-path of a prefix, with the methods that path actually answers. */
export interface RoutePrefixPath {
  /** Relative to the prefix, e.g. `/sign-out`. */
  path: string;
  methods: readonly HttpMethod[];
  /**
   * The per-IP admission budget for this path, overriding `PRE_AUTH_LIMIT`.
   *
   * REQUIRED, for the reason every policy on `RouteDefinition` is: it lived in a
   * fifth table keyed by the same four paths (`AUTH_PATH_LIMITS` in `app.ts`)
   * while registration, the 404/405 lookup, the allowlist and the published
   * document were all derived from this one — so adding a path here compiled,
   * booted and passed every test while silently taking the shared default. A
   * session read on every dashboard navigation and a credential submission need
   * budgets an order of magnitude apart, which is exactly the decision a missing
   * field hides.
   */
  preAuthLimit: number;
  /** Whether this Better Auth endpoint requires `x-captcha-response`. */
  captcha: boolean;
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
  /**
   * The exact sub-paths the prefix handler actually serves, each with its own
   * methods.
   *
   * Required, and it is the difference between an accurate boundary and a
   * misleading one — in BOTH dimensions. Treating the whole prefix as registered
   * made `PUT /api/auth/does-not-exist` answer `405 Allow: GET, POST` while
   * `GET` on the same path answered `404`. Declaring the methods once for the
   * prefix left the same over-claim in the method dimension: `GET /sign-out` was
   * advertised in `Allow` and in the document while the handler answers 404.
   */
  paths: readonly RoutePrefixPath[];
}

export function toManifest(
  routes: readonly RouteDefinition[]
): RouteManifestEntry[] {
  return routes.map(
    ({
      method,
      path,
      preAuth,
      auth,
      captcha,
      handlerRateLimit,
      body,
      response,
      query,
    }) => ({
      method,
      path,
      preAuth,
      auth,
      captcha,
      handlerRateLimit,
      body,
      response,
      query,
    })
  );
}

const DEVELOPMENT_ONLY_PREFIXES = ['/api/dev/'] as const;

/**
 * Is this path development-only — both unregistered and unpublished outside
 * development?
 *
 * One predicate for both decisions, because they are the same decision. It used
 * to filter the published DOCUMENT only, so `/api/dev/sign-up` kept a real
 * registration in production: measured with `NODE_ENV=production`, `POST`
 * answered `403` with its distinctive body, `GET` answered `405 Allow: POST,
 * OPTIONS` and `OPTIONS` answered `204`, while a genuinely unrouted
 * `/api/dev/does-not-exist` answered 404 for all three. That confirms to any
 * unauthenticated caller that the deployment carries a dev sign-up endpoint, and
 * the only thing keeping it harmless was one `NODE_ENV` string comparison inside
 * the handler — which a future `/api/dev/*` route can omit or misspell with
 * nothing failing the build, the boot or the suite.
 *
 * Also exported for the document builder's own consistency check, which
 * otherwise reads "declared but not a route" for every schema belonging to a
 * route that merely isn't PUBLISHED.
 */
export function isDevelopmentOnlyPath(path: string): boolean {
  return DEVELOPMENT_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * The routes THIS PROCESS serves.
 *
 * `ROUTES` stays the complete table — `scripts/build-openapi.ts` builds the
 * deployed document from it whatever the local `NODE_ENV` is, and
 * `scripts/find-unused-files.ts` reads it statically to prove every handler is
 * registered somewhere. This is what `app.ts` registers, looks up for the
 * 404-vs-405 boundary, and answers OPTIONS from, so outside development a
 * development-only path is genuinely unrouted rather than guarded.
 */
export function toRegisteredRoutes(
  routes: readonly RouteDefinition[],
  development = process.env.NODE_ENV === 'development'
): readonly RouteDefinition[] {
  if (development) return routes;
  return routes.filter((route) => !isDevelopmentOnlyPath(route.path));
}

/**
 * `production` is a parameter rather than a read of `NODE_ENV` alone because the
 * build generates the DEPLOYED document on a machine that is not the deployment:
 * an artefact built on a developer box must contain exactly what production
 * serves, and forcing `NODE_ENV=production` to get that would also trip
 * `assertEnv` into demanding production secrets to write a static file.
 */
export function toPublishedManifest(
  routes: readonly RouteDefinition[],
  production = process.env.NODE_ENV === 'production'
): RouteManifestEntry[] {
  const manifest = toManifest(routes);
  if (!production) return manifest;
  return manifest.filter((entry) => !isDevelopmentOnlyPath(entry.path));
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
 * `HEAD` is derived from `GET` for BOTH kinds of registration. Elysia dispatches
 * a HEAD to the matching GET route in either case (measured), so what decides
 * whether it is really served is what the handler does with it — and for the
 * Better Auth prefix that is `betterAuthServes`, which now answers HEAD from the
 * GET entry and hands `auth.handler` a GET. The two branches agreeing is the
 * point: while this one omitted HEAD, `HEAD /api/auth/get-session` was refused
 * `405` with `Allow: GET` — a boundary contradicting itself on one line.
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
      for (const sub of entry.paths)
        if (pathname === `${entry.prefix}${sub.path}`)
          for (const method of sub.methods) {
            methods.add(method);
            if (method === 'GET') methods.add('HEAD');
          }
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
