# Claude Opus Audit — full-codebase sweep + Bun 1.4 compatibility

Scope: whole codebase (not a diff). Audit sources: `CLAUDE.md` (as a requirement on
the code, not only on me), the official Bun 1.4 release post
(<https://bun.com/blog/bun-v1.4>), and the dimensions listed in the audit brief.
Exclusions: everything in `reports/should-ignore.md` (both sections) unless
materially new evidence contradicts the recorded reasoning.

Environment recorded at run start: `bun --version` → `1.4.0`;
`package.json#packageManager` → `bun@1.4.0`; `bun.lock` →
`"lockfileVersion": 2, "configVersion": 1`.

## Summary

47 entries: **2 High, 18 Medium, 26 Low**, and 1 withdrawn.
No Critical. Ranked below by severity, original numbering preserved.

| #   | Severity | Finding                                                                                                                                                    |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F27 | High     | `validID` does not canonicalise case, so three "you may not do this to yourself" guards can be walked past with one uppercase hex digit                    |
| F30 | High     | The verify-side per-destination budget is shared across all three surfaces, so anyone can cheaply deny a named victim's password recovery                  |
| F1  | Medium   | `/openapi.json` is unauthenticated and publishes the dev + internal maintenance surface                                                                    |
| F4  | Medium   | Bun 1.4: one half-sent request makes `app.stop()` hang, turning every deploy into a 135 s stall that exits 1 and skips the store closes                    |
| F6  | Medium   | The two `.js` files are inside the type-check program but their bodies are never type-checked                                                              |
| F8  | Medium   | No type-aware ESLint configuration: `no-floating-promises` and the whole thenable family are absent                                                        |
| F12 | Medium   | The `haveIBeenPwned` plugin can never fire, and the hand-rolled replacement fails OPEN where the plugin fails CLOSED                                       |
| F13 | Medium   | Bun 1.4 invalidates two specified assertions in `reports/test-strategy.md` §7.3, and the document actively steers away from the case that is now reachable |
| F14 | Medium   | `lib/r2/client.ts` sits outside every convention the rest of the codebase follows                                                                          |
| F16 | Medium   | The entire self-service credential surface has no test of any kind                                                                                         |
| F22 | Medium   | Closing `/openapi.json` (F1) turns the upload route into an enumeration oracle; the two are coupled and only one side knows it                             |
| F25 | Medium   | The three OTP delivery channels are the only outbound calls in the codebase with no timeout, and Bun 1.4 `fetch()` has no default                          |
| F28 | Medium   | `sanitizeFilename` truncates by UTF-16 code unit and can emit a lone surrogate, which the S3 SDK turns into a 500                                          |
| F29 | Medium   | `zodIssueMessage` reflects unbounded, attacker-controlled JSON key names into the 422 response body                                                        |
| F31 | Medium   | All three OTP send handlers report `200 "code sent"` for a malformed body and for OTP being switched off                                                   |
| F32 | Medium   | A NUL byte in any data-table search or filter value reaches a bound parameter and returns a deterministic 500                                              |
| F33 | Medium   | `notILike` and `ne` silently drop NULL rows, in a module that handles NULL correctly for `isEmpty`                                                         |
| F39 | Medium   | Public `verify_contact` sends starve the shared per-destination send budget, throttling a named victim's passwordless login to one code per hour           |
| F44 | Medium   | Bun 1.4's `Bun.cron()` removes the primary recorded objection to an in-process sweep, and with it two internet-reachable maintenance endpoints             |
| F45 | Medium   | `TODO.md` is gitignored, and eleven tracked source files cite it as the register of deferred decisions                                                     |
| F2  | Low      | `openApiConsistencyProblems` is documented as exported and is not                                                                                          |
| F3  | Low      | The two dev-only endpoints answer a production probe differently                                                                                           |
| F5  | Low      | Bun 1.4 invalidates the recorded measurement that justifies the after-response settle loop                                                                 |
| F7  | Low      | `constants/index.js` is a one-constant barrel with one consumer, in the wrong language and the wrong place                                                 |
| F9  | Low      | `SQLITE_MAINTENANCE_TOKEN` has no length floor, and the endpoints it guards are unthrottled and log no failures                                            |
| F10 | Low      | `page.out` is a 1.3 MB scraped HTML page committed to the repository                                                                                       |
| F11 | Low      | `knip` is a devDependency with a 95-line config that no gate ever runs                                                                                     |
| F15 | Low      | Four exported functions in `lib/r2/client.ts` have no production caller and each is hidden from the dead-code scanner with `@knipignore`                   |
| F17 | Low      | `@tanstack/react-table` is a production dependency for one type-only import, in a repository with no React                                                 |
| F18 | Low      | `should-ignore.md` #52 no longer describes the code it excuses                                                                                             |
| F19 | Low      | `sharp` and `unrs-resolver` are listed in both `trustedDependencies` and `ignoreScripts`, where Bun 1.4 makes the first entry dead                         |
| F20 | Low      | No `unhandledRejection` / `uncaughtException` handler: an escaped async error hard-kills the process and bypasses the entire shutdown design               |
| F21 | Low      | Bun 1.4 makes the `Set-Cookie` re-append workaround unnecessary, and its stated premise is false on the pinned runtime                                     |
| F23 | Low      | `MAX_REQUEST_BODY_BYTES` is 8× the largest body any route accepts, and its comment claims a derivation that does not exist                                 |
| F26 | Low      | Two log sites bypass the structured-logging convention with a bracket-prefixed string                                                                      |
| F34 | Low      | `positiveInt` accepts non-canonical number spellings and substitutes a default for out-of-range, which the sibling paginator explicitly refuses            |
| F35 | Low      | An inverted `isBetween` range is accepted and answered 200 with a provably empty set                                                                       |
| F36 | Low      | 403-vs-404 divergence on `PUT`/`DELETE /api/dash/users/:id` discloses which accounts outrank the caller                                                    |
| F37 | Low      | `serializeLogValue`'s `seen` set is visit-scoped, so a shared reference is reported as `[circular]`                                                        |
| F38 | Low      | The CI dead-code gate carries a named exemption for the live SVG sanitiser, justified by a directory that no longer exists                                 |
| F40 | Low      | The HIBP network call and the argon2 hash run before any check on the _target_ user                                                                        |
| F41 | Low      | The daily OTP spend breaker allows 2× the day's budget in one second at the UTC boundary, which its own justification does not cover                       |
| F42 | Low      | `ipIdentifier`'s failure log emits present, IP-bearing headers, which is the opposite of the boundary rule the sibling module states                       |
| F43 | Low      | A `roleId` union failure returns Zod's English `"Invalid input"`, defeating the reason `zodIssueMessage` exists                                            |
| F46 | Low      | The `@types/node` pin is a major behind the runtime Bun 1.4 emulates, and two majors are in one type program                                               |
| F47 | Low      | The Coolify health check verifies SQLite and never touches PostgreSQL                                                                                      |
| F24 | —        | withdrawn (premise was false)                                                                                                                              |

The two High findings share a property worth stating up front: both are cases
where the codebase states the correct rule in a comment and the code does not
implement it. F27 is a case-sensitivity mismatch between JavaScript string
equality and PostgreSQL `uuid` equality that walks past three separate
"not to yourself" guards; F30 is a reserved-capacity rule that the send path
implements and the verify path does not.

## Worklist

### Root / entry points

- [x] `app.ts`
- [x] `server.ts`
- [x] `routes.ts`
- [x] `package.json`
- [x] `bunfig.toml`
- [x] `tsconfig.json`
- [x] `drizzle.config.ts`
- [x] `eslint.config.mjs`
- [x] `prettier.config.js` / `.prettierignore`
- [x] `knip.jsonc`
- [x] `lefthook.yml`
- [x] `mise.toml`
- [x] `renovate.json`
- [x] `.gitignore` / `.gitleaksignore` / `.semgrepignore`
- [x] `.env` / `.env.test` / `.env.test.example` (handling, not contents)
- [x] `page.out`, `prompt*.md`, `read.txt`, `TODO.md` (tracked junk check)

### `.github/`

- [x] `.github/workflows/ci.yml`
- [x] `.github/workflows/security.yml`

### `app/api/` — HTTP handlers

- [x] `app/api/auth/forgot-password/reset/handler.ts`
- [x] `app/api/auth/forgot-password/send/handler.ts`
- [x] `app/api/auth/otp/messages.ts`
- [x] `app/api/auth/otp/send/handler.ts`
- [x] `app/api/auth/otp/verify/handler.ts`
- [x] `app/api/auth/passwordless/send/handler.ts`
- [x] `app/api/dash/permissions/handler.ts`
- [x] `app/api/dash/permissions/[id]/handler.ts`
- [x] `app/api/dash/permissions/messages.ts`
- [x] `app/api/dash/roles/handler.ts`
- [x] `app/api/dash/users/handler.ts`
- [x] `app/api/dash/users/messages.ts`
- [x] `app/api/dash/users/[id]/handler.ts`
- [x] `app/api/dash/users/[id]/target-user.ts`
- [x] `app/api/dash/users/[id]/sessions/handler.ts`
- [x] `app/api/dash/users/[id]/sessions/pagination.ts`
- [x] `app/api/dash/users/me/contact-change.ts`
- [x] `app/api/dash/users/me/change-email/handler.ts`
- [x] `app/api/dash/users/me/change-email/verify/handler.ts`
- [x] `app/api/dash/users/me/change-password/handler.ts`
- [x] `app/api/dash/users/me/change-phone/handler.ts`
- [x] `app/api/dash/users/me/change-phone/verify/handler.ts`
- [x] `app/api/dev/email-test/fixed/handler.ts`
- [x] `app/api/dev/sign-up/handler.ts`
- [x] `app/api/health/storage/handler.ts`
- [x] `app/api/internal/db-sweep/handler.ts`
- [x] `app/api/internal/sqlite-sweep/handler.ts`
- [x] `app/api/upload/image/handler.ts`
- [x] `app/api/upload/image/messages.ts`

### `lib/`

- [x] `lib/audit.ts` + `lib/audit/constants.ts`
- [x] `lib/auth.ts`
- [x] `lib/auth/allowed-paths.ts`
- [x] `lib/auth/api-error.ts`
- [x] `lib/auth/check-password.ts`
- [x] `lib/auth/code-errors.ts`
- [x] `lib/auth/keyring.ts`
- [x] `lib/auth/live-session.ts`
- [x] `lib/auth/login-guard.ts`
- [x] `lib/auth/otp-hash.ts`
- [x] `lib/auth/otp-key.ts`
- [x] `lib/auth/password.ts`
- [x] `lib/auth/password-pepper.ts`
- [x] `lib/auth/passwordless.ts`
- [x] `lib/auth/rotation.ts`
- [x] `lib/cache/index.ts` + `lib/cache/prefix.ts`
- [x] `lib/captcha.ts`
- [x] `lib/data-table/column-specs.ts`
- [x] `lib/data-table/config.ts`
- [x] `lib/data-table/filter-columns.ts`
- [x] `lib/data-table/parsers.ts`
- [x] `lib/env.js`
- [x] `lib/env.server.ts`
- [x] `lib/http/adapters/elysia.ts`
- [x] `lib/http/adapters/hono.ts.disabled`
- [x] `lib/http/after-response.ts`
- [x] `lib/http/contract.ts`
- [x] `lib/http/openapi.ts`
- [x] `lib/http/pre-auth.ts`
- [x] `lib/http/request.ts`
- [x] `lib/http/response.ts`
- [x] `lib/http/response-policy.ts`
- [x] `lib/http/route-manifest.ts`
- [x] `lib/http/security-headers.ts`
- [x] `lib/http/session.ts`
- [x] `lib/id.ts`
- [x] `lib/permissions/checker.ts`
- [x] `lib/permissions/constants.ts`
- [x] `lib/permissions/utils.ts`
- [x] `lib/r2/client.ts`
- [x] `lib/r2/optimize-image.ts`
- [x] `lib/r2/upload-helper.ts`
- [x] `lib/rate-limit/api.ts`
- [x] `lib/rate-limit/auth-storage.ts`
- [x] `lib/rate-limit/index.ts`
- [x] `lib/rate-limit/store.ts`
- [x] `lib/rate-limit/store-failure.ts`
- [x] `lib/sqlite/database.ts`
- [x] `lib/sqlite/driver.ts`
- [x] `lib/sqlite/maintenance.ts`
- [x] `lib/sqlite/maintenance-token.ts`
- [x] `lib/sqlite/sweep.ts`

### `db/`

- [x] `db/index.ts`
- [x] `db/schema.ts`
- [x] `db/limits.ts`
- [x] `db/maintenance.ts`
- [x] `db/queries/index.ts`
- [x] `db/queries/data-table.ts`
- [x] `db/drizzle/*.sql` + `db/drizzle/meta/` (migration/journal consistency)
- [x] `db/migrations/001_add_trgm_indexes.sql`

### `utils/`

- [x] `utils/api-messages.ts`
- [x] `utils/api-response.ts`
- [x] `utils/config.ts`
- [x] `utils/error-class.ts`
- [x] `utils/index.ts`
- [x] `utils/otp.ts`
- [x] `utils/sanitize-filename.ts`
- [x] `utils/time.ts`
- [x] `utils/images/config.ts`
- [x] `utils/images/rgba.ts`
- [x] `utils/images/server.ts`
- [x] `utils/images/svg-optimizer.ts`
- [x] `utils/svg/config.ts`
- [x] `utils/validation/auth.ts`
- [x] `utils/validation/constants.ts`
- [x] `utils/validation/otp.ts`
- [x] `utils/validation/permissions.ts`
- [x] `utils/validation/rules.ts`

### `constants/`, `types/`, `data/`

- [x] `constants/index.js`
- [x] `types/index.ts`
- [x] `types/data-table.ts`
- [x] `data/` (contents)

### `scripts/`

- [x] `scripts/find-non-null-assertions.ts`
- [x] `scripts/find-unused-files.ts`
- [x] `scripts/migrate.ts`
- [x] `scripts/smoke.ts`
- [x] `scripts/strip-comments.ts`
- [x] `scripts/probe/dev-live/*` (4 probes + README)

### `tests/`

- [x] `tests/helpers/*` (17 files — harness, provisioning, guards)
- [x] `tests/fixtures/*`
- [x] `tests/unit/*`
- [x] `tests/integration/*`
- [x] `tests/process/*`
- [x] Coverage gaps: which reachable route/lib has no test at all

### `bench/`

- [x] `bench/image/`
- [x] `bench/otp/`
- [x] `bench/s3/` (untracked, in-progress Bun S3 migration)
- [x] `bench/sqlite/`
- [x] `bench/uuid/`

### `docs/`, `.claude/`, stray dirs

- [x] `docs/` (which are vendored refs vs. project docs)
- [x] `.claude/settings.json` + `settings.local.json` + agents/skills
- [x] `.tmp-probe/` (untracked stray probes in repo root)

### Bun 1.4 cross-cutting passes

- [x] B1 `.env` loading under `bun --bun` (dev/start scripts) — proven by probe
- [x] B2 Duplicate-header combining (`,`) vs. IP/header readers
- [x] B3 `Request#clone()` / `Response#clone()` after body read
- [x] B4 `Bun.password.hash` argon2 `memoryCost >= 8`
- [x] B5 `server.stop()` semantics vs. graceful shutdown
- [x] B6 `Bun.sql` UTC decode / `.simple()` / named params / 65535 param cap
- [x] B7 test-runner features left on the table (`--parallel`, `--isolate`,
      `--shard`, `--timings`, `--changed`, `--retry`, fake timers)
- [x] B8 package-manager features (`bun audit fix`, `dedupe --check`, `prune
--production`, `pm licenses`, lockfile v2, linker)
- [x] B9 dependencies Bun 1.4 now replaces (`sharp`, `@aws-sdk/*`, `uuid`,
      `tar`, `json5`, `fast-xml-parser`, `string-width`)
- [x] B10 `Bun.cron()` vs. the deferred cron/sweep requirements
- [x] B11 `fetch()` behaviour changes (TypeError, bodyUsed, compress, timeouts)
- [x] B12 `fs.rmdir({recursive})`, Bun Shell globbing, TOML strictness, `import "."`
- [x] B13 `Bun.serve` static-dir routes / Range / conditional requests
- [x] B14 `process.on("memoryPressure")`, `--no-orphans`, profiling flags
- [x] B15 `jest.resetAllMocks()` / `toContain()` semantics in existing tests

### Sweep passes

- [x] Pass 1 — file-by-file sweep of every box above
- [x] Pass 2 — cross-cutting re-read (contract/consistency/placement/dead code)
- [x] Pass 3 — confirm two consecutive passes surface nothing new

## Findings

### F27 — `validID` does not canonicalise case, so three "you may not do this to yourself" guards can be walked past with one uppercase hex digit (High)

**The most serious finding in this audit. Every link verified by my own measurement.**

**Root cause — `utils/index.ts:503-515`:**

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
(`lib/rate-limit/index.ts:57`: `windowStart = now - (now % windowMs)`). An
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

`routes.ts:333-339` registers `GET /openapi.json` with `preAuth: 'none'`, and
`lib/http/openapi.ts:442-543` builds the document from the **whole** manifest with
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
and `/openapi.json` prints the path. Same reasoning applies to
`lib/http/openapi.ts:27-35`, which argues at length against merging Better
Auth's document because _"advertising dozens of endpoints that this server
rejects [is] a contract that is worse than an incomplete one"_; the identical
argument applies to endpoints this server refuses by environment, and is not
applied.

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

`server.ts:298` is `await app.stop()` — no argument, and the file argues at
length (lines 240-243) that the no-argument form is the correct one. It is, for
in-flight requests. It is not survivable for a stalled one.

Failure scenario: Coolify sends SIGTERM. One connection is mid-handshake — a
half-written request from a scanner, a client that died between headers, a
load-balancer health probe that was cut, or an attacker holding a socket open
with one byte. `await app.stop()` never resolves, so:

1. `drainAfterResponse` at `server.ts:299` is never reached.
2. The `finally` at `server.ts:322-332` never runs — **`closeDatabase`,
   `closeRateLimitStore` and `closeCacheStore` are all skipped**, because the
   forced-shutdown `process.exit(1)` at line 294 terminates the process from
   inside the timer callback and `finally` blocks do not run on `process.exit`.
3. The process sits for the full `SHUTDOWN_TIMEOUT_MS` and then exits **1**.

`SHUTDOWN_TIMEOUT_MS` is `(Math.max(60, MAX_ROUTE_TIMEOUT_SECONDS) + 15) * 1000`
(`server.ts:203-204`). `MAX_ROUTE_TIMEOUT_SECONDS` is 120 — `routes.ts:269`
(upload) and `routes.ts:307` (db-sweep) both declare `timeoutSeconds: 120`. So
the bound is **135 000 ms**, so every routine deploy becomes a 135-second stop
phase ending in a non-zero exit code, from one stalled socket. What that looks
like from the orchestrator's side, and how to tell it apart from a genuinely
failed deploy, is now `reports/coolify-deployment.md` §6.

Note the asymmetry this creates with the file's own design intent: `server.ts:300-307`
deliberately keeps a timed-out _drain_ at exit 0 so _"a routine deploy's stop
phase [does not] look like a crash to the orchestrator for the sake of a log
line."_ The stalled-`stop()` path defeats that reasoning entirely — it produces
both the crash-looking exit code and the skipped store closes, for a cause that
is not the application's fault.

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
`lib/rate-limit/auth-storage.ts:35`, `lib/rate-limit/index.ts:48`) — async
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
twice before the plugin could matter: `app.ts:395` only calls `auth.handler` when
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

