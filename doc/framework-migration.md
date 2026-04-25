# Framework Migration Guide

This codebase uses a **framework-agnostic handler** architecture. The business
logic for every API endpoint lives in a `handler.ts` file that does not import
anything Next.js specific. A thin `route.ts` wrapper (in Next's App Router
format) plugs those handlers into the current framework via an **adapter**.

To switch frameworks, you replace the adapter — not the handlers.

---

## Layout

```
lib/http/
├── contract.ts                  # HandlerInput / HandlerOutput / Handler types
├── session.ts                   # requireSession / requirePermission helpers
└── adapters/
    ├── next.ts                  # ACTIVE — toNextHandler
    ├── elysia.ts.disabled       # Ready, rename to activate
    └── hono.ts.disabled         # Ready, rename to activate

app/api/<route>/
├── handler.ts                   # Pure business logic — framework-agnostic
└── route.ts                     # Thin Next.js wrapper (3–5 lines)
```

## Handler contract

Every handler receives a `HandlerInput` and returns a `HandlerOutput`:

```ts
// lib/http/contract.ts
interface HandlerInput {
  body: unknown;              // parsed JSON, or null
  query: URLSearchParams;
  params: Record<string, string>;
  headers: Headers;           // Web-standard Headers
  url: string;
  method: string;
  ip: string;
  userAgent: string | null;
  apiPath: string;
  rawRequest: Request;        // escape hatch
}

interface HandlerOutput<T = unknown> {
  status: number;
  body: { success: boolean; message: string; data: T; meta?: PaginationMeta };
  headers?: Record<string, string>;
  cookies?: Array<{
    name: string;
    value: string;
    options?: {
      path?: string; domain?: string; maxAge?: number;
      httpOnly?: boolean; secure?: boolean;
      sameSite?: 'strict' | 'lax' | 'none'; expires?: Date;
    };
  }>;
}
```

Handlers never touch `NextResponse`, `next/headers`, or any framework import.
They rely on `apiSuccess`, `apiError`, `handleApiError`, `requireJsonBody`
from `utils/api-response.ts`, all of which return plain objects.

---

## Migrating to Elysia

### 1. Install

```bash
bun add elysia @elysiajs/cors
bun remove next next-auth   # keep if the dashboard frontend stays on Next
```

### 2. Activate the adapter

```bash
mv lib/http/adapters/elysia.ts.disabled lib/http/adapters/elysia.ts
```

Uncomment the file contents.

### 3. Replace `app/api/.../route.ts` files with an Elysia server

Create `server.ts` (or `index.ts`) at the project root:

```ts
import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';

import { betterAuthPlugin, toElysiaRoute } from '@/lib/http/adapters/elysia';

import * as usersHandlers       from '@/app/api/dash/users/handler';
import * as usersIdHandlers     from '@/app/api/dash/users/[id]/handler';
import * as sessionsHandlers    from '@/app/api/dash/users/[id]/sessions/handler';
import * as changePwHandlers    from '@/app/api/dash/users/me/change-password/handler';
import * as changeEmailHandlers from '@/app/api/dash/users/me/change-email/handler';
import * as permissionsHandlers from '@/app/api/dash/permissions/handler';
import * as permissionsIdHandlers from '@/app/api/dash/permissions/[id]/handler';
import * as rolesHandlers       from '@/app/api/dash/roles/handler';
import * as otpSendHandlers     from '@/app/api/auth/otp/send/handler';
import * as otpVerifyHandlers   from '@/app/api/auth/otp/verify/handler';
import * as devSignUpHandlers   from '@/app/api/dev/sign-up/handler';

new Elysia()
  .use(cors({ origin: process.env.PUBLIC_URL, credentials: true }))
  .use(betterAuthPlugin)

  // Dashboard
  .get   ('/api/dash/users',                toElysiaRoute(usersHandlers.GET))
  .post  ('/api/dash/users',                toElysiaRoute(usersHandlers.POST))
  .get   ('/api/dash/users/:id',            toElysiaRoute(usersIdHandlers.GET))
  .put   ('/api/dash/users/:id',            toElysiaRoute(usersIdHandlers.PUT))
  .delete('/api/dash/users/:id',            toElysiaRoute(usersIdHandlers.DELETE))
  .delete('/api/dash/users/:id/sessions',   toElysiaRoute(sessionsHandlers.DELETE))
  .post  ('/api/dash/users/me/change-password', toElysiaRoute(changePwHandlers.POST))
  .post  ('/api/dash/users/me/change-email',    toElysiaRoute(changeEmailHandlers.POST))
  .get   ('/api/dash/permissions',          toElysiaRoute(permissionsHandlers.GET))
  .post  ('/api/dash/permissions',          toElysiaRoute(permissionsHandlers.POST))
  .get   ('/api/dash/permissions/:id',      toElysiaRoute(permissionsIdHandlers.GET))
  .put   ('/api/dash/permissions/:id',      toElysiaRoute(permissionsIdHandlers.PUT))
  .delete('/api/dash/permissions/:id',      toElysiaRoute(permissionsIdHandlers.DELETE))
  .get   ('/api/dash/roles',                toElysiaRoute(rolesHandlers.GET))

  // Auth
  .post  ('/api/auth/otp/send',             toElysiaRoute(otpSendHandlers.POST))
  .post  ('/api/auth/otp/verify',           toElysiaRoute(otpVerifyHandlers.POST))
  .post  ('/api/dev/sign-up',               toElysiaRoute(devSignUpHandlers.POST))

  .listen(3000);
```

