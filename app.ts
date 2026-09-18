/**
 * The Elysia application — built, not listening.
 *
 * Split from `server.ts` so a route can be executed without a socket. Elysia
 * runs a route from a plain `Request` (`app.handle(new Request(...))`), which
 * is what makes an in-process conformance suite possible; Hono's
 * `app.request()` has the same shape, so the seam survives a framework move.
 *
 * This file is the ONLY place that knows the framework. Every endpoint is a
 * framework-agnostic `Handler` (see `lib/http/contract.ts`) listed in
 * `routes.ts` and lifted by `toElysiaHandler`; swapping to Hono means writing
 * one more adapter and one more version of this file, and touching nothing
 * under `app/api/**` and nothing in `routes.ts`.
 */
import { REGISTERED_ROUTES, ROUTE_PREFIXES } from '@/routes';
import { errorClassOf } from '@/utils';
import { cors } from '@elysia/cors';
import { Elysia } from 'elysia';
import { auth } from '@/lib/auth';
import { betterAuthServes } from '@/lib/auth/allowed-paths';
import { BASE_ERROR_CODES } from '@/lib/auth/code-errors';
import { PUBLIC_ORIGIN } from '@/lib/env';
import { elysiaRouteConfig, toElysiaHandler } from '@/lib/http/adapters/elysia';
import { runAfterResponse } from '@/lib/http/after-response';
import {
  allowlistedPathScope,
  enforcePreAuthIpLimit,
  UNKNOWN_PREFIX_SCOPE,
} from '@/lib/http/pre-auth';
import {
  boundedBodyRequest,
  buildRequestMeta,
  declaresBodyOver,
  MAX_REQUEST_BODY_BYTES,
} from '@/lib/http/request';
import { toWebResponse } from '@/lib/http/response';
import { applyResponsePolicy } from '@/lib/http/response-policy';
import {
  allowHeader,
  createBodyCeilingLookup,
  createRouteLookup,
  toManifest,
} from '@/lib/http/route-manifest';
import { applySecurityHeaders } from '@/lib/http/security-headers';

import {
  CUSTOM_AUTH_CODE,
  HTTP_STATUS,
  MSG_BODY_TOO_LARGE,
  MSG_INTERNAL_ERROR,
  MSG_METHOD_NOT_ALLOWED,
  MSG_PAGE_NOT_FOUND,
} from '@/utils/api-messages';
import { apiError, handleApiError } from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';

/**
 * The generated route inventory. Exported because three consumers need it and
 * every one of them was previously hand-maintained or absent: the 405 boundary
 * below, the OpenAPI document, and the registration check in
 * `scripts/find-unused-files.ts`.
 *
 * @knipignore
 */
export const ROUTE_MANIFEST = toManifest(REGISTERED_ROUTES);

const lookupMethods = createRouteLookup(REGISTERED_ROUTES, ROUTE_PREFIXES);
const lookupBodyCeiling = createBodyCeilingLookup(
  REGISTERED_ROUTES,
  ROUTE_PREFIXES
);

async function localiseAuthError(response: Response): Promise<Response> {
  if (response.ok) return response;

  const cloned = response.clone();
  let body: unknown;
  try {
    body = await cloned.json();
  } catch {
    return response;
  }

  const code = (body as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !Object.hasOwn(BASE_ERROR_CODES, code))
    return response;

  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json;charset=utf-8');
  return Response.json(
    { message: BASE_ERROR_CODES[code], code: CUSTOM_AUTH_CODE },
    { status: response.status, statusText: response.statusText, headers }
  );
}

/**
 * Request start times, for `Server-Timing` and the access log.
 *
 * A `WeakMap` keyed by the request rather than a field on the framework context:
 * it needs no framework support and cannot retain an entry for a request whose
 * response was never produced.
 */
const startedAt = new WeakMap<Request, number>();

/**
 * The status actually put on the wire, recorded where the response is produced.
 *
 * `set.status` is not it: every handler here returns a native `Response`, and
 * `set.status` still reads its pre-handler default in that case — the access log
 * reported 200 for every 404 it served. `onAfterResponse` sees `responseValue`
 * for route responses but not for the ones `onError` produces, so the two
 * sources together are what cover every path.
 */
const finalStatus = new WeakMap<Request, number>();

