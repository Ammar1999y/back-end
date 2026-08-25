# Claude Opus Audit — full-codebase sweep + Bun 1.4 compatibility

## Findings

### F27 — `validID` does not canonicalise case, so three "you may not do this to yourself" guards can be walked past with one uppercase hex digit (High)

**The most serious finding in this audit. Every link verified by my own measurement.**

**Root cause — `utils/index.ts:501-513`:**

```ts
const UUID_V7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const validID = (val: unknown): string => {
  if (typeof val !== 'string') return '';
  const trimmed = val.trim();
  return UUID_V7_REGEX.test(trimmed) ? trimmed : '';
};
```

The regex carries `/i`, and the function returns the input **verbatim**. Every id
the session carries comes out of a PostgreSQL `uuid` column, which always renders
lowercase. So `validID` mints a second spelling of the same row id: one that
fails a JavaScript `===` but matches the same row in SQL.

**The two runtime halves, both measured on the pinned stack.**

1. Elysia 1.4.29 preserves path-segment case. My first attempt used
   `app.handle()` on a bare instance and got 404 for _every_ case including the
   lowercase control, so the harness was wrong, not the claim — I re-ran it over
   a real listening socket:

```
REAL SOCKET   sent 01A02581 | status 200 | params.id seen: 01A02581-a7ee-723b-a68b-b0dfed4a4df9
REAL SOCKET   sent 01a02581 | status 200 | params.id seen: 01a02581-a7ee-723b-a68b-b0dfed4a4df9
```

2. PostgreSQL compares the two as equal. Against this project's own database
   (`DATABASE_URL` from `.env`):

```
{ "postgres": "reachable",
  "uuid_equal": true,          <- '01a0…'::uuid = '01A0…'::uuid
  "text_equal": false,         <- the JS comparison the guards use
  "normalised": "01a02581-a7ee-723b-a68b-b0dfed4a4df9" }
```

That single asymmetry — `text_equal: false`, `uuid_equal: true` — is the whole
defect.

**Guard 1 (High): self-edit routing → the admin schema.**
`app/api/dash/users/[id]/handler.ts:718-742`:

```ts
const targetId = validID(ctx.params.id);
if (!targetId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);
...
if (userId === targetId) {
  const selfResult = await handleSelfEdit(actor, targetId, body, auditMeta);
  return apiSuccess({ message: MSG_UPDATED, data: selfResult });
}
...
const adminResult = await handleAdminEdit(actor, actorPermissions, ...);
```

`userId === targetId` is the **only** thing routing to `handleSelfEdit`. The two
schemas are not comparable (`utils/validation/auth.ts:175-185`):

```ts
export const adminUpdateUserSchema = updateUserObject
  .extend({ phoneNumber: optionalPhoneSchema.optional() })
  .strict()
  .superRefine(refineUserUpdatePayload); // name/email/isActive/roleId/permissions/password

export const selfUpdateUserSchema = userRoleSchema
  .pick({ name: true })
  .extend({ id: idSchema })
  .strict(); // name only
```

I checked `handleAdminEdit` for a self-target guard and there is none — its only
ownership check is `if (editScope === 'own' && lockedUser.createdBy !== actor.userId)`,
which does not fire at `editScope === 'all'` and does not compare the target to
the actor.

Failure scenario: an actor holding `users.edit` at scope `all` sends
`PUT /api/dash/users/<their-own-id-with-one-hex-letter-uppercased>` with
`{"name":…,"email":…,"isActive":true,"roleId":<their own>,"password":"NewPass!2026"}`.
The self-edit branch is skipped, `adminUpdateUserSchema` accepts the payload,
and the handler writes a new argon2 hash to the actor's own credential row —
**with no current password, no captcha and no OTP.** Those three controls are
exactly what `app/api/dash/users/me/change-password/handler.ts:37-86` enforces
(`requireSession` → `enforceRateLimit` → `verifyTurnstileRequest` →
`verifyLoginAttempt`). The same request with a new `email` bypasses the
re-auth-plus-OTP contact-change flow in `me/change-email`, which then chains into
forgot-password on an attacker-controlled address.

The practical consequence: a stolen session cookie stops being recoverable. The
re-auth gate that exists so cookie theft cannot become account takeover is not
reached. Essentially every UUIDv7 contains at least one `a-f` digit, so the
alternate spelling always exists.

**Guard 2 (Medium-High): `cannotEditOwnRole`.**
`app/api/dash/permissions/[id]/handler.ts:145-160`:

```ts
const validatedDataParsed = adminUpdatePermissionSchema.safeParse({ ...body, id: ctx.params.id });
...
const roleId = validatedDataParsed.data.id;
if (actorRoleId === roleId)
  throw new CustomError(permissionMsg.cannotEditOwnRole, HTTP_STATUS.FORBIDDEN);
```

`id` flows through `idSchema` → `validID` (`utils/validation/rules.ts:64-68`),
so it keeps its case, while `actorRoleId` comes from the `uuid` column. The guard
is skipped and every downstream `eq(roles.id, roleId)` still finds the row. An
actor with `permissions.edit` can deactivate or re-scope their own role —
destroying dashboard access for themselves and everyone sharing it.

**Guard 3 (Medium): `cannotDeleteSelf`.**
`app/api/dash/users/[id]/handler.ts:776-780`:

```ts
const userId = validID(ctx.params.id);
if (!userId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);
if (actorUserId === userId)
  throw new CustomError(userMsg.cannotDeleteSelf, HTTP_STATUS.BAD_REQUEST);
```

Same skip. Per `should-ignore.md` #49 the soft delete is deliberately
unrecoverable and hard-deletes `accounts`, so this is self-destruction with no
undo. Note this is **not** covered by #42: #42's reasoning is that the owner
holds the `system` role and system-role rows are filtered out of the delete
path — that protects the owner, not any other `users.delete` holder.

**The fix belongs at the shared boundary, not at the three call sites.** There
are 20 `validID` call sites; `validID` returning `trimmed.toLowerCase()` makes
every one of them compare canonical forms, and `idSchema`
(`utils/validation/rules.ts:64-68`) inherits it. Two further sites are in the
same class but currently fail _safe_ rather than open —
`app/api/dash/users/[id]/handler.ts:84` (GET: a false `isSelf` makes the read
require `users.view`) and `app/api/dash/users/[id]/sessions/handler.ts:92` — and
they should move with the same change.

CLAUDE.md, Fix discipline: _"A reported defect is a **sample of a class**, not
the class… Fix at a shared boundary where possible."_ This is one root cause and
three broken guards; fixing the three comparisons individually would leave the
class open.

### F30 — The verify-side per-destination budget is shared across all three surfaces, so anyone can cheaply deny a named victim's password recovery (High)

The send side states the rule and enforces it — `lib/rate-limit/api.ts:127-134`:

> _"Recovery's own destination budget. **A separate key, not a slice of the shared
> one**: with a single shared pool two non-recovery surfaces could fill it between
> them and leave password recovery with nothing, which is a targeted
> account-recovery denial. Reserved capacity only counts as reserved if nothing
> else can spend it."_

and implements it at `:171-181`:

```ts
scope: isRecovery ? `otp.send.dest.recovery.${kind}` : `otp.send.dest.${kind}`,
limit: isRecovery ? OTP_RECOVERY_SEND_CAP_PER_HOUR : OTP_DESTINATION_SEND_CAP_PER_HOUR,
```

The verify side has **one** key for everything — `api.ts:212-223`:

```ts
export async function enforceOtpVerifyQuota(opts: { channel; identifier }) {
  await enforceRateLimit({
    scope: `otp.verify.dest.${otpContactKind(opts.channel)}`,
    identifier: opts.identifier.toLowerCase(),
    limit: OTP_DESTINATION_VERIFY_CAP, // 10
    window: OTP_DESTINATION_VERIFY_WINDOW_S, // 600 s
    failClosed: true,
  });
}
```

charged by all three surfaces, each **before** any account lookup:
`app/api/auth/otp/verify/handler.ts:65`,
`app/api/auth/forgot-password/reset/handler.ts:72`,
`lib/auth/passwordless.ts:102`.

**This is a deliberate trade-off, not an oversight, and the report should say
so.** The same function's docstring explains the choice: _"shared across every
purpose so rotating the purpose can't multiply the per-identifier attempt
budget."_ Sharing the key is what stops an attacker getting 3× the guess budget
by rotating `purpose`. The finding is that the two comments, in one file,
prescribe opposite designs for the same shape, and the consequence of the
verify-side choice was not weighed.

Failure scenario, with numbers. The window is fixed and 600 s wide
(`lib/rate-limit/index.ts:46`: `windowStart = now - (now % windowMs)`). An
attacker who knows `victim@gmail.com` POSTs `/api/auth/otp/verify` ten times with
`{channel:'email', email:'victim@gmail.com', code:'000000'}`. Each passes the
per-IP cap (60/min) and charges `otp.verify.dest.email:victim@gmail.com`. After
the tenth, `SQL_CONSUME`'s `WHERE … OR rate_limit.count < 10` stops matching and
`enforceRateLimit` throws 429 for that key. For the rest of the window the
victim's `POST /api/auth/forgot-password/reset` throws 429 at `handler.ts:72` —
before the account lookup and before `processOtpVerify` — so a _correct_ recovery
code cannot be redeemed. Passwordless login and contact verification die with it.
Sustained cost: 10 requests per 600 s, i.e. **1 request/minute per victim**, and
one IP's 60/min budget covers **60 victims simultaneously**.

Why splitting the key would not weaken brute-force resistance: the real authority
is the per-proof database counter, `OTP_MAX_VERIFY_ATTEMPTS = 5`
(`utils/validation/constants.ts:24`, enforced transactionally at
`utils/otp.ts:913`) plus `verification_sessions.verifyAttemptDaily` — both
per-user and both reached _after_ this limiter. `api.ts:225-234` says as much
itself.

### F1 — `/openapi.json` is unauthenticated and publishes the dev + internal maintenance surface (Medium)

`routes.ts:330-336` registers `GET /openapi.json` with `preAuth: 'none'`, and
`lib/http/openapi.ts:395-496` builds the document from the **whole** manifest with
no `NODE_ENV` filter and no allow/deny list. Every route in `ROUTES` is therefore
advertised to an unauthenticated caller in production, including:

- `POST /api/dev/sign-up` — plus its full request schema, because
  `openapi.ts:98` maps it to `devSignUpSchema` and `openapi.ts:111` marks it 201
- `GET /api/dev/email-test/fixed`
- `POST /api/internal/sqlite-sweep` and `POST /api/internal/db-sweep`

Failure scenario: `NODE_ENV=production`, attacker with no session issues
`GET /openapi.json`. The response names both dev endpoints and both maintenance
endpoints, with path parameters, query parameters, request-body schemas and the
exact status codes each returns. The attacker now knows a maintenance token
exists to be attacked and that a dev sign-up route exists to be probed for a
mis-set `NODE_ENV` — neither is discoverable otherwise, because both dev handlers
refuse outside development.