### F13 — Bun 1.4 invalidates two specified assertions in `reports/test-strategy.md` §7.3, and the document actively steers away from the case that is now reachable (Medium)

Companion to F4/F5, in a different artefact: the test specification, not the
code.

`reports/test-strategy.md:817-822` specifies as a requirement to assert:

> **Record and assert the real `app.stop()` semantics** (shipped as four wrong
> comments…). Measured on `elysia@1.4.29`: `stop()` **does** close the listener…
> and **what survives is an already-established keep-alive connection, on which a
> further request is still served. Assert both halves.**

My probe (see F5) shows the second half is false on Bun 1.4.0: the further
request on the pre-existing keep-alive socket was not served and the socket was
closed. Anyone implementing §7.3 as written produces a failing test for correct
runtime behaviour — and the likely resolutions are all bad: weaken the
assertion, or "fix" the shutdown path to restore a property Bun deliberately
changed.

`reports/test-strategy.md:836-842` is sharper, because it rules out the exact
case that is now reachable:

> **Forced shutdown must actually fire when the drain hangs** (shipped)… Assert a
> non-zero exit and the log line for a hung drain. **This needs a hang _after_
> `stop()` resolves, not during it: a hang during `stop()` leaves a ref'd handle
> and masks the defect.**

On Bun 1.3 that was correct test design — a hang _during_ `stop()` was not a
state production could enter, so exercising it only masked the `unref` bug. On
Bun 1.4 a hang during `stop()` is trivially reachable from the network (F4: one
half-sent request), and it is the _worse_ failure, because it also skips the
store closes. The document's advice therefore now points the test author away
from the only production-reachable hang.