/**
 * The single exit for a response this file produces: stamp the status, apply the
 * policy, hand it back.
 */
function finish(request: Request, response: Response): Response {
  finalStatus.set(request, response.status);
  const started = startedAt.get(request);
  return applyResponsePolicy(response, {
    durationMs: started === undefined ? undefined : performance.now() - started,
  });
}

/**
 * CORS policy as data, so the Hono example in
 * `lib/http/adapters/hono.ts.disabled` cannot drift away from it again — it
 * already had: the missing captcha header was present in both copies.
 *
 * **This is also one of the three things standing in for a CSRF token, so read it
 * as a security control and not as a browser convenience.** There is deliberately
 * no CSRF token anywhere in this application; a fourth mechanism would duplicate
 * these three:
 *
 * 1. Better Auth's own routes are origin-checked. `originCheckMiddleware`
 *    validates `Origin`/`Referer` against `trustedOrigins` on every non-GET
 *    request that carries a cookie, and `trustedOrigins` defaults to `baseURL`,
 *    which is `PUBLIC_ORIGIN`.
 * 2. The session cookie is `SameSite=Lax` — Better Auth's default, and nothing
 *    here sets `advanced.defaultCookieAttributes` to change it — so a cross-site
 *    POST/PUT/DELETE arrives with no session at all.
 * 3. Application JSON routes require exactly `application/json`
 *    (`lib/http/request.ts`, matched as a media-type essence). That is not a
 *    CORS-simple content type, so a cross-site attempt needs a preflight, and the
 *    single origin below is what answers it.
 *
 * The gap layer 3 does not cover is `multipart/form-data`, which IS CORS-simple:
 * a cross-site form can POST to an upload route with no preflight. Both such
 * routes (`app/api/upload/file/handler.ts`, `app/api/dash/media/files/handler.ts`)
 * are session-gated and layer 2 keeps the cookie off such a request; `bun run
 * smoke` asserts the 401. **Any future multipart or form-encoded route inherits
 * this gap and needs the same treatment.**
 */
const CORS_POLICY = {
  // A single trusted origin, not `*`: these endpoints are credentialed
  // (session cookie), and the browser refuses `*` with credentials anyway.
  origin: PUBLIC_ORIGIN,
  credentials: true,
  // `HEAD` is advertised because the runtime serves it from every `GET` route.
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  // `X-Captcha-Response` is not optional: `lib/captcha.ts` reads the token from
  // it and Better Auth's captcha plugin requires it on sign-in. Without it the
  // preflight still answers 204, so `curl` looks healthy while every browser
  // blocks the real request — which is exactly how it went unnoticed.
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Captcha-Response',
    'X-Maintenance-Token',
  ],
  // Without these the browser hides the backoff signal from client JS, so a
  // rate-limited UI cannot tell the user when to retry.
  exposeHeaders: ['Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
  // The plugin default is 5 seconds, which re-fires a preflight for practically
  // every cross-origin request. 10 minutes is the common browser ceiling for
  // the value actually being honoured.
  maxAge: 600,
} as const;

/** Lets shutdown honor the longest route-specific timeout. */
export const MAX_ROUTE_TIMEOUT_SECONDS = REGISTERED_ROUTES.reduce(
  (longest, route) => Math.max(longest, route.timeoutSeconds ?? 0),
  0
);

function notFound(): Response {
  return toWebResponse(
    apiError({ message: MSG_PAGE_NOT_FOUND, status: HTTP_STATUS.NOT_FOUND })
  );
}

/**
 * The 308 to the slash-free form of a path, or null if there is nothing to
 * canonicalise.
 *
 * Restores what the App Router did. Only for a path that actually exists without
 * the slash — an unknown path stays a 404 rather than becoming a redirect oracle.
 *
 * A function rather than an inline block because it is needed in two places: the
 * router's miss handler AND the OPTIONS gate, which runs before the router and
 * would otherwise answer 404 on a URL every other method redirects.
 */
function canonicalRedirect(url: URL): Response | null {
  if (url.pathname.length <= 1 || !url.pathname.endsWith('/')) return null;
  const target = url.pathname.slice(0, -1);
  if (lookupMethods(target).size === 0) return null;

  // `new Response`, not `Response.redirect`: the latter returns immutable
  // headers, which the response policy would then have to clone around.
  return new Response(null, {
    status: HTTP_STATUS.PERMANENT_REDIRECT,
    headers: { Location: target + url.search },
  });
}