This is not a generic "APIs expose their contract" observation: it defeats a
security decision this codebase makes explicitly, by name, one file away.
`app/api/dev/email-test/fixed/handler.ts:24-33` chose 404 over 403 precisely so
the endpoint is _"indistinguishable from an unrouted path in every other mode"_ —
and `/openapi.json` prints the path. The generator already limits Better Auth's
documented paths to the server's allowlist (`lib/http/openapi.ts:454-484`), but
does not apply the equivalent environment filter to manifest routes.

CLAUDE.md, Fix discipline: _"A reported defect is a **sample of a class**, not
the class… Inventory every site with the same shape."_ The dev-route disclosure
was fixed at each handler; the manifest-driven publisher was not swept.

The deployment-side decision this forces — rate-limit the route at Cloudflare
regardless, and treat blocking it as coupled to F22 rather than as a standalone
hardening step — is `reports/coolify-deployment.md` §5.

### F4 — Bun 1.4: one half-sent request makes `app.stop()` hang, turning every deploy into a 135 s stall that exits 1 and skips the store closes (Medium)

**Bun 1.4 behaviour change that breaks existing code.** Release post, _Upgrading
to 1.4_: _"`server.stop()` now closes idle keep-alive connections immediately. It
closes busy ones once their response is sent. It resolves when the last
connection has closed. Before, it closed only the listener and resolved while
requests were still being served. **It now stays pending on a connection that has
sent part of a request and stopped.** `server.stop(true)` closes such
connections."_

Reproduced on the pinned runtime. Probe: open a TCP socket, write
`"GET / HTTP/1.1\r\nHost: localhost\r\n"` (no terminating CRLF), then call
`server.stop()`.

```
$ bun stopprobe.ts
{"probe":"half-sent request vs stop()","bun":"1.4.0",
 "stopResolvedWithin3s":false,
 "result":"stop() STILL PENDING after 3000ms"}
{"escalation":"stop(true)","resolvedInMs":1}
```

`server.ts:265` is `await app.stop()` with no argument. That preserves in-flight
requests but is not survivable for a stalled one.

Failure scenario: Coolify sends SIGTERM. One connection is mid-handshake — a
half-written request from a scanner, a client that died between headers, a
load-balancer health probe that was cut, or an attacker holding a socket open
with one byte. `await app.stop()` never resolves, so:

1. `drainAfterResponse` at `server.ts:266` is never reached.
2. The `finally` at `server.ts:283-288` never runs — **`closeDatabase`,
   `closeRateLimitStore` and `closeCacheStore` are all skipped**, because the
   forced-shutdown `process.exit(1)` at line 261 terminates the process from
   inside the timer callback and `finally` blocks do not run on `process.exit`.
3. The process sits for the full `SHUTDOWN_TIMEOUT_MS` and then exits **1**.

`SHUTDOWN_TIMEOUT_MS` is `(Math.max(60, MAX_ROUTE_TIMEOUT_SECONDS) + 15) * 1000`
(`server.ts:220-221`). `MAX_ROUTE_TIMEOUT_SECONDS` is 120 — `routes.ts:266`
(upload) and `routes.ts:304` (db-sweep) both declare `timeoutSeconds: 120`. So
the bound is **135 000 ms**, so every routine deploy becomes a 135-second stop
phase ending in a non-zero exit code, from one stalled socket. What that looks
like from the orchestrator's side, and how to tell it apart from a genuinely
failed deploy, is now `reports/coolify-deployment.md` §6.

Note the asymmetry: a timed-out post-response drain is logged without changing
the successful shutdown status (`server.ts:266-275`), while a stalled `stop()`
produces both a non-zero exit and skipped store closes for a cause outside the
application.

The shape of the fix is already named by the release note (`stop(true)` closes
such connections, and resolved in 1 ms in the probe above); a bounded escalation
from `stop()` to `stop(true)` would keep the drain semantics the file argues for
while removing the indefinite hang. Not applying it here — reporting only, as
instructed.

### F6 — The two `.js` files are inside the type-check program but their bodies are never type-checked (Medium)

`tsconfig.json:7` sets `"allowJs": true`; `checkJs` appears nowhere in the file;
`tsconfig.json:33` is `"include": ["**/*.ts", "**/*.tsx", "**/*.mts"]`. Neither
`.js` file carries `// @ts-check` (verified — `lib/env.js` line 1 is a JSDoc
block, `constants/index.js` line 1 is `const MAX_ID = 999_999_999;`).

Both files ARE in the program, pulled in as import dependencies:

```
$ bunx tsc --noEmit --listFiles | grep -iE 'soft-house-dash-3/(lib/env|constants)'
D:/apps/job-app/soft-house-dash-3/constants/index.js
D:/apps/job-app/soft-house-dash-3/lib/env.server.ts
D:/apps/job-app/soft-house-dash-3/lib/env.js
```

Being in the program is not being checked. Proven with a scratch project using
the same flag combination (`allowJs: true`, no `checkJs`, `strict: true`), two
deliberate type errors inside a `.js` file with JSDoc annotations:

```
$ bunx tsc --noEmit                 # the project's flag combination
bad2.ts(5,14): error TS2322: Type 'number' is not assignable to type 'string'.
   <- the .ts error is reported; NOTHING from bad.js

$ bunx tsc --noEmit --checkJs       # same files, checkJs on
bad.js(3,3):  error TS2322: Type 'string' is not assignable to type 'number'.
bad.js(5,27): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.
bad2.ts(5,14): error TS2322: Type 'number' is not assignable to type 'string'.
```

Failure scenario: `lib/env.js` is the module that parses `PUBLIC_ORIGIN` — the
value used as the CORS allowlist (`app.ts:114`), as Better Auth's `baseURL`, and
therefore as the origin cookies are signed against. It is annotated as though it
were checked (`@param {string} raw`, `@returns {string}`, `/** @type {const} */`,
`/** @type {{ name: string, value: string }[]} */`) and those annotations are
decorative under the current config. `bun run build` and `bun run lint` are both
`tsc --noEmit`, and both stay green with an arbitrary type error in this file. A
refactor that makes `parseOrigin` return `URL` instead of `string`, or that lets
`readOriginEnv` return `undefined`, is caught by nothing: not tsc, not ESLint (no
type-aware config — see F8), and `PUBLIC_ORIGIN` has no unit test.

The two files are not equivalent in _why_ they are `.js`. `lib/env.js` was `.js`
because `next.config.js` had to import it; Next is gone (`eslint.config.mjs:14` —
_"`eslint-config-next` is gone with Next itself"_), so the reason was removed and
the file was not converted. `constants/index.js` has no stated reason at all.

CLAUDE.md, Types: _"A type you invented must be earned, not asserted."_ JSDoc
types in an unchecked `.js` file are asserted and never earned — the compiler
never evaluates them.

### F8 — No type-aware ESLint configuration: `no-floating-promises` and the whole thenable family are absent (Medium)

`eslint.config.mjs:53` uses `...tseslintConfigs.recommended`, not
`recommendedTypeChecked`, and no config object sets
`languageOptions.parserOptions.project` / `projectService`. Confirmed from the
resolved config for a real source file:

```
$ bunx eslint --print-config lib/auth.ts   (rule severities extracted)
@typescript-eslint/no-floating-promises             "ABSENT"
@typescript-eslint/no-misused-promises              "ABSENT"
@typescript-eslint/await-thenable                   "ABSENT"
@typescript-eslint/no-unnecessary-condition         "ABSENT"
@typescript-eslint/require-await                    "ABSENT"
@typescript-eslint/no-unsafe-assignment             "ABSENT"
@typescript-eslint/no-unsafe-member-access          "ABSENT"
@typescript-eslint/no-unsafe-argument               "ABSENT"
@typescript-eslint/no-unsafe-return                 "ABSENT"
@typescript-eslint/no-unsafe-call                   "ABSENT"
parserOptions.project:                              "ABSENT"
```

**Reported honestly: the code currently passes these rules.** I enabled them
against `app/ lib/ db/ utils/ types/ routes.ts app.ts server.ts` with a throwaway
config (deleted afterwards; `git status` count unchanged) and got **zero**
`no-floating-promises` and **zero** `no-misused-promises` violations. The only
hits were four benign `require-await` reports
(`app/api/health/storage/handler.ts:49`, `lib/auth.ts:103` and `:205`,
`lib/rate-limit/auth-storage.ts:35`, `lib/rate-limit/index.ts:37`) — async
functions satisfying an async interface without awaiting, which is correct.

So this is a finding about the **gate**, not about today's code, and it is the
kind the brief asks for: _"lint / tsconfig / CI gates configured but not
enforced, or enforced on the wrong thing."_

Failure scenario: every security-relevant operation here is a promise whose
result must be awaited — `enforcePreAuthIpLimit` (`lib/http/adapters/elysia.ts:58`),
`enforceRateLimit`, `assertLiveSession`, the audit writes, every
`withTransaction`. Dropping the `await` on any of them silently converts a
security check into a no-op that still returns 200: an un-awaited
`enforceRateLimit` never rejects, an un-awaited audit write is lost on process
exit, an un-awaited `withTransaction` returns before the transaction commits.
`tsc` reports none of these — an unused promise is a well-typed expression.
`no-floating-promises` is the only tool in the installed toolchain that detects
the class, it is one config line away (the plugin is already a devDependency and
already loaded), and the codebase is currently clean, so enabling it costs
nothing and locks the property in.

CLAUDE.md, Verification: _"'Verify nothing broke' never means `bun tsc`.
Type-checking proves shapes still line up, nothing else."_ The project's gates are
`tsc --noEmit && eslint .` — for this class of defect, exactly the combination
that rule warns about.

### F12 — The `haveIBeenPwned` plugin can never fire, and the hand-rolled replacement fails OPEN where the plugin fails CLOSED (Medium)

`lib/auth.ts:472-475` registers the plugin, with a custom message:

```ts
haveIBeenPwned({ customPasswordCompromisedMessage: MSG_PASSWORD_COMPROMISED }),
```

Read the installed plugin (better-auth 1.7.1,
`node_modules/better-auth/dist/plugins/haveibeenpwned/index.mjs`). It works by
wrapping `ctx.password.hash` and returning early unless the current path is in
its list:

```js
const paths = options?.paths || [
  "/sign-up/email", "/change-password", "/reset-password",
  "/email-otp/reset-password", "/phone-number/reset-password",
  "/admin/create-user", "/admin/set-user-password"
];
…
const c = await getCurrentAuthContext();
if (!c.path || !paths.includes(c.path)) return originalHash(password);
await checkPasswordCompromise(password, options?.customPasswordCompromisedMessage);
```

No `paths` option is passed, so the default list applies. The reachable Better
Auth surface is `lib/auth/allowed-paths.ts:16-22`:

```ts
export const BETTER_AUTH_ALLOWED_PATHS = [
  '/get-session',
  '/sign-out',
  '/sign-in/email',
  '/passwordless/verify',
] as const;
```