> Elysia route params use `:id` while Next uses `[id]`. The handlers already
> read from `ctx.params.id`, so the filesystem layout is cosmetic — no code
> changes are needed in `handler.ts`.

### 4. Move security headers out of `next.config.js`

`next.config.js` sets CSP, HSTS, COOP, CORP, X-Frame-Options, X-Content-Type,
Referrer-Policy, Origin-Agent-Cluster, etc. Elysia does not read this file —
translate each header to an `onRequest` hook or an equivalent plugin:

```ts
.onRequest(({ set }) => {
  set.headers['Content-Security-Policy']  = CSP;     // from next.config.js
  set.headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains; preload';
  set.headers['X-Frame-Options']           = 'DENY';
  set.headers['Cross-Origin-Opener-Policy'] = 'same-origin';
  set.headers['Referrer-Policy']            = 'strict-origin';
  // ...copy the rest from next.config.js
});
```

### 5. Better Auth

`app/api/auth/[...all]/route.ts` (the `toNextJsHandler(auth.handler)` file)
is replaced by the `.mount(auth.handler)` call inside `betterAuthPlugin`.

If any route needs `{ user, session }` via Elysia's macro (rather than calling
`auth.api.getSession` inside the handler), use `.guard({ auth: true })` or
add `{ auth: true }` per route. Handlers that currently call `requireSession`
or `requirePermission` keep working without changes because they read from
`ctx.headers`.

### 6. Validation

Elysia supports Zod through Standard Schema, so existing Zod schemas work as
Elysia route validators:

```ts
import { z } from 'zod';
import { sendOtpSchema } from '@/utils/validation/otp';

.post('/api/auth/otp/send', toElysiaRoute(otpSendHandlers.POST), {
  body: sendOtpSchema,  // optional — handler already validates
})
```

Adding `body: sendOtpSchema` lets Elysia pre-validate, populate OpenAPI, and
enable Eden Treaty typing. The handler still safe-parses internally, so
removing the handler-level check is optional.

Validation covers `body`, `query`, `params`, `headers`, and `cookie`. Path and
query values are auto-coerced to the declared type (`t.Numeric()` turns a
query string into a number). In production, validation error responses omit
schema detail by default to avoid leaking the shape — enable explicit detail
only in staging/local.

Docs: <https://elysiajs.com/essential/validation.md>

### 7. Framework-specific advantages to leverage

Elysia ships a number of features that either replace current ad-hoc code or
add capabilities Next.js does not provide. Adopt them deliberately after the
mechanical migration is green:

- **Macros for session / permission resolution.** Today every `/api/dash/*`
  handler calls `requirePermission(...)` imperatively. Elysia's `.macro({
  auth: { resolve({ headers }) { ... } } })` injects `{ user, session }` into
  the route context and returns `status(401)` on miss. Combined with
  `.guard({ auth: true })` on a dashboard sub-app, this removes the session
  check from every handler body while keeping it portable — the handler
  contract already accepts headers, so migration back to Next is a matter of
  re-adding the imperative call.
  Docs: <https://elysiajs.com/patterns/macro.md>

- **Plugin encapsulation.** Elysia isolates lifecycle hooks per instance
  unless `{ as: 'scoped' | 'global' }` is declared, and de-duplicates plugins
  via the `name` field. The existing `betterAuthPlugin` uses `name:
  'better-auth'` for this reason — any new plugin (rate-limit, audit,
  security-headers) should follow the same pattern to avoid double-running
  on sub-apps.
  Docs: <https://elysiajs.com/essential/plugin.md>

- **Auto-generated OpenAPI via `@elysiajs/openapi`.** Register the plugin,
  attach Zod/Valibot schemas to routes via `body`/`query`/`params`, and
  Scalar UI is served at `/openapi` for free. Solves §10.2 in `reports/final.md`
  without a separate toolchain. Works with Better Auth's `openAPI()` plugin
  to expose auth endpoints under a "Better Auth" tag.
  Docs: <https://elysiajs.com/patterns/openapi.md>

- **Eden Treaty end-to-end typing.** Export the `Elysia` app type, pass it to
  the frontend via `treaty<typeof app>(...)`, and the dashboard client gets
  autocompletion + response narrowing with zero codegen. Replaces hand-typed
  `fetch` wrappers in the Next dashboard.
  Docs: <https://elysiajs.com/eden/overview.md>

- **Reactive cookies with signing.** `t.Cookie({ ... })` validates incoming
  cookies; `cookie.name.value = ...` sets outgoing. `secret: [new, old]`
  supports rotation. Layer this over the `HandlerOutput.cookies` channel
  when a handler needs signed cookies.
  Docs: <https://elysiajs.com/patterns/cookie.md>

- **Trace / OpenTelemetry.** Built-in `trace({ onRequest, onHandle, ... })`
  reports elapsed time per lifecycle stage with no runtime overhead in
  static mode — useful for diagnosing the `At Scale` items in the final
  report (3.1 user-list join, 2.2 in-transaction session refresh).
  Docs: <https://elysiajs.com/patterns/trace.md>

- **Server Timing plugin.** `@elysiajs/server-timing` emits `Server-Timing`
  headers per request, giving the frontend a per-stage breakdown without
  setting up a full observability stack.
  Docs: <https://elysiajs.com/plugins/server-timing.md>

- **Bun binary build for production.** `bun build --compile
  --minify-whitespace --minify-syntax` emits a single binary with 2–3× less
  memory vs. `bun run`. Skip `--minify` if OpenTelemetry stays enabled
  (function names are needed). Pair with cluster mode (SO_REUSEPORT on
  Linux) to use every core — Elysia is single-threaded per instance.
  Docs: <https://elysiajs.com/patterns/deploy.md>

- **Method-chaining type inference.** Every `.use() / .get() / .post()`
  returns a new, wider type. If `server.ts` breaks the chain (assigns
  `app.get(...)` back to `app` imperatively), Eden Treaty loses types.
  Keep route registration as one continuous chain, or use `app.as('scoped')`
  when composing sub-apps.
  Docs: <https://elysiajs.com/key-concept.md>

---

## Migrating to Hono

### 1. Install

```bash
bun add hono hono/cors hono/secure-headers
```

### 2. Activate the adapter

```bash
mv lib/http/adapters/hono.ts.disabled lib/http/adapters/hono.ts
```

Uncomment the file contents.

### 3. Server wiring

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

import { auth } from '@/lib/auth';
import { toHonoRoute } from '@/lib/http/adapters/hono';

import * as usersHandlers       from '@/app/api/dash/users/handler';
import * as usersIdHandlers     from '@/app/api/dash/users/[id]/handler';
// ... (same list as Elysia)

const app = new Hono()
  .use(cors({ origin: process.env.PUBLIC_URL!, credentials: true }))
  .use(secureHeaders());

// Better Auth — no first-class Hono integration, mount the handler manually
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

app.get   ('/api/dash/users',           toHonoRoute(usersHandlers.GET));
app.post  ('/api/dash/users',           toHonoRoute(usersHandlers.POST));
app.get   ('/api/dash/users/:id',       toHonoRoute(usersIdHandlers.GET));
// ... (repeat for every handler)

export default app;
```