Failure scenario: §7.3 gets implemented as specified. The suite then encodes
Bun 1.3 semantics as the expected contract and has no coverage at all for the
half-sent-request hang. The next Bun upgrade review reads a green suite as
evidence that shutdown is characterised.

CLAUDE.md, Verification: _"A passing test proves that the test passed; whether
that settles the question is yours to judge."_ Here the specification would make
a passing test the wrong answer.

### F14 — `lib/r2/client.ts` sits outside every convention the rest of the codebase follows (Medium)

This file reads as though written by a different person than everything around
it, and CLAUDE.md's Consistency section is explicit that this is a defect in
itself: _"The codebase should read as though one person wrote it."_ Six concrete
divergences, all in one 399-line file:

**a. `deleteFromR2` is the one R2 function with no configuration guard.**
`uploadToR2` (`:78-81`), `copyFileInR2` (`:142-146`) and `getPresignedUrl`
(`:190-194`) all begin with `if (!validateR2Config) throw new Error('R2 is not
configured…')`. `deleteFromR2` (`:107-128`) does not. Failure scenario: on a
deploy with `R2_*` unset, the retention sweep (`db/maintenance.ts:280` is the
production caller) issues a DeleteObject to the literal host
`https://undefined.r2.cloudflarestorage.com` with `accessKeyId: ''` and fails
with an opaque SDK/DNS error, where every sibling function would have failed with
the sentence naming the cause. Already known and written down in a test helper —
`tests/helpers/object-store.ts:13`: _"`deleteFromR2` has no such [guard]"_ — but
not fixed and not in `should-ignore.md`.

