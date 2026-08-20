# Elysia Migration Review — Consolidated

## How to use this document

**No finding here is a fact until it is reproduced.** Every item was derived
from reading code or from a probe against a running server, but line numbers
drift and probes can be misread. Before changing anything:

- If the defect is visible from reading the code alone (a missing header in an
  allowlist, a wrong comparison, an argument order), fix it directly.
- If the claim asserts runtime behavior (a timeout firing, a header winning over
  another, a statement surviving a close), reproduce it first. If it does not
  reproduce, record that and stop.
- If the claim asserts a performance or dependency win, benchmark it. Do not
  adopt a native API because it exists.

Each finding ends with a **Disposition** line stating where the work belongs:
code in this pass, `TODO.md`, `reports/test-strategy.md`, or
`reports/should-ignore.md`.

Findings that were verified by a live probe are marked _(probe)_. Findings
derived from reading source only are marked _(static)_.

---

## High Severity

### 1. Captcha-protected requests are blocked by CORS _(probe)_

[`server.ts:65-74`](../server.ts#L65-L74) permits only `Content-Type`,
`Authorization`, and `X-Maintenance-Token`. The application reads the captcha
token from `x-captcha-response` in
[`lib/captcha.ts:59-69`](../lib/captcha.ts#L59-L69), and Better Auth requires
the same header for sign-in in
[`lib/auth.ts:430-440`](../lib/auth.ts#L430-L440).

A real preflight requesting `content-type,x-captcha-response` returns 204 but
advertises only the three configured headers. Browsers therefore block the
actual request before it reaches sign-in, passwordless verification, or any
custom captcha-protected route. A `curl` probe of the same preflight looks
healthy, because the 204 is returned either way — the failure only appears in a
browser.

The same block also inherits the plugin's five-second `maxAge`, confirmed on a
live preflight, so every cross-origin request re-fires its preflight roughly
every five seconds.

Add `X-Captcha-Response` to `allowedHeaders`, include `HEAD` in the advertised
methods, and set `maxAge` explicitly — 600 or higher once the front-end origin
is real. Keep the CORS policy in shared data so the already-drifted Hono example
cannot repeat this omission.

**Disposition:** code now. Preflight regression test →
`reports/test-strategy.md`.

### 2. Request bodies are buffered before admission checks _(static)_

[`lib/http/adapters/elysia.ts:45-50`](../lib/http/adapters/elysia.ts#L45-L50)
calls `buildHandlerInput` before the pre-auth limiter.
[`lib/http/request.ts:23-34`](../lib/http/request.ts#L23-L34) then eagerly reads
JSON or multipart bodies for every body-capable route. The order is inverted:
the rule should be check-then-read, and the code reads-then-checks. This causes
several regressions:

- Upload multipart data is parsed before the upload limiter at
  [`app/api/upload/image/handler.ts:21-36`](../app/api/upload/image/handler.ts#L21-L36),
  whereas the Next handler limited first.
- Dashboard and auth JSON routes now parse attacker-supplied multipart data that
  the Next adapter ignored.
- The maintenance sweep parses a supplied body before checking its token at
  [`app/api/internal/sqlite-sweep/handler.ts:29-34`](../app/api/internal/sqlite-sweep/handler.ts#L29-L34).
- No `serve.maxRequestBodySize` is configured
  (`node_modules/bun-types/serve.d.ts:678`), so Bun accepts up to its 128 MiB
  default before the per-file limit runs. The per-file check at
  [`app/api/upload/image/handler.ts:55`](../app/api/upload/image/handler.ts#L55)
  runs after `request.formData()` has already buffered the whole body, so a 100
  MB POST is read in full before rejection.

The media-type checks are also substring and case sensitive. A non-JSON type
containing `application/json` is parsed as JSON, while a valid mixed-case
`Multipart/Form-Data` type is rejected — media types are case-insensitive per
spec.

Give routes an explicit body policy such as `none`, `json`, or `multipart`. Run
header/path-only admission checks before body parsing, leave multipart lazy
until the upload limiter passes, match a normalized MIME essence exactly, and
set `maxRequestBodySize` close to the largest legitimate upload plus multipart
overhead. Keep the per-file check — it is per file, the transport limit is per
request — but the memory exposure goes away.

**Disposition:** code now. Oversized JSON and multipart tests that prove
rejection precedes parsing → `reports/test-strategy.md`.

### 3. Production security fails open when `NODE_ENV` is absent or misspelled _(probe)_

The package script sets production mode, but the server itself accepts any value
and logs a missing value as development at
[`server.ts:237-245`](../server.ts#L237-L245). Production-only secret validation
is guarded by an exact string comparison in
[`lib/env.server.ts:91-97`](../lib/env.server.ts#L91-L97), and HSTS is guarded
the same way in
[`lib/http/security-headers.ts:31-58`](../lib/http/security-headers.ts#L31-L58).

A live launch with `NODE_ENV=prodution`, an empty Better Auth secret, an empty
Turnstile secret, and a relative SQLite directory still started and served
requests. Next set its runtime mode itself; direct `bun server.ts` does not. An
overridden Coolify start command can therefore disable several security
invariants without preventing boot.

Validate `NODE_ENV` as exactly `development`, `test`, or `production` before
importing application modules. Static imports run before entry-point code, so a
small bootstrap must validate mode and then dynamically import the app —
validating at the top of `server.ts` is too late.

**Disposition:** code now. One CI smoke run through the real production command
→ `reports/test-strategy.md`.

### 4. Preserved Next.js source is unrollbackable and must be deleted _(static)_

The rollback path does not work. `HandlerInput.formData` became required at
[`lib/http/contract.ts:32-42`](../lib/http/contract.ts#L32-L42), but the
commented Next adapter still builds a context without it at
[`lib/http/adapters/next.ts:95-114`](../lib/http/adapters/next.ts#L95-L114), so
uncommenting that source fails type checking. Making the field optional would
not repair behavior because the active upload handler requires it at
[`app/api/upload/image/handler.ts:30-36`](../app/api/upload/image/handler.ts#L30-L36).
This contradicts the rollback claim at
[`docs/framework-migration.md:97-125`](../docs/framework-migration.md#L97-L125).

The commented source also duplicates body parsing and pre-auth logic that now
lives in shared modules, so a security fix in `lib/http/request.ts` or
`lib/http/pre-auth.ts` would not follow a rollback. Commented code that cannot
compile is not a rollback plan; it is drift that type checking cannot see, and
it distorts the unused-file scanner (finding 18).

**Decision: delete all Next.js source rather than repair it.** A returning
Next.js port is possible later, and a move to Hono is still open, but a written
conversion report serves both better than dozens of commented files.

Delete the commented Next adapter, the commented `route.ts` files,
`next.config.js`, and the retained Next catch-all. Replace them with a single
report — `reports/next-migration.md` — that captures, with real code examples:

- The Next adapter shape: how `HandlerInput` was built from `NextRequest`,
  including `formData`, and how `HandlerOutput` became a `NextResponse`.
- The per-route method exports, generated from the route manifest rather than
  hand-counted: 21 handler modules export 28 explicit methods, and with the
  Better Auth GET/POST pair they originate from 22 baseline route files.
- Every behavior difference already recorded in §4 of
  [`docs/framework-migration.md`](../docs/framework-migration.md), plus the ones
  in findings 8, 16, and 27 that are missing from it.
- The Next-only configuration that was dropped: fetch logging (finding 19) and
  the Server Actions encryption key (finding 17).

The report must state that any future Next port targets the current shared
modules — `buildHandlerInput`, `enforcePreAuthIpLimit`, `toWebResponse` — not
the duplicated logic that was deleted.

**Disposition:** code now (deletion + report). Cross-check finding 17 and 18 in
the same pass.

---

## Medium Severity

### 5. Bun's SQLite busy timeout is installed after a lock-taking PRAGMA _(static)_

[`lib/sqlite/database.ts:40-68`](../lib/sqlite/database.ts#L40-L68) says both
drivers default to a 5-second busy timeout, but Bun/SQLite defaults to zero.
`applyPragmas` runs `journal_mode = WAL` before setting `busy_timeout` at
[`lib/sqlite/database.ts:95-100`](../lib/sqlite/database.ts#L95-L100).
`journal_mode` can require a file lock, so concurrent cold starts can fail
immediately with `SQLITE_BUSY` instead of waiting for the configured two
seconds.

Confirm the zero default before changing anything — read `busy_timeout` back on
a fresh Bun connection. Then set `busy_timeout` immediately after opening the
connection and before any lock-taking PRAGMA or migration, and correct the
comment that claims a shared 5-second default.

**Disposition:** code now. Two-process lock regression →
`reports/test-strategy.md`.

### 6. Prepared statements have no deterministic finalization path _(probe)_

The wrapper created at
[`lib/sqlite/driver.ts:97-103`](../lib/sqlite/driver.ts#L97-L103) hides Bun's
`Statement.finalize()` and tracks no native statements. It then calls
`db.close(false)` at
[`lib/sqlite/driver.ts:117-122`](../lib/sqlite/driver.ts#L117-L122). SQLite's
`close_v2` defers actual closure while statements remain alive; a direct probe
confirmed that a wrapped `prepare()` statement still executes after this close.

The second review described this file as a clean boundary that deliberately
exposes only what callers need. That reading is wrong in one specific way: the
hidden `finalize()` is not interface simplification, it is the reason no
deterministic finalization path exists.

This invalidates the cleanup guarantee in the partial-prepare error path at
[`lib/rate-limit/store.ts:213-234`](../lib/rate-limit/store.ts#L213-L234).
Earlier statements survive until garbage collection if a later prepare fails.
The deep health check also creates a new unmanaged statement on every call at
[`lib/sqlite/database.ts:189-192`](../lib/sqlite/database.ts#L189-L192), so the
leak accumulates over uptime.

Re-run the probe first — a wrapped `prepare()` followed by `close(false)`, then
execute the statement. If it still runs, track every native prepared statement
in the connection and finalize all of them before closing, or expose a
disposable/finalize operation and make each owner responsible. Use
`db.close(true)` after deterministic finalization so a leak surfaces as an error
rather than being deferred.

**Disposition:** code now.

### 7. Process shutdown does not drain requests or close SQLite resources _(static)_

[`server.ts:237-246`](../server.ts#L237-L246) starts the listener but installs
no `SIGTERM` or `SIGINT` handling. Elysia wires only `process.on('beforeExit')`,
verified at `node_modules/elysia/dist/adapter/bun/index.js:192`, which is not a
container signal handler. Coolify's stop-first deployment sends SIGTERM, so it
can terminate active mutations, image uploads, or external calls without an
application-level drain. `next start` handled this; nothing does now.

Elysia already provides both halves — `app.stop(closeActiveConnections?)` and an
`onStop` lifecycle hook. Only the signal wiring is missing:

```ts
app.onStop(() => {
  console.log(JSON.stringify({ msg: 'server stopping' }));
});

for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void app.stop();
  });
```

`app.stop()` drains in-flight requests; `app.stop(true)` aborts them. Draining
is the correct default for a stop-first deploy. Make the handlers idempotent,
use `onStop` to close initialized stores without opening unused ones, and add a
bounded forced shutdown after the deployment grace period.

WAL protects database consistency; it does not finish an in-flight application
operation for the client. An upload can reach R2 with no matching row.

**Disposition:** code now.

### 8. Method and path mismatches return the wrong status _(probe)_

The retained Next catch-all exports only GET and POST at
[`app/api/auth/[...all]/route.ts:10-13`](../app/api/auth/%5B...all%5D/route.ts#L10-L13),
but Elysia registers `.all('/api/auth/*')` at
[`server.ts:230-235`](../server.ts#L230-L235). Unsupported methods can enter
Better Auth and consume its rate-limit budget before Better Auth rejects them.
Unsupported methods on explicit custom auth paths can also fall through to the
wildcard.

Separately, the global `NOT_FOUND` mapping at
[`server.ts:83-94`](../server.ts#L83-L94) turns a known path with a wrong method
into 404 — `GET /api/dash/users/me/change-password` returns 404 with the API
envelope, where Next's App Router returned 405. The CORS plugin answers OPTIONS
on unknown paths with 204, so capability discovery is inaccurate too: a client
cannot distinguish "no such path" from "wrong method".

This is a real contract change and it is the only one missing from §4 of
[`docs/framework-migration.md`](../docs/framework-migration.md), where every
other deliberate difference is recorded — so the defect is both behavioral and
documentary.

Register only GET and POST for the Better Auth wildcard. Elysia does not
distinguish 404 from 405 on its own, so a 405 boundary has to consult the route
manifest from finding 10 to check whether any method is registered for the path;
add `Allow`, preserve 404 for genuinely unknown paths, and make OPTIONS handling
route aware. If a decision is made to keep 404, add the row to §4 instead — but
do not leave it undocumented.

**Disposition:** code now, after finding 10's manifest exists.

### 9. Security and cache policy are not enforced on the final response _(probe)_

Security headers are written to Elysia's `set.headers` in an `onRequest` hook at
[`server.ts:55-63`](../server.ts#L55-L63). Application and Better Auth handlers
return native `Response` objects. With the pinned Elysia version, a header on
the native response wins over the same key in `set.headers`; a direct probe
returned the route's conflicting value, not the global policy. The comment at
[`lib/http/security-headers.ts:62-67`](../lib/http/security-headers.ts#L62-L67)
also describes route headers as already written even though this function runs
before the route, so the comment inverts the execution order.

`toWebResponse` sets no cache policy at
[`lib/http/response.ts:15-27`](../lib/http/response.ts#L15-L27). A live response
had no `Cache-Control`, including shared paths that also serve credentialed GET
data and cacheable error statuses.

Re-confirm the header precedence on the pinned version before restructuring —
this is version-dependent behavior. Then enforce policy in a final response
mapper that mutates or safely clones native responses, while retaining the early
hook for CORS short-circuits. Add `Cache-Control: no-store` by default for API,
auth, and error responses, with an explicit opt-out only for deliberately public
cacheable endpoints.

**Disposition:** code now.

### 10. The route table has no generated manifest and no in-process test seam _(static)_

The CI smoke step explicitly uses development mode at
[`ci.yml:35-57`](../.github/workflows/ci.yml#L35-L57) and launches
`bun server.ts` directly in
[`scripts/smoke.ts:31-35`](../scripts/smoke.ts#L31-L35). It therefore does not
exercise production secret validation, HSTS, the absolute SQLite path rule,
maintenance-token readiness, or production denial behavior. The suite checks
only readiness, two headers, one missing route, one unknown Better Auth path,
and the sweep guard at [`scripts/smoke.ts:51-90`](../scripts/smoke.ts#L51-L90).

The code-side blocker is structural, not a missing test: `server.ts` builds and
listens in one step, so nothing can execute a route without a socket. Elysia can
run a route from a plain `Request` with no port and no spawned process
(`docs/llms-full.txt:14656`), and Hono's `app.request()` has the same shape, so
this seam survives a framework move.

Also, the route inventory cannot be trusted when hand-counted. A manual count in
the earlier review reported 21 handler modules exporting 26 methods; those 21
modules export 28 explicit methods, from 22 baseline route files including the
Better Auth pair. Findings 4, 8, 18, and 21 all depend on this list, so it has
to be generated, not maintained by hand.

Split app construction from listening and export the app. Generate the route
manifest — path, method, options — from the registration table itself, and
expose it to both the 405 boundary (finding 8) and the scanner replacement
(finding 18).

**Disposition:** code now for the split, the export, and the generated manifest.
Everything about what to assert — conformance suite, cookie forwarding, CORS
preflight, multipart path, wrong method, production smoke launch through
`bun run start` — → `reports/test-strategy.md`.

### 11. SQLite invariants are untested, and one error name may be wrong in code _(static)_

The test named as concurrent invokes
`[runMigration(), runMigration(), runMigration()]` synchronously in one process
at
[`scripts/probe/local/_sqlite-semantics-child.cjs:139-170`](../scripts/probe/local/_sqlite-semantics-child.cjs#L139-L170)
and copies migration logic with `Database` directly instead of invoking the
production driver and `openDatabase`. The Better Auth storage test explicitly
leaves real storage untested at
[`scripts/probe/local/auth-storage-log-boundary.test.ts:18-27`](../scripts/probe/local/auth-storage-log-boundary.test.ts#L18-L27),
and the SQL semantics parent passes none of `SQL_AUTH_CONSUME`, `SQL_AUTH_GET`,
or `SQL_AUTH_SET` to its child at
[`scripts/probe/local/sqlite-semantics.test.ts:71-79`](../scripts/probe/local/sqlite-semantics.test.ts#L71-L79).

All of that is test work. **One part is not:** the tests manufacture the old
`SqliteError` name while Bun reports `SQLiteError`. Grep production code for
`SqliteError`, for `err.name ===` comparisons, and for `instanceof` checks
against the driver's error type. If any runtime branch matches the Node
`better-sqlite3` spelling, that branch is dead under Bun and the error is
misclassified — that is a code defect, not a test defect, and it is exactly the
kind of thing a test using the wrong name would never catch.

**Disposition:** error-name audit in code now. Everything else →
`reports/test-strategy.md`.

### 12. Listener defaults introduce unreviewed operational behavior _(probe)_

The app supplies no `serve` configuration at [`server.ts:55`](../server.ts#L55),
and parses its port with unchecked `Number` at
[`server.ts:237-245`](../server.ts#L237-L245). Invalid ports can bind an
ephemeral or clamped port while the startup log reports the requested value, so
the log lies to the operator.

**The 30-second request ceiling.** Elysia defaults `Bun.serve`'s `idleTimeout`
to 30 seconds, verified at `node_modules/elysia/dist/adapter/bun/index.js:167`.
Node/Next had no equivalent per-request ceiling. Measured, not assumed: a
handler sleeping 35 s under `.listen(4555)` had its connection dropped at 32.06
s with an empty reply (`curl` exit 52).

This is a contract regression for the upload path, which performs image
processing, parallel R2 operations, and a database insert at
[`lib/r2/upload-helper.ts:207-284`](../lib/r2/upload-helper.ts#L207-L284). On a
small VPS a large image can cross 30 s, and the client sees a dropped connection
rather than an error body — and possibly a file in R2 with no row.

Two fixes compose. Set the global ceiling deliberately instead of inheriting it:

```ts
app.listen({ port, idleTimeout: 60 });
```

Then extend it per request inside the upload adapter path only:

```ts
ctx.server?.timeout(ctx.request, 120);
```

`server.timeout(request, seconds)` is at
`node_modules/bun-types/serve.d.ts:1043`; `ctx.server` at
`node_modules/elysia/dist/context.d.ts:27`. The per-request form is strictly
better than raising the global ceiling, because every other route keeps the
tight default. Measure `sharp` plus R2 on the target VPS before picking numbers.

**`reusePort: true`.** Same Elysia default object. Two processes both bind port
3000 and the kernel splits traffic between them instead of the second dying with
`EADDRINUSE`. Each process opens its own SQLite files, so the rate-limit
counters silently halve and the limits stop meaning what they say. During a
rolling deploy or an accidental double-start there is no signal at all — no
error, no log, just half the protection.

```ts
const app = new Elysia({ serve: { reusePort: false } });
```

Also validate a decimal port in `1..65535` and log the actual bound port.

**Disposition:** code now for port validation, `reusePort: false`, and the
per-request extension. The chosen `idleTimeout` value depends on a VPS
measurement → `TODO.md`.

### 13. Production does not enforce the Bun/SQLite version tested by CI _(static)_

`packageManager` pins Bun for local tooling and `setup-bun` at
[`package.json:26`](../package.json#L26), but deployment uses unpinned Nixpacks.
The runbook itself requires manual log inspection at
[`reports/coolify-deployment.md:140-145`](coolify-deployment.md#L140-L145) and a
minimum SQLite version at
[`reports/coolify-deployment.md:357-363`](coolify-deployment.md#L357-L363).
Manual log inspection is a procedure that gets skipped, not a guarantee.
`bun:sqlite` behavior is now part of the production runtime, not only a build
tool detail, so a SQLite version difference can change transaction and locking
semantics in production.

Assert `Bun.version` and `sqlite_version()` during build and startup so runtime
drift fails before traffic is served. That part is cheap and unconditional.

For pinning itself there are two options. The conservative one is a
repository-owned image pinned by Bun version and preferably image digest, or a
checked-in Nixpacks configuration providing an equivalent guarantee. The second
review proposed a stronger option: `bun build --compile --target=bun-linux-x64`
produces a self-contained executable with the runtime embedded, which removes
the pinning problem entirely and removes `node_modules` from the runtime image.
It would also give the CI `build` step something to produce again — `build` is
currently `tsc --noEmit`, which emits nothing.

That option is not free: `sharp` and every other native addon must be verified
to load from a compiled binary first, and that verification has not been done.

**Disposition:** version assertions in code now. Single-binary build → `TODO.md`
with the `sharp` verification as the gating step.

### 14. Proxy headers are trusted without verifying the socket peer _(probe)_

[`lib/audit.ts:18-45`](../lib/audit.ts#L18-L45) trusts `cf-connecting-ip` or the
now-dead Vercel header based only on syntax. A direct origin request can forge
these values if the external firewall or reverse-proxy configuration ever
drifts. These values feed rate limits, Better Auth, and audit metadata, so a
forged header both bypasses limits and poisons the audit trail that is supposed
to be evidence.

The failure has two opposite faces. When the header is present it is accepted on
syntax alone and is forgeable. When it is absent nothing resolves, and every
`preAuthIpLimit` route answers 503 — reproduced locally, which is why
`bun run dev` answers 503 on every dashboard route.

Bun exposes `server.requestIP(request)`
(`node_modules/bun-types/serve.d.ts:1027`), reachable as
`ctx.server?.requestIP(ctx.request)` and returning `SocketAddress | null`. This
was unavailable to the Next adapter, so the migration opened a fix that did not
previously exist. It does **not** replace the trusted-header rule and must not:
behind Cloudflare the peer is Traefik, not the client. What it enables is
asserting the proxy — if the peer is not the expected upstream, the request
bypassed the edge and the forwarded identity is forgeable, which is a stronger
reason to reject than "no header, so 503".

**This is deferred by prior decision.** The full resolution is recorded in
[`reports/should-ignore.md`](should-ignore.md) as post-deploy work, because the
correct `TRUSTED_PROXY_CIDRS` values are not known until the edge is final.

Two things are still in scope now. First, add a `TODO` comment at every
trusted-header site in `lib/audit.ts` and in `buildHandlerInput`, referencing
`reports/should-ignore.md`, so the deferred work is discoverable by grep.
Second, remove `x-vercel-forwarded-for` — there is no Vercel in this deployment
and dead trusted-header entries are pure attack surface. Keep IP resolution
behind one small shared abstraction so a future Hono-on-Bun server uses the same
rule.

The development-mode 503 is worth a separate judgement: a dev-only fallback
identifier would make local dashboard work possible without touching the
production trust rule. Decide and record it either way.

**Disposition:** `TODO` comments and the dead-header removal in code now. Proxy
assertion → already in `reports/should-ignore.md`. Dev fallback → decide in this
pass, implement or record.

### 15. Public-origin parsing can disagree with Better Auth _(static)_

[`lib/env.js:37-67`](../lib/env.js#L37-L67) canonicalizes the value to an origin
for CORS, while [`lib/auth.ts:79-81`](../lib/auth.ts#L79-L81) passes the raw
value to Better Auth. Paths, credentials, query strings, and fragments are
silently discarded by CORS but remain input to Better Auth. Production `http:`
origins are also accepted here even though `PUBLIC_URL` separately forces HTTPS.
Two sources of truth for one setting means the security behavior cannot be
predicted from the configuration file alone.

Parse this setting once. Require an absolute origin with no credentials,
non-root path, query, or fragment; require HTTPS in production; and pass the
same canonical value to both consumers. If browser and API origins can differ,
use separate variables and configure Better Auth trusted origins explicitly.

**Disposition:** code now.

---

## Low Severity

### 16. Additional HTTP contract changes are undocumented _(probe)_

Elysia's default non-strict routing accepts both a path and its trailing-slash
form. A live request to `/api/health/storage/` returned 200; Next's default was
a 308 canonical redirect. Two URLs for one resource splits cache keys and
security-rule matching. Set `strictPath` plus an explicit canonical redirect, or
document and test the broader contract.

The converted development email route returns 404 in non-development mode at
[`app/api/dev/email-test/fixed/handler.ts:23-28`](../app/api/dev/email-test/fixed/handler.ts#L23-L28),
while the retained Next source returned 403. The migration document records only
the response-envelope change at
[`docs/framework-migration.md:77-90`](../docs/framework-migration.md#L77-L90).
Restore 403, or document the concealment decision deliberately — 404 hiding the
route's existence may well be preferable, but it has to be written down.

**Disposition:** code now. Both differences also belong in the finding 4
conversion report and in finding 27's inventory.

### 17. Next-specific tooling, dependencies, and deployment instructions remain active _(static)_

With finding 4's deletion decided, this becomes the cleanup that has to follow
it.

The security workflow still runs Semgrep's Next.js rules at
[`security.yml:28-37`](../.github/workflows/security.yml#L28-L37), while local
scripts removed them — CI scans a framework that is gone and does not scan the
one in use. The deployment runbook still asks operators to provision an unused
Server Actions encryption key at
[`reports/coolify-deployment.md:211-220`](coolify-deployment.md#L211-L220), says
to run one Node process at
[`reports/coolify-deployment.md:244-255`](coolify-deployment.md#L244-L255), and
recommends Next instrumentation at
[`reports/coolify-deployment.md:552-556`](coolify-deployment.md#L552-L556).

`prettier.config.js` still sorts `next` and `react` import groups.
`package.json` still carries `@tanstack/react-table`, `@types/react`, and
`browserslist` for a server with no front-end; those predate the migration, but
`browserslist` arguably falls inside "strip Next tooling". `node_modules/next`
is still on disk.

The lockfile still contains `next`, `better-sqlite3`, and its types at
[`bun.lock:468`](../bun.lock#L468), [`bun.lock:592`](../bun.lock#L592), and
[`bun.lock:986`](../bun.lock#L986). The second review concluded that `bun.lock`
is already correct and that the next `bun install --frozen-lockfile` prunes the
stale directory. That conclusion does not survive checking: `bun why` resolves
these through Better Auth and Drizzle optional peers, so they are part of the
current resolution graph, not a stale artefact, and a frozen install will not
remove them.

Re-run `bun why` for each of the three to confirm before acting. Remove the
stale workflow and runbook guidance and the dead front-end dependencies.
Regenerate and inspect the lockfile from a clean installation; if Bun's
optional-peer resolution retains these packages, document that fact rather than
claiming they are gone.

**Disposition:** code and docs now, in the same pass as finding 4.

### 18. The unused-file scanner cannot prove handler registration _(static)_

[`scripts/find-unused-files.ts:54-86`](../scripts/find-unused-files.ts#L54-L86)
marks every disabled Next route as an entry point. Its regex parser at
[`scripts/find-unused-files.ts:126-142`](../scripts/find-unused-files.ts#L126-L142)
then treats imports inside comments as live edges. A handler remains reachable
through its commented Next import even if its Elysia registration is deleted,
which is the exact inverse of the guarantee the new comments claim.

Finding 4's deletion removes the immediate cause, so re-run the scanner after
the deletion before rewriting it. What must still change: stop treating disabled
files as roots, and either parse syntax while ignoring comments or drop the
claim that this scanner proves registration. The generated route manifest from
finding 10 is the authoritative registration check.

The scanner also reports the benchmark harness as unreachable despite the Knip
configuration declaring benchmark roots, and the combined command is not a CI
gate. Both need fixing, and the new `bench/` directory from finding 22 has to be
declared as a root too.

**Disposition:** code now, after finding 4.

### 19. Explicit Next fetch logging was silently dropped _(static)_

The retained configuration enabled full outgoing fetch logging at
[`next.config.js:194-198`](../next.config.js#L194-L198). Neither the Elysia
server nor the migration's list of deliberate behavior changes provides an
equivalent, so an observability capability disappeared without a written
decision.

The decision has two sides: full URLs may leak sensitive data through query
strings, so restoring the capability verbatim is not obviously correct. Decide
explicitly. If it is still wanted, add a sanitized fetch wrapper or reuse the
instrumentation decision in finding 26. Otherwise document its removal in the
finding 4 conversion report instead of claiming Next performed only routing,
adaptation, and headers.

**Disposition:** decide in this pass; implement a sanitized wrapper or record
the removal. Instrumentation itself → finding 26.

### 20. Unverified performance claims must be benchmarked, not adopted _(static)_

The second review recommends `new Elysia({ precompile: true })` on the grounds
that a container starts once and serves for days, and that it makes the first
request after a deploy behave like every subsequent one
(`docs/llms-full.txt:9115`). The independent review recommends removing that
advice because the supplied Elysia reference explicitly suggests leaving it
false.

Both positions are arguments, neither is a measurement, and the disagreement
cannot be settled by reading either document. The reasoning in favour is sound
enough to justify a benchmark and not sound enough to justify a default change.

Do not change `precompile` in this pass. Record it in `TODO.md` with what to
measure: cold-start time, first-request latency after deploy, steady-state
latency, and memory at startup, on the target VPS rather than a developer
machine.

Treat this as the template for every other "the native/faster API exists" claim
in this document: findings 13, 22, and 33 follow the same rule.

**Disposition:** `TODO.md`. No code change.

---

## Bun And Elysia Improvement Opportunities

### 21. Route-wide invariants are optional at each call site _(static)_

`parseNone` is repeated for every route and the security-sensitive `dash` option
is manually repeated throughout [`server.ts:115-228`](../server.ts#L115-L228). A
newly added dashboard route is one omitted argument away from losing pre-auth
protection — and the omission produces no type error and no test failure, only a
silent hole in a security control.

The second review counted 26 `parseNone` repetitions, 19 `dash` objects, and 7
occurrences of the `/api/dash/users` prefix. Those counts derive from the
inventory corrected in finding 10, so re-count from the generated manifest
rather than trusting them.

Use Elysia `group()`/`guard()` for shared prefixes and parse policy, plus a
local `toDashboardHandler` wrapper for the portable adapter option. This is
compatible with the portability rule: the grouping stays confined to
`server.ts`, which is the file that gets rewritten per framework anyway, and the
security default becomes hard to omit rather than easy to drop.

**Disposition:** code now, after finding 10's manifest exists.

### 22. UUID generation may be able to use Bun's native implementation _(static)_

The project imports UUIDv7 directly from `uuid` in
[`db/schema.ts:31`](../db/schema.ts#L31),
[`lib/permissions/utils.ts:14`](../lib/permissions/utils.ts#L14), and
[`utils/index.ts:6`](../utils/index.ts#L6). Bun provides `Bun.randomUUIDv7()`
with the required string format.

Two problems, in order. The first is drift: three independent call sites means a
future change has to be made three times. Centralize ID generation behind one
project helper regardless of which implementation wins — that is worth doing on
its own.

The second is whether the native API is actually better here, which has not been
measured. Write a benchmark under `bench/` comparing `uuid`'s `v7` against
`Bun.randomUUIDv7()` in a shape that matches real usage — generation in a tight
loop, and generation interleaved with the insert path that actually consumes the
IDs — and assert format compatibility, including monotonicity within the same
millisecond if any code depends on ordering.

Keep the benchmark checked in rather than deleting it after the decision: it has
to be re-runnable after the Bun 1.4 upgrade, when the numbers may move.

Switch the helper to the native API and drop the package only if the benchmark
shows a real win with equal format guarantees. If it does not, keep `uuid` and
record the numbers so the question stays settled.

**Disposition:** helper centralization in code now. Benchmark under `bench/`
now. The swap itself is conditional on the benchmark result.

### 23. Native storage and database adoption is deferred by decision _(static)_

[`lib/r2/client.ts:1-8`](../lib/r2/client.ts#L1-L8) loads the AWS S3 client and
presigner packages where `Bun.S3Client` (`node_modules/bun-types/s3.d.ts:837`)
covers write, delete, and presign natively.
[`db/index.ts:1-9`](../db/index.ts#L1-L9) uses `drizzle-orm/neon-http`, which
issues one HTTPS round trip per query, in a long-lived Bun process that could
hold a pooled TCP connection through `Bun.SQL` with `drizzle-orm/bun-sql` — the
latter is already installed.

Both are real opportunities and both are **explicitly out of scope for now.**

`Bun.S3Client` is not a drop-in replacement: server-side copy, metadata and
cache-header parity, presigned-URL expiry semantics, and the multipart path all
have to be proven against R2 first. `Bun.SQL` changes the Neon connection model
— pooled endpoint, connection limits, cold-start behavior — and is the largest
single change in this document.

Do not change either module in this pass. `lib/r2/client.ts` is already a real
abstraction boundary, so the change stays contained whenever it happens; keep it
that way and do not let S3 types leak past it in the meantime.

**Disposition:** `TODO.md`, with the verification list above as the entry
criteria. No code change.

---

## New Findings From The Second Review

### 24. The API has no machine-readable contract, and Zod is enough to produce one _(static)_

The migration declined Elysia's `t`/TypeBox validation for a sound reason: Zod
already validates inside the handlers, and duplicating schemas creates two
sources of truth. The cost was never paid down: there is no OpenAPI document, no
generated client, and nothing a front-end can consume. For a repository whose
stated purpose is to be the starter kit for most upcoming projects, that forces
every future project to infer the contract from handler code.

The second review framed this as a choice between adopting `@elysia/openapi`
(with coupling) or generating OpenAPI from Zod independently. That framing is
too pessimistic: Elysia's OpenAPI documentation
(`https://elysiajs.com/patterns/openapi.html`) covers using Zod schemas
directly, so TypeBox is not required and no second schema language is
introduced.

Verify that against the pinned Elysia and Zod versions first — the integration
path and the required adapter differ between versions, and Zod 4 also emits JSON
Schema natively. Then adopt whichever route holds:

- Zod schemas stay the single source of truth and remain framework-independent.
- Only the document generation and the serving route live in `server.ts`, so a
  Hono move rewrites one file, the same boundary the route table already uses.
- Better Auth exposes its own OpenAPI document (`docs/llms-full.txt:1108`);
  extract and merge it so the auth routes appear alongside the rest.

If the Zod path does not work on the pinned versions, generate the document from
the Zod schemas directly (`zod-to-json-schema` or Zod 4's JSON Schema output)
and serve it from a normal route. Either way, do not introduce TypeBox.

**Disposition:** verify the Zod integration, then code in this pass.

### 25. Post-response work has no portable seam _(static)_

Elysia fires `onAfterResponse` after the response has been sent
(`docs/llms-full.txt:10685`). Anything that must happen per request but that the
client should not wait on belongs there, and audit-log writes are the obvious
candidate — the client currently waits on work whose result it never sees.

Two constraints shape how this lands.

**It must be one seam, not a framework detail sprinkled through handlers.**
Introduce a single module — for example `lib/http/after-response.ts` — exporting
one function that takes the request context and the queued work. `server.ts`
wires Elysia's `onAfterResponse` to it and nothing else touches the framework. A
Hono move then changes that one wiring line, not every call site. Handlers
enqueue through the shared abstraction, exactly as they already do for
`toWebResponse`.

**Not every audit write can move, and the code decides which.** Where the audit
row is written inside the same transaction as the mutation it records, that
coupling is deliberate and must stay — deferring it admits a mutation with no
audit row, which inverts the purpose of the audit trail. Read `lib/audit.ts`
call site by call site and classify each one: transactional and staying, or
post-response and moving. Record the classification in the module so the next
reader does not have to re-derive it.

Also confirm what Bun and Elysia guarantee about work started in
`onAfterResponse` during shutdown. It interacts with finding 7: a drain that
does not wait for queued post-response work silently drops audit rows on every
deploy.

**Disposition:** code the seam in this pass. Per-call-site migration only where
the classification allows it.

### 26. There is no request instrumentation _(static)_

Nothing measures request timing. The migration documents behavior that should be
measured — finding 12's timeout ceiling is unmeasurable from inside the
application today — and provides no measurement path. Finding 20's benchmark and
finding 13's VPS timing both need numbers this repository cannot currently
produce.

`@elysia/server-timing` adds `Server-Timing` headers at near-zero cost.
OpenTelemetry (`@elysia/opentelemetry`) is the larger commitment and also
answers finding 19's sanitized-fetch question, so one instrumentation decision
covers both. Neither is urgent; both are cheaper to add now than after the first
production incident.

If OpenTelemetry is adopted, apply finding 19's caveat: full URLs in spans can
leak sensitive query strings, so sanitization is part of the work, not a
follow-up.

**Disposition:** `server-timing` in code now if it stays confined to
`server.ts`. OpenTelemetry → `TODO.md` as a scoped decision together with
finding 19.

### 27. Next.js implicit HTTP behaviors were never inventoried _(static)_

Next.js supplied HTTP behavior that no one wrote, and the migration only caught
some of it. Findings 3, 8, 16, and 19 are each an instance of the same root
cause: a default that disappeared with the framework and was noticed
individually rather than systematically. There is no reason to believe the four
found so far are all of them.

Produce an explicit inventory. For each behavior, establish what Next did, what
Elysia does now, and whether the difference is intentional. Start from the known
cases and extend:

- Unmatched method → 405 with `Allow` versus the current 404 (finding 8).
- Trailing-slash → 308 canonical redirect versus the current 200 on both
  (finding 16).
- `NODE_ENV` set by the runtime itself versus accepted unvalidated (finding 3).
- Outgoing fetch logging (finding 19).
- `x-powered-by`: Next adds this by default unless `poweredByHeader` is
  disabled. Check whether `next.config.js` disabled it, and confirm the Elysia
  server does not emit an equivalent framework banner.
- Request path normalization before routing: duplicate slashes, `.` and `..`
  segments, percent-encoded separators. Verify that Elysia's matcher and any
  path-prefix security check agree on the normalized form, because a path-prefix
  guard that disagrees with the router is an authorization bypass.
- Automatic `HEAD` handling derived from `GET`, and whether a `HEAD` response
  now carries a body or a wrong `Content-Length`.
- Request header size and count limits, and URL length limits.

Each confirmed difference goes in three places: fixed or accepted in code,
recorded in §4 of
[`docs/framework-migration.md`](../docs/framework-migration.md), and captured in
finding 4's conversion report.

Verify each by probe against the running server rather than by reasoning about
what a framework "should" do.

**Disposition:** inventory and probes in code now. Assertions for each confirmed
behavior → `reports/test-strategy.md`.

### 28. An in-process cron could remove the maintenance endpoint _(static)_

[`app/api/internal/sqlite-sweep/handler.ts`](../app/api/internal/sqlite-sweep/handler.ts)
is an HTTP route because the deployed Coolify scheduled task `curl`s it, and the
handler's own comment correctly notes that moving it is a deployment change
rather than a code change.

`@elysia/cron` (`docs/llms-full.txt:2498`) would remove an authenticated,
internet-reachable maintenance endpoint from the attack surface entirely, along
with `SQLITE_MAINTENANCE_TOKEN` and gate 3 of the deployment runbook. That is
stronger than it first appears: finding 2 showed this specific route parses a
supplied body before checking its token, so deleting the endpoint eliminates the
class of problem rather than the instance.

Against it: an in-process cron runs once per container, so it needs revisiting
if the deployment ever scales past one process — and note the tension with
finding 12, where the current `reusePort: true` can produce a second process
silently, so the single-process assumption may already be violated without
anyone knowing.

Worth a decision, recorded either way. If it is adopted, keep the sweep logic in
a plain function that both a cron trigger and a route can call, so the choice
stays reversible and framework-independent.

**Disposition:** decide in this pass and record. If adopted, code the function
split now and the cron wiring in `server.ts` only.

### 29. A typed-session macro is available but framework-coupled _(static)_

The Better Auth integration page (`docs/llms-full.txt:1187`) shows an Elysia
`macro` with `resolve` that resolves `user` and `session` once, returns 401 when
absent, and makes both available to every route opting in with `{ auth: true }`.

That is better than every handler calling `auth.api.getSession` itself — the
repetition is the same failure mode as finding 21, where a new route can
silently omit a security step. It is also exactly the Elysia-specific coupling
the migration set out to avoid.

Recorded as a known trade-off, not a recommendation. If session resolution is
consolidated before the Elysia-versus-Hono question is settled, do it behind the
portable adapter — one shared resolver the adapter calls — rather than as an
Elysia macro. Adopt the macro only if Elysia stops being provisional.

**Disposition:** no code change. Record in `TODO.md` as blocked on the framework
decision.

### 30. Eden Treaty is the strongest argument for keeping Elysia _(static)_

`@elysia/eden` derives a fully typed client from the server's route types with
no code generation step. Most of this document pushes toward keeping Elysia at
arm's length; this is the one item that pushes the other way, and it is the
thing Hono's RPC does differently enough to matter for a starter kit that will
grow a front-end.

Weigh it explicitly when the Elysia-versus-Hono question is settled, rather than
discovering it afterward. It also interacts with finding 24: if the OpenAPI
document lands first, a generated client covers part of the same need in a
framework-independent way, which weakens the lock-in argument.

**Disposition:** no code change. Input to the framework decision; record in
`TODO.md`.

### 31. Two `bun:sqlite` capabilities exist behind the driver _(static)_

Recorded so they are not reimplemented later:

- `statement.iterate()` (`node_modules/bun-types/sqlite.d.ts:666`) streams rows
  instead of materialising an array. Relevant only if a sweep ever needs to walk
  a table larger than memory; the current bounded `DELETE ... LIMIT` sweep does
  not.
- `db.serialize()` / `Database.deserialize()`
  (`node_modules/bun-types/sqlite.d.ts:412`) give an in-process consistent
  snapshot. Not needed while both databases hold disposable state, but it is the
  answer if anything durable is ever put in SQLite.

Neither is a gap. Note that exposing either one means touching
[`lib/sqlite/driver.ts`](../lib/sqlite/driver.ts), which finding 6 is already
changing — sequence them so the finalization work lands first.

**Disposition:** no action. Reference material.

### 32. Bun's test-runner features are unused _(static)_

The suite runs as plain `bun test`. Bun's runner also provides `--coverage` with
a `--coverage-threshold` gate, snapshot testing, and lifecycle hooks. The probe
suite is currently the only automated coverage of the SQLite invariants and
nothing measures how much of the code it reaches — so the coverage is both weak
(finding 11) and unmeasured.

**Disposition:** `reports/test-strategy.md` in full. No code change.

### 33. Deliberately declined — do not "fix" these _(static)_

Recorded so a later reader does not undo a decision made on purpose. Anything in
this table that gets revisited needs a written reason, not an observation that
the API exists.

| Capability                                    | Why it is not used                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Bun.password` for argon2id                   | Current hashing and verification pass an Argon2 `secret` pepper at [`lib/auth/password.ts:76-100`](../lib/auth/password.ts#L76-L100); `Bun.password` has no secret parameter and the secret is not encoded in the PHC string. Switching would reject every existing password, not merely change cost parameters. Requires a designed and tested password migration, not a swap. |
| `Bun.S3Client`                                | Deferred by decision — see finding 23.                                                                                                                                                                                                                                                                                                                                          |
| `Bun.SQL` / `drizzle-orm/bun-sql`             | Deferred by decision — see finding 23.                                                                                                                                                                                                                                                                                                                                          |
| Elysia `t` / TypeBox validation               | Zod already validates in the handlers. Two schema languages for one contract is worse than neither. Finding 24 shows OpenAPI does not require TypeBox.                                                                                                                                                                                                                          |
| `.mount(auth.handler)` for Better Auth        | Better Auth owns the `/api/auth` prefix and refuses an empty `basePath`, so `mount` has to sit at the route-table root. `.all('/api/auth/*', …)` is the same behaviour, scoped — but narrow it to GET and POST per finding 8.                                                                                                                                                   |
| Elysia's reactive cookie map, `Bun.CookieMap` | Neither models `Partitioned`. `HandlerOutput.cookies` + `serializeSetCookie` is the portable path and loses no attribute.                                                                                                                                                                                                                                                       |
| `bun:sqlite` `safeIntegers`                   | Returns every integer as a `bigint`, which breaks `JSON.stringify`. The largest stored value is a millisecond timestamp against a ~9e15 ceiling.                                                                                                                                                                                                                                |
| `Bun.secrets`                                 | OS keychain; useless in a container. Coolify environment variables are the mechanism.                                                                                                                                                                                                                                                                                           |

**Disposition:** no action. Guard rail.

---

## Disposition Index

| Finding                                       | Disposition                                                  |
| --------------------------------------------- | ------------------------------------------------------------ |
| 1 CORS captcha header                         | Code now                                                     |
| 2 Body parsed before checks                   | Code now                                                     |
| 3 `NODE_ENV` fails open                       | Code now                                                     |
| 4 Delete Next source, write conversion report | Code now                                                     |
| 5 `busy_timeout` ordering                     | Code now                                                     |
| 6 Statement finalization                      | Code now (re-probe first)                                    |
| 7 Signal handling and drain                   | Code now                                                     |
| 8 405 versus 404, auth wildcard methods       | Code now, after 10                                           |
| 9 Final response policy                       | Code now (re-probe precedence)                               |
| 10 App/listen split, generated manifest       | Code now; assertions → `test-strategy.md`                    |
| 11 `SQLiteError` name audit                   | Code now; rest → `test-strategy.md`                          |
| 12 Port, `reusePort`, timeout                 | Code now; timeout value → `TODO.md`                          |
| 13 Version assertions                         | Code now; single binary → `TODO.md`                          |
| 14 Proxy trust                                | `TODO` comments + dead header now; rest → `should-ignore.md` |
| 15 Public origin parsed twice                 | Code now                                                     |
| 16 Trailing slash, 403 versus 404             | Code now                                                     |
| 17 Next tooling and lockfile                  | Code and docs now                                            |
| 18 Unused-file scanner                        | Code now, after 4                                            |
| 19 Fetch logging                              | Decide now; ties to 26                                       |
| 20 `precompile`                               | `TODO.md`                                                    |
| 21 `group()` / `guard()`                      | Code now, after 10                                           |
| 22 UUID helper + benchmark                    | Helper and `bench/` now; swap conditional                    |
| 23 `Bun.S3Client`, `Bun.SQL`                  | `TODO.md`                                                    |
| 24 OpenAPI from Zod                           | Verify, then code now                                        |
| 25 Post-response seam                         | Code now                                                     |
| 26 Instrumentation                            | `server-timing` now; OTel → `TODO.md`                        |
| 27 Next implicit behaviors                    | Inventory now; assertions → `test-strategy.md`               |
| 28 In-process cron                            | Decide now; function split if adopted                        |
| 29 Session macro                              | `TODO.md`, blocked on framework decision                     |
| 30 Eden Treaty                                | `TODO.md`, input to framework decision                       |
| 31 `bun:sqlite` extras                        | Reference only                                               |
| 32 Bun test features                          | `reports/test-strategy.md`                                   |
| 33 Declined list                              | Guard rail                                                   |