Hono uses `:id` for path params, same as Elysia — no handler changes.

### 4. Security headers

`secureHeaders()` covers X-Frame-Options, X-Content-Type-Options, Referrer-
Policy, etc. CSP and HSTS must be set explicitly to match `next.config.js`:

```ts
app.use(secureHeaders({
  contentSecurityPolicy: { /* mirror next.config.js CSP */ },
  strictTransportSecurity: 'max-age=63072000; includeSubDomains; preload',
}));
```

`secureHeaders()` ships 13 defaults out of the box: removes `X-Powered-By`,
sets `Strict-Transport-Security` (max-age 15552000), `X-Content-Type-Options:
nosniff`, `X-DNS-Prefetch-Control: off`, `X-Download-Options: noopen`,
`X-Frame-Options: SAMEORIGIN`, `X-Permitted-Cross-Domain-Policies: none`,
`X-XSS-Protection: 0`, `Cross-Origin-Resource-Policy: same-origin`,
`Cross-Origin-Opener-Policy: same-origin`, `Origin-Agent-Cluster: ?1`,
`Referrer-Policy: no-referrer`. CSP, `Permissions-Policy`, and
`Cross-Origin-Embedder-Policy` must be set explicitly. Override the HSTS
`max-age` to `63072000` to match the value listed in the security baseline.
Docs: <https://hono.dev/docs/middleware/builtin/secure-headers>

### 5. Framework-specific advantages to leverage

- **RPC / `hc` client with shared types (the "Hono stack").** Export
  `export type AppType = typeof app` from the server, then
  `hc<AppType>('/api')` in the dashboard gives typed calls (`client.dash.users
  .$get()`) with zero codegen. End-to-end typing for the Next frontend even
  after the API moves off Next.
  Docs: <https://hono.dev/docs/concepts/stacks>, <https://hono.dev/docs/guides/best-practices>

- **Modular routing via `app.route()` and `basePath()`.** Split the flat
  registration shown above into feature-scoped sub-apps:

  ```ts
  const dashUsers = new Hono()
    .get('/', toHonoRoute(usersHandlers.GET))
    .post('/', toHonoRoute(usersHandlers.POST))
    .get('/:id', toHonoRoute(usersIdHandlers.GET));

  const api = new Hono().basePath('/api')
    .route('/dash/users', dashUsers)
    .route('/auth/otp', otp);
  ```

  Keeps middleware scoped to the right prefix (`app.use('/api/dash/*',
  requireAuthMiddleware)`) and makes RPC types compose cleanly.
  Docs: <https://hono.dev/docs/api/hono>

- **`factory.createHandlers()` for reusable middleware chains.** Alternative
  to `toHonoRoute` when a route needs middleware before the handler (e.g.
  rate-limit → captcha → handler). Type inference is preserved.
  Docs: <https://hono.dev/docs/guides/best-practices>

- **`bodyLimit` middleware.** Not currently enforced in Next — there is no
  global body-size cap today. After migration, apply `bodyLimit({ maxSize:
  100_000 })` to JSON routes and a larger limit to `/api/upload/image`. On
  Bun, also bump `Bun.serve({ maxRequestBodySize })` — Bun rejects >128 MiB
  before Hono sees the request.
  Docs: <https://hono.dev/docs/middleware/builtin/body-limit>

- **`contextStorage()` (AsyncLocalStorage).** Lets `lib/audit.ts`,
  `lib/rate-limit/*`, and other utilities read the request context without
  threading it through every function signature. Requires `nodejs_compat` /
  `nodejs_als` on Cloudflare Workers; works natively on Node and Bun.
  Docs: <https://hono.dev/docs/middleware/builtin/context-storage>

