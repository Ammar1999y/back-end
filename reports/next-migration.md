# Next.js source archive and rollback/port reference

The Next.js App Router layer was retained as commented-out files after the
Elysia migration (`docs/framework-migration.md`) so a rollback would have been
an uncomment. Those files have since been deleted. This report is what replaces
them: real code lifted from the files before they were deleted, plus a corrected
map of how to roll back to Next.js or port on to Hono without them.

This report does not restate `docs/framework-migration.md` — it is a companion,
written to survive after that document's source references
(`lib/http/adapters/next.ts`, the 22 `app/api/**/route.ts` files) are gone. It
also corrects one claim in that document's §5 that no longer holds — see the
next section.

## Why this report exists instead of commented source

`docs/framework-migration.md` §5 says: "The Next adapter as commented out still
calls the old inline helpers, so it works as-is." That was true when written. It
was not true by the time the file was deleted: `lib/http/adapters/next.ts` no
longer type-checked against the `HandlerInput` contract that existed at that
point, so uncommenting it was never going to be a working rollback by the time
anyone needed one. (The contract has changed again since — see the note below
the `buildContext` quote.)

At the time the Next source was commented out, `lib/http/contract.ts` declared
`formData` as a **required** member of `HandlerInput` (no `?`) — past tense, and
the tense is the point: `HandlerInput` has carried neither `body` nor `formData`
since the lazy-reader change, only `readJson()` and `readFormData()`. The quote
below is the contract as it was, kept because it is what makes the
uncomment-is-not-a-rollback argument concrete, not a description of the code
today. The current contract is in "The new adapter", § 7.

```ts
export interface HandlerInput {
  // ...
  /**
   * Parsed multipart form, or null when the request was not
   * `multipart/form-data`.
   *
   * Parsed by the adapter rather than by the handler, because reading it from
   * `rawRequest` is not portable: a web `Request` body can be read once, and
   * every framework other than Next consumes it in its own parser first — on
   * Elysia `rawRequest.formData()` throws `Body has already been used`, which a
   * `.catch` at the call site silently turns into "no files".
   */
  formData: FormData | null;
  // ...
}
```

The commented `buildContext` in `lib/http/adapters/next.ts` predates that field
and never sets it:

```ts
// async function buildContext(...): Promise<HandlerInput> {
//   ...
//   return {
//     body,
//     query: url.searchParams,
//     params: params ?? {},
//     headers: request.headers,
//     url: request.url,
//     method: request.method,
//     ip: getClientIp(request.headers) ?? '',
//     userAgent: request.headers.get('user-agent'),
//     apiPath: url.pathname,
//     rawRequest: request,
//   };
// }
```

`formData` is the only field missing — every other `HandlerInput` field is
present. Uncommented as-is, this function returns an object literal missing a
required property against an explicit `Promise<HandlerInput>` return annotation:
`tsc` rejects it ("Property 'formData' is missing in type '{...}' but required
in type 'HandlerInput'"). Uncommenting the file is therefore not a rollback
step, it is a compile error. § 7 below targets the current shared modules
instead, which already produce a conformant `HandlerInput`.

**The contract above is a snapshot from the moment `next.ts` was deleted, not
the current one.** `HandlerInput` has changed again since: there is no
`formData` field any more, and no eager `body` field either. It now exposes two
lazy, memoised methods instead — `readJson(): Promise<unknown>` and
`readFormData(): Promise<FormData | null>` (`lib/http/contract.ts`) — each gated
by the route's declared `body` policy (`BodyPolicy`,
`'none' | 'json' | 'multipart'`, also in `lib/http/contract.ts`). Nothing in the
adapter layer reads a body byte any more; the handler calls a reader itself,
after its own admission checks. The proposed Next adapter under "If you port
back to Next.js" below is written against this current shape, not the `formData`
one quoted above.

## The Next adapter, verbatim

Full contents of `lib/http/adapters/next.ts`, reproduced with the comment
markers stripped so it reads as real code. Nothing else changed: doc comments,
naming, and logic are exactly as they exist in the file right now.

