# Framework migration: Next.js → ElysiaJS

Status: **done**. Elysia is the active framework. The Next.js layer has been
DELETED — `reports/next-migration.md` replaces it with the adapter source, the
route inventory and the behaviour deltas, in a form that cannot rot the way
commented-out code did.

This document is the map for two audiences: whoever needs to roll back to
Next.js, and whoever migrates on to Hono.

---

## 1. What the application actually was

Next.js served no pages here. There is no `page.tsx`, no `layout.tsx`, no
`public/`, no React. `app/` contained only `api/**`, and every `route.ts` was
three lines of wiring:

```ts
export const GET = toNextHandler(handlers.GET, { preAuthIpLimit: true });
```

The endpoint logic already lived in a framework-agnostic `Handler`
(`lib/http/contract.ts`), so Next was doing exactly three jobs:

1. mapping the file system to routes,
2. building a request context and serialising a response,
3. attaching security headers from `next.config.js`.

All three are now done explicitly, in `server.ts` and `lib/http/`.

## 2. The shape after the migration

```
server.ts                      entry point: validate the runtime, listen, handle signals
app.ts                         the ONLY file that knows the framework; exports `app`
routes.ts                      the route table AS DATA — framework-free
lib/http/contract.ts           Handler / HandlerInput / HandlerOutput, cookie codec
lib/http/route-manifest.ts     route types, manifest, the 405 lookup  — shared
lib/http/request.ts            buildRequestMeta + withBodyPolicy(…)   — shared
lib/http/response.ts           toWebResponse(output)                  — shared
lib/http/response-policy.ts    the final response policy              — shared
lib/http/pre-auth.ts           enforcePreAuthIpLimit(meta)            — shared
lib/http/after-response.ts     the post-response seam                 — shared
lib/http/security-headers.ts   the header set, as data                — shared
lib/http/openapi.ts            the contract, from the manifest + Zod  — shared
lib/http/adapters/elysia.ts    ~25 lines: glue only
lib/http/adapters/hono.ts.disabled   the same shape, for later
app/api/**/handler.ts          UNCHANGED except the upload's lazy multipart read.
```

`server.ts` and `app.ts` are split for two reasons: a route has to be runnable
from a plain `Request` with no socket (`app.handle(...)`), which is what makes
an in-process conformance suite possible; and `NODE_ENV` has to be validated
BEFORE the application modules that read it are imported, which a static import
in the same file cannot do. `routes.ts` is separate again because it is the one
artefact a move to Hono keeps unchanged.

The adapters shrank on purpose. Under Next, `adapters/next.ts` held body
parsing, IP extraction, the pre-auth limiter and cookie serialisation — so a
second framework meant reimplementing four security-relevant behaviours. They
now live in shared modules, and an adapter is glue: build the input, run the
handler, serialise the output, catch.

## 3. Decisions taken, and why

**Runtime is Bun, and the SQLite driver moved with it.** `better-sqlite3` is
built against the V8 C++ API and hard-panics under Bun (`NAPI FATAL ERROR`);
`bun:sqlite` is unreachable from Node. The driver and the server framework were
therefore one decision, not two. `lib/sqlite/driver.ts` is the only file that
changed — no caller did.

**No Elysia `t` validation, and no OpenAPI plugin.** Zod already validates
inside the handlers. Declaring the same schemas again in Elysia's `t` would
couple the route table to Elysia and create two sources of truth for the same
contract. The cost of that decision — no machine-readable contract — has since
been paid down without reversing it: `lib/http/openapi.ts` generates the
document from the route manifest and the same Zod schemas, using Zod 4's native
`toJSONSchema`. No plugin, no second schema language.

**Routes are registered from a data table, with `parse: 'none'`.** Elysia parses
the body into `ctx.body` by default, which drains the stream. The adapter reads
the raw `Request` instead, so Better Auth still receives an unread body.

Each route DECLARES its body policy (`none` / `json` / `multipart`) and its
pre-auth policy as REQUIRED fields in `routes.ts`, rather than passing them as
optional arguments at each registration. That is not style: an optional argument
repeated 28 times is one omission away from a route silently losing its pre-auth
limit, with no type error and no test failure. Omitting either field now fails
to compile.