- **`timing` middleware.** Emits `Server-Timing` headers with per-stage
  measurements. `startTime(c, 'db')` / `endTime(c, 'db')` or `wrapTime(c,
  'db', db.query(...))`. Pair with `setMetric` for custom markers.
  Docs: <https://hono.dev/docs/middleware/builtin/timing>

- **Router selection for the deployment target.** `SmartRouter` (default)
  auto-picks RegExpRouter vs TrieRouter. For serverless/edge where the
  module reinitializes per request, `LinearRouter` skips the compile step.
  `PatternRouter` shrinks the bundle below 15 KB. Pass via
  `new Hono({ router: new LinearRouter() })`. The `/api/auth/*` wildcard
  forces SmartRouter to fall back to TrieRouter — unavoidable but harmless
  because that route runs once per auth request.
  Docs: <https://hono.dev/docs/concepts/routers>

- **`HTTPException` and `app.onError`.** The adapter already funnels thrown
  `CustomError`s through `handleApiError`, so `onError` at the Hono level is
  only needed for errors that escape the adapter (framework internals,
  middleware before the adapter runs). Register a final net:

  ```ts
  app.onError((err, c) => writeResponse(handleApiError(err), c));
  ```

  Note: `HTTPException.getResponse()` is not aware of `Context`, so if any
  middleware throws one, copy CORS/expose headers onto the resulting
  response explicitly.
  Docs: <https://hono.dev/docs/api/exception>

- **Additional built-in middleware worth enabling.** `timeout()` to cap
  long-running handlers, `etag()` for GET caching, `ipRestriction()` for
  admin-only endpoints, `cache()` for safe idempotent GETs, `logger()` with
  `pretty-json` during local dev.
  Docs: <https://hono.dev/docs/middleware/builtin/timeout>

- **Signed cookies via `setSignedCookie`.** HMAC SHA-256, async due to
  WebCrypto. Matches Elysia's signed-cookie feature. Swap the adapter's
  `setCookie` call for `setSignedCookie` when a handler emits a cookie that
  must be tamper-resistant.
  Docs: <https://hono.dev/docs/helpers/cookie>

---

## Outstanding portability notes

- **CORS:** currently enforced by `Access-Control-Allow-Origin` in
  `next.config.js`. When switching frameworks, use `@elysiajs/cors` or
  `hono/cors` and pass `process.env.PUBLIC_URL`.

- **`app/api/upload/image/`:** migrated to the same `handler.ts + route.ts`
  split, but the handler calls `ctx.rawRequest.formData()` directly because
  multipart parsing is framework-specific. When switching frameworks, the
  multipart reader works unchanged under Elysia and Hono since both preserve
  the underlying web `Request`. If Elysia/Hono offers a native multipart
  parser you prefer, swap the `rawRequest.formData()` call.

- **Security headers in `next.config.js`:** CSP, HSTS, COOP, CORP, X-Frame-
  Options, X-Content-Type-Options, Referrer-Policy, X-XSS-Protection,
  Origin-Agent-Cluster, X-DNS-Prefetch-Control, X-Permitted-Cross-Domain-
  Policies — all must be re-implemented in the new framework's middleware.

- **Rate limit behaviour:** `enforceRateLimit` now throws `CustomError(429)`
  carrying `responseHeaders` (Retry-After, X-RateLimit-*). Every adapter
  catches the error via `handleApiError` and copies those headers onto the
  response, so behaviour is identical across frameworks.

- **`ctx.rawRequest` body is single-use:** the Next adapter runs
  `safeReadJson(request)` during `buildContext` for JSON content types, which
  consumes the body stream. Any handler that later calls
  `ctx.rawRequest.json()` / `.text()` / `.formData()` on a JSON request gets
  an empty stream. Today only `upload/image` uses `rawRequest`, and multipart
  content-type skips `safeReadJson`, so the issue is latent. Fix: clone the
  request before reading (`safeReadJson(request.clone())`) or restrict
  `rawRequest` usage to `.headers` / `.url` only.

