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

Docs: <https://elysiajs.com/essential/validation.md>

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

---

## Outstanding portability notes

- **Cookies (handler-set):** the current `HandlerOutput` contract does not
  include an outgoing-cookie field. Better Auth cookies are managed inside
  its own handler so this does not affect existing endpoints. If a handler
  later needs to set a cookie directly (e.g. a feature flag cookie), extend
  `HandlerOutput` with a `cookies: Array<{ name, value, options }>` field
  and update all three adapters. Noted for future work.

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