**Better Auth is a prefix route, not `.mount()`.** `.mount(auth.handler)` would
have to be mounted at `/` — Better Auth owns the `/api/auth` prefix itself and
refuses an empty `basePath` — which puts a catch-all at the root of the route
table. A prefix route is the same behaviour, scoped — registered per method
(`GET` and `POST` only, from `ROUTE_PREFIXES`) rather than with `.all(...)`,
which would let unsupported methods into Better Auth to consume its own
rate-limit budget before it rejects them. Elysia's router resolves static
segments before wildcards, so the explicit routes still win; this is asserted
from outside by `scripts/smoke.ts`.

## 4. Behaviour that deliberately changed

Everything else is byte-identical. These are not:

| What                                            | Before                                                                        | After                                                                                                     | Why                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CSP                                             | Full front-end policy (`script-src` + inline hash, `style-src`, `img-src`, …) | `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`                         | Those directives grant nothing on a JSON API. Denying every fetch directive says the one thing that matters.                                                                                                                                                                                                       |
| Security headers in dev                         | Emitted **nothing** outside production                                        | Emitted always, except HSTS                                                                               | A local request exercised a different response than the deployed one, so no header bug could surface before deploy. HSTS stays production-only: on `http://localhost` it pins the whole host for every project on every port.                                                                                      |
| CORS                                            | A static `Access-Control-Allow-Origin: PUBLIC_URL` header                     | `@elysia/cors` — real preflight, `Vary: Origin`, credentials, `Retry-After` / `X-RateLimit-*` exposed     | A hand-written ACAO answers no preflight and carries no `Vary`. It was never a working CORS configuration.                                                                                                                                                                                                         |
| CORS origin                                     | `PUBLIC_URL`                                                                  | `PUBLIC_ORIGIN` (new, in `lib/env.js`)                                                                    | The old `cleanEnvUrlToDomain` helper (since deleted) stripped the port, so `http://localhost:3000` became `http://localhost` and could never match a browser `Origin` header. `PUBLIC_ORIGIN` is also what Better Auth signs cookies against, and is `lib/env.js`'s only export.                                   |
| Static asset headers                            | `Cache-Control` rules for `/pwa`, `/public`, `/_next/static`                  | Gone                                                                                                      | There are no static files and no `public/`. The rules described routes that did not exist.                                                                                                                                                                                                                         |
| `upload/image`                                  | Read `ctx.rawRequest.formData()`                                              | Calls `await ctx.readFormData()` — a lazy reader the adapter hands it, gated on the route's `body` policy | A web `Request` body reads once. Elysia's parser drained it first, and the handler's `.catch` turned `Body has already been used` into a generic "no files" 400. The adapter briefly parsed it eagerly instead; both readers are now lazy, so admission checks inside a handler still run before a byte is parsed. |
| `/api/dev/email-test/fixed`                     | Ad-hoc `{success, data}` / `{success, message}` bodies                        | The standard envelope                                                                                     | It bypassed the contract only because it was written against `NextResponse`. Dev-only endpoint; no client depends on the shape.                                                                                                                                                                                    |
| `next build` in CI                              | `bun run build`                                                               | `bun run smoke`                                                                                           | A Bun server has no build artefact, so nothing else forces the module graph to evaluate. `scripts/smoke.ts` boots the real server instead.                                                                                                                                                                         |
| Unmatched method                                | `405` with `Allow` (App Router)                                               | `405` with `Allow`, decided from the generated route manifest                                             | Elysia reports a wrong method and an unknown path identically as `NOT_FOUND` (measured), so it returned `404` for both and a client could not tell them apart. `lib/http/route-manifest.ts` is what can tell them apart.                                                                                           |
| Trailing slash                                  | `308` redirect to the canonical path                                          | `308` redirect to the canonical path                                                                      | Elysia's default non-strict routing served `200` on BOTH forms (measured), splitting cache keys and security-rule matching. `strictPath: true` plus a manifest-checked redirect in `app.ts` restores the original behaviour.                                                                                       |
| `/api/dev/email-test/fixed` outside development | `403`                                                                         | `404`                                                                                                     | Deliberate, and recorded rather than left as an accident of the rewrite: `403` confirms the route exists. A development-only endpoint should be indistinguishable from an unrouted path in every other mode.                                                                                                       |
| Better Auth methods                             | `GET` and `POST` only (`toNextJsHandler` exported exactly those)              | `GET` and `POST` only                                                                                     | The first Elysia version registered `.all('/api/auth/*')`, so unsupported methods entered Better Auth and consumed its rate-limit budget before it rejected them. Restored to the two methods, with the rest stopping at the 405 boundary.                                                                         |
| `Cache-Control`                                 | Not set on API responses                                                      | `no-store` on every API, auth and error response, with a per-handler opt-out                              | Not a Next behaviour that was lost — a gap in both. Every response here is per-user, credentialed, or an error; `no-store` is the only directive that says so to every intermediary including the back/forward cache.                                                                                              |
| `Server-Timing`                                 | Absent                                                                        | `app;dur=<ms>` on every response, plus one structured access-log line per request                         | Nothing measured request timing, so the timeout ceiling below was unmeasurable from inside the application. Implemented against the existing response and post-response seams; no plugin, no dependency.                                                                                                           |
| CORS allowed headers                            | n/a (the static ACAO header answered no preflight)                            | `Content-Type, Authorization, X-Captcha-Response, X-Maintenance-Token`, `max-age=600`, `HEAD` advertised  | `X-Captcha-Response` was missing, so every browser sign-in was blocked while a `curl` preflight still returned 204. The plugin's 5-second `maxAge` also re-fired a preflight for practically every cross-origin request.                                                                                           |
| Request body parsing                            | JSON only, on `application/json`; multipart read by the handler               | Declared per route as `none` / `json` / `multipart`, parsed only AFTER admission checks                   | The Elysia adapter parsed the body BEFORE the pre-auth limiter, so JSON-only routes parsed attacker-supplied multipart data and the maintenance route parsed a body before checking its token. Media types now match on a normalised essence rather than by substring.                                             |
| Request body limit                              | Node default                                                                  | `maxRequestBodySize` 8 MiB → `413`                                                                        | Bun accepted up to its 128 MiB default before the per-file check could run, so a 100 MB POST was buffered in full before rejection.                                                                                                                                                                                |
| Per-request timeout                             | None                                                                          | 60 s server-wide; 120 s on the upload route via `server.timeout()`                                        | Elysia inherits Bun's `idleTimeout` and defaulted it to 30 s — measured dropping a 35 s request at 32.1 s with an empty reply and no error body. Neither replacement number is measured on the target host yet (`TODO.md` EM-1).                                                                                   |
| Port reuse                                      | n/a                                                                           | `reusePort: false`                                                                                        | Elysia's default is `true`, so two processes both bound the port and the kernel split traffic between them — each with its own SQLite files, halving the rate-limit counters with no error and no log.                                                                                                             |
| `NODE_ENV`                                      | Set by the framework                                                          | Validated as exactly `development` / `test` / `production` before the app loads                           | `bun server.ts` sets nothing. `NODE_ENV=prodution` with an empty Better Auth secret, an empty Turnstile secret and a relative SQLite directory still started and served requests. Reproduced.                                                                                                                      |
| Runtime version                                 | Node major pinned by the image                                                | `Bun.version` and `sqlite_version()` asserted at startup                                                  | `bun:sqlite` is compiled into the Bun binary, so database semantics travel with the runtime. Manual log inspection is a procedure that gets skipped, not a guarantee.                                                                                                                                              |
| Outgoing fetch logging                          | `logging.fetches` with full URLs                                              | Removed, not replaced                                                                                     | A deliberate omission rather than an oversight: full URLs leak query strings, and this application calls Turnstile, HIBP and R2. Recorded in `TODO.md` EM-6 together with the OpenTelemetry decision.                                                                                                              |
| Machine-readable contract                       | None                                                                          | `GET /openapi.json`, generated from the route manifest and the existing Zod schemas                       | The migration declined Elysia's `t`/TypeBox for a sound reason and never paid the cost down. Zod 4 emits JSON Schema natively, so no second schema language and no plugin were needed.                                                                                                                             |
| Framework banner                                | `x-powered-by` unless disabled (`next.config.js` disabled it)                 | None emitted                                                                                              | Verified by probe rather than assumed.                                                                                                                                                                                                                                                                             |
| Path normalisation                              | Framework-normalised before routing                                           | WHATWG `URL` collapses `.` and `..`; `//` and `%2F` do not match                                          | Verified by probe: the router and `new URL(request.url).pathname` agree in every case tested, so a path-prefix guard cannot disagree with the router. `//api/health/storage` and `/api%2Fhealth%2Fstorage` both `404`.                                                                                             |
| Header block / URL length                       | Node defaults                                                                 | Bun's parser answers `431` above roughly 16–32 KB of headers, or ~200 headers                             | Unchanged, and NOT reachable from application code: the `431` is emitted by Bun's HTTP parser before the request reaches Elysia, so it carries no security headers, no API envelope and no access-log line (measured).                                                                                             |