```ts
import type { Handler, HandlerInput, HandlerOutput } from '../contract';

import { NextResponse } from 'next/server';
import { getClientIp } from '@/lib/audit';
import { enforceRateLimit, ipIdentifier } from '@/lib/rate-limit';

import { handleApiError } from '@/utils/api-response';

// Coarse pre-auth limit so traffic without a valid session can't force
// repeated session lookups. Generous enough that a shared NAT egress isn't
// punished, tight enough to cap unauthenticated abuse.
const PRE_AUTH_LIMIT = 120;
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
 */
function preAuthScope(pathname: string): string {
  const segments = pathname
    .split('/')
    .filter(Boolean)
    .filter((segment) => segment !== 'api')
    .slice(0, PRE_AUTH_SURFACE_SEGMENTS)
    .map((segment) => segment.slice(0, PRE_AUTH_SEGMENT_MAX));
  return segments.length > 0 ? `preauth.${segments.join('.')}` : 'preauth.root';
}

/**
 * Lifts a framework-agnostic `Handler` into a Next.js App Router handler.
 *
 * Handles:
 *   - building HandlerInput from the Next `Request` and route `params`
 *   - JSON body parsing (null on parse failure — handlers decide if required)
 *   - catching thrown errors and converting to HandlerOutput via `handleApiError`
 *   - serialising HandlerOutput to NextResponse with proper headers
 *
 * When `opts.preAuthIpLimit` is true, a coarse per-IP rate limit runs before
 * the handler. Use it on authenticated surfaces (e.g. /api/dash/*) so that
 * unauthenticated traffic can't hammer the session layer.
 */
export function toNextHandler(
  handler: Handler,
  opts?: { preAuthIpLimit?: boolean }
) {
  return async (
    request: Request,
    context?: { params?: Promise<Record<string, string>> }
  ): Promise<NextResponse> => {
    try {
      const ctx = await buildContext(request, context);
      if (opts?.preAuthIpLimit) {
        // Fail-closed: this limiter exists specifically so unauthenticated
        // traffic can't hammer session lookup. Letting requests through on
        // a degraded limiter store would silently strip the protection it
        // exists for, so a 503 is the correct shape. Locally that now means a
        // broken disk or schema rather than a network outage, which makes
        // failing closed more clearly right, not less.
        await enforceRateLimit({
          scope: preAuthScope(ctx.apiPath),
          identifier: ipIdentifier(ctx.headers),
          limit: PRE_AUTH_LIMIT,
          window: PRE_AUTH_WINDOW_S,
          failClosed: true,
        });
      }
      const output = await handler(ctx);
      return toNextResponse(output);
    } catch (error) {
      return toNextResponse(handleApiError(error));
    }
  };
}

async function buildContext(
  request: Request,
  context?: { params?: Promise<Record<string, string>> }
): Promise<HandlerInput> {
  const url = new URL(request.url);
  const params = context?.params ? await context.params : {};
  const body = await safeReadJson(request);

  return {
    body,
    query: url.searchParams,
    params: params ?? {},
    headers: request.headers,
    url: request.url,
    method: request.method,
    ip: getClientIp(request.headers) ?? '',
    userAgent: request.headers.get('user-agent'),
    apiPath: url.pathname,
    rawRequest: request,
  };
}

/**
 * Reads JSON body without throwing. Returns null when:
 *   - method cannot have a body (GET/HEAD)
 *   - body is empty
 *   - body is malformed (handlers that require a body call `requireJsonBody`)
 */
async function safeReadJson(request: Request): Promise<unknown> {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return null;

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return null;

  try {
    const text = await request.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toNextResponse(output: HandlerOutput): NextResponse {
  const response = NextResponse.json(output.body, { status: output.status });
  if (output.headers) {
    for (const [key, value] of Object.entries(output.headers)) {
      response.headers.set(key, value);
    }
  }
  if (output.cookies) {
    for (const cookie of output.cookies) {
      const { extraFlags, extra, ...nativeOptions } = cookie.options ?? {};
      response.cookies.set({
        name: cookie.name,
        value: cookie.value,
        ...nativeOptions,
      });

      // NextResponse.cookies has no slot for unmodelled attributes; append them
      // to the existing Set-Cookie line so Partitioned / Priority / etc. survive.
      const flags = extraFlags ?? [];
      const extraAttributes = Object.entries(extra ?? {});
      if (flags.length > 0 || extraAttributes.length > 0) {
        const setCookieValues = response.headers.getSetCookie();
        const lastIdx = setCookieValues.length - 1;
        let line = setCookieValues[lastIdx];
        if (line !== undefined) {
          for (const flag of flags) line += `; ${flag}`;
          for (const [k, v] of extraAttributes) line += `; ${k}=${v}`;
          setCookieValues[lastIdx] = line;
          response.headers.delete('set-cookie');
          for (const v of setCookieValues)
            response.headers.append('set-cookie', v);
        }
      }
    }
  }
  return response;
}
```