The intersection of the two lists is **empty**. And the allowlist is enforced
twice before the plugin could matter: `app.ts:382` only calls `auth.handler` when
`prefix.paths.includes(subPath)`, and `lib/auth.ts:109-113` throws 404 for
anything else. So no request can reach a path on which this plugin does anything.
It is inert configuration.

Failure scenario: the plugin's presence reads as "compromised-password checking
is enabled via the auth library". It is not; the real check is
`lib/auth/check-password.ts`, called by hand from four handlers
(`app/api/dash/users/handler.ts:178`,
`app/api/dash/users/[id]/handler.ts:332`,
`app/api/dash/users/me/change-password/handler.ts:64`,
`app/api/auth/forgot-password/reset/handler.ts:79`). The two implementations do
the same k-anonymity lookup against the same endpoint with the same
`Add-Padding` header — and **disagree on the security-critical case**:

|                       | plugin (dead)                                                    | `check-password.ts` (live)                                  |
| --------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| HIBP returns an error | `throw new APIError("INTERNAL_SERVER_ERROR")` — fails **closed** | logs `hibp.degraded`, loop exits, `return` — fails **open** |
| retries               | none                                                             | 3 attempts, 1 s timeout each                                |

So the copy that survives is the permissive one, and the copy that would refuse a
password it could not check is the one that cannot run. During a HIBP outage,
every password-setting path in the application accepts a known-breached password.

Two CLAUDE.md rules apply. Consistency: _"Find the existing implementation before
writing a new one. Reimplementing inline what a helper already provides is a
defect even when it works — the copies drift, and the real call count becomes
invisible."_ Both halves happened: they drifted on failure mode, and the plugin
registration makes the real call count look like five when it is four. And Fix
discipline: _"Never narrow an existing contract…"_ is not the issue here; the
issue is that the dead registration is load-bearing documentation that is wrong.

(The fail-open behaviour itself is `should-ignore.md` #52 — see F18 for why that
entry no longer describes the code. The _duplication_ and the _inert plugin_ are
not in that entry.)

### F14 — `lib/r2/client.ts` sits outside every convention the rest of the codebase follows (Medium)

This file reads as though written by a different person than everything around
it, and CLAUDE.md's Consistency section is explicit that this is a defect in
itself: _"The codebase should read as though one person wrote it."_ Five concrete
divergences remain in this file:

**a. `deleteFromR2` is the one R2 function with no configuration guard.**
`uploadToR2` (`:61-64`), `copyFileInR2` (`:117-121`) and `getPresignedUrl`
(`:156-160`) all begin with `if (!validateR2Config) throw new Error('R2 is not
configured…')`. `deleteFromR2` (`:87-106`) does not. Failure scenario: on a
deploy with `R2_*` unset, the retention sweep (`db/maintenance.ts:280` is the
production caller) issues a DeleteObject to the literal host
`https://undefined.r2.cloudflarestorage.com` with `accessKeyId: ''` and fails
with an opaque SDK/DNS error, where every sibling function would have failed with
the sentence naming the cause. Already known and written down in a test helper —
`tests/helpers/object-store.ts:13`: _"`deleteFromR2` has no such [guard]"_ — but
not fixed and not in `should-ignore.md`.

**b. Four `try { … } catch (error) { throw error; }` blocks.** Lines 83, 105,
136, 190 (`grep -n 'throw error;' lib/r2/client.ts` returns exactly those four).
Every one is a no-op that only widens the stack. This is a class of four, not one
slip.

**c. R2 is the only env group with no boot-time validation.**
`:10-15` reads all six `R2_*` variables straight from `process.env`, and
`rg` confirms they appear nowhere else in application code.
`lib/env.server.ts:8-14` states its contract — _"Hard-fail at module-load time
when a required server env var is missing… Imported by every server-only module
that depends on these values (auth, DB, rate-limit, captcha, OTP)"_ — and R2 is
absent from that list. So a deploy missing R2 credentials boots green, passes the
health check, and fails on the first upload.

**d. Logging convention.** `:167-171` uses
`console.error('[R2] Expiry time …')` — a plain interpolated string, with an
`[R2]` prefix used nowhere else, at `error` level for a value that was
successfully clamped (not an error). Every other module in this codebase logs
`console.error(JSON.stringify({ msg: …, errorClass: … }))`.

**e. `getR2ConfigStatus` leaks values where it reports presence.** `:302-311`
returns `accountId`/`accessKeyId`/`secretAccessKey` as booleans but
`publicBucket`, `privateBucket` and `publicUrl` as their **actual values**. It
has no HTTP caller today (only `scripts/probe/dev-live/database/retention-sweep.dev-probe.ts:267`),
so this is latent rather than live — but the shape invites exposure, and
`app/api/health/storage/handler.ts:18-19` states the opposite rule for this
codebase: _"The body reports status only: no paths, schema contents, or row
counts."_

### F22 — Closing `/openapi.json` (F1) turns the upload route into an enumeration oracle; the two are coupled and only one side knows it (Medium)

Reported as its own finding because acting on F1 in isolation creates a new
defect, and nothing in F1's own neighbourhood says so.

`app/api/upload/image/handler.ts:41-52` documents the coupling explicitly:

> _**Runs BEFORE the session check, which inverts the order every other handler
> here uses**_ _(`requirePermission` first, input validation after). Unavoidable:
> the resource IS the subject of the permission check… The visible consequence is
> that an unauthenticated caller gets 400 for an unknown resource and 401 for a
> known one (measured), which distinguishes valid page names._
>
> _That is not a leak today, for a specific reason: the valid names are published
> in `/openapi.json`, which is a public route. It WOULD become an enumeration
> oracle if `DASHBOARD_PAGES` ever gained a name that is not public, **or if the
> OpenAPI route were closed**._

So the handler's security argument is _"this leak is free because a public route
already leaks it."_ F1's finding is that the same public route leaks things it
should not (the dev and internal-maintenance surface). Both are correct, and
together they mean there is no change to `/openapi.json` that is safe on its own:

- Close or gate `/openapi.json` → `POST /api/upload/image?resource=X` becomes a
  working unauthenticated oracle for the `DASHBOARD_PAGES` key set, by the
  handler's own measurement (400 vs 401).
- Leave it public → the dev routes and `/api/internal/*` stay advertised (F1).

Failure scenario, concretely: someone reads F1, adds a `NODE_ENV === 'production'`
guard to the OpenAPI handler, ships it. An unauthenticated attacker then walks
candidate resource names against the upload route and reads the status code:
`400` for `foo`, `401` for a real page name. `routes.ts:255-263` declares
`resource` as `enum: DASHBOARD_PAGE_NAMES`, and `requireUploadResource`
(`:54-59`) throws `BAD_REQUEST` before `requireAnyPermission` (`:64`) can throw
`UNAUTHORIZED`. The oracle is exact, unauthenticated, and bounded only by the
per-IP pre-auth limit of 120/60 s.

The handler already names the fix — _"Either change means moving the session
check ahead of this — at the cost of a second session lookup"_ — so the two
findings have one combined remedy, and applying F1 without it regresses. The
runbook states the coupling as an operational rule so an edge change cannot be
made in ignorance of it (`reports/coolify-deployment.md` §5).

CLAUDE.md, Fix discipline: _"Sweep the class, not the instance… Fix at a shared
boundary where possible; list what you deferred."_ The shared boundary here is
"what may an unauthenticated caller learn about the route table", and it has two
sites, not one.

### F25 — The three OTP delivery channels are the only outbound calls in the codebase with no timeout, and Bun 1.4 `fetch()` has no default (Medium)

The rule exists in this codebase, stated twice, with reasoning that names this
exact hazard:

- `lib/captcha.ts:15-17` — _"Cap the outbound siteverify call so a Cloudflare
  slowdown can't stall OTP/auth handlers indefinitely"_ →
  `SITEVERIFY_TIMEOUT_MS = 3000`, applied via `AbortController` at `:39-46`.
- `lib/auth/check-password.ts:10-12` — _"Per-attempt timeout. Three attempts ×
  ~1s + backoff stays under ~3.5s total so a HIBP outage never stalls user
  create/update for many seconds"_ → `HIBP_ATTEMPT_TIMEOUT_MS = 1000`, applied at
  `:28-41`.

The three OTP senders follow neither:

**a. SMS — `utils/otp.ts:121-134`.** `await fetch('https://apis.deewan.sa/sms/v1/messages', { method, headers, body })`
— no `signal`, no timeout.

**b. WhatsApp — `utils/otp.ts:148-155`.** `await fetch('https://services.rmz.one/api/whatsapp/send', { method, headers, body })`
— no `signal`, no timeout.

**c. Email — `utils/otp.ts:28-40`.** The nodemailer transport is created with
only `service` and `auth`:

```ts
_transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
```

No `connectionTimeout`, `greetingTimeout` or `socketTimeout`. Read from the
**installed** package (nodemailer 9.0.5,
`node_modules/nodemailer/lib/smtp-connection/index.js:14-16`):

```js
const CONNECTION_TIMEOUT = 2 * 60 * 1000; // 120 s
const SOCKET_TIMEOUT = 10 * 60 * 1000; // 600 s
const GREETING_TIMEOUT = 30 * 1000; // 30 s
```

applied at `:415`, `:847`, `:855`, `:1105` as `this.options.X || DEFAULT`. With
none supplied, all three defaults apply — a stalled SMTP socket is held for **10
minutes**.

For the two `fetch` sites, there is no library default to fall back on. Probed on
the pinned runtime against a socket that accepts and never replies:

```
$ bun fetchto.ts
{"bun":"1.4.0","elapsedMs":20191,"outcome":"STILL PENDING at 20000ms"}
```

So Bun 1.4's `fetch()` imposes no timeout in the 0–20 s range — a hung provider
hangs the handler.

Failure scenario, concrete: `POST /api/auth/otp/send` declares no
`timeoutSeconds` in `routes.ts:71-77`, so it inherits `IDLE_TIMEOUT_SECONDS = 60`
(`server.ts:214`). The provider accepts the TCP connection and stops responding.
The transaction has already committed — `utils/otp.ts:579` closes it and `:610`
is `await sendOtp(channel, sendTo, otpCode, smsMessage)`, deliberately _after_
the commit — so the row is durable with `nextAllowedAt` set. Result:

1. The user is throttled for the backoff window (`calculateNextAllowedAt`,
   30 s on the first attempt) having received no code.
2. The client's connection can be dropped at the 60-second ceiling with an empty
   body and no application error response.
3. The handler keeps running. For SMS/WhatsApp there is nothing to stop it; for
   email it can sit for up to 600 s.