`/api/health/storage` and `/api/internal/sqlite-sweep` keep their **exact** body
shapes — a deployed health check and a scheduled task parse them. They went onto
the `Handler` contract via `apiRaw`, which is the escape hatch for a body that
cannot be the envelope.

## 5. Rolling back to Next.js

**Read `reports/next-migration.md` first.** The commented Next.js source this
section used to describe is gone, and it was never a working rollback:
`HandlerInput.formData` became required while the commented `buildContext` never
set it, so uncommenting it failed type checking. That report carries the adapter
source, the per-route method exports and the behaviour deltas, and states the
one correction that matters — a returning port targets the CURRENT shared
modules (`buildRequestMeta` / `withBodyPolicy`, `enforcePreAuthIpLimit`,
`toWebResponse`), not the duplicated body-parsing and pre-auth logic that lived
inside the deleted adapter.

1. Recreate `app/api/**/route.ts`, `lib/http/adapters/next.ts` and
   `next.config.js` from `reports/next-migration.md`.
2. `bun add next@16.3.1 better-sqlite3@13.0.3` and
   `bun add -d eslint-config-next@16.3.1 @types/better-sqlite3`.
3. Restore `lib/sqlite/driver.ts` to `better-sqlite3` — **required**, not
   optional. `bun:sqlite` cannot load under Node, and Next route handlers run
   under Node. The file's header documents the differences in both directions.
   Restore `better-sqlite3` to `ignoreScripts` in `package.json` and to
   `serverExternalPackages` in `next.config.js`.