A second, independent reason not to uncomment this file even if the `formData`
gap were patched: `toNextResponse`'s cookie loop re-implements attribute
serialisation (`extraFlags`, `extra`, the manual `Set-Cookie` line rebuild) that
now lives once, centrally, in `serializeSetCookie` (`lib/http/contract.ts`) and
is used via `toWebResponse` (`lib/http/response.ts`). Patching only the type
error would leave two copies of cookie serialisation free to drift. § 7 below
writes the adapter against the shared modules instead, which is the same
conclusion `docs/framework-migration.md` §5 already reaches for a Hono port
("prefer rewriting it against the shared modules instead of keeping two copies
of the body parser") — it just hadn't been applied back to its own Next.js
rollback step.

## Per-route method exports

Counts below are grepped, not hand-counted. Commands, run from the repo root:

```bash
# route files
find app/api -name "route.ts" | wc -l
# → 22

# handler modules the routes wire up (app/api/**/handler.ts)
find app/api -name "handler.ts" | wc -l
# → 21

# explicit HTTP-method exports across every route.ts: `toNextHandler` wiring
# AND the hand-rolled `export async function GET/POST` endpoints, commented
# or not
grep -rEn "^// export (const (GET|POST|PUT|DELETE|PATCH) =|async function (GET|POST|PUT|DELETE|PATCH))" app/api --include=route.ts | wc -l
# → 28

# the Better Auth catch-all — destructured, not an individual
# `export const METHOD =`, so counted separately
grep -n "toNextJsHandler" "app/api/auth/[...all]/route.ts"
# → // export const { GET, POST } = toNextJsHandler(auth.handler);   (+2 methods)

# preAuthIpLimit: true occurrences, for cross-check against the table below
grep -ro "preAuthIpLimit: true" app/api --include=route.ts | wc -l
# → 21 (across 14 files)
```

**Totals:** 22 route files · 21 handler modules · 28 explicit method exports ·
**30 total HTTP methods bound under `app/api/**`** once the Better Auth
`{ GET, POST }` pair is added to the 28.

The one route file with no `handler.ts` is the Better Auth catch-all
(`app/api/auth/[...all]/route.ts`) — it calls `auth.handler` directly, so there
is no local handler module to count. All other 21 route files have a 1:1
`handler.ts`.

| Route file                                           | Methods exported | `{ preAuthIpLimit: true }`                                    |
| ---------------------------------------------------- | ---------------- | ------------------------------------------------------------- |
| `app/api/auth/[...all]/route.ts`                     | GET, POST        | n/a — Better Auth's own routing/security, not `toNextHandler` |
| `app/api/auth/forgot-password/reset/route.ts`        | POST             | yes                                                           |
| `app/api/auth/forgot-password/send/route.ts`         | POST             | yes                                                           |
| `app/api/auth/otp/send/route.ts`                     | POST             | no                                                            |
| `app/api/auth/otp/verify/route.ts`                   | POST             | no                                                            |
| `app/api/auth/passwordless/send/route.ts`            | POST             | yes                                                           |
| `app/api/dash/permissions/route.ts`                  | GET, POST        | yes                                                           |
| `app/api/dash/permissions/[id]/route.ts`             | GET, PUT, DELETE | yes                                                           |
| `app/api/dash/roles/route.ts`                        | GET              | yes                                                           |
| `app/api/dash/users/route.ts`                        | GET, POST        | yes                                                           |
| `app/api/dash/users/[id]/route.ts`                   | GET, PUT, DELETE | yes                                                           |
| `app/api/dash/users/[id]/sessions/route.ts`          | GET, DELETE      | yes                                                           |
| `app/api/dash/users/me/change-email/route.ts`        | POST             | yes                                                           |
| `app/api/dash/users/me/change-email/verify/route.ts` | POST             | yes                                                           |
| `app/api/dash/users/me/change-password/route.ts`     | POST             | yes                                                           |
| `app/api/dash/users/me/change-phone/route.ts`        | POST             | yes                                                           |
| `app/api/dash/users/me/change-phone/verify/route.ts` | POST             | yes                                                           |
| `app/api/dev/email-test/fixed/route.ts`              | GET              | n/a — hand-rolled `NextResponse`, never used `toNextHandler`  |
| `app/api/dev/sign-up/route.ts`                       | POST             | no                                                            |
| `app/api/health/storage/route.ts`                    | GET              | n/a — hand-rolled `Response.json`, never used `toNextHandler` |
| `app/api/internal/sqlite-sweep/route.ts`             | POST             | n/a — hand-rolled `Response.json`, never used `toNextHandler` |
| `app/api/upload/image/route.ts`                      | POST             | no                                                            |

Every file with more than one method applies the same `preAuthIpLimit` value to
all of its methods — there is no file that splits `true`/`false` across its own
exports.

Two canonical route-file shapes, both copied verbatim (comment markers stripped)
from the files above. The plain shape (21 of 22 files; example is
`app/api/auth/forgot-password/reset/route.ts`):

```ts
import { toNextHandler } from '@/lib/http/adapters/next';

import * as handlers from './handler';

export const POST = toNextHandler(handlers.POST, { preAuthIpLimit: true });
```

The catch-all shape (`app/api/auth/[...all]/route.ts`, the only file of the 22
that doesn't fit the plain shape):

```ts
import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth';

export const { GET, POST } = toNextJsHandler(auth.handler);
```

One historical note relevant to § 7: in the frozen commented-out source, three
route files — `dev/email-test/fixed`, `health/storage`, `internal/sqlite-sweep`
— never fit the plain shape either. Their logic was inline, hand-rolled against
`NextResponse.json` / `Response.json`, not routed through `toNextHandler` or a
`./handler` import. The Elysia migration extracted that inline logic into
`handler.ts` modules for all three (unchanged in spirit, now typed as `Handler`
and returning the envelope via `apiRaw`/`apiError`/`apiSuccess`) so that
`server.ts` could wire them exactly like every other route. A future Next.js
port inherits this simplification for free: all 21 handler-backed routes,
including these three, now fit the one-line plain shape above — none of them
need the old hand-rolled response code back.

## Mapping old routes to the current Elysia table

`app.ts` is the only file that knows the framework — not `server.ts`, which
validates the runtime and owns `listen`/shutdown and registers nothing. Every
row below is either an explicit `instance.route(...)` in `app.ts`'s loop over
`ROUTES` (`routes.ts`) or, for Better Auth, one of the per-method `/api/auth/*`
registrations from `ROUTE_PREFIXES` at the end of that loop. There is no
`.all(...)` anywhere.

| Next route (file-system path)            | Method(s)                  | Elysia path                              | Note                                                                                                                                                                                                                |
| ---------------------------------------- | -------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/auth/forgot-password/reset`        | POST                       | `/api/auth/forgot-password/reset`        | —                                                                                                                                                                                                                   |
| `/api/auth/forgot-password/send`         | POST                       | `/api/auth/forgot-password/send`         | —                                                                                                                                                                                                                   |
| `/api/auth/otp/send`                     | POST                       | `/api/auth/otp/send`                     | —                                                                                                                                                                                                                   |
| `/api/auth/otp/verify`                   | POST                       | `/api/auth/otp/verify`                   | —                                                                                                                                                                                                                   |
| `/api/auth/passwordless/send`            | POST                       | `/api/auth/passwordless/send`            | —                                                                                                                                                                                                                   |
| `/api/dash/permissions`                  | GET, POST                  | `/api/dash/permissions`                  | —                                                                                                                                                                                                                   |
| `/api/dash/permissions/[id]`             | GET, PUT, DELETE           | `/api/dash/permissions/:id`              | `[id]` → `:id`                                                                                                                                                                                                      |
| `/api/dash/roles`                        | GET                        | `/api/dash/roles`                        | —                                                                                                                                                                                                                   |
| `/api/dash/users`                        | GET, POST                  | `/api/dash/users`                        | —                                                                                                                                                                                                                   |
| `/api/dash/users/[id]`                   | GET, PUT, DELETE           | `/api/dash/users/:id`                    | `[id]` → `:id`                                                                                                                                                                                                      |
| `/api/dash/users/[id]/sessions`          | GET, DELETE                | `/api/dash/users/:id/sessions`           | `[id]` → `:id`                                                                                                                                                                                                      |
| `/api/dash/users/me/change-email`        | POST                       | `/api/dash/users/me/change-email`        | registered before `/api/dash/users/:id` so the static segment wins over the dynamic one                                                                                                                             |
| `/api/dash/users/me/change-email/verify` | POST                       | `/api/dash/users/me/change-email/verify` | same                                                                                                                                                                                                                |
| `/api/dash/users/me/change-password`     | POST                       | `/api/dash/users/me/change-password`     | same                                                                                                                                                                                                                |
| `/api/dash/users/me/change-phone`        | POST                       | `/api/dash/users/me/change-phone`        | same                                                                                                                                                                                                                |
| `/api/dash/users/me/change-phone/verify` | POST                       | `/api/dash/users/me/change-phone/verify` | same                                                                                                                                                                                                                |
| `/api/upload/image`                      | POST                       | `/api/upload/image`                      | —                                                                                                                                                                                                                   |
| `/api/health/storage`                    | GET                        | `/api/health/storage`                    | —                                                                                                                                                                                                                   |
| `/api/internal/sqlite-sweep`             | POST                       | `/api/internal/sqlite-sweep`             | —                                                                                                                                                                                                                   |
| `/api/dev/sign-up`                       | POST                       | `/api/dev/sign-up`                       | dev-only, marked for removal in production (`TODO` in `routes.ts`)                                                                                                                                                  |
| `/api/dev/email-test/fixed`              | GET                        | `/api/dev/email-test/fixed`              | same                                                                                                                                                                                                                |
| `/api/auth/[...all]`                     | GET, POST, … (all methods) | `/api/auth/*`                            | `[...all]` (Next optional catch-all) → Elysia wildcard `*`; registered LAST in `app.ts`, once per method in `ROUTE_PREFIXES`, so every explicit route above wins — Elysia resolves static segments before wildcards |

Every route path is otherwise byte-identical between the two file-system
layouts; the only shape change anywhere in the table is Next's bracket
dynamic-segment syntax becoming Elysia's colon syntax, and the optional
catch-all becoming a plain wildcard.

## Next-only configuration that was dropped

`next.config.js` was deleted along with the route files — before deletion it was
retained in the same commented, banner-marked state they were. Walking it top to
bottom, as it read before deletion:

### `logging.fetches` (full outgoing fetch URL logging)

```js
logging: {
  fetches: {
    fullUrl: true,
  },
},
```

Next instrumented `fetch()` calls made from server code and, with this flag,
logged the complete outgoing URL rather than a truncated one. Dropped with no
equivalent: neither Elysia nor Bun instruments `fetch`, and no module in
`lib/http/**`, `app.ts` or `server.ts` replaces this logging.
`docs/framework-migration.md` does not mention this setting at all — it is an
undocumented gap, not a deliberate decision recorded anywhere else. Anyone who
relied on this for debugging outgoing calls (e.g. to the identity/email
providers) has nothing to fall back on today.

### Server Actions config

Not present. Walking the file as it read before deletion, there was no
`experimental.serverActions` key, no Server Actions encryption key, and no
`serverActions` entry of any kind — confirmed with `grep -rn "serverActions"`
across the repository outside `node_modules`, which returns no matches anywhere,
including in `docs/framework-migration.md` and every `.env*` file. This is
consistent with `docs/framework-migration.md` §1: "There is no `page.tsx`, no
`layout.tsx`, no `public/`, no React." Server Actions are invoked from a React
component tree; this repository never had one, so there was never a Server
Actions config to lose in the first place.

### `headers()` security-header block → `lib/http/security-headers.ts`

The full block, as retained (comment markers stripped):

```js
const isDev = process.env.NODE_ENV !== 'production';
const CSP = `
  base-uri 'self';
  default-src 'self';
  script-src 'self' 'sha256-nne+twLvxGzokkKtrC/+Z9Mdq4l8OjukUCknsajUZSs=' https://challenges.cloudflare.com/turnstile/${isDev ? " 'unsafe-eval' 'unsafe-inline'" : ''};
  style-src 'self' 'unsafe-inline';
  font-src 'self';
  connect-src 'self';
  frame-src 'self' https://challenges.cloudflare.com/;
  worker-src 'self' blob:;
  img-src 'self' data: blob:;
  media-src 'self';
  object-src 'none';
  form-action 'none';
  frame-ancestors 'none';
  upgrade-insecure-requests;
`;

const headers = isDev
  ? []
  : [
      {
        source: '/(.*?)',
        locale: false,
        headers: [
          {
            key: 'Content-Security-Policy',
            value: CSP.replaceAll(/\s{2,}/g, ' ').trim(),
          },
          { key: 'X-Frame-Options', value: `DENY` },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Referrer-Policy', value: 'strict-origin' },
          { key: 'Cross-Origin-Resource-Policy', value: `same-origin` },
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          {
            key: 'Strict-Transport-Security',
            value: `max-age=63072000; includeSubDomains; preload`,
          },
          { key: 'Access-Control-Allow-Origin', value: PUBLIC_URL },
          { key: 'X-XSS-Protection', value: '0' },
          { key: 'Origin-Agent-Cluster', value: '?1' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
          { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
        ],
      },
      {
        source: '/(pwa|js|images|styles|fonts)/(.*?)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=604800, immutable' },
        ],
      },
      {
        source: '/public/(.*?)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=604800, immutable' },
          { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
        ],
      },
      {
        source:
          '/(manifest.json|og.png|favicon.ico|robots.txt|sitemap.xml|.well-known(?:/.*)?)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=604800, immutable' },
          { key: 'Cross-Origin-Resource-Policy', value: `cross-origin` },
        ],
      },
      {
        // Same source pattern as the block above, duplicated verbatim in the
        // original file with `locale: false` added — the file's own
        // duplication, not a transcription error in this report.
        source:
          '/(manifest.json|og.png|favicon.ico|robots.txt|sitemap.xml|.well-known(?:/.*)?)',
        locale: false,
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=604800, immutable' },
          { key: 'Cross-Origin-Resource-Policy', value: `cross-origin` },
        ],
      },
      {
        source: '/_next/static/(.*?)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
    ];

// in nextConfig:
async headers() {
  return headers;
},
```

Replaced by `lib/http/security-headers.ts` (`SECURITY_HEADERS`,
`applySecurityHeaders`), invoked from `app.ts`'s `onRequest` hook and again from
its `onError`. Not a straight port — see § 6 for the itemised behaviour
differences (CSP collapses to `default-src 'none'`, headers now apply in
development too, the static-asset `Cache-Control` rules and the
`Access-Control-Allow-Origin` line are gone because there are no static routes
and `@elysia/cors` owns CORS now). The commented-out
`Content-Security-Policy: require-trusted-types-for` block directly above `CSP`
(marked `TODO: try to add this in production`) was never active in the Next
config either — it is dead text in both versions, not a dropped feature.

### `serverExternalPackages`, `poweredByHeader`, `reactStrictMode`, image config, and the rest

The full `nextConfig` object, in file order:

```js
const nextConfig = {
  reactStrictMode: true,
  // better-sqlite3 is a native addon; bundling it breaks the .node load.
  // Remove it here when the driver becomes bun:sqlite (see lib/sqlite/driver.ts).
  serverExternalPackages: ['jsdom', 'css-tree', 'better-sqlite3'],
  // TODO: active it for front-end
  // reactCompiler: true,
  poweredByHeader: false,
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: 'https', hostname: '**', port: '', search: '' },
      { protocol: 'http', hostname: '**', port: '', search: '' },
    ],
  },
  async headers() {
    return headers;
  },
  logging: {
    fetches: {
      fullUrl: true,
    },
  },
  // TODO: test the behavior of the scroll when navigate in the dash
  // experimental: {
  //   scrollRestoration: false,
  // },
};
module.exports = nextConfig;
```

Top to bottom:

- **`const { PUBLIC_URL } = require('./lib/env');`** (top of file) — the value
  fed into the dropped `Access-Control-Allow-Origin` header above. Superseded by
  `PUBLIC_ORIGIN`, which is `lib/env.js`'s ONLY export and is read by
  `@elysia/cors`'s `origin` in `app.ts` and by Better Auth's `baseURL` in
  `lib/auth.ts`. Two corrections to what this bullet used to say: `PUBLIC_URL`
  is now an environment variable NAME that `lib/env.js` reads (with
  `NEXT_PUBLIC_URL` as a legacy alias), not an export — nothing can import it —
  and `cleanEnvUrlToDomain`, the port-stripping helper this bullet blamed, no
  longer exists in any source file. The port-stripping problem it described is
  what `PUBLIC_ORIGIN`'s strict parse replaced (see § 6).
- **`reactStrictMode: true`** — doubles component render/effects in development
  to surface impure React code. No successor: there is no React tree to
  strict-mode.
- **`serverExternalPackages: ['jsdom', 'css-tree', 'better-sqlite3']`** — told
  Next's server bundler not to inline these native/CJS-only packages.
  `better-sqlite3` is gone from the runtime entirely (`lib/sqlite/driver.ts` now
  uses `bun:sqlite`); `jsdom` is still a real dependency (`package.json`:
  `"jsdom": "^30"`) and is still used server-side, in `utils/svg/server.ts` and
  `utils/images/server.ts`; `css-tree` is no longer in `package.json` at all.
  None of the three need a successor setting: per `docs/framework-migration.md`
  §7, "A Bun server has no build artefact" — Bun runs `server.ts` and its
  imports as source, with no bundling step for a bundler to be told to skip a
  package in.
- **`// reactCompiler: true`** (commented, `TODO: active it for front-end`) —
  never active in the config before it was deleted either. No successor;
  front-end-only.
- **`poweredByHeader: false`** — checked: **yes, it was disabled.** This
  suppressed Next's own `X-Powered-By: Next.js` response header. No successor
  needed: Elysia does not send an `X-Powered-By` header by default, so there is
  nothing left to suppress.
- **`images: { unoptimized: true, remotePatterns: [...] }`** — configured Next's
  image optimizer: disabled it outright (`unoptimized: true`) and, for when it
  wasn't, allow-listed every `https` and `http` host (`hostname: '**'`). Dead
  configuration even under Next — there is no `<Image>` component anywhere in
  this API-only repository. No successor.
- **`async headers()`** — see the previous subsection.
- **`logging.fetches`** — see above; dropped with no equivalent.
- **`// experimental: { scrollRestoration: false }`** (commented,
  `TODO: test the behavior of the scroll when navigate in the dash`) — never
  active; a browser-navigation concern with no meaning for an API-only server.
- **`module.exports = nextConfig;`** — the CJS export Next's config loader
  requires. No successor: `server.ts` needs no equivalent single config object,
  only its own explicit `Elysia()` chain and plugin calls.

## Behaviour differences

Reproduced from `docs/framework-migration.md` §4:

| What                        | Before                                                                        | After                                                                                                                             | Why                                                                                                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSP                         | Full front-end policy (`script-src` + inline hash, `style-src`, `img-src`, …) | `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`                                                 | Those directives grant nothing on a JSON API. Denying every fetch directive says the one thing that matters.                                                                                                                                        |
| Security headers in dev     | Emitted **nothing** outside production                                        | Emitted always, except HSTS                                                                                                       | A local request exercised a different response than the deployed one, so no header bug could surface before deploy. HSTS stays production-only: on `http://localhost` it pins the whole host for every project on every port.                       |
| CORS                        | A static `Access-Control-Allow-Origin: PUBLIC_URL` header                     | `@elysia/cors` — real preflight, `Vary: Origin`, credentials, `Retry-After` / `X-RateLimit-*` exposed                             | A hand-written ACAO answers no preflight and carries no `Vary`. It was never a working CORS configuration.                                                                                                                                          |
| CORS origin                 | `PUBLIC_URL`                                                                  | `PUBLIC_ORIGIN` (new, in `lib/env.js`)                                                                                            | `cleanEnvUrlToDomain` strips the port, so `http://localhost:3000` became `http://localhost` and could never match a browser `Origin` header. `PUBLIC_ORIGIN` is also what Better Auth signs cookies against.                                        |
| Static asset headers        | `Cache-Control` rules for `/pwa`, `/public`, `/_next/static`                  | Gone                                                                                                                              | There are no static files and no `public/`. The rules described routes that did not exist.                                                                                                                                                          |
| `upload/image`              | Read `ctx.rawRequest.formData()`                                              | Calls `await ctx.readFormData()`, after its own rate limiter, once the route's `body: 'multipart'` policy (`routes.ts`) admits it | A web `Request` body reads once, and every framework but Next drains it in its own parser first. A lazy, policy-gated reader keeps the body unbuffered until the handler's own admission check has run, instead of the adapter parsing it up front. |
| `/api/dev/email-test/fixed` | Ad-hoc `{success, data}` / `{success, message}` bodies                        | The standard envelope                                                                                                             | It bypassed the contract only because it was written against `NextResponse`. Dev-only endpoint; no client depends on the shape.                                                                                                                     |
| `next build` in CI          | `bun run build`                                                               | `bun run smoke`                                                                                                                   | A Bun server has no build artefact, so nothing else forces the module graph to evaluate. `scripts/smoke.ts` boots the real server instead.                                                                                                          |

`/api/health/storage` and `/api/internal/sqlite-sweep` keep their **exact** body
shapes — a deployed health check and a scheduled task parse them. They went onto
the `Handler` contract via `apiRaw`, the escape hatch for a body that cannot be
the envelope.

### Further differences (filled in by probe)

Every row below was measured against a running server on the pinned versions
(Bun 1.3.14, Elysia 1.4.29), not reasoned about. "After" is the behaviour after
the migration-review pass; "First Elysia build" is what the migration shipped
before it.

| Behaviour                    | Next.js App Router                          | First Elysia build (measured)                               | After (measured)                                                       |
| ---------------------------- | ------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| Wrong method, known path     | `405` + `Allow`                             | `404` with the API envelope                                 | `405` + `Allow: GET, HEAD, OPTIONS`                                    |
| Unknown path                 | `404`                                       | `404`                                                       | `404` — unchanged, and now distinguishable from the row above          |
| Trailing slash               | `308` → canonical path                      | `200` on BOTH forms                                         | `308` + `Location: /api/health/storage`                                |
| `OPTIONS` on unknown path    | `404`                                       | `204` from the CORS plugin, for any path at all             | `404`; a real preflight on a known path still answers `204`            |
| Preflight allowed headers    | n/a — the static ACAO answered no preflight | `Content-Type, Authorization, X-Maintenance-Token`          | `Content-Type, Authorization, X-Captcha-Response, X-Maintenance-Token` |
| Preflight `Max-Age`          | n/a                                         | `5` (the plugin default)                                    | `600`                                                                  |
| `Cache-Control`              | absent on API responses                     | absent                                                      | `no-store` on 200, 404, 405 and 500                                    |
| `Server-Timing`              | absent                                      | absent                                                      | `app;dur=<ms>`                                                         |
| `x-powered-by`               | emitted unless disabled (it was disabled)   | none                                                        | none                                                                   |
| `HEAD` on a `GET` route      | served from `GET`                           | served from `GET`                                           | served from `GET`, and now carries the full response policy            |
| `//api/health/storage`       | normalised by the framework                 | `404`                                                       | `404`                                                                  |
| `/api/./health/storage`      | normalised                                  | `200` — WHATWG `URL` collapses the dot segment              | `200`                                                                  |
| `/api/foo/../health/storage` | normalised                                  | `200` — same reason                                         | `200`                                                                  |
| `/api%2Fhealth%2Fstorage`    | `404`                                       | `404`                                                       | `404`                                                                  |
| Oversized request body       | Node default                                | buffered up to Bun's 128 MiB default before any check       | `413` at 8 MiB, before the handler                                     |
| 35-second handler            | completed                                   | connection dropped at 32.1 s, empty reply, `curl` exit 52   | completes (60 s server-wide, 120 s on the upload route)                |
| Two processes, one port      | `EADDRINUSE`                                | both bound it; the kernel split traffic silently            | `EADDRINUSE` on the second                                             |
| `NODE_ENV=prodution`         | framework set the mode itself               | booted and served with development posture                  | refuses to boot, exit 1, `{"msg":"startup rejected",…}`                |
| Long query string            | framework limit                             | `200` to 16 KB, `431` at 32 KB                              | same — Bun's limit, not ours                                           |
| Large / many headers         | Node defaults                               | `200` at 16 KB or 50 headers; `431` at 32 KB or 200 headers | same — see the note below                                              |

Two measurements worth stating separately, because both contradict a plausible
assumption:

**Bun's `431` is below the application.** A request whose header block exceeds
Bun's limit is answered `431 Request Header Fields Too Large` by the HTTP parser
before Elysia sees it: no security headers, no API envelope, and no access-log
line (verified — the server logged nothing for it). Nothing in application code
can change that, and it is the one response shape this API cannot make uniform.

**Router match and `url.pathname` never disagreed.** For every path form above,
what the router matched and what `new URL(request.url).pathname` reported were
the same string. A path-prefix security guard therefore cannot disagree with the
router on these inputs — which is the failure mode worth looking for, and it did
not reproduce.

**A route's own header beat the global policy.** With a security header written
into Elysia's `set.headers` from an `onRequest` hook and the same key set on a
native `Response` returned by the route, the route's value won on the wire. This
is why the policy is now re-applied in `mapResponse` as well as in the hook; the
hook alone covers the CORS preflight short-circuit and the unmatched-path 404,
which measurably do not reach `mapResponse`.

## If you port back to Next.js

Corrected from `docs/framework-migration.md` §5, which used to say "uncomment
`lib/http/adapters/next.ts`… it works as-is" — the claim § 1 of this report
disproves. That doc has since been corrected to point here, so the two now
agree; this paragraph stays as the record of what was wrong, not as a live
warning about text you will find there. Target the current shared modules:
`buildRequestMeta` and `withBodyPolicy` (`lib/http/request.ts`),
`enforcePreAuthIpLimit` (`lib/http/pre-auth.ts`), `toWebResponse`
(`lib/http/response.ts`) — the exact modules `lib/http/adapters/elysia.ts`
already targets. `withBodyPolicy` takes the route's `BodyPolicy`
(`'none' | 'json' | 'multipart'`, `lib/http/contract.ts`) as a required
argument, so a Next port must carry each route's `body` value across from
`routes.ts` rather than inventing one. Nothing under `app/api/**/handler.ts`
needs to change; no handler was ever edited for the framework, in either
migration direction.

1. **There is nothing left to uncomment.** `lib/http/adapters/next.ts`, every
   `app/api/**/route.ts`, and `next.config.js` are gone from the working tree.
   Recreate them from the code quoted in this report instead of looking for a
   `DISABLED` banner to strip. Write the adapter fresh (below) against the
   shared modules. Recreate `next.config.js`'s `headers()` from the current
   `lib/http/security-headers.ts` values rather than the frozen block quoted in
   § 5, in case they've moved on since. All 21 handler-backed routes, including
   the three that used to be hand-rolled (`dev/email-test/fixed`,
   `health/storage`, `internal/sqlite-sweep`), now fit the one-line
   `toNextHandler(handlers.METHOD, opts)` shape — see the note at the end of
   § 3.
2. **The new adapter** — the Elysia adapter's shape, retargeted at Next's
   request/context signature. The two-call split matters here as much as it does
   in `lib/http/adapters/elysia.ts`: `buildRequestMeta` reads no body byte, so
   an admission check can run before `withBodyPolicy` hands the handler its lazy
   readers.

   ```ts
   import type { BodyPolicy, Handler } from '@/lib/http/contract';

   import { enforcePreAuthIpLimit } from '@/lib/http/pre-auth';
   import { buildRequestMeta, withBodyPolicy } from '@/lib/http/request';
   import { toWebResponse } from '@/lib/http/response';

   import { handleApiError } from '@/utils/api-response';

   export function toNextHandler(
     handler: Handler,
     opts: { preAuthIpLimit?: boolean; body: BodyPolicy }
   ) {
     return async (
       request: Request,
       context?: { params?: Promise<Record<string, string>> }
     ): Promise<Response> => {
       try {
         const params = context?.params ? await context.params : {};
         const meta = buildRequestMeta(request, params);
         if (opts.preAuthIpLimit) await enforcePreAuthIpLimit(meta);
         const input = withBodyPolicy(meta, opts.body);
         return toWebResponse(await handler(input));
       } catch (error) {
         return toWebResponse(handleApiError(error));
       }
     };
   }
   ```

   Same shape as `toElysiaHandler` in `lib/http/adapters/elysia.ts`: build the
   head-only `meta`, run the optional pre-auth limiter against it, THEN complete
   it into a full `HandlerInput` via `withBodyPolicy` — passing the route's own
   `body` policy, which is required here, not optional, because `withBodyPolicy`
   has no default to fall back to. The only Next-specific step is unwrapping
   `context.params` (a `Promise` under the App Router) before handing it to
   `buildRequestMeta`. `toWebResponse` returns a standard `Response`, which the
   App Router accepts directly from a route handler — no `NextResponse` wrapping
   is required, and none of the manual `Set-Cookie`/cookie-flag rebuilding from
   the old `toNextResponse` is needed: `toWebResponse` already calls the shared
   `serializeSetCookie` (`lib/http/contract.ts`).

3. `bun add next@16.3.1 better-sqlite3@13.0.3` and
   `bun add -d eslint-config-next@16.3.1 @types/better-sqlite3`.
4. Restore `lib/sqlite/driver.ts` to `better-sqlite3` — **required**, not
   optional. `bun:sqlite` cannot load under Node, and Next route handlers run
   under Node. The file's header documents the differences in both directions.
   Restore `better-sqlite3` to `ignoreScripts` in `package.json` and to
   `serverExternalPackages` in `next.config.js`.
5. `tsconfig.json`: restore the `next` plugin, and `next-env.d.ts` +
   `.next/types/**/*.ts` in `include`. `next dev` regenerates `next-env.d.ts`.
6. `eslint.config.mjs`: swap `typescript-eslint` back for
   `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript`, and
   drop the `globals` block (that config supplied them). An earlier revision of
   this step also said to drop a `unicorn/no-empty-file` override; there is no
   such override in `eslint.config.mjs` and there never was one to drop.
7. `package.json` scripts: `next dev` / `next build` / `next start`. Restore
   `--config=p/nextjs` in `scan:sast` and in `lefthook.yml`.
8. Delete `app.ts`, `server.ts`, `lib/http/adapters/elysia.ts`,
   `scripts/smoke.ts`, and the `elysia` + `@elysia/cors` dependencies.

   **`app.ts` is the one that matters and an earlier revision of this step left
   it out.** It is the ONLY importer of `elysia`, `@elysia/cors` and
   `lib/http/adapters/elysia.ts`, so following the old step 8 removed the
   dependencies and their adapter while leaving the file that imports all three
   — `bun run build` (`tsc --noEmit`) then failed on three unresolvable imports
   in a file this procedure never mentioned. Recorded rather than silently
   corrected, because "the report is stale in four places" and "the report
   breaks the tree at step 8" are different findings.

   Also delete from `app.ts`, rather than porting: the route-registration loop
   (Next's file system does that job), the `strictPath`/`reusePort`/
   `maxRequestBodySize` serve options, and the `mapResponse` hook. Everything
   else in it — CORS, the security-header hook, the 404-vs-405 boundary, the
   trailing-slash 308, the post-response wiring — has to be REBUILT somewhere,
   which is what "What Next.js would not give back" below is about.

Unchanged from the original §5: what does **not** need reverting, because it is
framework-independent — `lib/http/contract.ts`, `request.ts`, `response.ts`,
`pre-auth.ts`, `security-headers.ts`, every `handler.ts`, and the probe suite.

### What Next.js would not give back

- The 404-versus-405 boundary, including the `Allow` header on a wrong method.
- The trailing-slash `308` redirect to the canonical path.
- The response policy (`lib/http/response-policy.ts`).
- The post-response seam (`lib/http/after-response.ts`).
- The OpenAPI route (`lib/http/openapi.ts`).
- The runtime assertions in `server.ts`.

## If you port to Hono

`lib/http/adapters/hono.ts.disabled` is retained on disk (not part of this
deletion) — read it directly rather than relying on this report; it already
contains the working adapter (`toHonoHandler`, ~10 lines against the same three
shared modules), a full `app.ts`-equivalent wiring example, and a verification
checklist. `bun add hono` is the only new dependency; the runtime stays Bun, so
`lib/sqlite/driver.ts` does not change.

The same rule as § 7 applies: target `buildRequestMeta`, `withBodyPolicy`,
`enforcePreAuthIpLimit`, and `toWebResponse` — do not reimplement body parsing,
IP extraction, the pre-auth limiter, or cookie serialisation inside the Hono
adapter itself. Two things live OUTSIDE the disabled adapter file and are easy
to lose in a port: the route table (`routes.ts`) and everything in `app.ts` —
the security-header hook, CORS, the response policy, the 405 boundary and the
trailing-slash 308. Neither is in `server.ts`, which validates the runtime and
owns `listen`/shutdown only. Port the header **values** from
`lib/http/security-headers.ts` into Hono's `app.use` + `secureHeaders()` rather
than retyping them into that plugin's options. Better Auth has no first-class
Hono integration; serve it from a prefix route registered last, so the explicit
routes above it win — and restrict it to GET and POST, as `app.ts` does, rather
than an `.all(...)` catch-all: registering every method lets unsupported ones
into Better Auth to consume its own rate-limit budget before it rejects them.