// Short Host values can make Elysia route against a suffix of the real path.
const MIN_ROUTABLE_HOSTNAME_LENGTH = 4;

/**
 * 404 or 405, decided from the manifest.
 *
 * Elysia reports both as `NOT_FOUND` — measured on the pinned version — so a
 * wrong method on a known path returned 404 with the API envelope where the App
 * Router returned 405, and a client could not tell "no such path" from "wrong
 * method". The manifest is the only thing that can tell them apart.
 */
function routeMiss(pathname: string): Response {
  const methods = lookupMethods(pathname);
  if (methods.size === 0) return notFound();

  return toWebResponse({
    status: HTTP_STATUS.METHOD_NOT_ALLOWED,
    body: { success: false, message: MSG_METHOD_NOT_ALLOWED, data: null },
    headers: { Allow: allowHeader(methods) },
  });
}

const base = new Elysia({
  // Elysia's default is a permissive match that accepts both `/x` and `/x/`.
  // Two URLs for one resource split cache keys and security-rule matching; the
  // App Router answered the trailing-slash form with a 308 to the canonical
  // path, which the redirect in `onError` below restores.
  strictPath: true,
  serve: {
    // Fail a second bind instead of letting the kernel split traffic silently.
    reusePort: false,
    // Bun's default is 128 MiB, which is buffered before any per-file check can
    // run. The per-file limit stays: it is per file, this is per request.
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  },
})
  // `onRequest`, and registered BEFORE the CORS plugin. Hooks run in
  // registration order, and the plugin answers a preflight from its own
  // `onRequest` — so anything registered after it never sees an OPTIONS request.
  // This covers the two paths that never produce a route response and therefore
  // never reach `mapResponse`: the preflight short-circuit and the unmatched
  // path (both measured).
  .onRequest(({ set, request }) => {
    startedAt.set(request, performance.now());
    applySecurityHeaders(set.headers);

    const url = new URL(request.url);
    if (url.hostname.length < MIN_ROUTABLE_HOSTNAME_LENGTH)
      return finish(request, notFound());

    // The ONE ceiling every request crosses, whatever serves it.
    //
    // The reader in `withBodyPolicy` bounds the routes it reads for, and that is
    // every route in the table — but not `/api/auth/*`, which hands the raw
    // request to `auth.handler`, nor the next mount of that shape. Those
    // inherited `maxRequestBodySize` in front of captcha-holding and
    // pre-auth-limited endpoints, and nothing said so. Deciding here, from the
    // path alone, means a mount cannot opt out of the ceiling by not using the
    // reader — and cannot have it widened by the `Content-Type` its caller
    // chose.
    //
    // `Content-Length` only, because this hook must not touch the stream: the
    // body still has to reach whichever consumer is allowed to read it. A
    // chunked request declares no length, so the counting half is applied where
    // the body is actually read — `readBoundedText` for table routes,
    // `boundedBodyRequest` at the Better Auth prefix below.
    if (declaresBodyOver(request, lookupBodyCeiling(url.pathname)))
      return finish(
        request,
        toWebResponse(
          handleApiError(
            new CustomError(MSG_BODY_TOO_LARGE, HTTP_STATUS.CONTENT_TOO_LARGE)
          )
        )
      );

    // Route-aware OPTIONS. The CORS plugin answers OPTIONS on ANY path with
    // 204 (it registers its own `OPTIONS /` and `OPTIONS /*` catch-alls —
    // node_modules/@elysia/cors/dist/cjs/index.js), so capability discovery
    // reported every nonexistent path as valid. Registered before the plugin, so
    // this wins.
    //
    // The trailing-slash redirect has to be repeated here rather than left to
    // `onError`: this hook short-circuits before the router runs, so an OPTIONS
    // on the slash form never reached the canonicalisation below and answered 404
    // while every other method on the same URL answered 308 (measured). One URL
    // shape, one answer.
    if (
      request.method === 'OPTIONS' &&
      lookupMethods(url.pathname).size === 0
    ) {
      const canonical = canonicalRedirect(url);
      return finish(request, canonical ?? notFound());
    }
  })
  // Spread into mutable arrays: the plugin's option type is `string[]`, and the
  // policy above is `readonly` so nothing can mutate the shared source of truth.
  .use(
    cors({
      ...CORS_POLICY,
      methods: [...CORS_POLICY.methods],
      allowedHeaders: [...CORS_POLICY.allowedHeaders],
      exposeHeaders: [...CORS_POLICY.exposeHeaders],
    })
  )
  /**
   * The final response policy.
   *
   * Not a replacement for the `onRequest` hook above — an addition. Measured on
   * `elysia@1.4.29`: a header on a native `Response` returned by a route WINS
   * over the same key in `set.headers`, so a route (or a dependency) setting its
   * own `Content-Security-Policy` silently replaced the global one. This runs
   * last and overwrites.
   */
  .mapResponse(({ responseValue, request }) => {
    if (!(responseValue instanceof Response)) return;
    return finish(request, responseValue) as never;
  })
  /**
   * Post-response work. One wiring line, by design — everything else lives in
   * `lib/http/after-response.ts`, so a Hono move changes this line and nothing
   * else. See that module for why no audit write moves here.
   */
  .onAfterResponse(({ request, set, path, responseValue }) => {
    const started = startedAt.get(request);
    startedAt.delete(request);
    const stamped = finalStatus.get(request);
    finalStatus.delete(request);
    runAfterResponse(request, {
      method: request.method,
      path,
      status:
        stamped ??
        (responseValue instanceof Response
          ? responseValue.status
          : typeof set.status === 'number'
            ? set.status
            : 200),
      durationMs: started === undefined ? 0 : performance.now() - started,
    });
  })
  .onError(({ code, error, set, request }) => {
    // Re-applied: an error thrown inside `onRequest` itself lands here before the
    // hook above finished, so this is the only guarantee for that path.
    applySecurityHeaders(set.headers);

    if (code === 'NOT_FOUND') {
      const url = new URL(request.url);
      const canonical = canonicalRedirect(url);
      if (canonical) return finish(request, canonical);

      return finish(request, routeMiss(url.pathname));
    }

    // Anything reaching here escaped `toElysiaHandler`'s own catch — a framework
    // -level fault, not an application one. The message is never echoed: it can
    // carry internals, and `handleApiError` is the only sanctioned path for
    // turning an error into a body.
    console.error(
      JSON.stringify({
        msg: 'unhandled server error',
        code,
        errorClass: errorClassOf(error),
      })
    );
    return finish(
      request,
      toWebResponse(
        apiError({
          message: MSG_INTERNAL_ERROR,
          status: HTTP_STATUS.INTERNAL_ERROR,
        })
      )
    );
  });

