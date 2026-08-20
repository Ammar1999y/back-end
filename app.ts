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
import { ROUTE_PREFIXES, ROUTES } from '@/routes';
import { cors } from '@elysia/cors';
import { Elysia } from 'elysia';
import { auth } from '@/lib/auth';
import { PUBLIC_ORIGIN } from '@/lib/env';
import { elysiaRouteConfig, toElysiaHandler } from '@/lib/http/adapters/elysia';
import { runAfterResponse } from '@/lib/http/after-response';
import { toWebResponse } from '@/lib/http/response';
import { applyResponsePolicy } from '@/lib/http/response-policy';
import {
  allowHeader,
  createRouteLookup,
  toManifest,
} from '@/lib/http/route-manifest';
import { applySecurityHeaders } from '@/lib/http/security-headers';

import {
  HTTP_STATUS,
  MSG_INTERNAL_ERROR,
  MSG_METHOD_NOT_ALLOWED,
  MSG_PAGE_NOT_FOUND,
} from '@/utils/api-messages';
import { apiError } from '@/utils/api-response';

/**
 * The generated route inventory. Exported because three consumers need it and
 * every one of them was previously hand-maintained or absent: the 405 boundary
 * below, the OpenAPI document, and the registration check in
 * `scripts/find-unused-files.ts`.
 */
export const ROUTE_MANIFEST = toManifest(ROUTES);

const lookupMethods = createRouteLookup(ROUTES, ROUTE_PREFIXES);

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
 */
export const CORS_POLICY = {
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

/** Body big enough for the largest legitimate upload plus multipart framing. */
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

/**
 * The longest per-request ceiling any route grants itself.
 *
 * Derived, not written down twice. A shutdown that force-exits sooner than this
 * cannot honestly be called a drain: it would abort exactly the long request the
 * per-route ceiling exists to permit. `server.ts` sizes its forced shutdown from
 * this value, so raising a route's `timeoutSeconds` raises the shutdown bound
 * with it instead of silently invalidating it.
 */
export const MAX_ROUTE_TIMEOUT_SECONDS = ROUTES.reduce(
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
    // Elysia defaults this to `true`, so two processes both bind the port and
    // the kernel splits traffic between them instead of the second failing with
    // EADDRINUSE (measured, both defaults confirmed at
    // node_modules/elysia/dist/adapter/bun/index.js:166-167). Each process opens
    // its own SQLite files, so the rate-limit counters silently halve during an
    // accidental double-start — no error, no log, half the protection.
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
    if (request.method === 'OPTIONS') {
      const url = new URL(request.url);
      if (lookupMethods(url.pathname).size === 0) {
        const canonical = canonicalRedirect(url);
        return finish(request, canonical ?? notFound());
      }
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
  .mapResponse(({ response, request }) => {
    if (!(response instanceof Response)) return;
    return finish(request, response) as never;
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
        errorClass: (error as { name?: string })?.name ?? 'Unknown',
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
  for (const route of ROUTES)
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
   * position: Better Auth runs plugin `onRequest` handlers ahead of its own hooks,
   * so a path outside the list still reached the captcha plugin first. That
   * plugin matches its endpoint list with `pathname.includes(...)` — read in
   * `node_modules/better-auth/dist/plugins/captcha/index.mjs` — so ANY path
   * containing `sign-in/email` matched. Measured: `/api/auth/zz/sign-in/email/zz`
   * answered `400 Missing CAPTCHA response` instead of 404, and supplying a token
   * makes it perform an outbound Turnstile siteverify for a path this server does
   * not serve — unauthenticated, attacker-triggerable spend against the Turnstile
   * quota. Checking first removes the whole class rather than that one plugin.
   *
   * The `before` hook stays. It is defence in depth, and it is what protects any
   * future caller that reaches `auth.handler` by another route.
   */
  for (const prefix of ROUTE_PREFIXES)
    for (const method of prefix.methods)
      instance.route(
        method,
        `${prefix.prefix}/*`,
        ({ request }: { request: Request }) => {
          const url = new URL(request.url);
          const subPath = url.pathname.slice(prefix.prefix.length);
          if (prefix.paths.includes(subPath)) return auth.handler(request);
          // Unreachable auth paths now answer with this API's envelope like every
          // other unknown path, instead of Better Auth's own bodyless 404 — and
          // the trailing-slash form redirects, which the wildcard match had been
          // hiding from `onError`.
          return canonicalRedirect(url) ?? notFound();
        },
        elysiaRouteConfig
      );

  return instance;
}

export const app = register(base);