**b. The doc comment prescribes the opposite of what the code does.**
`:30-36` says `* - region: 'auto' for R2 compatibility`; `:44` is
`region: 'weur'`. A reader following the comment would "fix" a working
configuration. CLAUDE.md Baseline 4-5: a comment must supply what the code
cannot — this one contradicts it.

**c. Four `try { … } catch (error) { throw error; }` blocks.** Lines 100, 125,
161, 225 (`grep -n 'throw error;' lib/r2/client.ts` returns exactly those four).
Every one is a no-op that only widens the stack. This is a class of four, not one
slip.

**d. R2 is the only env group with no boot-time validation.**
`:11-16` reads all six `R2_*` variables straight from `process.env`, and
`rg` confirms they appear nowhere else in application code.
`lib/env.server.ts:8-14` states its contract — _"Hard-fail at module-load time
when a required server env var is missing… Imported by every server-only module
that depends on these values (auth, DB, rate-limit, captcha, OTP)"_ — and R2 is
absent from that list. So a deploy missing R2 credentials boots green, passes the
health check, and fails on the first upload.

**e. Logging convention.** `:203-207` uses
`console.error('[R2] Expiry time …')` — a plain interpolated string, with an
`[R2]` prefix used nowhere else, at `error` level for a value that was
successfully clamped (not an error). Every other module in this codebase logs
`console.error(JSON.stringify({ msg: …, errorClass: … }))`.

**f. `getR2ConfigStatus` leaks values where it reports presence.** `:389-398`
returns `accountId`/`accessKeyId`/`secretAccessKey` as booleans but
`publicBucket`, `privateBucket` and `publicUrl` as their **actual values**. It
has no HTTP caller today (only `scripts/probe/dev-live/database/retention-sweep.dev-probe.ts:267`),
so this is latent rather than live — but the shape invites exposure, and
`app/api/health/storage/handler.ts:18-19` states the opposite rule for this
codebase: _"The body reports status only: no paths, schema contents, or row
counts."_

### F16 — The entire self-service credential surface has no test of any kind (Medium)

Five routes change a user's own credentials, and none of them is referenced
anywhere under `tests/` or `scripts/`:

```
$ rg -n 'change-password|change-email|change-phone|forgot-password|passwordless/send' tests/ scripts/
(no output)
```

The URL literals that appear anywhere in `tests/` are only these two:

```
$ rg -o "'/api/[a-z0-9/:._-]+'" tests/ -N --no-filename | sort -u
'/api/dash/roles'
'/api/dash/users'
```

Untested routes, verified individually: `POST /api/dash/users/me/change-password`,
`POST /api/dash/users/me/change-email`,
`POST /api/dash/users/me/change-email/verify`,
`POST /api/dash/users/me/change-phone`,
`POST /api/dash/users/me/change-phone/verify`,
`POST /api/auth/forgot-password/send`, `POST /api/auth/forgot-password/reset`,
`POST /api/auth/passwordless/send`, `GET /api/dash/users/:id`,
`DELETE /api/dash/users/:id`, `DELETE /api/dash/users/:id/sessions`,
`GET|PUT|DELETE /api/dash/permissions/:id`, `GET /api/health/storage`,
`POST /api/internal/sqlite-sweep`, `GET /api/dev/email-test/fixed`.

Failure scenario: these are precisely the endpoints where a regression is a
credential-boundary failure rather than a broken feature. `change-password` calls
re-auth (`verifyLoginAttempt`), a HIBP check, an argon2 rehash, a session-revocation
sweep and an audit write, in a transaction — and `should-ignore.md` "Known
Issues" #1 and #6, plus entry #54, all describe live race and notification gaps
in exactly this code. Every one of those accepted risks is accepted without a
single test pinning the current behaviour, so there is nothing to detect the
moment an accepted risk turns into a realised one. `forgot-password/reset` is the
unauthenticated password-reset path; it has no test either.

This is not a gap the strategy document already tracks: `reports/test-strategy.md`
mentions `forgot-password` exactly once (line 1126, in a note about rate-limit
keyspaces) and never mentions `change-password`, `change-email` or `change-phone`
at all.