/**
 * Applies the route table and the Better Auth prefix to a built instance.
 *
 * A function, not a sequence of top-level statements: this module is imported
 * for its exports, and a bare loop at module scope is a side effect a reader has
 * to go looking for. Nothing here is conditional — the returned instance is the
 * only one anything uses.
 */
function register(instance: typeof base): typeof base {
  // Every policy a route needs is a REQUIRED field on its record in `routes.ts`,
  // so a new route cannot lose its pre-auth limit or its body policy by omitting
  // an argument here.
  for (const route of REGISTERED_ROUTES)
    instance.route(
      route.method,
      route.path,
      toElysiaHandler(route),
      elysiaRouteConfig
    );

  /**
   * Better Auth, registered last and as a prefix so every explicit route above
   * wins: Elysia's router resolves static segments before wildcards (verified).
   * `parse: 'none'` keeps the body stream intact — Better Auth reads the request
   * itself.
   *
   * GET and POST only, matching what `toNextJsHandler` exported. Registering
   * every method let unsupported ones into Better Auth to consume its
   * rate-limit budget before it rejected them; they now stop at the 405
   * boundary.
   *
   * **The allowlist is enforced HERE, before `auth.handler` is called at all.**
   * `lib/auth.ts` also enforces it, in a `before` hook, and that is not the same
   * position: Better Auth runs every plugin's `onRequest` ahead of its own
   * hooks, so a path outside the list reaches the whole plugin chain before the
   * hook can reject it. A plugin that matches its endpoint list loosely then
   * acts on a path this server does not serve — the captcha plugin did exactly
   * that, spending an outbound Turnstile siteverify on an unauthenticated
   * request to an unrouted path. Deciding here removes the class; both checks
   * stay, because only this one is upstream of the plugins.
   */
  for (const prefix of ROUTE_PREFIXES) {
    // The union of every sub-path's methods. Registered from the table rather
    // than declared beside it, so a prefix cannot be mounted for a method no
    // path under it serves.
    const registered = new Set(prefix.paths.flatMap((entry) => entry.methods));
    for (const method of registered)
      instance.route(
        method,
        `${prefix.prefix}/*`,
        async ({ request }: { request: Request }) => {
          const url = new URL(request.url);
          const subPath = url.pathname.slice(prefix.prefix.length);
          // One lookup answers membership, the budget and (via
          // `betterAuthServes`) the method — all from the same record.
          const known = prefix.paths.find((path) => path.path === subPath);
          try {
            // Admission must precede Better Auth plugins that perform outbound work.
            // The allowlist decides the SCOPE, not just the budget. An
            // allowlisted path gets its OWN key — the whole sub-path, so a
            // budget declared per path is also counted per path — and
            // everything else shares ONE fixed key, so rotating
            // `/api/auth/<random>` can neither multiply the budget nor the
            // `rate_limit` keyspace.
            await enforcePreAuthIpLimit(buildRequestMeta(request), {
              limit: known?.preAuthLimit,
              scope: known
                ? allowlistedPathScope(`${prefix.prefix}${known.path}`)
                : UNKNOWN_PREFIX_SCOPE,
            });
            // Unreachable auth paths answer with this API's envelope like every
            // other unknown path, instead of Better Auth's own bodyless 404 — and
            // the trailing-slash form redirects, which the wildcard match had been
            // hiding from `onError`.
            //
            // `routeMiss`, not `notFound`: five real `ROUTES` entries sit under
            // this prefix (`/api/auth/otp/*`, `/api/auth/forgot-password/*`,
            // `/api/auth/passwordless/send`) and are not Better Auth paths, so a
            // `GET` on one falls through the `GET /api/auth/*` wildcard to here.
            // Answering 404 made the same wrong-method condition on the same path
            // give two answers depending on the method: measured, `GET
            // /api/auth/otp/send` → 404 with no `Allow` while `PUT` on it → 405
            // with `Allow: POST, OPTIONS`, because PUT is not a method this
            // wildcard is mounted for and reached `onError` instead. `routeMiss`
            // falls back to `notFound()` on an empty lookup, so a genuinely
            // unknown sub-path keeps its 404.
            if (!known)
              return canonicalRedirect(url) ?? routeMiss(url.pathname);
            // A known path under a method it does not serve is a 405 with an
            // accurate `Allow`, decided from the same table. Handing it to
            // `auth.handler` instead answered Better Auth's own 404 for
            // `GET /sign-out`, and let `GET /sign-in/email` reach the captcha
            // plugin's processing before the method was rejected.
            if (!betterAuthServes(subPath, request.method))
              return routeMiss(url.pathname);
            // Better Auth answers 404 for a HEAD on a path it serves for GET
            // (measured on 1.7.1), and Elysia dispatches HEAD to the GET
            // registration — so the substitution has to happen here or HEAD is
            // unserved on every auth path. The runtime discards the body.
            // `new Request(url, …)` is a GET; naming the method explicitly is what
            // the linter objects to, not the substitution.
            const forwarded =
              request.method === 'HEAD'
                ? new Request(request.url, { headers: request.headers })
                : // The half the `onRequest` hook cannot do. That hook refuses a
                  // body which DECLARES itself over the ceiling; a chunked request
                  // declares nothing, and Better Auth reads the body itself — so
                  // without this the captcha-holding and pre-auth-limited
                  // endpoints under this prefix would still be bounded by nothing
                  // but `maxRequestBodySize`. Same lookup as the hook, so the two
                  // halves of one ceiling cannot drift. Reading it here also makes
                  // the refusal a 413 from this file rather than whatever the
                  // library makes of a stream that errored mid-parse.
                  await boundedBodyRequest(
                    request,
                    lookupBodyCeiling(url.pathname)
                  );
            return localiseAuthError(await auth.handler(forwarded));
          } catch (error) {
            // This wildcard bypasses the adapter that normally preserves API
            // errors — the 413 `boundedBodyRequest` throws included.
            return toWebResponse(handleApiError(error));
          }
        },
        elysiaRouteConfig
      );
  }

  return instance;
}

export const app = register(base);