4. Those in-flight requests are "busy" connections, so under Bun 1.4 they also
   hold `app.stop()` open during a deploy (F4's mechanism, here from the
   application's own side).

This is the _same class_ the file already fixed once, in the same function.
`utils/otp.ts:600-609` explains why delivery was moved out of the transaction:
_"`sendOtp` is an SMTP session or a provider HTTPS call, so it can take seconds —
an SMTP timeout, tens… Ten concurrent sends against a hanging provider exhausted
the pool… A provider outage became a full-application outage."_ The author
identified an unbounded call, and relocated it instead of bounding it — so the
pool-exhaustion instance is fixed while the unbounded call itself remains.

CLAUDE.md, Fix discipline: _"A reported defect is a **sample of a class**, not
the class. Sweep the class, not the instance… Inventory every site with the same
shape."_ The class is "outbound call on a request path"; it has five members, and
two of the five carry the guard.

(Related: `should-ignore.md` #52's original complaint was precisely _"no
`AbortSignal`"_ on the HIBP call. That one was fixed — see F18 — and the fix was
not swept to the OTP senders.)

### F28 — `sanitizeFilename` truncates by UTF-16 code unit and can emit a lone surrogate, which the S3 SDK turns into a 500 (Medium)

`utils/sanitize-filename.ts:19-24`:

```ts
const sanitized = nameWithoutExt
  .replaceAll('..', '')
  .replaceAll(/[^\p{L}\p{N}\p{Zs}_\-()]/gu, '')
  .replaceAll(/\s+/g, ' ')
  .trim()
  .slice(0, maxLength); // code units, not code points
```

`\p{L}` and `\p{N}` admit astral characters (U+20000 is `\p{Lo}`), each two code
units, so `slice(0, 50)` can land between a surrogate pair. Measured with a
filename of `'a' + '\u{20000}'.repeat(30) + '.png'`:

```
{ "inputCodeUnits": 65,
  "outputCodeUnits": 50,
  "outputIsWellFormed": false,
  "lastUnitHex": "d840",
  "loneSurrogateEmitted": true,
  "encodeURIComponentThrows": true }
```

Failure scenario: upload a genuine PNG (so the MIME and magic-byte checks at
`app/api/upload/image/handler.ts:120-136` pass) whose multipart filename ends in
a truncated astral character. `handler.ts:111` sanitises it, and
`lib/r2/upload-helper.ts:160-162` builds the object key
`temp/${shortId}_${safeName}.${extension}`, which reaches
`uploadToR2({ key })` → `lib/r2/client.ts:69-79`
`new PutObjectCommand({ Key: key })`. A lone surrogate cannot be
percent-encoded — `encodeURIComponent` on the composed key throws `URIError`
(measured above). `URIError` is not a `CustomError`, so
`lib/r2/upload-helper.ts:366-369` logs it and rethrows a generic 500.

**Attribution, stated precisely:** I verified the lone surrogate and the
`URIError` from `encodeURIComponent` myself. That the AWS SDK is the throw site
on this exact path was measured by a subagent, not by me — it reported
`"temp/bad_a\ud840.webp" => URIError | String contained an illegal UTF-16
sequence.` before any network I/O, against a control key that failed with
`ECONNREFUSED` instead. I consider the class established either way: a key that
cannot be percent-encoded cannot be put on the wire, so some layer must throw.

The result is a deterministic 500 for attacker-chosen input, after the server has
already paid for buffering, `optimizeImage` and `generateBlurhash` — the same
"deterministic 500 any authorized caller could trigger" that
`lib/data-table/column-specs.ts:5-19` exists to prevent elsewhere.

Secondary, same line: `.trim()` runs **before** `.slice()`, so truncation can
reintroduce a trailing space. Measured:
`sanitizeFilename('a'.repeat(49) + ' b')` → `"aaa…a "`.

### F29 — `zodIssueMessage` reflects unbounded, attacker-controlled JSON key names into the 422 response body (Medium)

`utils/validation/rules.ts:45-50`:

```ts
if (issue?.code === 'unrecognized_keys')
  return `حقول غير معروفة في الطلب: ${issue.keys.join('، ')}`;
```

Every other client-facing message in this API is a server-owned constant
(`utils/api-messages.ts`, `app/api/**/messages.ts`). This one interpolates raw
request input with no length bound and no character filter, and the result
becomes `CustomError.message` → `handleApiError` → the client's `message` field.
It is reachable from every `.strict()` schema — `adminUpdateUserSchema`,
`selfUpdateUserSchema`, `adminUpdatePermissionSchema` and the nested permission
schemas.

Measured against the real `selfUpdateUserSchema`:

```
body: {"id":"<uuid>","name":"ok name","<img src=x onerror=alert(1)>":1,"a\r\nSet-Cookie: x=y":1}
message: "حقول غير معروفة في الطلب: <img src=x onerror=alert(1)>، a\r\nSet-Cookie: x=y"

body with one 200 000-character key name
message length: 200 026 characters
```

Failure scenario: two distinct outcomes, both concrete. (a) A ~200 KB request
body produces a ~200 KB response `message`, amplified through the JSON envelope —
there is no cap anywhere between the schema and `Response.json`, and the route's
own body limit (8 MiB, `app.ts:138`) is the only bound, so a single request can
force a multi-megabyte response. (b) Untrusted text is reflected verbatim into a
field the dashboard displays.

**Flagging my uncertainty explicitly, per CLAUDE.md Baseline 3: I do not know
whether the front-end renders `message` as HTML.** There is no front-end in this
repository to check. If it is rendered as text (React's default) this is not
XSS; if any consumer uses `dangerouslySetInnerHTML` or `v-html` on an API
message, it is. The CRLF is JSON-escaped, so header injection is _not_ possible.
The unbounded length is a defect regardless of how the message is rendered.

### F31 — All three OTP send handlers report `200 "code sent"` for a malformed body and for OTP being switched off (Medium)

`app/api/auth/otp/send/handler.ts:176-192` (identical shape in
`forgot-password/send/handler.ts` and `passwordless/send/handler.ts`):

```ts
} catch (error) {
  await ensureMinDelay(Date.now() - start);
  // Collapse unknown-identifier / already-verified to the generic success so
  // existence can't be probed. …
  if (error instanceof CustomError &&
      (error.status === HTTP_STATUS.BAD_REQUEST ||
       error.status === HTTP_STATUS.NOT_FOUND)) {
    return apiSuccess({ message: otpMsg.sendSuccess, data: GENERIC_SEND_DATA });
  }
  return handleApiError(error, otpMsg.sendError);
}
```

The stated purpose — collapsing _unknown-identifier / already-verified_ — is
already served somewhere else: those two cases return `genericResponse()`
**inline** at `:109-116` and never throw. Tracing every throw that can actually
reach this catch leaves exactly two, and neither depends on account existence:

- **404**, from `:41-42` `if (!OTP_ENABLED) throw new CustomError(MSG_PAGE_NOT_FOUND, 404)`
- **400**, from `requireJsonBody` (`utils/api-response.ts:45-48`)

Failure scenario A: a client posts without `Content-Type: application/json`.
`withBodyPolicy` hands the handler the constant-null reader
(`lib/http/request.ts:66,91`), `readJson()` returns `null`, `requireJsonBody`
throws 400 — and the caller receives
`200 {"success":true,"message":"تم إرسال رمز التحقق بنجاح","data":{"nextAllowedIn":30}}`.
The client shows a code-entry screen and starts a 30-second countdown for a
message that was never sent. Same for a body of `null`, `[]` or `"x"`.

Failure scenario B, the worse one: deploy with OTP channels unconfigured so
`OTP_ENABLED === false`. Every recovery request then answers `200 "code sent"`
forever, with no 404, no log line and nothing in the health check. **Account
recovery is completely unavailable and the endpoint reports success**, which is
precisely the "silent fallback that hides a failure" the audit brief names under
Stability.

Distinct from `should-ignore.md` #58, which is about collapsing **429** and is
explicitly a privacy contract ("real / fake / verified / throttled"). A malformed
body and a disabled feature are neither.

### F32 — A NUL byte in any data-table search or filter value reaches a bound parameter and returns a deterministic 500 (Medium)

The value pipeline bounds _length_ and escapes _LIKE metacharacters_, and filters
no control characters. PostgreSQL rejects 0x00 in a text parameter at Bind time.

Two independent entry paths. Quick search, `db/queries/data-table.ts:97-110`:

```ts
const rawSearch = searchParams.get('search')?.trim() ?? '';   // trim() does not strip U+0000
...
const escaped = escapeLike(search);
conditions.push(ilike(col as AnyColumn, `%${escaped}%`));
```

and filter values, where `safeString` (`lib/data-table/parsers.ts:39-49`) is the
only sanitiser — trim plus length — feeding `escapeLike`
(`lib/data-table/filter-columns.ts:79-82`):

```ts
export function escapeLike(value: string): string {
  return value.replaceAll(/[%_\\]/g, String.raw`\$&`); // %, _, \ only
}
```

I measured the string pipeline directly:

```
input:  new URL('http://x/?search=ab%00cd').searchParams.get('search')?.trim()
raw codepoints:       [ 97, 98, 0, 99, 100 ]
after escapeLike:     [ 97, 98, 0, 99, 100 ]
bound param would be: [ 37, 97, 98, 0, 99, 100, 37 ]     // %ab\0cd%
escapeLike('%_\\'):   \%\_\\                              // metacharacters ARE handled
```

and the database half against this project's own PostgreSQL:

```
NUL-bearing: {"outcome":"REJECTED","errno":"22021","code":"ERR_POSTGRES_SERVER_ERROR",
              "message":"invalid byte sequence for encoding \"UTF8\": 0x00","ctor":"PostgresError"}
control:     {"outcome":"accepted","rows":0}
```

Failure scenario: `GET /api/dash/users?search=ab%00cd` (or the same byte inside a
`filters` value, or in an `eq` on `email`, which has no `%` wrapper at all).
`PostgresError` is not a `CustomError`, so `app/api/dash/users/handler.ts:136-138`
and `app/api/dash/permissions/handler.ts:109-111` fall through to
`handleApiError` → **HTTP 500** plus a stack trace in the log, on a path whose
declared contract is 422. Any authenticated caller can trigger it at will.

The project already owns the filter that removes this: `sanitizeStrict`
(`utils/validation/rules.ts:15-23`) has an allowlist that drops U+0000, and every
Zod-validated _write_ path runs it. The data-table _read_ path is the only place
a raw client string reaches a bound parameter without it — and it is reachable
from both the `search` and `filters` channels.

CLAUDE.md, Consistency: _"Find the existing implementation before writing a new
one."_ `escapeLike` was written to solve the LIKE-metacharacter half and the
control-character half was not carried over from the helper that already had it.

### F33 — `notILike` and `ne` silently drop NULL rows, in a module that handles NULL correctly for `isEmpty` (Medium)

`lib/data-table/filter-columns.ts:152-154` and `:182`:

```ts
case 'notILike': {
  return notIlike(column, `%${escapeLike(value as string)}%`);
}
...
return negated ? ne(column, value) : eq(column, value);
```

versus `:250-259`, which goes out of its way for exactly this:

```ts
case 'isEmpty': {
  return isStringLike(spec.type) ? isEmpty(column) : isNull(column);
}
```

SQL three-valued logic: `NULL NOT ILIKE '%abc%'` evaluates to NULL, not TRUE, so
the row is excluded from a predicate that plainly describes it.

The reachable nullable column is `roles.description` — `db/schema.ts:490` is
`description: varchar('description', { length: ROLE_DESCRIPTION_MAX })` with no
`.notNull()` (verified), `utils/validation/permissions.ts:159-169` makes it
`.optional().nullish()` so a POST without one writes NULL, and it is registered
filterable at `app/api/dash/permissions/handler.ts:42`.

Failure scenario: a role created without a description is **absent** from the
result of "description does not contain abc" — a list it obviously belongs in —
and absent from `meta.total`, returned with a 200. An operator filtering to find
roles that lack a given description gets a silently incomplete list. Same for the
`ne` operator. Every other text column in scope is `notNull` today, so this is
one column now; the defect is in the shared operator, so every future nullable
text column inherits it.

### F39 — Public `verify_contact` sends starve the shared per-destination send budget, throttling a named victim's passwordless login to one code per hour (Medium)

The mirror image of F30, on the send side, and it survives the reservation
described there. `lib/rate-limit/api.ts:120-136`:

```ts
const OTP_DESTINATION_SEND_CAP_PER_HOUR = 6; // shared by every NON-recovery surface
const OTP_RECOVERY_SEND_CAP_PER_HOUR = 5; // its own key — reserved
const OTP_SURFACE_SEND_CAP_PER_HOUR = 5; // per surface
```

`recovery` gets `otp.send.dest.recovery.${kind}`; `verify_contact`,
`passwordless` and `contact_change` share `otp.send.dest.${kind}` with a limit of
6, of which one surface may take 5. `verify_contact` is the unauthenticated
public surface, and its quota is charged **pre-lookup** at
`app/api/auth/otp/send/handler.ts:83-87` — before the "already verified → generic
response" early return at `:109-116`, so the charge lands even though nothing is
sent.

Failure scenario: an attacker POSTs
`/api/auth/otp/send {channel:'email', email:'victim@gmail.com'}` five times an
hour. The victim's address is already verified, so no message is delivered and
the attacker pays nothing. After the fifth request
`otp.send.surface.verify_contact.email:victim@gmail.com` is 5/5 and
`otp.send.dest.email:victim@gmail.com` is 5/6. The victim's passwordless-login
send (`app/api/auth/passwordless/send/handler.ts:69-73`) then gets **one** code
that hour instead of five, and `contact_change` gets none. Cost: five requests
per hour, well inside the 60/min per-IP cap.

Recovery is genuinely protected here — that is what the reserved key buys. The
finding is that the same reasoning was applied to one of four surfaces.

### F44 — Bun 1.4's `Bun.cron()` can replace two internet-reachable maintenance endpoints (Medium)

`runMaintenanceSweep` is already independent of its trigger, and
`reusePort: false` enforces the single-process assumption required by an
in-process schedule. Bun 1.4 supplies a runtime-level cron API, so adopting it
would not couple the sweep to Elysia.

From the release post: _"Bun.cron() registers a scheduled job with the operating
system… You can also pass a function instead of a file. Bun runs it on the event
loop, with no system cron involved. **Jobs never overlap**, and `using` stops the
job when it goes out of scope"_, plus `job.unref()` and `job.stop()`.
Non-overlap matters here — `runMaintenanceSweep` is a bounded batch loop
(`lib/sqlite/sweep.ts:54-67`) that must not run twice concurrently.

What adopting it would concretely remove:

- `POST /api/internal/sqlite-sweep` and `POST /api/internal/db-sweep` as
  unauthenticated-reachable routes (`routes.ts:288-305`, `preAuth: 'none'`);
- `SQLITE_MAINTENANCE_TOKEN` and every gap in **F9** (no length floor, no
  throttle, no failure logging);
- both paths from the public contract in **F1**;
- one gate of the deployment runbook and its `/api/internal/*` edge rule. The
  deployment half of this decision is recorded under "Settled decisions" in
  `reports/coolify-deployment.md`, which is where it now sits.

**The one Bun 1.4 caveat an adopter must not miss**, from _Upgrading to 1.4_:
_"`Bun.cron.parse()` and in-process `Bun.cron()` now use local time… Before, they
used UTC… To keep the old times, pass `{ tz: 'UTC' }`."_ This project already has
a timezone concept (`resolveBusinessTimezone`, `utils/config.ts`), so the
schedule must state its zone explicitly rather than inherit the container's.

### F45 — Tracked documentation still cites the gitignored `TODO.md` as a decision register (Medium)

The source-comment part of this finding is resolved: no code comment now
outsources its rationale to `TODO.md`. Six non-comment references remain in
`bench/image/README.md`, `bench/uuid/README.md`, and
`docs/framework-migration.md`. They are outside this comment-only write scope,
but still point tracked documentation at a file Git ignores.

### F3 — The two dev-only endpoints answer a production probe differently (Low)

Same class, sibling files, opposite decisions:

- `app/api/dev/email-test/fixed/handler.ts:29-33` → `404 MSG_PAGE_NOT_FOUND`,
  with a comment explaining that 403 _"confirms the route exists to anyone who
  asks"_.
- `app/api/dev/sign-up/handler.ts:45-50` → `403` with the distinctive body
  `'هذه النقطة متاحة فقط في بيئة التطوير'`.

Failure scenario: in production, `POST /api/dev/sign-up` with no body returns 403
and that literal message. `POST /api/dash/nonexistent` returns 404. The response
is a positive existence oracle for a route whose sibling was deliberately made
silent for that exact reason — and it names its own purpose in the message.

CLAUDE.md, Consistency: _"Follow the established pattern, not your preferred
one… where patterns compete, adopt the dominant one and note the divergence."_
The dominant pattern here is the documented one, and the divergence is not noted.
The interim mitigation — block `/api/dev/` at the edge so the divergence is not
visible from the internet — is `reports/coolify-deployment.md` §5.

### F7 — `constants/index.js` is a one-constant barrel with one consumer, in the wrong language and the wrong place (Low)

Whole file:

```js
const MAX_ID = 999_999_999;

export { MAX_ID };
```

Sole consumer, verified by ripgrep across the repo:

```
$ rg -n "@/constants|constants/index" --glob '!node_modules' .
utils/index.ts:4:import { MAX_ID } from '@/constants';
```

Failure scenario: a maintainability defect rather than a runtime one, and the
exact example the audit brief names. A top-level `constants/` directory implies a
shared constant namespace and there is none — one numeric bound, one importer,
while `utils/validation/constants.ts` already exists as the home for exactly this
kind of value (it holds `NAME_MAX`, `ROLE_NAME_MIN` and the other input bounds).
The cost is that the next author needing a shared bound has two plausible places
to put it and no rule to choose between them, which is how the second copy of a
limit appears. It also drags a second unchecked `.js` file into the program for
one line (see F6).

CLAUDE.md, Consistency: _"Find the existing implementation before writing a new
one… If the helper almost fits, extend it instead of building a parallel path."_
`utils/validation/constants.ts` is that helper.

### F9 — `SQLITE_MAINTENANCE_TOKEN` has no length floor, and the endpoints it guards are unthrottled and log no failures (Low)

Three gaps compounding in one trust boundary:

1. **No floor.** `lib/env.server.ts:192-193` is
   `export const SQLITE_MAINTENANCE_TOKEN = process.env.SQLITE_MAINTENANCE_TOKEN ?? ''`
   — no minimum length, no format rule. The same file establishes the opposite
   standard 150 lines earlier for the other bearer secret
   (`lib/env.server.ts:39`: `BETTER_AUTH_SECRET_MIN_LENGTH = 32`, reasoning: _"a
   floor, not a strength test — no regex can prove randomness"_). That reasoning
   applies verbatim here and is not applied. `SQLITE_MAINTENANCE_TOKEN=x` is
   accepted at boot.
2. **No throttle.** `routes.ts:288-305` declares `preAuth: 'none'` for both
   `POST /api/internal/sqlite-sweep` and `POST /api/internal/db-sweep`, and
   `app/api/health/storage/handler.ts:50-59` gates `?deep=1` on the same token
   behind `preAuth: 'none'` (`routes.ts:273-288`). Token guesses are therefore
   unlimited: `lib/sqlite/maintenance-token.ts` is the only check and nothing
   admission-limits the requests reaching it.
3. **No record.** Both handlers return 401 (`sqlite-sweep/handler.ts:38-42`,
   `db-sweep/handler.ts:24-28`) with no `console.error` and no audit write, so an
   exhaustive guessing run leaves nothing in the logs. Every other rejection path
   in this codebase logs its class.

Failure scenario: operator sets a short human-chosen token. An attacker reads
`/openapi.json` (F1), learns both `/api/internal/*` paths exist, and guesses at
full request rate against a comparison that is constant-time but unthrottled and
unlogged. The operator-side half — that the generated value is the entire control
until a floor exists, and how to generate it — is
`reports/coolify-deployment.md` gate 4.

**Impact is genuinely bounded, and I checked rather than assumed it.** Both sweeps
delete only already-due rows: `lib/sqlite/sweep.ts:54-67` runs a bounded delete
parameterised by `cutoff`, and `db/maintenance.ts:54-56` uses fixed retention
windows (`SESSION_GRACE = '30 days'`, `VERIFICATION_SESSION_TTL = '1 day'`,
`TEMP_FILE_TTL = '24 hours'`). A compromised token therefore cannot reset a live
rate-limit counter, cannot delete an unexpired session, and cannot delete a
recent upload — it can only run a job early that deletes what the next scheduled
run would delete anyway. That is why this is Low, not High: the finding is the
missing floor and the missing detection, not a data-loss path.

CLAUDE.md, Fix discipline: _"Sweep the class, not the instance."_ The secret-floor
rule exists in this file for one of the two bearer secrets it defines.

### F10 — `page.out` is a 1.3 MB scraped HTML page committed to the repository (Low)

```
$ git ls-files --error-unmatch page.out
page.out
$ ls -la page.out
-rw-r--r-- 1 Administrator 197121 1327209 Aug 21 10:35 page.out
$ file page.out
page.out: HTML document, Unicode text, UTF-8 text, with very long lines (32455)
$ head -c 200 page.out
<!DOCTYPE html><html lang="en" class="inter_… dark" data-banner-state="visible" data-assistant-state="closed" data-page-mode
```

Tracked, 1.3 MB, a saved web page unrelated to the application. Nothing imports
it and `.gitignore` does not cover it.

Failure scenario: CLAUDE.md §1 states this repository _"is the **starter kit** for
most of my upcoming projects."_ Every future project cloned from it inherits
1.3 MB of an unrelated saved HTML page in its root, in its history, and in every
CI checkout. The same root also carries five untracked prompt scratch files
(`prompt-fix.md`, `prompt-marge.md`, `prompt-report.md`,
`prompt-review-commit.md`, `read.txt`) and an untracked `.tmp-probe/` directory
that knip reports as unused:

```
$ bunx knip --no-progress
Unused files (4)
.tmp-probe/activity.ts
.tmp-probe/limits.ts
.tmp-probe/probe-extract.ts
.tmp-probe/probe-jsonb.ts
```

(Recorded for accuracy: knip runs fine here. A first attempt through a subagent
hit `RangeError: Array buffer allocation failed` in `oxc-parser` under concurrent
memory pressure; not reproducible, so no finding is made about knip's usability.)

### F11 — CI gates Knip's unused-file check but leaves its export checks advisory (Low)

`.github/workflows/ci.yml` runs `bunx knip --include files`, while the full
`bun run find:unused-files` command also checks unused exports and types. Those
categories can therefore regress without failing CI. Widen the gate once the
remaining export findings are resolved.

### F15 — Four exported functions in `lib/r2/client.ts` have no production caller and each is hidden from the dead-code scanner with `@knipignore` (Low)

Verified by ripgrep with `bench/`, `tests/`, `reports/` and `*.md` excluded — the
only hits are the definitions themselves:

| export              | line | `@knipignore` at | production callers |
| ------------------- | ---- | ---------------- | ------------------ |
| `copyFileInR2`      | 110  | 109              | none               |
| `getPresignedUrl`   | 141  | 140              | none               |
| `getPublicUrl`      | 195  | 194              | none               |
| `isAllowedMimeType` | 207  | 206              | none               |

`tests/helpers/object-store.ts:54` independently confirms one of them:
_"`getPresignedUrl` has no production caller to vary it for."_

Failure scenario: `isAllowedMimeType` is the one that matters, because it is a
security helper with a **fail-open default** —
`if (!allowedTypes || allowedTypes.length === 0) return true` (`:211-213`). It is
dead today, so it protects nothing and harms
nothing. The risk is the shape it leaves lying around: the next author who needs
MIME filtering finds a ready-made helper whose empty-list case admits everything,
and a caller that resolves its allowlist from configuration would silently accept
any upload if that configuration were missing. The real MIME gate lives elsewhere
(`utils/images/config.ts` / the upload handler), so this is also a second,
divergent implementation of the same concept — the F12 pattern again.

The `@knipignore` markers are what make this invisible: 20 of them across the
repo, four in this one file. CI's file-only Knip gate does not inspect exports,
so the annotations still hide these from the gated category.

Same class, worth naming because it is more dangerous than a dead function:
`utils/validation/rules.ts:163-164` is `/** @knipignore */ export const
richTextSchema = z.any();` — an exported _validation schema_ that validates
nothing, with no callers, kept alive by a suppression. A future handler that
picks it up gets a schema which accepts arbitrary input while looking like
validation.

### F17 — `@tanstack/react-table` is a production dependency for one type-only import, in a repository with no React (Low)

`types/data-table.ts:3` is the only import site anywhere:

```ts
import type { ColumnSort } from '@tanstack/react-table';
```

used once, at `types/data-table.ts:9`:

```ts
export interface ExtendedColumnSort<TData> extends Omit<ColumnSort, 'id'> {
```

`ColumnSort` is `{ id: string; desc: boolean }`, and the `Omit<…, 'id'>` discards
half of it — so the entire value drawn from the package is `{ desc: boolean }`.

There is no React in this repository: no `.tsx` file exists
(`rg --files --glob '*.tsx'` → empty), no module imports `react`, and `react` is
not in `dependencies` or `devDependencies`.

Failure scenario: a React table library sits in `dependencies` (not
`devDependencies`), so it ships. Bun 1.4's new `bun prune --production` cannot
remove it, `bun audit` includes it and its transitive tree in the attack surface
this project must track, and Renovate raises PRs for it. All of that is carried
for `{ desc: boolean }`. The audit brief's placement dimension names this shape
directly — a dependency doing something its presence does not describe.

### F18 — `should-ignore.md` #52 no longer describes the code it excuses (Low)

Reported under the exception the brief allows: _"unless you find materially new
evidence… that shows the documented reasoning is factually incorrect."_

`reports/should-ignore.md:100-104` reads:

> **H2: HIBP check fails open silently and has no HTTP timeout** —
> `lib/auth/check-password.ts:18-59` — `checkPasswordCompromise` retries the HIBP
> API up to 3 times and falls through silently on exhaustion **with no
> `AbortSignal`**; during an HIBP outage, compromised passwords are silently
> accepted and **admin operations stall 10–30s** on user-creation hot path

Three of those claims are now false. The current
`lib/auth/check-password.ts:27-68` has:

- an `AbortSignal` per attempt — `const controller = new AbortController()`
  (`:28`), `signal: controller.signal` (`:41`), cleared in `finally` (`:67`);
- a declared bound — `HIBP_ATTEMPT_TIMEOUT_MS = 1000` with the comment _"Three
  attempts × ~1s + backoff stays under ~3.5s total"_ (`:10-12`), so the stall is
  ~3.5 s, not 10–30 s;
- a log on every failed attempt — `console.error(sanitizeForLog({ msg:
'hibp.degraded', attempt, error }))` (`:60`), so it is not silent.

What remains true is the substantive half: on exhaustion the loop ends and the
function returns normally (`:27-69`), so the check **fails open** and a
breached password is accepted during an outage.

Failure scenario for the entry itself, which is why this matters: the ignore
list is what the next audit is told not to reopen. #52's stated impact
("stall 10–30 s", "no AbortSignal") was the part that made it look like a
performance issue already understood; that part was fixed and the entry was not
updated. The genuinely unresolved decision — fail open or fail closed when HIBP
is unreachable — is now recorded only inside a stale description of a fixed
problem, and F12 shows the codebase already contains a fail-closed
implementation of the same check that nothing can reach.

### F19 — `sharp` and `unrs-resolver` are listed in both `trustedDependencies` and `ignoreScripts`, where Bun 1.4 makes the first entry dead (Low)

`package.json:79-87`:

```json
"ignoreScripts": ["sharp", "unrs-resolver"],
"trustedDependencies": ["argon2", "sharp", "unrs-resolver"]
```

Bun 1.4 release post, _nativeDependencies and ignoreScripts_: _"`ignoreScripts`
skips a package's lifecycle scripts entirely, **even if it is also in
`trustedDependencies`**."_ So `sharp` and `unrs-resolver` in
`trustedDependencies` grant nothing — the only effective entry is `argon2`.

Failure scenario: the two lists state opposite intents for the same two
packages, and Bun resolves it silently in favour of `ignoreScripts`. A future
maintainer removing `sharp` from `ignoreScripts` to fix a native-build problem
would simultaneously re-enable its postinstall via the still-present
`trustedDependencies` entry, which is not what removing one line looks like.
`sharp` is also a `devDependency` used only by `bench/` (verified: its only
imports are `bench/image/run.mjs:15` and five files under
`bench/image/shared/`), so the whole pair of entries exists for benchmark
tooling.

### F20 — No `unhandledRejection` / `uncaughtException` handler: an escaped async error hard-kills the process and bypasses the entire shutdown design (Low)

`server.ts:312-315` registers handlers for `SIGTERM` and `SIGINT` and nothing
else. Grep confirms neither `unhandledRejection` nor `uncaughtException` is
registered anywhere in the repository:

```
$ rg -n 'unhandledRejection|uncaughtException' --glob '!node_modules' .
(only reports/*.md and this audit file)
```

Reproduced on the pinned runtime — an unhandled rejection in detached work, with
a `Bun.serve` listener up and no handler registered:

```
$ bun rejprobe.ts
{"step":"listening","port":54950,"bun":"1.4.0"}
{"step":"about to reject"}
error: detached post-response failure
      at <anonymous> (…/rejprobe.ts:9:33)
Bun v1.4.0 (Windows x64)
=== process exit code: 1 ===
```

The queued `fetch` at +600 ms never ran: the process was gone. So one escaped
rejection is an immediate, total outage of a single-process deployment
(CLAUDE.md §1: _"a private VPS running Coolify"_).

**Stated honestly: I found no reachable trigger in application code.** I checked
the paths that could produce one and they are all defended:
`lib/http/after-response.ts:31-59` isolates every task in its own `try/catch`
and its drain uses `Promise.all(inFlight).catch(() => {})` (`:100`);
`lib/auth/passwordless.ts:209` has a `.catch(() => {})`; and the single
`void`-ed promise in application code, `server.ts:314` `void shutdown(signal)`,
cannot reject because `shutdown` catches its drain errors (`:264-282`) and the
store closes are individually wrapped (`:295-310`). So this is a resilience gap, not a
live defect — the same shape as F8.

Failure scenario, and why it is still worth reporting: the sources that remain
are the ones application code does not wrap — the `Bun.SQL` pool
(`db/index.ts:48`) and `bun:sqlite` raising asynchronously outside a query
`await`, and any future post-response caller (`enqueueAfterResponse` currently
has no production caller). When one
fires, the outcome is strictly worse than a normal stop: `shutdown()` never runs,
so `closeDatabase`, `closeRateLimitStore` and `closeCacheStore` are all skipped,
the after-response queue is dropped, and the only record is a raw multi-line
stack trace on stdout — not the `JSON.stringify({ msg, errorClass })` line every
other failure path in this codebase emits, so it will not parse in whatever log
pipeline the deployment uses. How to recognise that shape at deploy time — the
absence of `{"msg":"server stopping"}` before the exit — is recorded alongside F4
in `reports/coolify-deployment.md` §6.

Bun 1.4 makes this concrete rather than theoretical, and changes what a handler
must cover. From _Upgrading to 1.4_: _"Exceptions thrown in `node:fs`,
`node:dns`, and `crypto.pbkdf2` callbacks are now `uncaughtException`… A handler
registered there [on `unhandledRejection`] no longer sees it. Move the handler."_
This codebase uses `node:crypto` (`lib/sqlite/maintenance-token.ts:10`) and
`node:path`/`node:fs` paths, so a future handler has to be on **both** events —
registering only `unhandledRejection` would already be the wrong choice on 1.4.0.

CLAUDE.md, Stability dimension of the brief: _"unhandled rejections,
startup/shutdown paths, resource leaks."_ `server.ts` implements a bounded,
logged shutdown; nothing guarantees that path is the one taken.

### F21 — Bun 1.4 makes the `Set-Cookie` re-append workaround unnecessary (Low)

`lib/http/response-policy.ts`, in the immutable-header fallback:

```ts
const cookies = response.headers.getSetCookie();
if (cookies.length > 0) {
  headers.delete('set-cookie');
  for (const cookie of cookies) headers.append('set-cookie', cookie);
}
```

Measured on Bun 1.4.0 — `new Headers(h)` preserves repeated `Set-Cookie` values:

```
$ bun -e '…append two set-cookie + two x-dup, then new Headers(h)…'
{
 "bun": "1.4.0",
 "original_getSetCookie": [ "a=1; Path=/", "b=2; Path=/" ],
 "copy_getSetCookie":     [ "a=1; Path=/", "b=2; Path=/" ],
 "copy_get_setcookie": "a=1; Path=/, b=2; Path=/",
 "copy_xdup_get": "first, second",
 "copy_preserves_two_cookies": true
}
```

The copy already carries both cookies as separate entries. The block is
idempotent, so it has no runtime failure scenario; it is unnecessary work in the
fallback path and can be removed.

### F26 — Two log sites bypass the structured-logging convention with a bracket-prefixed string (Low)

Every log call in this codebase emits one JSON object — `console.error(JSON.stringify({ msg, … }))`
or `console.error(sanitizeForLog({ msg, … }))` — with `msg` as a dotted or
spaced key (`'otp.provider.failed'`, `'server stopping'`, `'hibp.degraded'`).
`lib/http/after-response.ts:62-71` is the access log and defines the shape.

Two sites do not:

- `lib/captcha.ts:32` —
  `console.error('[captcha] TURNSTILE_SECRET_KEY missing — rejecting request');`
- `lib/r2/client.ts:167-171` —
  ``console.error(`[R2] Expiry time ${expiresIn}s is out of range. Using ${validExpiry}s instead. …`)``
  (also at `error` level for a value that was successfully clamped — see F14e)

Failure scenario: a deployment that ships stdout to a JSON log pipeline gets two
lines that do not parse, and they are not arbitrary lines — the captcha one is
the signal that **CAPTCHA verification is disabled by misconfiguration and every
protected request is being rejected**. It is the highest-value alert in the file
and the one least likely to reach an alerting rule, because it has no `msg` key
to match on. `lib/env.server.ts:29` puts `TURNSTILE_SECRET_KEY` in
`REQUIRED_IN_PRODUCTION`, so in production this branch is unreachable — which
leaves it reachable exactly where it is hardest to notice: a non-production
deployment with `NODE_ENV=test`, where `lib/captcha.ts:26-29` selects
`process.env.TURNSTILE_SECRET_KEY` (not the dev test key) and it is unset.

CLAUDE.md, Consistency: _"Converging on one way of doing each thing matters more
than any individual variation being slightly better."_

### F34 — `positiveInt` accepts non-canonical number spellings and substitutes a default for out-of-range, which the sibling paginator explicitly refuses (Low)

`utils/index.ts:423-427`:

```ts
export const positiveInt = (val: unknown, maxValue = MAX_ID) => {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0 || num > maxValue) return 0;
  return num | 0;
};
```

`app/api/dash/users/[id]/sessions/pagination.ts:96-124` rejects this exact
input class locally, for the same concept:

> _"Canonical decimal integers only. `Number()` accepts a whole family of
> spellings a query string has no business carrying — `1e2`, `0x10`, `+1`,
> `' 5 '` and `'05'` all became numbers… and the over-cap rejection could be
> bypassed by spelling the number differently."_
> `const CANONICAL_INTEGER = /^(?:0|[1-9]\d*)$/;` … _"Over the maximum is
> rejected, not clamped."_

The shared helper was never swept. Measured (`maxValue = 100`):

```
"1e2"   -> 100     "0x10"  -> 16      "+1"  -> 1     " 5 " -> 5
"05"    -> 5       "10.9"  -> 10
"101"   -> 0       "10001" -> 0       "1e20" -> 0    "abc" -> 0    "" -> 0
```

Consumers: `lib/data-table/parsers.ts:309-312` for `maxPerPage`, `page` and
`perPage` on every paginated dashboard endpoint, where the `0` then meets a `||`
and becomes a _default_.

Failure scenario: `GET /api/dash/users?perPage=101` serves **10** rows, not 100
and not a 422 — the client asked for something invalid and cannot tell that from
having asked for the default. `GET /api/dash/users?page=10001` silently returns
page 1. Meanwhile `GET /api/dash/users/<id>/sessions?limit=1e1` is a 422. Two
spelling policies for one concept, in one API. No authorization consequence —
`perPage` stays bounded by `MAX_PER_PAGE = 100` and `page` by `MAX_PAGE = 10_000`.

Related, same function: `db/queries/data-table.ts:74`'s
`const safePerPage = Math.min(parsed.perPage, MAX_PER_PAGE)` is unreachable
protection — `positiveInt` already returned 0 for anything above `maxPerPage`.
It reads as the clamp that enforces the ceiling; the ceiling is actually enforced
by a fallback.

Also latent: `num | 0` is a 32-bit signed truncation, so a `maxValue` above
2^31−1 returns a **negative** result for an in-range input
(`positiveInt(3_000_000_000, 4_000_000_000) === -1294967296`). No current caller
passes such a `maxValue`, but it contradicts both the function's name and its own
`> maxValue` guard.

### F35 — An inverted `isBetween` range is accepted and answered 200 with a provably empty set (Low)

`lib/data-table/filter-columns.ts:228-248` validates that bounds are _present_
and never that they are _ordered_:

```ts
const from = rawStart ? dayBounds(rawStart).start : null;
const to = rawEnd ? dayBounds(rawEnd).next : null;
if (!from && !to) invalidFilter();
return and(
  from ? gte(column, from) : undefined,
  to ? lt(column, to) : undefined
);
```

This is the same class the same function rejects fourteen lines earlier
(`:113-117`), with the reason stated there: a malformed range _"answered a
question nobody asked with a 200 instead of reporting the malformed range."_

Failure scenario: a `createdAt` `isBetween` filter of
`["2026-12-31","2026-01-01"]` generates
`created_at >= 2026-12-30T21:00:00Z AND created_at < 2026-01-01T21:00:00Z` —
unsatisfiable by construction — and returns `200`, `data: []`, `total: 0`. A user
who transposed two dates in a date-picker is told there are no matching records
rather than that the range is backwards. Same shape in the numeric branch
(`:241-247`).

### F36 — 403-vs-404 divergence on `PUT`/`DELETE /api/dash/users/:id` discloses which accounts outrank the caller (Low)

`app/api/dash/users/[id]/handler.ts:385-391` calls `validateRolePermissionScope`,
which throws `MSG_CANNOT_GRANT_UNOWNED_PERMISSIONS` with **403**
(`lib/permissions/utils.ts:442-446`). Every neighbouring unreachable-target gate
deliberately answers **404 `MSG_NOT_FOUND`** instead — `:368` (protected system
role), `:375` (out-of-scope owner), and all three checks in
`app/api/dash/users/[id]/target-user.ts:40-51`. `handleApiError`
(`utils/api-response.ts:133-143`) passes a `CustomError`'s message and status
through verbatim, so the difference reaches the client.

Failure scenario: an actor holding `users.view` + `users.edit` but **not**
`permissions.view` lists users (which per `should-ignore.md` #39 shows every
non-system user), then sends a minimal valid `PUT` at each id. `404` means
nonexistent, system-role, or not-mine; `403 "لا يمكنك منح صلاحيات لا تملكها"`
means _this account exists and its role holds a permission I do not_. That
reconstructs the relative privilege ranking of every account in the dashboard
without ever granting `permissions.view` — which is the grant that is supposed to
gate exactly that knowledge. Same leak on `DELETE` (`:814`) and in
`sessions/handler.ts`'s `assertTargetReachable`.

Distinct from `should-ignore.md` #9 (a user GET exposing role permissions to its
own holder) — this is a cross-account inference by a caller with no permissions
grant at all.

### F37 — `serializeLogValue`'s `seen` set is visit-scoped, so a shared reference is reported as `[circular]` (Low)

`utils/index.ts:315` and `:325`:

```ts
if (seen.has(obj)) return '[circular]';
...
seen.add(obj);                     // never removed
```

Nothing is deleted from `seen`, so the second occurrence of any repeated but
**acyclic** reference is dropped and mislabelled. Measured:

```
sanitizeForLog({ x: shared, y: shared })  ->  {"x":{"a":1,"b":2},"y":"[circular]"}
```

Failure scenario: the module's stated purpose is diagnostics for incident
response. A payload where two fields legitimately point at one object — a user
record referenced from both a request context and an error, a `meta` object
reused across fields — loses the second copy and tells the reader there is a
cycle where there is none. During an incident that is a false lead about the
shape of the data, in the one artefact the responder has. Correct form is a
path-scoped set (add before recursing, delete after).

### F40 — The HIBP network call and the argon2 hash run before any check on the _target_ user (Low)

`app/api/dash/users/[id]/handler.ts:339-341`:

```ts
const password = validatedDataParsed.data.password;
if (password) await checkPasswordCompromise(password);
const hashedPassword = password ? await hashPassword(password) : null;
```

Both precede the transaction and therefore precede the target row read
(`:344-362`), the protected-system-role check (`:368`), the ownership check
(`:375`) and the role-authority check (`:385`). The _endpoint_ permission check
has already run, so this is target-authorization ordering only.

Failure scenario: an actor holding only `users.editOwn` sends a `PUT` with a
`password` at a user they did not create. The server makes an outbound HTTPS
request to the HIBP range API and computes one argon2id hash at
`memoryCost: 65_536, timeCost: 3, parallelism: 4` (`lib/auth/password.ts:5-12`),
then answers 404. Bounded to 10/min/actor by the limiter at `:708-713`, so this
is amplification rather than a DoS primitive — but the work is spent
unconditionally on behalf of a target the caller has no authority over, and both
calls sit one statement away from the checks that would have refused.

Distinct from `should-ignore.md` #45 (synchronous hashing as a throughput
concern) and #52 (HIBP fail-open/timeout): the claim here is ordering.

### F41 — The daily OTP spend breaker allows 2× the day's budget in one second at the UTC boundary (Low)

With `OTP_GLOBAL_SEND_CAP_PER_DAY = 2000` and `window = ONE_DAY_S`
(`lib/rate-limit/api.ts:121`, `:200-206`), `windowStart = now - (now % 86_400_000)`
is UTC midnight.

Failure scenario: 2000 charges at `23:59:59.999Z` and 2000 at `00:00:00.000Z`
dispatch **4000 paid messages inside one second**, and leave the whole of day two
at zero. A spend cap that can be doubled in a burst is not a strict daily cap.
Anchor it on a rolling counter or halve the cap across staggered windows.

### F42 — `ipIdentifier`'s failure log emits present, IP-bearing headers, which is the opposite of the boundary rule the sibling module states (Low)

`lib/rate-limit/api.ts:76-84`:

```ts
console.error(
  sanitizeForLog({
    msg: 'missing client ip headers',
    cf: headers.get('cf-connecting-ip'),
    forwarded: headers.get('x-forwarded-for'),
    host: headers.get('host'),
    ua: headers.get('user-agent'),
  })
);
```

None of `cf` / `forwarded` / `host` / `ua` matches a denylist fragment in
`serializeLogValue`, so `sanitizeForLog` passes them through verbatim.
`lib/rate-limit/store-failure.ts:19-33` states the rule this area works under —
withhold values that embed a destination, because _"withholding it costs no
diagnostic value."_

Failure scenario: the branch fires whenever `cf-connecting-ip` is absent **or**
fails `IP_SCHEMA` — i.e. on every non-Cloudflare ingress path — and in exactly
that case `x-forwarded-for` is the header most likely to carry the real client
address chain. Every such request writes a client IP into the application log.

`should-ignore.md` #63 blesses _"the missing headers are logged"_, and that is
why this is Low rather than higher: the distinction is that what gets logged is
not the _missing_ header but a _present, IP-bearing_ one. Logging the header
**names** that were absent carries the same diagnostic value with none of the
data.

### F43 — A `roleId` union failure returns Zod's English `"Invalid input"`, defeating the reason `zodIssueMessage` exists (Low)

`utils/validation/auth.ts:40`:

```ts
roleId: z.union([z.literal(CUSTOM_ROLE_VALUE), idSchema]);
```

`zodIssueMessage` was written because _"Zod's built-in unknown-key message is
English and would be the only non-Arabic string a client ever sees"_
(`utils/validation/rules.ts:41-44`). A union failure produces `invalid_union`,
whose own message is `"Invalid input"`, and neither branch's message survives.

Failure scenario, on `POST /api/dash/users` and `PUT /api/dash/users/:id`
(inherited through `updateUserObject`): a client sending `roleId: "not-a-uuid"`,
a v4 UUID, `0`, `null` or `""` receives `422 "Invalid input"` — the English
string the helper exists to prevent — where `idSchema` on its own would have
returned `"رقم المعرف غير صحيح، اعد تحميل الصفحة ثم حاول مرة اخرى"`. No security
impact; it is the stated contract of the validation layer not holding at the one
field that uses a union.

### F46 — The `@types/node` pin is a major behind the runtime Bun 1.4 emulates, and two majors are in one type program (Low)

Bun 1.4 _"now reports Node.js 26"_ (release post, _Upgrading to 1.4_:
`process.versions.modules` is 147). `package.json:58` still pins
`"@types/node": "24"`.

The result is two majors resolved into one type-check program, which Bun 1.4's
new `bun dedupe --check` reports directly:

```
$ bun dedupe --check
bun dedupe v1.4.0 (34cbb9a40)
~ @types/node 26.2.0 -> 24.13.3
~ get-tsconfig 4.14.3 -> 4.14.1
~ undici-types 8.3.0
3 duplicate versions can be removed (checked 598 packages) [38.00ms]
```

Traced in the lockfile:

```
bun.lock:456   "@types/node": ["@types/node@24.13.3", …]           <- the hoisted pin
bun.lock:1234  "bun-types/@types/node": ["@types/node@26.2.0", …]  <- what @types/bun wants
bun.lock:1222  "@types/jsdom/@types/node":     26.2.0
bun.lock:1226  "@types/nodemailer/@types/node": 26.2.0
```

`tsconfig.json:31` is `"types": ["bun"]`, so the program loads `@types/bun` →
`bun-types@1.4.0` → `@types/node@*` → 26.2.0, while the hoisted copy application
code resolves `node:*` against is 24.13.3.

Failure scenario: type-checking claims the Node 24 surface while the runtime
behaves as Node 26. A Node 26 API that Bun 1.4 implements is a type error under
the 24 definitions; a Node 24 signature that changed in 26 type-checks clean and
misbehaves. Neither is a live bug I can point at today — `bun run lint` passes —
which is why this is Low. It is worth reporting because the pin is now _provably_
stale against a documented runtime change, and because Bun 1.4 shipped the tool
that detects the whole class: `bun dedupe --check` _"never changes package.json,
and `--check` fails CI if there are duplicates"_, and it currently exits 0 while
reporting three. Nothing in `.github/workflows/ci.yml` or `lefthook.yml` runs it
(the only dependency gate is `bun audit`, `ci.yml:186`).

### F47 — The Coolify health check verifies SQLite and never touches PostgreSQL (Low)

**Moved to `reports/coolify-deployment.md`, which owns both halves of this one.**
The finding stands as written: `app/api/health/storage/handler.ts` is the
deployment's readiness endpoint and every check it performs is against the
rate-limit SQLite store, so an unreachable PostgreSQL — a wrong `DATABASE_URL`
after a rotation, the database container not yet up, an exhausted pool — still
answers `200 {"status":"ok"}` and the orchestrator keeps routing traffic to a
container on which every login, dashboard route and OTP send fails. The lazy
`bun:sql` pool means nothing else forces the failure to surface either. That is
the same argument the handler's own header makes for existing, not applied to
the primary datastore. `should-ignore.md` #8 does not cover it: its reasoning is
_"we do not have one"_, and an absent health check fails safe where one that
asserts `ok` does not.

What is _not_ recorded here any more is the remedy, because it is not a code
decision alone: whether the `SELECT 1` belongs in the `?deep=1` branch or as a
shallow check with a short timeout depends on the poll interval configured on the
server. That is now **gate 9** of the runbook, together with the blind-spot list
in its §7.

### F24 — WITHDRAWN (my error, not a defect)

I reported that `app/api/upload/image/handler.ts:78-83` was _"the only
`enforceRateLimit` call site that omits `window`"_. **That is false, and the
finding is withdrawn.**

I inventoried all 27 call sites afterwards. Omitting `window` is the norm across
the dashboard surface, not an anomaly: `users.get`, `users.post`,
`users.id.get`, `users.id.put`, `users.id.delete`, `roles.get`,
`permissions.get`, `permissions.post`, `permissions.id.get`,
`permissions.id.put`, `permissions.id.delete`, all five `users.me.change-*`
sites and the sessions handler all rely on the `?? 60` default at
`lib/rate-limit/api.ts:259`. The sites that state it explicitly are the auth and
OTP surfaces, where the window is genuinely not 60 s
(`ONE_HOUR_S`, `ONE_DAY_S`, `OTP_DESTINATION_VERIFY_WINDOW_S`) or where being
explicit about a per-minute credential budget is the point.

So the convention is coherent and the upload route follows it. There is no
inconsistency to report, and the CLAUDE.md rule I cited does not apply.

Kept in the report rather than deleted because the audit brief asks for proof per
finding, and a finding I could not sustain should be visible as such.

### Deliberately swept with NO finding (recorded so the coverage contract is honest)

- **B6 `Bun.sql` timestamp decoding.** Bun 1.4 changes MySQL `DATETIME`/`TIMESTAMP`
  and Postgres `timestamp` read through `.simple()` to decode as UTC, and says
  "`timestamptz` is unaffected". Every timestamp column in `db/schema.ts` is
  declared `withTimezone: true, mode: 'string'` (checked all 20+ sites), so the
  driver returns the raw string and no `Date` conversion happens. No `.simple()`
  call exists in the repository. Not applicable.
- **B7 test-runner features.** `tests/helpers/run.ts:64-94` already adopts
  `--isolate` (unit only, with a measured reason at `:65-71`), `--no-isolate` plus
  `--parallel=N` (integration, `:191-194`), serial for the process tier, and
  `--no-env-file` (`:198`). `--shard`/`--timings` need multiple CI runners and CI
  runs one test job; `--retry` would mask the determinism this harness is built
  for. Nothing to add.
- **B9 `Bun.S3Client` migration.** Already investigated and decided in
  `bench/s3/README.md`, with four named blockers (no `cacheControl`, no custom
  metadata — both silently dropped by `write()` — no `CopyObject`, no 5xx retry on
  `PUT`) and upstream status recorded. The evidence there says a naive port
  _regresses_ cacheability. Reporting a migration would contradict the project's
  own evidence. (What IS reported from this area is F14/F15, which are about the
  existing file's quality, not the SDK choice.)
- **B4 argon2 `memoryCost`.** Bun 1.4 raises `Bun.password.hash()`'s argon2
  minimum `memoryCost` to 8. This project uses the npm `argon2` package
  (`lib/auth/password.ts:1`) with `memoryCost: 65_536`, not `Bun.password`, and
  `reports/elysia-migration-review-final.md:943` records why (`Bun.password` has
  no `secret` pepper parameter). Not applicable either way.
- **B1 `.env` under `bun --bun`.** Bun 1.4 stops loading `.env` when Bun is
  invoked _as node_. Probed: `bun --bun probe.ts` still loads `.env`
  (`PROBE_SECRET=from_dotenv`, `execArgv=["--bun"]`). `package.json`'s `dev` and
  `start` scripts (`bun --bun server.ts`) are unaffected, and no script invokes
  `node`. No finding.
- **B12/B13/B14 sweeps.** No `fs.rmdir`, no `Bun.$`, no `.xml`/`.css`/`import "."`
  imports, no `Bun.cron`, no `Bun.serve` static-`dir` route, no `Bun.mmap`, no
  `setKeepAlive`, no `dgram`, no `tls.createServer`, no `WebSocket` anywhere in
  application code — verified by grep. `bunfig.toml` parses under Bun 1.4's
  stricter TOML (the server boots, and `bun test` reads it). Nothing applicable.
- **`db/schema.ts` index gaps.** Every missing-index case I could construct is
  already in `should-ignore.md` (#20, #35, #38, #55, #62, Known Issues #11) or is
  explicitly justified with `EXPLAIN` evidence in `db/maintenance.ts:78-91`. No
  new finding.

## Pass 2 — cross-cutting re-read

Pass 1 was file-by-file. Pass 2 asked the questions a per-file read cannot: is a
claim made in one file contradicted in another, is a class fully inventoried, is
there a second implementation of one concept. It produced **two corrections to
findings already written and no new findings.**

### Correction to F26 — the unstructured-log class has three members, not two

F26 says _"Two sites do not"_. A third exists, found while reading the
contact-change flow: `app/api/dash/users/me/contact-change.ts:41`

```ts
console.error('cookie cache refresh failed:', sanitizeForLog(e));
```

Same shape as the other two — a leading plain string, so the line has no `msg`
key to match on, and here a second argument as well. It fires when the
post-change session-cookie refresh fails, which is the moment a user's cached
identity is known to be stale. Read F26 as covering `lib/captcha.ts:32`,
`lib/r2/client.ts:167-171` and this site.

### Classes checked in pass 2 and found complete

- **Two implementations of one concept.** Two candidate pairs examined.
  `haveIBeenPwned` plugin vs `lib/auth/check-password.ts` — real, reported as
  **F12**. `db/maintenance.ts` vs `lib/sqlite/maintenance.ts` — **not** a defect: they are
  different jobs against different stores on different schedules, and the
  directory prefix carries the distinction.
- **Fail-open/fail-closed asymmetry across limiter call sites.** All 27 sites
  inventoried. The five fail-open ones (`users.get`, `users.id.get`,
  `permissions.get`, `permissions.id.get`, `roles.get`) are all read-only routes
  declaring `preAuth: 'ip-limit'`, and `lib/http/adapters/elysia.ts:58` runs the
  fail-**closed** `enforcePreAuthIpLimit` ahead of the handler — so a store
  outage 503s before the fail-open limiter is reached. Not a defect. This is also
  what showed F24's premise to be false; F24 is withdrawn above.