CLAUDE.md, Verification: _"Write and run a test when reasoning isn't enough."_
For a re-auth-then-mutate sequence with a documented TOCTOU window, reasoning is
not enough.

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
(`server.ts:178`). The provider accepts the TCP connection and stops responding.
The transaction has already committed — `utils/otp.ts:579` closes it and `:610`
is `await sendOtp(channel, sendTo, otpCode, smsMessage)`, deliberately _after_
the commit — so the row is durable with `nextAllowedAt` set. Result:

1. The user is throttled for the backoff window (`calculateNextAllowedAt`,
   30 s on the first attempt) having received no code.
2. The client's connection is dropped at ~60 s with an empty body and no error —
   the exact failure `server.ts:169-171` records as measured (_"a 35-second
   handler had its connection dropped at 32.1 s with an empty reply and no error
   body"_).
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
`uploadToR2({ key })` → `lib/r2/client.ts:86-96`
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

The reachable nullable column is `roles.description` — `db/schema.ts:491` is
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

### F44 — Bun 1.4's `Bun.cron()` removes the primary recorded objection to an in-process sweep, and with it two internet-reachable maintenance endpoints (Medium)

This is the brief's third category — _"a relevant Bun 1.4 feature would produce a
concrete, evidenced improvement in security."_

`lib/sqlite/maintenance.ts:10-25` records the decision and its reasons:

> _"ON THE IN-PROCESS CRON, decided rather than left open: `@elysia/cron` would
> remove an authenticated, internet-reachable maintenance endpoint from the
> attack surface, along with `SQLITE_MAINTENANCE_TOKEN` and one gate of the
> deployment runbook. It is NOT adopted now, for three reasons:_
> _1. It is another Elysia coupling while the Elysia-versus-Hono question is
> open, and the trigger would have to be rewritten with the framework._
> _2. The sweep must run as ONE job. That is a single-process assumption, and
> Elysia's `reusePort` defaulted to `true` until this pass…_
> _3. The specific defect that motivated it … is fixed at the source."_

All three arguments are about `@elysia/cron`, a **framework plugin**. Bun 1.4
ships `Bun.cron()` as a **runtime** API, and that dissolves reason 1 exactly:

- It is not a framework coupling. It survives an Elysia→Hono move untouched,
  which is precisely the property this module says it needs. The trigger would
  live next to the work in `lib/sqlite/maintenance.ts`, not in `app.ts`.
- Reason 2 is already satisfied by this codebase: `app.ts:216` now sets
  `reusePort: false`, and the module's own text says the single-process
  assumption _"is only sound now that `reusePort: false` makes a second process
  fail loudly."_
- Reason 3 was never an argument against a cron — it records that a _separate_
  defect was fixed at source.

From the release post: _"Bun.cron() registers a scheduled job with the operating
system… You can also pass a function instead of a file. Bun runs it on the event
loop, with no system cron involved. **Jobs never overlap**, and `using` stops the
job when it goes out of scope"_, plus `job.unref()` and `job.stop()`.
Non-overlap matters here — `runMaintenanceSweep` is a bounded batch loop
(`lib/sqlite/sweep.ts:54-67`) that must not run twice concurrently.

What adopting it would concretely remove:

- `POST /api/internal/sqlite-sweep` and `POST /api/internal/db-sweep` as
  unauthenticated-reachable routes (`routes.ts:291-308`, `preAuth: 'none'`);
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

Reported as a finding rather than a suggestion because the recorded decision is
now resting on a premise the runtime has removed, and nothing in the module will
say so the next time someone reads it.

### F45 — `TODO.md` is gitignored, and eleven tracked source files cite it as the register of deferred decisions (Medium)

```
$ git ls-files --error-unmatch TODO.md
error: pathspec 'TODO.md' did not match any file(s) known to git
$ git check-ignore -v TODO.md
.gitignore:15:TODO*.md	TODO.md
```

The file is 17.5 KB on this machine and is referenced by name — often by item ID —
from tracked source:

| tracked file                          | reference                                              |
| ------------------------------------- | ------------------------------------------------------ |
| `server.ts:174`                       | _"the target VPS, which is recorded in `TODO.md`"_     |
| `routes.ts:267`                       | _"NOT measured on the target host yet — see TODO.md"_  |
| `db/index.ts:60`                      | _"(TODO.md items 2 and 3)"_                            |
| `db/schema.ts:105`                    | _"needs a migration — tracked in `TODO.md`"_           |
| `lib/id.ts:20`                        | _"`TODO.md` EM-5 for the decision"_                    |
| `lib/http/openapi.ts:24`              | _"That trade is recorded in `TODO.md`"_                |
| `lib/auth/rotation.ts:56`             | _"see the verification-session TTL item in TODO.md"_   |
| `lib/sqlite/maintenance.ts:27`        | _"Recorded in TODO.md so the decision is revisitable"_ |
| `lib/sqlite/database.ts:101`          | _"as an open decision in TODO.md"_                     |
| `scripts/find-unused-files.ts:85`     | _"recorded in TODO.md"_                                |
| `docs/framework-migration.md:125,129` | _"`TODO.md` EM-1"_, _"`TODO.md` EM-6"_                 |

plus `bench/uuid/README.md` and `bench/image/README.md`, and the CI gate's own
justification (`.github/workflows/ci.yml:44-46`: _"which is tracked in
TODO.md"_).

Failure scenario: CLAUDE.md §1 states this repository _"is the **starter kit** for
most of my upcoming projects."_ Clone it and you get eleven source files pointing
at a register that is not there — including the deferred measurements that make
several **numbers in the code** provisional (`IDLE_TIMEOUT_SECONDS`, the upload
route's 120 s ceiling, `MAX_IMAGE_SIZE = 1 // placeholder`). Each of those reads
as a settled value with a pointer to the reasoning, and the pointer resolves to
nothing. The same applies to a second machine, to CI, and to anyone reviewing a
PR. It also means the knip backlog (F11) and the `utils/images/server.ts`
exemption (F38) are both "tracked" in a file no reviewer can open.

The ignore rule is `TODO*.md`, a pattern rather than a path — so this was almost
certainly aimed at scratch files like `TODO-notes.md` and caught the register
too. (`CLAUDE.md` and `/prompt-*.md` are ignored by the same block; those read as
deliberate personal-workflow exclusions and I am not reporting them. `TODO.md` is
different precisely because tracked code depends on it.)

CLAUDE.md, Baseline 4-5: a comment must supply what the code cannot. Eleven of
them delegate that job to a file the reader does not have.

### F2 — `openApiConsistencyProblems` is documented as exported and is not (Low)

`lib/http/openapi.ts:391` states: _"Exported so it can be asserted directly,
rather than only through the 500 that `openApiDocument` raises."_ Line 392 is
`function openApiConsistencyProblems(` — no `export`. Verified by grep: the only
references anywhere are the definition, the one internal call at line 445, and
three report files that repeat the false claim
(`reports/test-strategy.md:612` — _"`openApiConsistencyProblems(manifest)` is
exported for this"_, `reports/elysia-migration-verification-response.md:663` —
_"is now real and exported"_).

Failure scenario: a test author follows `reports/test-strategy.md:612` and writes
`import { openApiConsistencyProblems } from '@/lib/http/openapi'`. It does not
compile. The consequence is not the compile error but what it has already cost:
the four consistency rules at `openapi.ts:405-427` have **no direct test**, and
their only coverage is the indirect 500 in `scripts/smoke.ts:79`. The stated
reason for exporting — asserting the rules directly rather than through a 500 —
is exactly the coverage that is missing.

CLAUDE.md, Baseline 4: _"Comment only where a reader would ask *why* and the
answer isn't recoverable from the code."_ A comment asserting a property the code
does not have is worse than none — it was believed by two later documents.

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

### F5 — Bun 1.4 invalidates the recorded measurement that justifies the after-response settle loop (Low)

`server.ts:254-257` states as measured fact:

> _"What survives is an ALREADY-ESTABLISHED keep-alive connection: a second
> request written on a socket opened before the stop was still served after it
> resolved. So requests can still arrive during the drain, which is what the
> settle loop in `lib/http/after-response.ts` exists for."_

That is no longer true on Bun 1.4, which closes idle keep-alive connections
immediately on `stop()`. Reproduced:

```
$ bun keepalive.ts
{ "bun": "1.4.0",
  "firstRequestServed": true,
  "stopResolvedInMs": 2,
  "secondRequestWriteError": null,
  "secondRequestServed": false,
  "rawAfterStop": "\"<CLOSED>\"" }
```

Request 1 on the keep-alive socket was served; `stop()` resolved in 2 ms; the
second request written on that same socket after `stop()` resolved was **not**
served and the socket was closed.

Failure scenario: this is a comment, so it misleads a reader rather than a
client — but it is load-bearing, which is why it is worth reporting. It is the
stated justification for the settle loop in `lib/http/after-response.ts`, and the
next person to touch shutdown will reason from a premise the runtime no longer
supports: either keeping a loop for a case that cannot happen, or removing it
after discovering the premise is false without noticing that F4 introduced a
_different_ reason to keep a bounded drain. The comment is careful to say
"re-measured on `elysia@1.4.29`" — but `stop()` is Bun's, not Elysia's
(the comment says so itself: _"a thin delegate to `Bun.serve`'s"_), and the Bun
version moved underneath the measurement.

CLAUDE.md, _Before claiming a defect_: _"Check the **installed** version of the
library, not your memory of it."_ The same duty applies to a recorded measurement
that a later runtime upgrade silently invalidates.

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
2. **No throttle.** `routes.ts:291-308` declares `preAuth: 'none'` for both
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

### F11 — `knip` is a devDependency with a 95-line config that no gate ever runs (Low)

`knip.jsonc` is a maintained 95-line configuration and `knip` is a devDependency,
but nothing enforces it. `.github/workflows/ci.yml:41-48` runs the scanner alone
and says so:

> _"The scanner alone, not `bun run find:unused-files`, which also runs knip. Knip
> currently reports 85 unused exports and 34 unused exported types that predate
> this work; gating on it would fail every build until that is cleaned up, which
> is tracked in TODO.md."_

`lefthook.yml:64` likewise runs `bun scripts/find-unused-files.ts`, not the
`find:unused-files` script that chains knip. So `bun run find:unused-files`
(`package.json:17`) is the only path that invokes knip, and it is invoked by no
gate.

Failure scenario: a config that no gate reads drifts silently — a `@knipignore`
added for a file that later becomes genuinely dead keeps it invisible, and the
85-export backlog the CI comment records has no mechanism that stops it growing.
The deliberate exclusion is documented and reasonable as a decision; what makes
it a finding is that there is no ratchet, so the gap can only widen. This is the
"configured but not enforced" case the brief names, and it is the only one I found
where the tool itself works (verified above) and the config is current.

### F15 — Four exported functions in `lib/r2/client.ts` have no production caller and each is hidden from the dead-code scanner with `@knipignore` (Low)

Verified by ripgrep with `bench/`, `tests/`, `reports/` and `*.md` excluded — the
only hits are the definitions themselves:

| export              | line | `@knipignore` at | production callers |
| ------------------- | ---- | ---------------- | ------------------ |
| `copyFileInR2`      | 135  | 133              | none               |
| `getPresignedUrl`   | 175  | 172              | none               |
| `getPublicUrl`      | 246  | 240              | none               |
| `isAllowedMimeType` | 263  | 261              | none               |

`tests/helpers/object-store.ts:54` independently confirms one of them:
_"`getPresignedUrl` has no production caller to vary it for."_

Failure scenario: `isAllowedMimeType` is the one that matters, because it is a
security helper with a **fail-open default** —
`if (!allowedTypes || allowedTypes.length === 0) return true; // Allow all if no
restrictions` (`:266-268`). It is dead today, so it protects nothing and harms
nothing. The risk is the shape it leaves lying around: the next author who needs
MIME filtering finds a ready-made helper whose empty-list case admits everything,
and a caller that resolves its allowlist from configuration would silently accept
any upload if that configuration were missing. The real MIME gate lives elsewhere
(`utils/images/config.ts` / the upload handler), so this is also a second,
divergent implementation of the same concept — the F12 pattern again.

The `@knipignore` markers are what make this invisible: 20 of them across the
repo, four in this one file. Combined with F11 (no gate runs knip at all), the
dead-code signal is suppressed twice — once by the annotation and once by the
absent gate.

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

used once, at `types/data-table.ts:41`:

```ts
export interface ExtendedColumnSort<TData> extends Omit<ColumnSort, 'id'> {
```

`ColumnSort` is `{ id: string; desc: boolean }`, and the `Omit<…, 'id'>` discards
half of it — so the entire value drawn from the package is `{ desc: boolean }`.

There is no React in this repository: no `.tsx` file exists
(`rg --files --glob '*.tsx'` → empty), no module imports `react`, and `react` is
not in `dependencies` or `devDependencies`. The same file carries 25 lines of
commented-out React module augmentation (`types/data-table.ts:5-35`) referencing
`RowData`, `React.FC`, `SVGProps` — the leftover of a front-end that is not here.

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

`server.ts:356-359` registers handlers for `SIGTERM` and `SIGINT` and nothing
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
`lib/http/after-response.ts:102-119` isolates every task in its own `try/catch`
and its drain uses `Promise.all(inFlight).catch(() => {})` (`:198`);
`lib/auth/passwordless.ts:209` has a `.catch(() => {})`; and the single
`void`-ed promise in application code, `server.ts:358` `void shutdown(signal)`,
cannot reject because `shutdown` swallows everything (`:315-332`) and the store
closes are individually wrapped (`:339-354`). So this is a resilience gap, not a
live defect — the same shape as F8.

Failure scenario, and why it is still worth reporting: the sources that remain
are the ones application code does not wrap — the `Bun.SQL` pool
(`db/index.ts:48`) and `bun:sqlite` raising asynchronously outside a query
`await`, and any future post-response caller (`enqueueAfterResponse` has, by its
own comment at `lib/http/after-response.ts:67`, _"NO CALLER YET"_). When one
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
startup/shutdown paths, resource leaks."_ `server.ts` invests ~130 lines in a
correct, bounded, logged shutdown; nothing guarantees that path is the one taken.

### F21 — Bun 1.4 makes the `Set-Cookie` re-append workaround unnecessary, and its stated premise is false on the pinned runtime (Low)

This is the brief's second category — _"the code retains a workaround that Bun
1.4 makes unnecessary."_

`lib/http/response-policy.ts:56-63`:

```ts
// `getSetCookie` is the only way to carry repeated `Set-Cookie` values
// through a copy; `new Headers(headers)` folds them into one comma-joined
// line, which browsers reject.
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

The copy carries both cookies as separate entries. The comment's premise — that
`new Headers(headers)` _"folds them into one comma-joined line"_ — describes only
what `.get('set-cookie')` returns, which is the documented Fetch-spec behaviour
for `get()` on a multi-valued header and is unrelated to what goes on the wire.
Bun 1.4's header change says so explicitly: _"Set-Cookie still comes back as
separate values from `getSetCookie()`."_ And in Bun 1.4 the same comma-folding
now applies to `x-dup` too (`"first, second"` above), which is the general
behaviour change, not a `Set-Cookie` defect.

Failure scenario: none at runtime — the workaround is idempotent (delete, then
re-append the same values in the same order), so it is dead weight rather than a
bug. The cost is the comment: it records a runtime behaviour that does not exist,
in the one function that every response in the application passes through, and it
is the kind of claim a later reader will trust rather than re-measure. The
`getSetCookie()` call itself is still the correct way to enumerate the values;
what is obsolete is the delete-and-re-append, and the reason given for it.

CLAUDE.md, _Before claiming a defect_: _"A behaviour you remember from an earlier
version is a hypothesis, not a bug report."_ Applies symmetrically to a
workaround kept for a behaviour that is no longer there.

### F23 — `MAX_REQUEST_BODY_BYTES` is 8× the largest body any route accepts, and its comment claims a derivation that does not exist (Low)

`app.ts:137-138`:

```ts
/** Body big enough for the largest legitimate upload plus multipart framing. */
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
```

The largest legitimate upload is 1 MiB, not 8:
`utils/validation/constants.ts:4` is `export const MAX_IMAGE_SIZE = 1; // MB`,
`app/api/upload/image/handler.ts:21` is
`const MAX_FILE_SIZE = MAX_IMAGE_SIZE * 1024 * 1024`, and
`:22` is `const MAX_FILES_PER_REQUEST = 1`. So one file, 1 MiB, plus multipart
framing — a few hundred bytes. 8 MiB is not that number.

Failure scenario: the comment asserts the constant is derived from the upload
limit, so a future change to `MAX_IMAGE_SIZE` reads as automatically covered when
it is not. Raise `MAX_IMAGE_SIZE` to 10 and the route silently starts rejecting
at the _framework_ layer with Bun's own 413 instead of the handler's
`uploadMsg.fileTooLarge` envelope — the client gets a different error shape for
the same mistake, and the handler's message is unreachable. In the other
direction, every admitted request may currently buffer up to 8 MiB for a body
that will be refused above 1 MiB.

The proxy-side consequence — that 8 MiB is the number Cloudflare and Traefik are
aligned to, that it may be set tighter, and that it must never be set below what
the application accepts — is `reports/coolify-deployment.md` §5.

This is worth reporting mainly because the codebase does this correctly
elsewhere and clearly knows the pattern: `app.ts:149-152`
(`MAX_ROUTE_TIMEOUT_SECONDS` reduced from the route table) and
`server.ts:203-204` (`SHUTDOWN_TIMEOUT_MS` derived from two ceilings, with a
comment explaining precisely why writing the number twice is wrong). The same
argument applies here and was not applied. CLAUDE.md, Consistency: _"where
patterns compete, adopt the dominant one."_

### F26 — Two log sites bypass the structured-logging convention with a bracket-prefixed string (Low)

Every log call in this codebase emits one JSON object — `console.error(JSON.stringify({ msg, … }))`
or `console.error(sanitizeForLog({ msg, … }))` — with `msg` as a dotted or
spaced key (`'otp.provider.failed'`, `'server stopping'`, `'hibp.degraded'`).
`lib/http/after-response.ts:138-148` is the access log and defines the shape.

Two sites do not:

- `lib/captcha.ts:32` —
  `console.error('[captcha] TURNSTILE_SECRET_KEY missing — rejecting request');`
- `lib/r2/client.ts:203-207` —
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

`utils/index.ts:425-429`:

```ts
export const positiveInt = (val: unknown, maxValue = MAX_ID) => {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0 || num > maxValue) return 0;
  return num | 0;
};
```

`app/api/dash/users/[id]/sessions/pagination.ts:104-124` documents this exact
defect class and fixes it locally, for the same concept:

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

`utils/index.ts:317` and `:327`:

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

### F38 — The CI dead-code gate carries a named exemption for the live SVG sanitiser, justified by a directory that no longer exists (Low)

`scripts/find-unused-files.ts:78-88`:

```
 * `utils/images/server.ts` — a second, DIVERGENT copy of the server-side SVG
 * sanitiser/optimiser. The live one is `utils/svg/server.ts`
 * (`lib/r2/upload-helper.ts` imports it); … only this file is orphaned.
 */
const KNOWN_UNREACHABLE = new Set(['utils/images/server.ts']);
```

Three of those claims are false today:

```
$ ls utils/svg/
ls: cannot access 'utils/svg/': No such file or directory

$ rg -n "from '@/utils/images" lib/
lib/r2/upload-helper.ts:14:import { sanitizeSvgServer, svgOptimizerServer } from '@/utils/images/server';
```

`utils/images/server.ts` is the **live** SVG sanitiser on the image-upload path,
not an orphaned duplicate, and the file said to be live does not exist. The
exemption is currently inert — the gate passes without needing it:

```
$ bun scripts/find-unused-files.ts
No unreachable files. Every file is reachable from an entry point.
gate exit=0
```

Failure scenario: this is a real CI gate (`.github/workflows/ci.yml:49`) and the
exemption is permanent. If `utils/images/server.ts` ever _does_ become orphaned —
for instance if `upload-helper.ts` moves SVG handling to `Bun.Image` — the gate
stays silent about the security-relevant sanitiser being dead, which is the one
case the exemption most needs to stop covering. The comment says an entry here
_"is a decision someone has to defend"_; the decision it defends is no longer the
one in front of it.

Same stale reference in the test specification:
`reports/test-strategy.md:1268` and `:1275` require tests _"against both copies:
`utils/svg/server.ts` and `utils/images/server.ts`"_ — half of which cannot be
written. Same class as F13.

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

### F41 — The daily OTP spend breaker allows 2× the day's budget in one second at the UTC boundary, which its own justification does not cover (Low)

`lib/rate-limit/index.ts:33-40` accepts the fixed-window 2× boundary burst and
adds:

> _"For the global daily OTP budget a fixed window is also the more faithful
> model: it IS a calendar-day cost cap, not a rolling one."_

With `OTP_GLOBAL_SEND_CAP_PER_DAY = 2000` and `window = ONE_DAY_S`
(`lib/rate-limit/api.ts:121`, `:200-206`), `windowStart = now - (now % 86_400_000)`
is UTC midnight.

Failure scenario: 2000 charges at `23:59:59.999Z` and 2000 at `00:00:00.000Z`
dispatch **4000 paid messages inside one second**, and leave the whole of day two
at zero. The sustained-rate argument in that docstring holds; the _cost_ argument
does not — a spend cap that can be doubled in a burst is not a spend cap, and
this breaker exists specifically because _"~2000 requests naming nonexistent
addresses exhausted a full day of delivery for the whole application at zero cost
to the attacker"_ (`api.ts:187-195`). This is the one claim in that docstring the
code does not support. Cheap to close (anchor the daily key on a rolling counter,
or halve the cap across two staggered windows).

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
`lib/r2/client.ts:203-207` and this site.

### Correction to F5 — the stale keep-alive measurement is recorded in three places, not one

F5 quotes `server.ts:254-257` and names `lib/http/after-response.ts` only as the
consumer of the claim. It is not just the consumer — it repeats the measurement
verbatim at `lib/http/after-response.ts:166-171`:

> _"An earlier revision of this comment gave the wrong reason for that — it
> claimed `Elysia.stop()` does not close the listening socket. It does:
> re-measured on `elysia@1.4.29`, a new connection is refused as soon as
> `stop()` resolves. **What survives is an ALREADY-ESTABLISHED keep-alive
> connection, on which a further request is still served.** The hole is real…"_

So the claim my probe falsified on Bun 1.4.0 is written down in three artefacts:
`server.ts:254-257`, `lib/http/after-response.ts:166-171`, and
`reports/test-strategy.md:817-822` (as a required assertion — F13). All three are
one class and move together.

### Classes checked in pass 2 and found complete

- **Comments claiming a symbol is exported when it is not.** Swept every
  `Exported (for|so|because)` / `is exported` comment in tracked source.
  Three others make the claim and all three are true: `utils/index.ts:374-376`
  (`export function serializeForLog`), `lib/http/pre-auth.ts:25-29`
  (`export function preAuthScope`), `app.ts:40-47` (`export const ROUTE_MANIFEST`).
  `lib/http/openapi.ts:389-392` (F2) is the only false one — the class is a
  single instance.
- **Version-pinned "measured on" claims that Bun 1.4 could have invalidated.**
  Swept all 25. The Bun-pinned ones (`db/index.ts:15`, `db/schema.ts:64`,
  `lib/sqlite/database.ts:65`, `lib/sqlite/driver.ts:110`, `lib/id.ts:19`,
  `tests/helpers/*`) all state Bun 1.4.0 and remain accurate. The Elysia-pinned
  ones that do not touch `stop()` (`app.ts:187`, `app.ts:378`,
  `lib/http/response-policy.ts:7`, `lib/http/route-manifest.ts:166`) concern
  routing and header precedence, which Bun 1.4 does not change. Only the
  `stop()`/keep-alive claim is stale, and it is the one corrected above.
- **Two implementations of one concept.** Three candidate pairs examined.
  `haveIBeenPwned` plugin vs `lib/auth/check-password.ts` — real, reported as
  **F12**. `utils/svg/*` vs `utils/images/*` — resolved in the working tree
  (`utils/svg/` deleted); only the stale references remain, reported as **F38**.
  `db/maintenance.ts` vs `lib/sqlite/maintenance.ts` — **not** a defect: they are
  different jobs against different stores on different schedules, and the
  directory prefix carries the distinction.
- **Fail-open/fail-closed asymmetry across limiter call sites.** All 27 sites
  inventoried. The five fail-open ones (`users.get`, `users.id.get`,
  `permissions.get`, `permissions.id.get`, `roles.get`) are all read-only routes
  declaring `preAuth: 'ip-limit'`, and `lib/http/adapters/elysia.ts:58` runs the
  fail-**closed** `enforcePreAuthIpLimit` ahead of the handler — so a store
  outage 503s before the fail-open limiter is reached. Not a defect. This is also
  what showed F24's premise to be false; F24 is withdrawn above.

## Pass 3 — confirmation

Pass 3 re-walked the worklist against the findings list looking for any unit
where pass 1 recorded a conclusion that pass 2's cross-cutting view contradicts.
It surfaced **nothing new** — no new findings, and no further corrections beyond
the two above.

**The run ended on pass 3**, the second consecutive pass to surface no new
finding (pass 2 produced two corrections to existing findings and no new ones;
pass 3 produced neither).

One coverage limit worth stating rather than leaving implicit: `tests/`,
`bench/` and `docs/` were swept for _what they assert about the application_ —
which is where F13, F16, F18 and F38 came from — and not audited as software in
their own right. `bench/s3/` in particular is 8 test files of untracked
in-progress work whose own correctness I did not review; `bench/s3/README.md`
was read and its conclusions were taken as given (see the B9 entry under
"Deliberately swept").

## Open

Empty at the end of the run, as required. Both entries opened during the sweep
were resolved:

- **O1 — "the Coolify health check omits PostgreSQL".** Resolved into a finding:
  **F47**. `should-ignore.md` #8 covers _having no health check_; this endpoint
  exists, is used as the readiness probe, and asserts `ok` while the primary
  datastore is unreachable — a different proposition, so it is reported at Low.
- **O2 — "Bun 1.4 duplicate-header combining vs. header consumers".** Resolved to
  **no finding**, and deleted rather than promoted. I inventoried every
  `headers.get()` consumer in application code:
  `x-maintenance-token` (3 sites), `content-type`, `x-captcha-response`,
  `cf-connecting-ip`, `user-agent`, `x-forwarded-for`, `host`. Every one
  either compares for equality — so a comma-joined duplicate fails the compare and
  the request fails **closed** — or is only logged. `cf-connecting-ip` is
  validated by `IP_SCHEMA` (`lib/audit.ts:65`) and a combined value is
  rejected, and `getSetCookie()` is unaffected by the change (see F21). Nothing
  is weakened.