4. `tsconfig.json`: restore the `next` plugin, and `next-env.d.ts` +
   `.next/types/**/*.ts` in `include`. `next dev` regenerates `next-env.d.ts`.
5. `eslint.config.mjs`: swap `typescript-eslint` back for
   `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript`, and
   drop the `globals` block (that config supplied them). An earlier revision of
   this step also said to drop a `unicorn/no-empty-file` override; there is no
   such override in `eslint.config.mjs` and there never was one to drop.
6. `package.json` scripts: `next dev` / `next build` / `next start`. Restore
   `--config=p/nextjs` in `scan:sast` and in `lefthook.yml`.
7. Delete `app.ts`, `server.ts`, `lib/http/adapters/elysia.ts`,
   `scripts/smoke.ts`, and `elysia` + `@elysia/cors`. **`app.ts` is the one to
   not forget**: it is the only importer of `elysia`, `@elysia/cors` and the
   Elysia adapter, so removing the dependencies while leaving it breaks
   `tsc --noEmit` on three unresolvable imports. See `reports/next-migration.md`
   § 7 step 8 for what in it has to be rebuilt rather than simply deleted.

What does **not** need reverting, because it is framework-independent:
`routes.ts`, `lib/http/contract.ts`, `route-manifest.ts`, `request.ts`,
`response.ts`, `response-policy.ts`, `pre-auth.ts`, `after-response.ts`,
`security-headers.ts`, `openapi.ts`, every `handler.ts`, and the probe suite.

What a Next port would NOT get back for free, because Next never provided it
either — it is application code now and has to be ported with the rest: the 405
boundary, the trailing-slash redirect, the response policy, the post-response
seam, and the runtime assertions in `server.ts`.

## 6. Migrating on to Hono

Read `lib/http/adapters/hono.ts.disabled` — it is the whole adapter, plus the
`server.ts` equivalent and a list of what to verify. The runtime stays Bun, so
the SQLite driver does **not** change.

The things that are not in the adapter, and are the usual way a migration loses
something: the route table is `routes.ts`, and the security headers, CORS, the
response policy, the 405 boundary and the trailing-slash 308 are all in
`app.ts`. None of them is in `server.ts`, which validates the runtime and owns
`listen`/shutdown only. Port the header **values** from
`lib/http/security-headers.ts` rather than retyping them into
`hono/secure-headers` options.

## 7. Verifying a migration

`bun run smoke` asserts, from outside the process: the server boots, readiness
reports `ok` (so SQLite opened, migrated and matched its expected PRAGMAs), the
security headers are attached, an unrouted path returns the API envelope rather
than a framework default, Better Auth is mounted, and the maintenance surface
fails closed without a token.

`bun run test` covers the SQLite rate-limit and cache invariants against the
real driver.

Neither needs PostgreSQL or the network.