- **Elysia body-parser divergence:** the disabled Elysia adapter reads
  `ctx.body` directly from Elysia's built-in parser. Elysia rejects malformed
  JSON before the handler runs, while the Next adapter's `safeReadJson`
  returns `null` and lets `requireJsonBody` translate that to a 400. When
  activating the Elysia adapter, build `ctx.body` via the same `safeReadJson`
  helper used by Next so both frameworks deliver the same 400 on malformed
  JSON.

- **No request body-size limit on any adapter.** `safeReadJson` reads the
  entire request into memory with no cap; `app/api/upload/image` has its own
  MIME/magic-byte check but no byte ceiling. Next's App Router applies no
  implicit JSON size limit in route handlers, so this is latent today. Under
  Bun/Elysia the default `maxRequestBodySize` is 128 MiB; under Hono there
  is no limit unless `bodyLimit({ maxSize })` is applied. When activating
  either adapter, apply a coarse cap per route class: `~100 KB` for JSON
  handlers, a larger explicit limit for `upload/image`. Elysia: configure
  `parse` with a max, or reject in `onParse`. Hono: `app.use('/api/dash/*',
  bodyLimit({ maxSize: 100_000 }))`. Without this, a ~100 MB POST is
  accepted into memory before a handler rejects it.

- **Hono's `strict: true` default breaks trailing-slash URLs.** Hono by
  default treats `/api/dash/users` and `/api/dash/users/` as two different
  routes (the latter 404s). Next's App Router tolerates either. If any
  existing client — curl scripts, mobile SDKs, upstream proxies that append
  a slash — sends the trailing form, migration to Hono silently breaks
  them. Activate the adapter with `new Hono({ strict: false })`, or
  explicitly mount a trailing-slash redirect middleware. Elysia treats both
  as the same route by default, so this only affects Hono.

- **Pre-adapter errors bypass `handleApiError`.** The adapter wraps the
  handler in `try/catch`, but errors raised *before* the handler runs —
  framework router 404, malformed-JSON rejection by Elysia's built-in
  parser, `bodyLimit` overflow on Hono, middleware exceptions — never reach
  `handleApiError` and are returned in the framework's native error shape
  (`{ error: string }` on Elysia, plain-text on Hono). Clients then see two
  different JSON contracts from the same endpoint depending on which layer
  fails. Install framework-level funnels:

  ```ts
  // Elysia
  app.onError(({ error }) => handleApiError(error).body);

  // Hono
  app.onError((err, c) => writeResponse(handleApiError(err), c));
  app.notFound((c) => writeResponse(
    handleApiError(new CustomError(MSG_PAGE_NOT_FOUND, 404)), c,
  ));
  ```

  Without this, `reports/final.md` §6.1 (centralized error wrapper) is
  re-introduced at the framework boundary after migration.

- **`baseURL: process.env.NEXT_PUBLIC_URL` is Next-specific.** `lib/auth.ts`
  reads `NEXT_PUBLIC_URL` for Better Auth's `baseURL`. The `NEXT_PUBLIC_*`
  prefix convention only has meaning to Next's bundler; Bun/Node read plain
  env vars. The value still works, but the name becomes misleading once
  Next is no longer the host framework. Rename to `PUBLIC_URL` (with a
  fallback to `NEXT_PUBLIC_URL` during migration) and update the CORS
  origin reference that uses the same variable.

- **Audit logs:** `auditLog` now accepts `meta: { ip, userAgent, apiPath }`
  (built by `getAuditMeta(ctx)`) instead of a raw `Request`. The adapter
  resolves IP via the trusted-proxy precedence in `lib/audit.ts` — unchanged
  from the Next version.

---

## Checklist when adding a new endpoint

1. Create `app/api/<path>/handler.ts` exporting `Handler` functions
   (`GET`, `POST`, etc.). Never import from `next/*`.
2. Create `app/api/<path>/route.ts`:

   ```ts
   import { toNextHandler } from '@/lib/http/adapters/next';
   import * as handlers from './handler';

   export const GET  = toNextHandler(handlers.GET);
   export const POST = toNextHandler(handlers.POST);
   ```
3. When the codebase switches to Elysia or Hono, register the handler in
   `server.ts` — `handler.ts` stays untouched.
