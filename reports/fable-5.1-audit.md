# Fable 5.1 audit

Scope: whole repository at commit `ca4ed06`, excluding `tests/`. Runtime pins: Bun 1.4.2, Elysia 1.4.30, Drizzle 0.45.2, Better Auth 1.7.3, PostgreSQL 18. Items documented in `reports/should-ignore.md` are not repeated.

## Findings

### F-18 · High · User creation and bulk session revocation are outside the re-authentication class

- **Where:** `app/api/dash/users/handler.ts:147` (`POST`, `requirePermission(ctx, { resource: 'users', action: 'create' })`), `app/api/dash/users/[id]/sessions/handler.ts:94-98` (`authorizeSessionAccess`, shared by `GET` and `DELETE`), class definition `lib/http/session.ts:38-49`.
- **Evidence:** `requirePermission` checks the window only when `reauth` is passed (`lib/http/session.ts:62-70`). The complete inventory of `reauth: true` is six sites: `permissions/handler.ts:125`, `permissions/[id]/handler.ts:136,407`, `users/[id]/handler.ts:824,891`, `users/[id]/two-factor/handler.ts:64`. The PUT site's own rule reads "Either all of them are or none are." Neither the create nor the session route passes it.
- **Failure scenario:** A stolen session cookie of an administrator holding `users.create` (the threat the window exists for) cannot reset a password, change a role, delete or reset 2FA — each answers `401 REAUTH_REQUIRED` — but it can `POST /api/dash/users` with a chosen password and any standard role whose matrix is within the actor's (`validateRolePermissionScope(..., 'grant')`, `handler.ts:184-192`), or with `permissions.create` a custom matrix up to the actor's own. The result is an independent credential that survives rotation of the compromised account. Separately, `DELETE /api/dash/users/:id/sessions` with `revokeAll` signs every in-scope user out without the window that the equivalent `PUT` (deactivate, password change) requires.
- **Impact:** The control is bypassed for the action with the largest consequence in the family it guards: converting a transient session compromise into a persistent principal.
- **Remediation:** Add `reauth: true` to the `POST` call and to `authorizeSessionAccess` (scoped to `DELETE`, or split the call, if listing one's own devices is meant to stay ungated).
- **Tests:** none assert which routes require the window; `tests/integration/mutating-route-authorization.test.ts:100-104` signs in with the window already open and `signedInUser` always mints it (`tests/helpers/session.ts:294-296`). A route-table-driven case ("re-auth routes answer 401 `REAUTH_REQUIRED` before the window is opened") would have caught both members.

### F-43 · High · Nine known addresses exhaust the deployment-wide OTP delivery budget and switch off recovery, passwordless and email second-factor sign-in for a day

- **Where:** `lib/rate-limit/api.ts:137,191-201` (`OTP_GLOBAL_SEND_CAP_PER_DAY = 2000`, key `otp.send.global:<contactKind>`, no surface dimension), charged for every purpose at `utils/otp.ts:759`; per-surface destination cap `OTP_SURFACE_SEND_CAP_PER_HOUR = 5` (`api.ts:143`).
- **Evidence:** `tests/unit/otp-global-breaker.test.ts:182-185` pins the key shape (one key per contact kind). The destination quota is split per surface precisely so "no other surface can spend" reserved capacity (`api.ts:152-159` and the test's own wording at `:115-118`), but the pool every surface drains into is not. Per real address per hour, anonymously: `recovery` 5 + `passwordless` 5 (+ `verify_contact` 5 while unverified) → 240 global units a day → 2000 ÷ 240 ≈ 9 addresses.
- **Failure scenario:** An attacker sprays `/api/auth/forgot-password/send` and `/api/auth/passwordless/send` at nine harvested staff addresses, ten requests an hour each (about 2 160 Turnstile tokens a day). Once `otp.send.global:email` reaches 2 000, the three anonymous send routes collapse the breaker's refusal into the generic `200 + nextAllowedIn: 30` (`forgot-password/send/handler.ts:107-111`, `passwordless/send/handler.ts:110-112`, `otp/send/handler.ts:158-167`), so every user is told a code was sent and none is; `/two-factor/otp/send` (`lib/auth/two-factor-otp.ts:194`) and `/forgot-password/second-factor/send` (`:97-112`) surface the failure, so a user whose only second factor is email OTP cannot sign in and the recovery grant chain is dead. Known Issue #12 (fixed UTC window) lets the same 2 000 be spent twice across midnight.
- **Impact:** Deployment-wide denial of account recovery and of sign-in for the email-OTP population at trivial cost, with no user-visible error and no log line that distinguishes budget exhaustion from any other `*.send.failed`.
- **Remediation:** Split the breaker into a reserved tier (`recovery`, `two_factor`, `recovery_second_factor`) and a discretionary tier (`verify_contact`, `passwordless`, `contact_change`) the way the destination quota is already split; add a per-destination daily cap on the global charge (it is post-eligibility, so the pre-lookup oracle argument does not apply); emit a distinct `otp.budget.exhausted` log line.
- **Tests:** none assert that a flood on one surface leaves the global budget available to recovery or the second factor.

### F-77 · High · `scripts/migrate.ts` reports success for every schema state the Drizzle migrator cannot reconcile

- **Where:** `scripts/migrate.ts:78-80` (`migrate(drizzle({ client }), { migrationsFolder })` followed by `ok`), `node_modules/drizzle-orm/pg-core/dialect.js:56-71`, `node_modules/drizzle-orm/migrator.js:22-23`.
- **Evidence:** The installed migrator reads one ledger row (`order by created_at desc limit 1`) and applies a journal entry only when `lastDbMigration.created_at < migration.folderMillis`. The `hash` it writes is never compared. Three states therefore print `drizzle migrations ... ok` and `up to date` while applying nothing: (a) code rolled back to a folder ending at `0010` against a database at `0011`; (b) an applied `.sql` file edited in place; (c) a journal entry whose `when` is lower than an already-applied entry's, which is skipped permanently. Today's journal is strictly increasing (`1777126781584 … 1788770375076`, checked), but nothing enforces it, and merging two branch-generated migrations is the ordinary way to break it. The test harness detects (b) by fingerprinting every `.sql` plus the journal (`tests/helpers/provision.ts:103-124`); production has no equivalent.
- **Failure scenario:** Two feature branches each run `db:generate`; the branch merged second carries the lower `when`. Staging, already at the first branch's entry, skips the second forever and reports `ok`; a fresh environment applies both. The first write that needs the skipped column fails with a 500 that nothing in the deploy predicted.
- **Impact:** Silent schema/code divergence on the one command that gates every deploy of every project built on this kit.
- **Remediation:** After `migrate()`, assert against the ledger: row count equals `journal.entries.length`, each stored `hash` equals the SHA-256 of the on-disk `.sql`, and journal `when` values strictly increase. About fifteen lines, no dependency, and all three states become a refusal.
- **Tests:** `tests/process/oauth-migration.test.ts:90` covers fresh install, upgrade and double application only.

### F-113 · High · Four pre-parse regexes in `sanitizeSvg` are quadratic on unterminated input; one 410 KB upload blocks the event loop for tens of seconds

- **Where:** `utils/images/svg-optimizer.ts:449` (`/<!--[\s\S]*?-->/g`), `:454` (`/<!\[CDATA\[[\s\S]*?\]\]>/g`), `:459` (`/<\?[\s\S]*?\?>/g`), `:481` (`/<[^>]+>/g` for `elementCount`); size cap `:437-438` (`SERVER_MAX_IMAGE_SIZE * 2 * 1024 * 1024` = 419 430 bytes); the three strip passes precede the `includes('<svg')` gate at `:473`.
- **Evidence (measured, Bun 1.4.2, this machine):**

  | input                           | 8 000   | 16 000  | 32 000   | 300 000 benign `<a>` |
  | ------------------------------- | ------- | ------- | -------- | -------------------- |
  | `elementCount` on N `<`         | 22.7 ms | 84.0 ms | 314.1 ms | 11.5 ms              |
  | comment strip on N bytes `<!--` | 7.0 ms  | 28.7 ms | 130.2 ms |                      |
  | PI strip on N bytes `<?`        | 18.1 ms | 55.2 ms | 217.9 ms |                      |

  Clean 4× per doubling; extrapolated to the 419 430-byte cap this is roughly 50 s for `elementCount` alone (the subagent measured 53.9 s and 47 s end to end). Reached via `admitUpload` → `validateSvgUpload` → `sanitizeSvg` with `Content-Type: image/svg+xml`; the work is synchronous, so no other request in the process is served meanwhile, and `timeoutSeconds: 120` is Bun's idle timeout, which cannot interrupt it.

- **Failure scenario:** Any account with `create`/`edit` on any dashboard page uploads 400 KB of `<!--` (no valid markup needed) twenty times a minute (`UPLOAD_ADMISSION_LIMIT`); the process spends most of every minute stalled and every other user sees timeouts.
- **Impact:** Process-wide denial of service from one authenticated low-privilege account.
- **Remediation:** Drop the three strip passes (the XML parser already handles comments, CDATA and PIs, and only elements are serialised) and count `<` with a linear scan or after the parse via `querySelectorAll('*').length`; if a pre-parse strip must stay, use terminator-anchored patterns such as `/<!--(?:[^-]|-(?!->))*-->/g`.
- **Tests:** every large-input SVG test uses benign filler (`'A'.repeat(SVG_SIZE_CAP)`, well-formed comments); no unterminated-markup case exists.

### F-114 · High · An attacker-controlled ICC profile is copied verbatim into the stored WebP, unbounded in size, so the re-encode neither strips metadata nor bounds memory

- **Where:** `lib/r2/optimize-image.ts:146-166` (`encodeAttempt`: `new Bun.Image(input).resize(…).webp({ quality })`), `:81-90` (`measureEncodeCost` prices pixels only), `:290-330` (the byte-target binary search walks every rung when the target is unreachable).
- **Evidence:** Bun 1.4's release note states "ICC color profiles like Display P3 survive transcoding". Re-run of the subagent's probe on this machine: a 952-byte PNG carrying `eXIf`, `iCCP` and `tEXt` becomes a WebP whose chunks are `VP8X(10) ICCP(35) ALPH(24) VP8(2938)`; EXIF and text markers are gone, the fake ICC bytes are present verbatim; the WebP → WebP path likewise keeps `ICCP` and drops `EXIF`/`XMP`. Subagent measurements: a 7 325-byte PNG with a 50 000-byte ICC produced a 146 784-byte public object; a 194 520-byte PNG (under the 1 MiB cap) declaring a 200 000 000-byte deflated profile drove RSS from 250 MB to 576 MB across five ladder rungs and ended in `422 targetUnreachable`, because the profile is a constant no rung can shrink. `MAX_IMAGE_PIXELS`, `MAX_IMAGE_EDGE` and the megapixel budget bound none of this (the image is 64×64 and is charged the one-unit floor).
- **Failure scenario:** (a) 50 KB of arbitrary attacker bytes are stored and served from the public origin under `image/webp` with `Content-Disposition: inline`, a covert channel and a fuzz surface for downstream ICC parsers; (b) twenty ≤1 MiB uploads a minute each allocate several 200 MB output buffers on a VPS.
- **Remediation:** Decide the ICC policy in `encodeAttempt`: strip it (the pipeline normalises everything else), or refuse in `measureEncodeCost` when the declared `iCCP`/`ICCP` payload exceeds a few kilobytes, before any encode. Either way, assert metadata survival in a test.
- **Tests:** `grep` over `tests/` finds no `iCCP`, `ICCP`, `EXIF` or `exif`; the strip invariant is asserted nowhere.

### F-01 · Medium · Graceful stop aborts every in-flight request older than 5 s

- **Where:** `server.ts:144-158` (`stopServer`), `lib/shutdown.ts:8-13` (`SHUTDOWN_POLICY.gracefulStopMs = 5000`), `app.ts:178-182` (`MAX_ROUTE_TIMEOUT_SECONDS`), `routes.ts:534,684` (`timeoutSeconds: 120`).
- **Evidence:** On Bun 1.4 `server.stop()` waits for busy connections ("closes busy ones once their response is sent") and `stop(true)` closes them at once. `stopServer` races `app.stop()` against a fixed 5 000 ms sleep and then calls `app.stop(true)`. Reproduction (scratch script, Bun 1.4.2): a 3 s handler in flight plus one half-sent socket; grace 1 s.

  ```
  {"step":"before stop","pendingRequests":1}
  {"step":"after grace","raced":"grace elapsed","ms":1023,"pendingRequests":1}
  {"step":"client outcome","result":"ERR TypeError ECONNRESET","ms":1032}
  ```

  Same handler without the half-sent socket: `stop()` resolved after 2 805 ms and the client received `status 200`. `server.pendingRequests` (bun-types `serve.d.ts:1177`) counted the busy request and not the half-sent socket.

- **Failure scenario:** Coolify sends `SIGTERM` for a deploy while an administrator's upload is 6 s into image processing (the route carries `timeoutSeconds: 120` because processing "may outlast the global ceiling"). At t+5 s the connection is reset; the client sees a network error, the `files` row stays `pending` and the object, if already written, waits for the nightly sweep. Any request slower than 5 s at deploy time fails the same way.
- **Impact:** The 135 s `shutdownTimeoutMs` budget that the runbook tells the operator to protect (`reports/coolify-deployment.md` §"Stop grace period") never reaches in-flight requests; only post-response drains use it. The escalation was written for stalled half-sent sockets but cannot tell them from busy requests, so the drain semantics `app.stop()` was adopted for are lost for exactly the long requests the route ceilings exist for.
- **Remediation:** After the grace, escalate to `app.stop(true)` only while `app.server.pendingRequests === 0` (nothing but stalled sockets remains); otherwise keep waiting in grace-sized steps until the shutdown budget is spent. Correct the policy-table wording ("how long `app.stop()` may wait on half-sent connections") once the behaviour matches it.
- **Tests:** `tests/process/shutdown-lifecycle.test.ts` covers the half-sent socket and a clean stop only. Missing: a `SIGTERM` with a handler still running past `gracefulStopMs` must complete with 200 before the process exits 0.

### F-07 · Medium · The trigram search floor counts UTF-16 code units, so two-character astral terms bypass it and force sequential scans

- **Where:** `db/queries/data-table.ts:114-118` (`rawSearch.length >= MIN_SEARCH_LENGTH`), `lib/data-table/filter-columns.ts:162-166` (`filter.value.length < min`), `lib/data-table/parsers.ts:32-33` (`MIN_SEARCH_LENGTH = 3`).
- **Evidence:** `'😀😀'.length` is 4 (code units) for 2 code points, so both gates accept it while rejecting `'ab'`. Measured against PostgreSQL 18.6 on a 20 001-row table with `gin (name gin_trgm_ops)`, `EXPLAIN (costs off)`:

  ```
  ilike '%abc%'  -> Bitmap Heap Scan / Bitmap Index Scan on probe_t_name_trgm
  ilike '%ab%'   -> Seq Scan  Filter: (name ~~* '%ab%')
  ilike '%😀😀%'  -> Seq Scan  Filter: (name ~~* '%😀😀%')
  select show_trgm('😀😀') -> {}
  ```

- **Failure scenario:** Any authorised dashboard user sends `GET /api/dash/users?search=😀😀`, or up to `MAX_FILTER_ITEMS` (20) two-character astral `iLike` filters per request, at the per-user limiter rate (60/min; 120/min on media). Each request evaluates the predicate twice (rows and `count()`), unindexed, on `users`, `roles` and `files`.
- **Impact:** Availability. The floor is the only defence the layer has against unindexed substring scans for `iLike`/`startsWith`/`endsWith`, and it is bypassable by construction; the effect scales with table size.
- **Remediation:** Measure terms in code points (`[...term].length`) in one shared helper used by both gates.
- **Tests:** none cover the length unit; `tests/integration/string-bounds.test.ts` already documents the code-unit-versus-character class for Zod/`varchar`, so the sibling case has a home.

### F-19 · Medium · The user `PUT` demands the window for a self-rename and answers 401 where 403 is due

- **Where:** `app/api/dash/users/[id]/handler.ts:818-825` (gate with `throwError: false, reauth: true`), `:846-855` (self branch, then the 403).
- **Evidence:** `requirePermission` runs `hasAdminReauth` whenever `reauth` is set and a session resolved, regardless of the permission outcome (`lib/http/session.ts:62-70`). The self path writes only `name` (`selfUpdateUserSchema`, `utils/validation/auth.ts:229-235`).
- **Failure scenario:** Any dashboard user renaming themselves receives `401 REAUTH_REQUIRED` until they post their password to `/api/dash/auth/reauth`. A caller with no `users.edit` grant targeting another id also receives `401 REAUTH_REQUIRED` first and the `403` only after proving a password, inverting the ordering the gate documents ("a caller with no grant learns nothing about whether a proof would have helped").
- **Remediation:** Call `requirePermission` without `reauth`, then require the window inside the admin branch after the `editScope` check.
- **Tests:** none; every fixture touching this route runs with the window open.

### F-28 · Medium · Production may run a cached public domain with no purge credentials, so unpublish and delete are not revocations

- **Where:** `lib/cloudflare/purge.ts:7,81-82` (`CACHE_PURGE_CONFIGURED`; unconfigured returns `{attempted: 0, purged: 0, failed: []}`), `lib/media/visibility.ts:101-105` and `lib/media/lifecycle.ts:159-166` (an empty `failed` counts as purged), `lib/r2/client.ts:459-460` (`public, max-age=31536000, immutable` on every public image), `lib/env.server.ts:98-121` (production requires `R2_PUBLIC_URL` with a public bucket, but the purge pair only both-or-neither).
- **Evidence:** The unconfigured state is documented as supported ("that deployment has accepted edge copies living out their lifetime", `purge.ts:73-76`) — an owner decision — but no boot rule ties it to whether `R2_PUBLIC_URL` is a Cloudflare-cached custom domain, and the unpublish/delete responses report success either way.
- **Failure scenario:** Production, public bucket on a custom domain, purge variables unset. A published image is cached at the edge for a year; unpublish answers 200, flips the row to `private` and removes the origin object; the edge keeps serving the bytes to anyone holding the URL.
- **Impact:** For the cache lifetime, the media library's privacy control is a no-op, and nothing in the deployment, the logs or the API says so.
- **Remediation:** In production, require the purge pair whenever `R2_PUBLIC_BUCKET` is set unless an explicit opt-out names the origin as uncached (r2.dev); expose `cachePurgeConfigured` beside `canPublish` in the media list payload so the client can warn before publishing.
- **Tests:** `tests/unit/cloudflare-purge-unconfigured.test.ts` asserts the no-op; nothing asserts what unpublish reports in that configuration.

### F-29 · Medium · The transition sweep and an in-flight publish can delete both copies of a file

- **Where:** `lib/media/visibility.ts:86-98` (`tryDelete` reads `bucketType` unlocked, then deletes), `:233-238` (the request's flip is conditioned only on `transition = towards(to)`), `:298-313` (`retryTransitions` calls `tryDelete` and clears the marker afterwards in a separate statement).
- **Evidence:** A `to_public` row older than `TRANSITION_STALE_AFTER` (10 min) is picked up by the nightly sweep: `tryDelete(id, key, 'public')` passes its live check (row still `private`) and enters `deleteFromR2` plus purge (up to ~20 s). If the abandoned request's flip lands in that window, it matches (marker still `to_public`), the row becomes `public`/`cleanup`, and the request's own `tryDelete(id, key, 'private')` then sees `public ≠ private` and removes the private copy while the sweep has removed the public one. The row ends `active`/`public` with no object; the next `cleanup` pass finds nothing to delete, succeeds, and clears the marker.
- **Conditions:** A publish request still running after ten minutes, which the client-facing timeouts do not prevent (the handler continues after the socket closes) and which F-41 makes possible on a hung R2 socket; the sweep runs once a day. Unlikely, irreversible.
- **Remediation:** Make the sweep claim the row before touching the store: in one transaction, `FOR UPDATE` on the row and compare-and-set `transition` from `to_*` to `NULL`, so the abandoned request's flip can no longer match; or hold the row lock across the delete and the clear.
- **Tests:** `tests/integration/media-files.test.ts:807,877` cover a lost marker and a revert that cannot remove its target; none drives a flip landing during the sweep's delete.

### F-44 · Medium · `/forgot-password/reset` spends an outbound HIBP call and a 64 MiB Argon2id hash before any account lookup or code check

- **Where:** `app/api/auth/forgot-password/reset/handler.ts:94-100` (`checkPasswordCompromise`, `hashPassword`) before the `users` lookup at `:102` and `processOtpVerify` at `:124`; `lib/auth/password.ts:5-12` (argon2id, `memoryCost 65_536`, `timeCost 3`, `parallelism 4`).
- **Evidence (measured on this machine):** 97 ms per hash sequentially, 879 ms for eight concurrent (≈9 hashes/s, thread-pool bound). Gates in front: per-IP 60/min (`:65-71`), Turnstile, and the per-destination verify quota, which any syntactically valid address satisfies as a fresh key.
- **Failure scenario:** Sixty requests a minute per IPv6 /64 consume about a tenth of the host's hashing capacity; ten buckets saturate it, and the shared thread pool then delays every password verification, change-password and admin user creation. The same traffic turns the server into an HIBP flooder, which fails open (should-ignore #52), so sustained abuse also disables breach screening.
- **Remediation:** Charge the per-IP limiter with `cost` sized against the hash (the primitive exists for this, `lib/rate-limit/api.ts:268-274`) or lower the limit. Do not move the hash after the code comparison: its account-independence is what keeps the response free of an existence oracle (`:90-93`).
- **Tests:** none bound pre-proof work on this route.

### F-45 · Medium · A password reset can complete against an account deactivated or soft-deleted mid-flow

- **Where:** `app/api/auth/forgot-password/reset/handler.ts:102-112` (eligibility read outside the transaction) versus `:132-211` (`onVerified`); same shape in `forgot-password/complete/handler.ts:100-116` versus `:173-219`.
- **Evidence:** `processOtpVerify` locks the `users` row (`utils/otp.ts:963-967`) without an eligibility predicate, and `onVerified` re-reads only 2FA and `accounts` rows. The correct pattern exists in the same file: `markContactVerified` (`utils/otp.ts:833-849`) re-reads `users` under the lock with `deletedAt IS NULL AND isActive`.
- **Failure scenario:** An administrator suspends a compromised account while a reset holding a valid code is in flight; the reset's lock serialises after the suspension, the password is rewritten, sessions and proofs are revoked, and an audit row records `passwordReset: true` on a suspended account. Bounded because sign-in still refuses inactive accounts; live again the moment the account is restored.
- **Remediation:** Re-read `users` under the held lock with the eligibility predicate and refuse with the generic `invalidOrExpired`, on both routes.

### F-46 · Medium · The advertised resend countdown is a constant 30 s against a doubling server ladder, so obedient clients lose about every second code and burn their hourly quota

- **Where:** `app/api/auth/otp/send/handler.ts:33-35,89`, `passwordless/send/handler.ts:30,80`, `forgot-password/send/handler.ts:30,77` (`GENERIC_SEND_DATA = { nextAllowedIn: 30 }`); ladder `utils/otp.ts:55-58` (`30 · 2^(n-1)`), refusal `:640-648`, per-surface charge before the refusal (`otp/send/handler.ts:80-84`).
- **Evidence:** Send 1 at t=0 (next allowed 30 s), send 2 at t=30 (next 60 s), send 3 at t=60 is refused inside `processOtpSend`, the 429 is collapsed to `200 + "code sent" + nextAllowedIn: 30`, and the destination unit spent at `:80-84` is not refunded (`lib/rate-limit/index.ts:112-117`). After five taps the destination quota is exhausted and the client receives a real 429 with `Retry-After`, `X-RateLimit-Limit: 5` and `X-RateLimit-Remaining` (`utils/api-response.ts:140-152`).
- **Impact:** A user following the API's own countdown gets roughly half the codes they ask for and then a hard 429. Should-ignore #58's premise that the endpoint returns "an identical 200 for every case" does not hold for the destination-quota throttle; that divergence is not an existence oracle (the key is charged pre-lookup for addresses nobody owns).
- **Remediation:** Advertise the ladder's worst case (`nextAllowedIn: 480`) or flatten the ladder to a constant on the three anonymous surfaces; the real per-row value cannot be returned without an oracle.
- **Tests:** none cover the countdown's truthfulness or the destination-quota 429.

### F-53 · Medium · The 15-minute re-authentication window satisfies every destructive two-factor transition, while the behaviour document promises a password on each

- **Where:** `lib/auth/reauth-grant.ts:63-76` (`requireReauthPassword` falls back to `hasAdminReauth` when no `password` field is present), `lib/auth.ts:186-208` (the library password hook mints a synthetic proof from the same window), `lib/auth/admin-reauth.ts:23` (`ADMIN_REAUTH_MAX_AGE_S = 900`), `docs/two-factor-flow.md:309-313` ("تُطلب في كل مرة، بلا ذاكرة … لا تدوم إطلاقًا").
- **Evidence:** Every app-owned transition (`/two-factor/disable`, `/methods/disable`, `/generate-backup-codes`, `/backup-codes/acknowledge`, `/totp/start`, `/passkey/grant`) calls `requireReauthPassword`; `/two-factor/get-totp-uri` returns the decrypted secret on the window alone. `lib/auth/admin-reauth.ts:27` states the window deliberately covers 2FA management, so this is an owner decision; the document asserts the opposite guarantee.
- **Failure scenario:** A session-only attacker whose request lands inside an owner's open window posts an empty body to `get-totp-uri`, keeps the TOTP secret, and then `disable`s 2FA.
- **Remediation:** Either require a literal password on `disable`, `methods/disable` and `get-totp-uri`, or correct the document. One of the two must move.
- **Tests:** `tests/integration/oauth-review-regressions.test.ts:268` proves that neither password nor window yields the re-auth code; nothing tests that the window alone suffices or must not.

### F-54 · Medium · Sign-in and recovery second factors share one `verification_sessions` row, so a first-factor holder can block recovery

- **Where:** `lib/auth/two-factor-otp.ts:198,341,398`, `app/api/auth/forgot-password/second-factor/send/handler.ts:101`, `forgot-password/complete/handler.ts:144` (all `purpose: 'two_factor'`); `db/schema.ts:963-967` (`ux_verification_sessions_user_contact_purpose`).
- **Evidence:** The send ladder, the five-sends cycle cap, `isBlocked`/`blockedUntil`, and the 15-per-24h `verifyAttemptDaily` counter all live on that one row (`utils/otp.ts:587,600-605,983-989`). The limiter surface was separated (`second-factor/send/handler.ts:42-44` explains why); the proof row was not.
- **Failure scenario:** An attacker who knows the victim's password signs in, receives a challenge, and exhausts the sends and verifies against the victim's contact: six sends → a six-hour block; fifteen failed verifies → a block a fresh code does not lift. The victim then cannot complete `/forgot-password/second-factor/send` or `/complete` either, and the only exit is the administrative reset, which destroys their passkeys and backup codes.
- **Remediation:** A distinct `otpPurpose` (`recovery_second_factor`) for the two recovery handlers, matching the already-separate limiter surface.
- **Tests:** none cross the two surfaces.

### F-55 · Medium · No containment action removes trusted devices except the destructive two-factor reset

- **Where:** `app/api/dash/users/[id]/sessions/handler.ts:279-336` (bulk revocation deletes `sessions` only; no reference to `trustedDevices`, `revokePendingProofs` or `revokeTwoFactorState`), `lib/auth/trusted-device.ts:100-112` (expiry pushed forward on every use), `lib/auth/two-factor-challenge.ts:604-621` (`proceed` on a trusted device).
- **Evidence:** Trusted devices are dropped only via `revokeTwoFactorState` (method removal, passkey deletion, disable, recovery, contact change, admin reset). There is no "sign out everywhere" self-service route.
- **Failure scenario:** A user reports suspicious activity; the administrator revokes every session. The attacker's `trust_device` cookie survives (30 days, renewed on use), and with the unchanged password they sign back in with 2FA skipped. The operator's only remedy also deletes every passkey and the backup-code set.
- **Remediation:** Have bulk session revocation call `revokePendingProofs(tx, targetId)`, or add a non-destructive "revoke trusted devices" action.
- **Tests:** none cover trusted-device revocation on any containment path.

### F-56 · Medium · The two-factor rollout preflight can report zero stranded accounts for a configuration that strands them

- **Where:** `scripts/check-two-factor-rollout.ts:34-48,69-98` versus `utils/validation/two-factor.ts:41-48` and `utils/validation/env-list.ts:33-45`.
- **Evidence:** The runtime silently drops phone channels when `PHONE_ENABLED` is false (`.filter((channel) => PHONE_ENABLED || !isPhoneChannel(channel))`); the preflight's `parseList` applies no such filter, tolerates duplicates that `parseEnvEnumList` refuses, keeps its own copies of the method and channel sets, and its `usable` CTE omits `users.is_active`.
- **Failure scenario:** The operator runs the preflight for `otp,totp` with channels `email,sms` on a phone-disabled deployment, reads `strandedAccounts: 0`, ships, and every phone-OTP user meets the hard 403 at their next sign-in.
- **Remediation:** Apply the same `PHONE_ENABLED` filter and reuse `parseEnvEnumList` (the module has no imports so it can be adopted).
- **Tests:** none reference the script.

### F-65 · Medium · Better Auth's own response metadata is published verbatim, and it is wrong for both verify endpoints

- **Where:** `lib/http/openapi.ts:1999-2014` (`betterAuthResponses` spreads the generated 200 and overrides only `description`; a `BETTER_AUTH_BODIES` override table exists for requests, `:497`, none for responses).
- **Evidence (generated with all methods enabled):** `POST /api/auth/two-factor/verify-totp` publishes `200 → {status: boolean}` while the handler returns `{token, user}` (`better-auth/dist/plugins/two-factor/verify-two-factor.mjs:25,101`; `lib/auth/two-factor.ts:188-198` passes it through); `verify-backup-code` publishes `required: ["user", "session"]` while the body is `{token, user}` (`backup-codes/index.mjs:224-234`).
- **Failure scenario:** A generated client's `VerifyTotpResponse.status` is `undefined` after a successful login; a client validating responses rejects every successful backup-code verification. Only when 2FA is enabled (the paths are unpublished in the current local configuration).
- **Remediation:** A `BETTER_AUTH_RESPONSES` override keyed like `BETTER_AUTH_BODIES`, and extend `openApiConsistencyProblems` (`:2276-2280`) from "a 200 exists" to "the 200 is overridden or attested".
- **Tests:** `tests/unit/openapi-contract.test.ts:848` asserts the schema's provenance, which is what lets the wrong shape pass.

### F-66 · Medium · Eighteen session-required Better Auth operations publish `security: []` alongside a 401

- **Where:** `lib/http/openapi.ts:2517-2521`.
- **Evidence:** Only `/reauth/*`, `/get-session` and `/sign-out` get a security requirement; every `/two-factor/*` management path and the four passkey paths are `use: [sessionMiddleware]` (`lib/auth/two-factor-enrolment.ts:202,289,381,465,525,564,619,692,772,822`, `lib/auth/trusted-device.ts:228,261,291`) yet publish `[]`, which in OpenAPI means "no credential required".
- **Failure scenario:** A generated SDK omits the cookie on those calls and every one answers 401; a reader using the document as the authority on which operations are privileged is misled.
- **Remediation:** Derive `security` from the endpoint's middleware chain, or keep a session-required path set beside `BETTER_AUTH_PATH_STATUSES`; assert `401 ∈ responses ⟹ security ≠ []`.
- **Tests:** `openapi-contract.test.ts:1052` iterates the table manifest only; `:369` accepts any array.

### F-67 · Medium · Published string constraints describe the post-transform value, so the document is narrower than the API

- **Where:** `utils/validation/rules.ts:156-166` (`emailSchema` lowercases and trims before its domain regex); the same class for `name` and the folder/file name schemas; `lib/http/openapi.ts:534-544` (`z.toJSONSchema` cannot see `.trim()`, `.toLowerCase()`, `z.preprocess`).
- **Evidence (measured, Zod 4.5.4):** `A.B@GMAIL.COM`, `a.b@gmail.com` and `a.b@Gmail.com` are accepted by the server and rejected by the published pattern. Only `phoneSchema`/`optionalPhoneSchema` compensate with `.meta()` overrides (`rules.ts:224-232,246-250`).
- **Impact:** A client or gateway validating against the document refuses input the API accepts on eleven routes (`email`/`newEmail` ×5, `name` ×2, folder/file names ×4).
- **Remediation:** Extend the `.meta()` precedent to every preprocessed field (case-insensitive pattern plus a one-line normalisation note).

### F-78 · Medium · Nothing detects drift between `db/schema.ts` and the generated migrations

- **Where:** `package.json` (`db:generate` is manual), `lefthook.yml` (`gates` group: typecheck, lint, format, audit, runtime, routes, dedupe, secrets, sast, workflows), `.github/workflows/ci.yml` (no drizzle step), `tests/helpers/provision.ts:103` (the fingerprint deliberately excludes `db/schema.ts`).
- **Evidence:** No drift exists today: `bunx drizzle-kit generate` against a scratch copy of `db/drizzle/meta` printed `No schema changes, nothing to migrate`, and live introspection of the migrated test template showed zero index differences against `0011_snapshot.json` and exactly the 31 CHECK constraints the schema declares. The DDL is computed from source constants: `PHONE_NUMBER_MODE` drives `phone_number` nullability and which phone CHECK exists, `REQUIRE_ROLE_FOR_LOGIN` drives both `chk_active_user_has_role` and the `users.role_id` FK's `onDelete` (`db/schema.ts:222-224`), the three OTP attempt maxima are inlined into CHECKs, and eight `*_MAX` constants are column widths.
- **Failure scenario:** `OTP_MAX_ATTEMPTS` is raised to 10 without `db:generate`; the database still enforces `attempt_number <= 5`, and the sixth send fails with `23514` → 500.
- **Remediation:** A CI job that copies `db/drizzle/meta` to a temp `out`, runs `drizzle-kit generate`, and fails if any `.sql` is produced.

### F-79 · Medium · The `page_name` enum is computed from `DASHBOARD_PAGES` with an unearned double assertion, and no test compares any enum to the database

- **Where:** `db/schema.ts:140-143` (`Object.keys(DASHBOARD_PAGES) as unknown as [DashboardPage, ...DashboardPage[]]`), `:158` (`pgEnum('page_name', pageNameValues)`), `app/api/dev/sign-up/handler.ts:85-86` and `lib/permissions/utils.ts:111` (string asserted into the column type).
- **Evidence:** Consistent today (`Object.keys(DASHBOARD_PAGES)`, `pageName.enumValues` and the database labels are all `home, users, permissions, media`). The only enum-versus-database assertion in the suite is for `provider_id` (`tests/process/oauth-migration.test.ts:92-97`); nine PostgreSQL enums, one guarded, and the unguarded one is the only one whose members change without anyone opening `db/schema.ts`.
- **Failure scenario:** A page is added to `DASHBOARD_PAGES`; TypeScript is satisfied by the assertions, `PERMISSIONS_ARRAY_MAX` grows, and the first `role_permissions` write for the new page fails with `22P02 invalid input value for enum page_name` → 500 on the permissions save.
- **Remediation:** One integration test asserting `pg_enum` labels equal each exported `pgEnum`'s `enumValues`; replace the double assertion with a typed literal that `DASHBOARD_PAGES` is derived from. Distinct from should-ignore #46, which accepts that the enum blocks evolution.

### F-80 · Medium · A file move racing a folder delete surfaces as an unmapped `23503` (500) because the file side does not take the tree lock

- **Where:** `lib/media/files.ts:142-145` (`updateFile`: `lockFilesForEdit` then a non-locking `getFolder`), `:186-188` (`moveFiles`, same shape), versus `lib/media/folders.ts:504-520` (`deleteFolder`: `lockTree`, `lockFolderFor`, count, delete); `lib/media/folders.ts:83-84` (`folderNameConflict` maps unique violations only).
- **Evidence:** `files.folder_id` has no `onDelete` rule (`0008:33`, `no action`). `lockTree` is called from `folders.ts:386,437,504` and `lifecycle.ts:327,382`, never from `files.ts`. Either interleaving of `deleteFolder(F)` and `moveFiles(→F)` ends with one side violating `files_folder_id_folders_id_fk`: the UPDATE needs `FOR KEY SHARE` on F while the DELETE holds `FOR UPDATE`, so the loser raises `23503` and no layer maps it.
- **Impact:** A 500 on an operation with correct 4xx semantics available (`folderNotFound`, `folderNotEmpty`); no corruption. Sibling of F-36.
- **Remediation:** Take `lockTree(tx)` in `moveFiles`/`updateFile` whenever `folderId` is present, and map `23503` on that constraint beside the unique mapping.

### F-87 · Medium · The `matrix` test tier runs nowhere

- **Where:** `package.json:13,33` (`test:all` and `test:matrix` are the only callers of `run.ts matrix`; `test:all` is invoked by nothing), `.github/workflows/ci.yml:61,200,215` (unit, integration, process), `lefthook.yml` pre-push (`bun run test` only).
- **Evidence:** The matrix tier is the only thing that boots the six supported two-factor deployments (`disabled`, `totp-only`, `backup-only`, `passkey-only`, `otp-email`, `otp-whatsapp`) in separate children, because the method allow-list is read at module load. `tests/unit/harness-layout.test.ts` asserts every test file belongs to a tier some script runs, and `test:all` satisfies it while nothing runs the tier.
- **Failure scenario:** A regression in any non-default configuration (the class `tests/helpers/run.ts:70-77` records: an empty method list removed enforcement from `/sign-in/email` while every suite was green) ships unobserved.
- **Remediation:** Add `bun run test:matrix` to the `tests` job after the process step; it needs the same PostgreSQL service and runs serially.

### F-101 · Medium · `/sign-in/email` honours an unvalidated client `callbackURL` because the before-hook's returned body is merged, not replaced

- **Where:** `lib/auth.ts:600-611` (the hook returns `{ email, password, rememberMe }`), `node_modules/better-auth/dist/api/dispatch.mjs:217` (`internalContext = defuReplaceArrays(rest, internalContext)`), `node_modules/better-auth/dist/api/routes/sign-in.mjs:242,257,359-363` (`use: [formCsrfMiddleware]` with no `originCheck`; `callbackURL` in the body schema; `setHeader("Location", ctx.body.callbackURL)` and `{ redirect: !!callbackURL, url: callbackURL }`).
- **Evidence:** Reproduced against the installed `defu`: merging `{body:{email,password:"pwproof…",rememberMe:true}}` over a body carrying `callbackURL:"https://attacker.example/"` keeps `callbackURL`. Every sibling endpoint that redirects wraps its URL in `originCheck` (`password.mjs:49,96`, `email-verification.mjs:132`, `update-user.mjs:356`); `signInEmail` does not. `lib/http/openapi.ts:500` publishes the body as `loginSchema.omit({ captcha: true })`, so the field is live and undocumented. The app's own OAuth entry validates the equivalent field (`lib/auth/oauth.ts:82-97`). The hook's own text at `lib/auth.ts:151-153` states the merge rule.
- **Failure scenario:** A login page that derives `callbackURL` from a `?next=` parameter submits it; the response carries `Location: https://attacker.example/` and `redirect: true`, and Better Auth's client follows it. Cross-site injection of the field is blocked by the origin check, so this needs a co-operating frontend, which is the standard one. The same 200 also echoes `token` into JavaScript; harmless while no bearer plugin is enabled.
- **Remediation:** Return `callbackURL: undefined` in the hook's body for `/sign-in/email` (defu treats an explicit `undefined` as a value), or reject bodies carrying it. The invariant "the returned body does not remove keys" belongs beside `PASSWORD_PROOF_PATHS`; the other patched paths (`verify-totp`, `verify-backup-code`, `get-totp-uri`) have no such optional field today.
- **Tests:** none send `callbackURL` to any auth path.

### F-102 · Medium · Argon2 verification runs inside the login transaction, holding `FOR UPDATE` on the user row and a pooled connection for the whole hash

- **Where:** `lib/auth/login-guard.ts:190-201` (`FOR UPDATE` first), `:274-277` (`verifyPasswordDetailed` awaited inside the executor), `:382-384` (`withTransaction(executor)`), `db/limits.ts:14-23` (`MAX_POOL_CONNECTIONS = 10`, and the rule that nothing may hold a transaction across slow work).
- **Evidence:** Measured on this machine (F-44): 97 ms per argon2id hash alone, 879 ms for eight concurrent, because the hashes share one thread pool. Under a burst of sign-ins each transaction therefore holds its connection for up to ~0.9 s, and ten of them hold the entire pool while OTP sends, media writes and admin mutations queue behind Bun's 30 s `connectionTimeout`. The stated scaling direction (more processes) multiplies the connection pressure without raising the per-process hash ceiling.
- **Remediation:** Read hash and counters in a short transaction, verify outside it, then commit the counter or lock update in a second short transaction guarded by a compare-and-swap on `accounts.password`. The codebase already has that shape: `returnPasswordProof` (`:373-378`) plus `upgradePasswordHash`'s CAS (`:460-472`).
- **Tests:** `tests/integration/credential-concurrency.test.ts` covers correctness under parallel wrong passwords; nothing asserts connection-hold duration.

### F-103 · Medium · Per-path `preAuthLimit` values are applied to two-segment shared buckets, so twelve two-factor paths share one per-IP counter

- **Where:** `app.ts:438-441` (`scope: known ? undefined : UNKNOWN_PREFIX_SCOPE`, so a known path falls back to `preAuthScope(pathname)`), `lib/http/pre-auth.ts:10,29-37` (`PRE_AUTH_SURFACE_SEGMENTS = 2`).
- **Evidence:** Computed over the allowlist: `preauth.auth.two-factor` receives `/two-factor/{disable,get-totp-uri,totp/start,totp/confirm,verify-totp,trust-device,trusted-devices,methods,otp/send,otp/verify,generate-backup-codes,verify-backup-code}` with declared limits of 20, 30 and 60; `preauth.auth.reauth`, `.oauth` and `.passkey` each merge three paths. The ceiling checked is the current request's limit while the counter is shared, so `/two-factor/trusted-devices` (60) can spend the bucket down and `/two-factor/otp/send` (20) is then refused. `lib/auth/allowed-paths.ts:122` assigns `otp/send` a budget "below the verify budget" that this makes fictional. The surface granularity is the documented design for table routes; the defect is assigning per-path limits to paths that do not get per-path keys.
- **Failure scenario:** One 2FA sign-in behind a shared NAT (`methods`, `otp/send`, `otp/verify`, a mistyped code, a trusted-devices listing) plus any polling reaches 20 requests in 60 s; the next `otp/send` from that address answers 429.
- **Remediation:** Pass an explicit scope for known prefix paths (`scope: \`preauth.auth${subPath}\``); `PreAuthLimitOptions.scope` already exists for this.
- **Tests:** `tests/integration/auth-prefix-allowlist.test.ts` asserts unknown paths collapse to one row; nothing asserts known paths get distinct rows.

### F-116 · Medium · A legal line-wrapped `data:` URI silently loses its `<image>` and the upload returns 200

- **Where:** `utils/images/svg-optimizer.ts:46` (`SAFE_DATA_URI = /^data:(image\/(?:png|webp));base64,([\w+/=]+)$/i`, no whitespace admitted), `:656-659` (an `image` without a kept reference is removed with `isValid: true`).
- **Evidence:** XML attribute-value normalisation turns an embedded newline into a space, so base64 wrapped at 76 columns (what many exporters and every MIME-style encoder emit) never matches; the same payload unwrapped is kept verbatim (subagent probe: `data uri with newline in base64: ADMITTED`, output `<svg xmlns=…></svg>`). The module refuses rather than strips for animation (`:533-546`) and for the pixel caps (`:554-564`); one policy, two answers.
- **Impact:** A valid document is stored with its bitmap removed and the client is told it succeeded.
- **Remediation:** Strip ASCII whitespace from the payload before matching, or refuse with a reason.

### F-117 · Medium · `targetUnreachable` (422) is the answer for ordinary high-detail images, after the whole ladder has been encoded

- **Where:** `lib/r2/optimize-image.ts:245-249` (`targetSize = SERVER_MAX_IMAGE_SIZE MiB` = 209 715 bytes, `minQuality = 50`, `minWidth = 800`), `:317-330`.
- **Evidence (subagent, this class of machine):** 900×900 noise → 422 after 3.3 s (final 935 528 bytes, 5 rungs); 1400×1400 → 422 after 5.4 s; 2000×2000 → 422 after 13.6 s. The floor rung (800 px at q50) cannot reach 200 KB for near-incompressible content, so every rung is walked and then refused. The 1–5 MP band is charged the same five units whether it costs 30 ms or 5 s.
- **Impact:** Dense screenshots, dithered artwork and QR-like grids are refused with "cannot compress to the required size" after seconds of encoder work; the cheapest CPU per charged unit on the upload surface.
- **Remediation:** Accept the best rung when the target is unreachable (record the overshoot), or lower `minQuality`/`minWidth` so the floor can meet the target; price the ladder walk, not the input pixels.
- **Tests:** `targetUnreachable` appears once in the suite as a message; nothing drives the ladder to exhaustion.

### F-02 · Low · `mapResponse` reads the deprecated `response` alias

- **Where:** `app.ts:301` (`.mapResponse(({ response, request }) => …)`) versus `app.ts:309` (`onAfterResponse` reads `responseValue`).
- **Evidence:** `node_modules/elysia/dist/types.d.ts:549,561,618` mark `response` as `@deprecated use context.responseValue instead`; `dist/compose.js` still assigns both (`c.response=c.responseValue=…`), so the hook works on 1.4.30.
- **Impact:** This hook is the single exit that applies the security-header override, `Server-Timing` and the status stamp used by the access log. One file reads the same value under two names, one of them scheduled for removal; the failure on removal would be a compile error, not a silent gap, so impact is maintainability only.
- **Remediation:** Destructure `responseValue` in `mapResponse`, matching `onAfterResponse`.

### F-03 · Low · The parked Hono adapter re-introduces closed defects if followed

- **Where:** `lib/http/adapters/hono.ts.disabled:141-150,144` (example wiring), `docs/framework-migration.md:189` ("Read `lib/http/adapters/hono.ts.disabled` — it is the whole adapter"), `app.ts:116-119` (cites it as the drift guard).
- **Evidence:** The file is tracked and excluded from `tsc`, ESLint and knip by its extension, so nothing checks it. Against the current code it already disagrees: it registers `ROUTES` instead of `REGISTERED_ROUTES` (so `/api/dev/sign-up` would be live in production, the defect `toRegisteredRoutes` closed — `lib/http/route-manifest.ts:221-260`); it serves `/openapi.json` unauthenticated (`app.get('/openapi.json', …)`) where the table requires `auth: 'permission'` (`routes.ts:732-742`); it iterates `prefix.methods`, a field `RoutePrefix` no longer has (`lib/http/route-manifest.ts:174-189`); and it mounts `auth.handler` with no per-path admission limit, no `betterAuthServes` 405, no allowlist check ahead of Better Auth's plugin chain and no `localiseAuthError` (all in `app.ts:417-484`).
- **Impact:** No runtime effect today. A migration that follows the documented instruction inherits four regressions the Elysia file closed, and no gate catches it because the file compiles nowhere.
- **Remediation:** Either keep the example compiling (a `hono.example.ts` under a `tsc` project that stubs `hono`, or move the wiring into `docs/framework-migration.md` as prose that names the `app.ts` controls to port), or delete it and let `app.ts` be the specification. Drop the claim in `app.ts:116-119` that the file cannot drift.

### F-04 · Low · Unrelated artefacts are tracked at the repository root

- **Where:** `page.out` (1 327 209 bytes, a saved HTML page from a documentation site), `i18n-db.txt` (a Drizzle schema sketch for a `places` table with JSONB translations that exists nowhere in the schema).
- **Evidence:** `git ls-files page.out i18n-db.txt` lists both; neither is referenced by any source, script, config or test (`grep -rn "page.out\|i18n-db"` over the tree outside `node_modules` finds nothing).
- **Impact:** 1.3 MB of noise in every clone and in `prettier --check .` / knip scans; the schema sketch reads as project intent to a newcomer.
- **Remediation:** Remove both from the repository (keep the sketch in `TODO.md` if it is still a plan); add `*.out` to `.gitignore`.

### F-05 · Low · The SQLite driver keeps a statement-tracking workaround that Bun 1.4 retired

- **Where:** `lib/sqlite/driver.ts:136-154,180-188` (`live` set, per-statement `finalize` bookkeeping, the finalize loop in `close()`), header comment `lib/sqlite/driver.ts:104-131`.
- **Evidence (Bun 1.4 release notes, "bun:sqlite db.close() now finalizes every db.query() statement… db.close(true) finalizes those too"), reproduced on Bun 1.4.2:**

  ```
  {"bun":"1.4.2","closeThrew":null,"afterPrepared":"THROWS: Database has closed","afterCached":"THROWS: Database has closed","doubleFinalize":"finalize() after close: ok","renamed":"rename after close: ok"}
  {"closeFalse_afterPrepared":"{\"a\":1}"}
  ```

  `close(true)` with an outstanding `prepare()`d statement does not throw, invalidates the statement, releases the file handle (rename succeeds), and a later `finalize()` is a no-op. Only `close(false)` still leaves the statement live — and the wrapper never calls it (`driver.ts:188` always passes `true`).

- **Impact:** The set, the `finalized` flag and the loop exist to do what the runtime now does; the header comment's own admission ("the throw this design once used as a leak SIGNAL is gone… the tracking Set earns its place from `close(false)`") describes a path the code cannot take. Dead mechanism plus a paragraph of retired reasoning.
- **Remediation:** Reduce `close()` to `db.close(true)`, drop `live`, keep `finalize()` on the wrapper only as the pass-through the deep health check needs. The Bun floor asserted in `server.ts` (1.4.2) is what makes this safe.

### F-06 · Low · Operator-facing documents describe routes and limits that no longer exist

- **Where:** `docs/framework-migration.md:111,113-114,118,124,135` and `reports/coolify-deployment.md:995`.
- **Evidence:** `docs/framework-migration.md` states the request body limit is "8 MiB → 413" while `app.ts:175` sets `MAX_REQUEST_BODY_BYTES = 12 * 1024 * 1024`; it documents `/api/dev/email-test/fixed`, `/api/internal/sqlite-sweep` and `upload/image`, none of which is in `routes.ts` (the upload route is `/api/upload/file`; the sweep is `lib/schedule.ts`); it names `lib/env.js`, which is `lib/env.ts`. The runbook says "ONE route sits at 120 s (`/api/upload/image`)" while `routes.ts:534,684` put 120 s on `POST /api/dash/media/files` and `POST /api/upload/file`.
- **Impact:** The two documents are the ones an operator and a future migrator are told to read; the wrong body limit and the wrong route names send them to endpoints that 404 and to a size ceiling the server does not enforce.
- **Remediation:** Correct the five references; the 120 s statement should name both routes or none.

### F-08 · Low · `isEmpty`/`isNotEmpty` build a `CASE` PostgreSQL cannot index, and they skip the scan-only gate by ordering

- **Where:** `db/queries/index.ts:22-34` (`isEmpty`), `lib/data-table/filter-columns.ts:132` (early `return 'apply'` for no-value operators) before `:159` (the `allowScanOnly` gate).
- **Evidence:** Measured on PostgreSQL 18.6 with a btree on `name`: `where case when name is null then true when name='' then true else false end` → `Seq Scan`; `where name is null or name = ''` → `BitmapOr` over two index scans. Same truth table, one is sargable. Separately, `isNotEmpty` with `{ type: 'text', allowScanOnly: false }` builds SQL while `notILike` on the same spec is a 422, because the no-value early return precedes the scan-only check.
- **Impact:** Availability, bounded by table size; and a future edit adding these operators to `SCAN_ONLY_OPERATORS` would silently do nothing.
- **Remediation:** Emit `or(isNull(column), eq(column, ''))` and move the no-value early return below the scan-only gate.
- **Tests:** `tests/unit/filter-closed-set-values.test.ts:66-70` pins the closed-set branch (`IS NULL`); nothing pins the text branch's shape or the gate order.

### F-09 · Low · The media `unfiled` scope contradicts the partial trigram index it would need

- **Where:** `db/migrations/002_media_trgm_indexes.sql:4-6` (`WHERE status = 'active' AND folder_id IS NOT NULL`), `lib/media/lifecycle.ts:60-61` (`unfiledNow` = `isNull(files.folderId)`), `app/api/dash/media/handler.ts:122-127`.
- **Evidence:** `folder_id IS NULL` is the negation of the index predicate, so `?scope=unfiled&search=…` can never use `idx_files_display_name_trgm`; the `folder` and `all` scopes do satisfy it. Inert today only because `unreferenced()` fails closed while `USAGE_SOURCES` is empty; it arms the moment a project registers an owner table.
- **Impact:** A sequential scan of `files` plus the `NOT EXISTS` set per row for every unfiled search, once armed.
- **Remediation:** Drop `folder_id IS NOT NULL` from the predicate, or add a second partial index for the unfiled set, or record that the unfiled set is small enough that a scan is the intended plan.

### F-10 · Low · `ne` on a date column is the one negated form that does not union `IS NULL`

- **Where:** `lib/data-table/filter-columns.ts:216-221`.
- **Evidence:** Emitted SQL for `ne` on a date spec is `(col < $1 or col >= $2)`; the text, boolean, number and `notInArray` branches all add `or col is null` (`:212-214,222-227,239-244`) for the three-valued-logic reason the file states at `:206`. Not reachable today: every registered date column comes from the `NOT NULL` `timestamps` helper. `users.deletedAt`, `users.lockedUntil`, `users.authRevokedAt` and `files.unfiledAt` are nullable and sit on tables that already carry a spec map.
- **Impact:** Once a nullable timestamp is registered, "not on day X" hides every row with no date from both the list and `meta.total`, with a 200.
- **Remediation:** `or(lt(column, start), gte(column, next), isNull(column))`.
- **Tests:** `tests/unit/filter-and-input-edges.test.ts:215-255` sweeps the other negated forms; the date branch is outside the sweep.

### F-11 · Low · A `select`/`multiSelect` descriptor may omit `values`, which makes `isEmpty`/`eq` a deterministic 500 on an enum column

- **Where:** `lib/data-table/column-specs.ts:39-46` (`values?` optional), `lib/data-table/filter-columns.ts:63-65` (`isStringLike` is true for a valueless `select`), `:69-78` (`membersAllowed` returns true when `values` is undefined).
- **Evidence:** With `{ kind: { type: 'select' } }` on `files`, `isEmpty` emits `"files"."kind" = ''` and `eq 'audio'` emits `"files"."kind" = $1`; against PostgreSQL 18.6 an enum compared to `''` fails with `22P02 invalid input value for enum`. All three current `select` specs do supply `values`, so this is a missing compile-time guarantee, not a live path.
- **Remediation:** Make `FilterColumnSpec` a discriminated union in which `select`/`multiSelect` require `values`; `membersAllowed`'s undefined branch then disappears.

### F-12 · Low · `maxPerPage` does not lower the default page size

- **Where:** `lib/data-table/parsers.ts:354` (`boundedInt(params.perPage, maxPerPage, 10)`).
- **Evidence:** `?maxPerPage=5` with no `perPage` yields `perPage: 10` and no report; `?maxPerPage=5&perPage=10` is a 422. `routes.ts:87-90,104-108` publish `maxPerPage` as the ceiling applied to `perPage` for the request.
- **Impact:** Published-contract violation: a caller that declared a ceiling of 5 receives 10 rows.
- **Remediation:** Fallback `Math.min(10, maxPerPage)`.

### F-13 · Low · A real column outside the sort allowlist discards the handler's `defaultSort`

- **Where:** `lib/data-table/parsers.ts:377-384` (default substituted only when the parsed list is empty) versus `db/queries/data-table.ts:143-145` (allowlist filter applied later).
- **Evidence:** With `defaultSort: { id: 'createdAt', desc: true }`, `sort=[{"id":"roleId"}]` (a real `users` column not in the spec) emits `ORDER BY "users"."id" DESC` only; `sort=[{"id":"zzz"}]` the same; no `sort` parameter emits `created_at desc, id desc`.
- **Impact:** Bounded while ids are UUID v7 (time-ordered) and every default is `createdAt desc`; any other default, or a non-time-sortable key, changes row order silently for a bookmarked URL naming a renamed column.
- **Remediation:** Apply `defaultSort` after the allowlist filter, or pass `Object.keys(filterableColumns)` as `parseSortingState`'s `columnIds` so the parser's own fallback fires.

### F-14 · Low · The published "Allowed ids" lists are hand-copied from the handlers, and the enforced item caps are unpublished

- **Where:** `routes.ts:114-125,238-240,366,507-509` versus `app/api/dash/users/handler.ts:54-60`, `app/api/dash/permissions/handler.ts:40-46`, `app/api/dash/media/handler.ts:37-44`; `lib/data-table/parsers.ts` caps `MAX_SORT_ITEMS` 10, `MAX_FILTER_ITEMS` 20, `MAX_FILTER_VALUES` 20, `MAX_ID_LENGTH` 64, `MAX_VALUE_LENGTH` 512.
- **Evidence:** The three prose lists match the spec maps today by inspection only; `tests/unit/openapi-contract.test.ts:556-598` asserts parameter names and `perPage`/`filters` bounds for two list routes, never the id list, and never `/api/dash/media`. The per-item caps and the per-column operator sets (`mimeType` is `select`, so `inArray` is a 422) appear nowhere in the document, so a generated client can build a 21-filter request the schema accepts and the server rejects.
- **Remediation:** Derive the id list from the spec maps (`routes.ts` already imports the handler modules), publish the caps, add the media route to the contract test.

### F-15 · Low · `getColumn` forces invented `as` assertions at every call site

- **Where:** `lib/data-table/filter-columns.ts:424-441` (`keyof T` parameter, `columnKey as string`, `col as unknown as AnyColumn`), call sites `db/queries/data-table.ts:125,150,160` (`… as keyof T`) and `:126` (`col as AnyColumn`).
- **Evidence:** The narrow signature is widened back to `string` on its first line, and `safeGetColumn` ends in a double assertion after a structural `'dataType' in col` check. drizzle-orm exports `is` and `Column`, so `if (!is(col, Column)) return null; return col;` removes every assertion (CLAUDE.md, Types: import the library's type).
- **Remediation:** Take `string`, use `is(col, Column)`.

### F-16 · Low · The business-timezone default path of `dayBounds` is untested

- **Where:** `utils/time.ts` (`dayBounds` resolves through the default `timeZone` = `BUSINESS_TIMEZONE`); `tests/unit/time-dst.test.ts` (51 cases, every one passing an explicit zone).
- **Evidence:** Measured: `createdAt eq 2026-01-01` binds `2025-12-31T21:00:00.000Z` / `2026-01-01T21:00:00.000Z` independent of `process.env.TZ`, so the invariant holds today; hard-coding `'UTC'` in `dayBounds` or dropping the default parameter would shift every date filter by three hours with no failing test. `lte`/`gt` are calendar-relative (`lte` → `< next day`) as documented at `lib/data-table/filter-columns.ts:271-272` and asserted nowhere.
- **Remediation:** One unit case per operator through the default zone.

### F-17 · Low · JSON routes inherit the 12 MiB multipart body ceiling

- **Where:** `app.ts:175,246` (`MAX_REQUEST_BODY_BYTES` on `serve.maxRequestBodySize`), `lib/http/request.ts:134-142` (`safeReadJson` reads and `JSON.parse`s the whole body with no bound of its own).
- **Evidence:** No `Content-Length` check or bounded reader exists anywhere under `lib/http` or `app/**` (`grep -rni "content-length\|maxRequestBodySize"` finds only `app.ts:246`). The ceiling is documented as sized for the largest admitted document; every `body: 'json'` route accepts the same 12 MiB. Public routes read the body only after the per-IP limiter and the captcha (`app/api/auth/otp/send/handler.ts:50-67`, `forgot-password/send/handler.ts:46-60`, `passwordless/send/handler.ts:49-63`, `otp/verify/handler.ts:44-59`), and dashboard routes only after authorisation, so the exposure is an authenticated user or a captcha-holding client parsing 12 MiB per request at the per-user rate.
- **Impact:** Availability, bounded by rate limits: tens of MB of `JSON.parse` on the event loop per minute per caller, versus JSON payloads whose Zod schemas bound them to a few KiB.
- **Remediation:** Give `json` routes their own ceiling in `withBodyPolicy` (reject on `Content-Length` above it and stop a bounded read at it), sized from the largest JSON schema; keep 12 MiB for `multipart` only.

### F-20 · Low · The user detail `GET` releases session metadata on a cookie-cached write-tier grant

- **Where:** `app/api/dash/users/[id]/handler.ts:81-85,110-111,164-199` versus `app/api/dash/users/[id]/sessions/handler.ts:94-98`.
- **Evidence:** The parent `GET` asks for `users.view`, which the checker serves from the signed cookie when present (`lib/permissions/checker.ts:30,107-108,198-213`; cache `maxAge: 300`, `lib/auth.ts:683-687`), then derives `editAll = actorViewPermissions?.users?.edit === true` from that cached matrix and returns the target's session `ipAddress`, `userAgent`, `createdAt` and a cursor into the child route. The child route asks for `edit`, which always re-reads the database.
- **Impact:** Extends Known Issue #5 in kind: a write-tier authority evaluated from the cache, and two routes of one resource answering the same question from different sources. After a grant is revoked, the parent keeps emitting other users' session IPs for up to five minutes while the child refuses.
- **Remediation:** `forceDB: true` on the parent `GET` (as `two-factor/handler.ts:59` does), or take `editAll`/`editOwn` from a database-backed check.

### F-21 · Low · "New password must differ" is enforced on only one of two proof branches

- **Where:** `app/api/dash/users/me/change-password/handler.ts:59-63` (plaintext compare) and `:73-92` (window branch).
- **Evidence:** `currentPassword` is optional (`reauthPasswordSchema`, `utils/validation/rules.ts:191-195`). With the window open and `currentPassword` omitted, the compare is a no-op and nothing verifies `newPassword` against `expectedHash`.
- **Failure scenario:** `POST {"newPassword": "<current password>"}` re-hashes the same plaintext, passes the compare-and-swap, revokes every other session and every pending proof, and reports `passwordChanged` for a credential that did not change.
- **Remediation:** Verify `newPassword` against the stored hash and reject with `newPasswordSameAsCurrent`; that covers both branches.
- **Tests:** `tests/integration/self-service-credentials.test.ts:569` covers the password-proof branch only.

### F-22 · Low · `POST /api/dash/users` spends HIBP and Argon2 before the role grant is checked

- **Where:** `app/api/dash/users/handler.ts:178-192`.
- **Evidence:** `checkPasswordCompromise` and `hashPassword` (argon2id, 64 MiB) run at `:178-180`; `validateAssignableRole` and `validateRolePermissionScope(..., 'grant')` only inside the transaction at `:183-192`. The `PUT` path added `assertTargetEditable` (`users/[id]/handler.ts:396-418`) to stop exactly this amplification; the sweep did not reach `POST`.
- **Impact:** Bounded by the 20/min per-actor limiter: each refused request costs one outbound HTTPS call and one 64 MiB hash.
- **Remediation:** Run the two grant validations before `:178`, keeping the in-transaction copies authoritative.

### F-23 · Low · `validateRolePermissionScope` always locks `FOR SHARE`, including for callers that asked for an unlocked read

- **Where:** `lib/permissions/utils.ts:492-499`; callers with `lock: false` at `app/api/dash/users/[id]/sessions/handler.ts:156-158,172-178` and on the pool at `users/[id]/handler.ts:167,358-364`.
- **Evidence:** `assertTargetReachable` honours `lock` for its own query and then hands the same executor to `validateRolePermissionScope`, which appends `.for('share')` unconditionally; on the `GET` paths this is a `SELECT … FOR SHARE` in autocommit.
- **Impact:** Correct but misleading: two read paths take row-share locks on `role_permissions` per request, and a parameter named `lock: false` does not do what it says.
- **Remediation:** Thread `lock` through, or derive it from `check`.

### F-24 · Low · Three role-presence guards read the cookie-cached `roleId` while the same call returns a fresh one

- **Where:** `app/api/dash/users/[id]/handler.ts:104-108,843` (`hasRole`, consumed at `:262-263`), `app/api/dash/users/[id]/sessions/handler.ts:115-116`.
- **Evidence:** `checkUserPermission` returns `roleId` read from the database on the forced branch (`lib/permissions/checker.ts:154-159,186-195`); these sites use `session.user.roleId` from the cookie. Dead today because `REQUIRE_ROLE_FOR_LOGIN = true` keeps roleless sessions from existing.
- **Impact:** If the documented toggle is flipped, the guards go live and are wrong in both directions (a role granted after login is refused; a role removed mid-session still passes on read paths).
- **Remediation:** Use the `roleId` the same `requirePermission` call returns.

### F-25 · Low · Permission matrices are asserted total while the schema stores partial ones; the id preprocess falls back to a number

- **Where:** `app/api/dash/permissions/handler.ts:188`, `app/api/dash/permissions/[id]/handler.ts:256`, `lib/permissions/utils.ts:113` (`p.permissions as Record<PermissionAction, boolean>`), `db/schema.ts:867` (`$type<PermissionActions>()`), `utils/validation/rules.ts:145,151-154`.
- **Evidence:** `normalizeActionsForPage` builds `Partial<Record<PermissionAction, boolean>>` (`utils/validation/permissions.ts:83-98`), so rows legitimately hold partial matrices; every current reader normalises through `sanitizePermissions` (`lib/permissions/utils.ts:195-199`), which is why nothing breaks. `rules.ts:145` returns the number `0` from the UUID `idSchema` preprocess on the invalid path, a leftover of the numeric-id variant, and `:151-154` asserts a narrower `ZodPipe` type than Zod produces.
- **Remediation:** Type the column and the three sites as `Partial<…>`; make the preprocess fall back to `''` and drop the cast (CLAUDE.md, Types).

### F-26 · Low · Side effects of administrative mutations are not audited where the dedicated routes audit them

- **Where:** `app/api/dash/users/handler.ts:228-234` (credential `accounts` insert, no event), `app/api/dash/users/[id]/handler.ts:984` (credential row hard-delete on soft-delete, no event), `:683-684` (`removeMethodIntent` strips OTP second-factor enrolments on an admin contact change, no event; `lib/auth/two-factor-challenge.ts:1388-1408`), `:800` and `app/api/dash/permissions/[id]/handler.ts:348-357` (bulk session revocation, no `sessions` event), `permissions/[id]/handler.ts:484-487` (`role_id` nulled on soft-deleted users, no event).
- **Evidence:** The dedicated routes for the same effects do write events (`sessions/handler.ts:318-333`, `two-factor/handler.ts:164-178`, `change-password/handler.ts:165-174`), so an investigator sees "sessions revoked" or "second factor removed" only when the operator used the narrow route.
- **Remediation:** Emit the events at the shared boundaries (`removeMethodIntent`, `revokeOtherSessions`) or record counts in the causing event's `newData`.
- **Tests:** `tests/integration/authorization-and-audit.test.ts:566-668` asserts the users rows only.

### F-27 · Low · Email and phone changes disagree about the acting session

- **Where:** `app/api/dash/users/me/contact-change.ts:119-124,178,252`; callers `change-email/handler.ts:148`, `change-email/verify/handler.ts:102`, `change-phone/handler.ts:135`, `change-phone/verify/handler.ts:98`.
- **Evidence:** `CommitEmailChangeOpts` omits `keepSessionId`, so an email change revokes every session including the caller's and repairs the client with `refreshSessionCookies`; the phone commit keeps the live session. Both live in the helper that exists to keep the two flows aligned.
- **Impact:** One rotation policy, two outcomes; a reader cannot tell which is intended.
- **Remediation:** Decide once and encode it in the shared type.
- **Tests:** `self-service-credentials.test.ts:925` asserts the email behaviour; the phone commit's session semantics are unasserted.

### F-30 · Low · Byte-level image gates key off the raw `Content-Type` while the spec lookup normalises it

- **Where:** `lib/media/upload.ts:207` (`fileTypeFor(entry.type)`, normalised), `:238` (`validateMagicBytes(raw entry.type)`), `:247` (`entry.type === 'image/svg+xml'` exact), `utils/images/raster-bytes.ts:30-34` (`hasRasterSignature` exact-key lookup), `lib/r2/upload-helper.ts:68` (`{valid: true}` on a miss).
- **Evidence (measured):** an animated WebP declared `image/webp; charset=utf-8` resolves to the image spec and `validateMagicBytes` returns `{"valid":true}` where the exact type returns `{"valid":false,"animated":true}`; `image/svg+xml; charset=utf-8` resolves to the SVG spec while `admitUpload` skips `validateSvgUpload`. Not exploitable today: `processImage` (`upload-helper.ts:172`) re-checks `isAllowedImageType` on the raw string and throws 400 — a refusal from an unrelated module, after the header was already decoded.
- **Impact:** The animation gate and the SVG sanitiser depend on a coincidence in a different file; normalising that check would open both.
- **Remediation:** Normalise once in `admitUpload` and key every downstream check off `spec`.
- **Tests:** `tests/unit/upload-validation.test.ts` exercises the gates with exact types only.

### F-31 · Low · Multipart admission is bounded by rate, not by bytes: extra parts are parsed uncharged and buffered before the budget runs

- **Where:** `lib/media/upload.ts:153-168` (`takeSingleFile` caps the named field only), `:224` (`Buffer.from(await entry.arrayBuffer())` inside `admitUpload`), `:260,267,281` (the budget is charged after buffering, for the one taken file), `lib/http/request.ts:148-153` (`request.formData()` parses every part).
- **Evidence:** A request with one 1 KB PDF in `files` and ~11 MiB of other parts is charged `DOCUMENT_REQUEST_UNIT` against a 60 MiB/min budget while 12 MiB was parsed; at `UPLOAD_ADMISSION_LIMIT` = 20/min that is ~240 MiB/min of multipart parsing per user against 40 MiB accounted. The only concurrency gate (`acquireEncoder`, `lib/r2/optimize-image.ts:347-370`) sits after the body is in memory.
- **Impact:** Bounded by authentication and the per-user rate; the documented "one file per request" (`docs/file-manager-user-guide.md` §4, §14) is enforced per field, not per form.
- **Remediation:** Count `File` entries across the whole form; charge on `Content-Length`/part size before buffering; consider an admission semaphore around `readFormData()` shaped like `acquireEncoder`.

### F-32 · Low · Recursive folder delete's worst case outlives the 60 s ceiling because purge batches run sequentially

- **Where:** `routes.ts:624-643` (no `timeoutSeconds` on `DELETE /api/dash/media/folders/:id`, nor on `DELETE /api/dash/media/files` or publish/unpublish), `server.ts:135` (`IDLE_TIMEOUT_SECONDS = 60`), `lib/cloudflare/purge.ts:10-12,86-90` (`PURGE_BATCH_SIZE = 30`, `DEADLINE_MS = 10_000`, `ATTEMPTS = 2`, one batch after another), `lib/media/lifecycle.ts:160` (all public URLs of the tree in one `purgeUrls` call; `FOLDER_RECURSIVE_DELETE_MAX = 200`).
- **Evidence:** ⌈200/30⌉ = 7 batches × 2 attempts × 10 s = up to 140 s of purge alone when Cloudflare stalls; 50 file ids → 2 batches → ~40 s; publish/unpublish → ~20 s on top of four R2 round-trips.
- **Impact:** The client loses the `{folders, deleted, pending}` outcome the guide promises while the deletion continues server-side.
- **Remediation:** Give these routes their own `timeoutSeconds` derived from the batch arithmetic, or take the purge off the request path (mark and let the sweep purge).

### F-33 · Low · `deleteFiles` accepts a `pending` row that every sibling path refuses

- **Where:** `lib/media/lifecycle.ts:233-243` (refuses `deleting` and a set `transition` only) versus `lib/media/files.ts:108-113` (`lockFilesForEdit` requires `active`) and `lifecycle.ts:358` (`deleteFolderTree` requires `active`).
- **Evidence:** A pending library row (folder set, so `mediaGoverned()` true) marked `deleting` while `storeUpload` sits between its insert (`upload.ts:445`) and its PUT (`:461`) lets the PUT land after `finishDeleting` removed object and row — an object with no row that only the read-only reconcile will ever see. Bounded: a pending library id is disclosed only by the activation response.
- **Remediation:** Add `row.status === 'active'` to the `visible` filter.

### F-34 · Low · A referrer with a plain foreign key loses the object before the row delete is refused

- **Where:** `lib/media/lifecycle.ts:137-180` (objects deleted first, rows second; the `DELETE` at `:168-179` is unguarded), `:471-487` (`reapUnfiled` catches the FK violation only on the status update), `lib/media/usages.ts:185-194`.
- **Evidence:** A project that adds `file_id uuid references files(id)` without the composite `(id, status)` shape and without a `USAGE_SOURCES` entry: `unreferenced()` answers true, the row is stamped, reaped, marked `deleting` (a plain FK on `id` does not block a status change), the object is deleted, then the row `DELETE` raises 23503. The referrer survives pointing at bytes that are gone. The only guard is the CI test `tests/integration/media-usages.test.ts`.
- **Remediation:** Assert the FK shape from the catalogue at boot, or delete the row in a transaction first and the object after, preferring an orphan object over lost bytes.

### F-35 · Low · Rename and move are allowed during a visibility transition

- **Where:** `lib/media/files.ts:96-117` (`lockFilesForEdit` checks `status` but not `transition`) versus `lifecycle.ts:242` and `visibility.ts:177`, which refuse a set marker.
- **Evidence:** `visibility.ts:202` builds the new object's `Content-Disposition` from the row read in step 1, so a rename landing mid-copy leaves the stored header and `displayName` disagreeing until the next publish; `downloadUrl` re-signs with the current name, so only the inline object is affected. Contradicts the guide's "قيد المعالجة" contract (§1, §13).
- **Remediation:** Add `!row.transition` to `lockFilesForEdit`.

### F-36 · Low · `deleteFolderTree` can 500 after deleting the files

- **Where:** `lib/media/lifecycle.ts:381-414`; `files.folder_id` has no `ON DELETE` rule (`db/schema.ts:729`).
- **Evidence:** Step 3 re-resolves the tree and returns `folders: 0` on a mismatch, but the following `tx.delete(folders)` is not protected against a concurrent, uncommitted insert or move into the subtree; it blocks on that writer's `FOR KEY SHARE` and then raises 23503, so the request fails with `deleteError` after the files are already gone — the opposite of the outcome type documented at `lib/media/folders.ts:47-57`.
- **Remediation:** `FOR UPDATE` on the subtree's folder rows in step 3 (as `deleteFolder` does via `lockFolderFor`), or catch 23503 and return 0.

### F-37 · Low · The document byte budget lacks the load-time assert the image budget has

- **Where:** `lib/media/upload.ts:104-112` (asserts `MAX_UPLOAD_COST <= UPLOAD_MEGAPIXEL_BUDGET`), `:122-124` (`documentCost`, no assert against `DOCUMENT_BYTE_BUDGET_MIB = 60`).
- **Evidence:** `rateLimit` refuses a cost above the limit without a write (`lib/rate-limit/index.ts:47-57`), so raising `MAX_DOCUMENT_SIZE_MB` above 60 turns every maximum-size document upload into a permanent 429 — the failure the image assert exists to prevent.
- **Remediation:** Mirror the assert.

### F-38 · Low · The storage health route is unauthenticated, un-rate-limited and reports subsystem state

- **Where:** `routes.ts:688-707` (`preAuth: 'none'`, `handlerRateLimit: false`), `app/api/health/storage/handler.ts`.
- **Evidence:** The body carries `journalModeWal`, `schemaVersion`, `busyTimeout`, `synchronousNormal`, `postgres` (plus `quickCheck`/`writable` behind the token). Mitigations that hold: `pingDatabase` single-flights the PostgreSQL probe (`db/index.ts:87`), and the deep path is token-gated with a length guard before `timingSafeEqual`. Residual: four synchronous SQLite pragma reads per request on the event loop with no admission bound, and an anonymous oracle for "is PostgreSQL up / is the limiter schema wrong". The 200 `ok` / 503 shape is right for Coolify.
- **Remediation:** `preAuth: 'ip-limit'` with a generous limit, or return only `status` anonymously and the `checks` detail behind the maintenance token.

### F-39 · Low · A keyless `DeleteObjects` error entry is counted as a successful delete

- **Where:** `lib/r2/client.ts:223-228`.
- **Evidence:** `refused` is built only from `Errors` entries whose `Key` is a string (`_Error.Key` is `string | undefined` in `@aws-sdk/client-s3` 3.1127.0 `models_0.d.ts:3650`); every key not in `refused` is pushed to `deleted`, so an error without a key marks its object deleted and `finishDeleting` removes the row while the object stays.
- **Remediation:** Treat a chunk containing any keyless error as wholly unconfirmed.

### F-40 · Low · Outbound Cloudflare purge has no spend breaker, unlike every other paid outbound call

- **Where:** `lib/cloudflare/purge.ts` (per-call batch, per-batch retry, no budget) versus `lib/rate-limit/api.ts:191-201` (`enforceOtpGlobalSendBudget`, the codebase's breaker pattern).
- **Evidence:** From the route limits, one authenticated user can drive ~200 purge API calls per minute (`media.files.delete` 30/min × 50 ids, folder delete 30/min × 200 descendants, visibility 10/min). Exhausting the zone quota makes every later unpublish/delete leave rows `deleting` and edge copies live — F-28's failure without any misconfiguration. Cloudflare's documented purge ceiling was not verified.
- **Remediation:** One `enforceRateLimit` global scope charged per purge call, mirroring the OTP breaker.

### F-41 · Low · The S3 client has no request or connection timeout and states a retry count it does not set

- **Where:** `lib/r2/client.ts:36-46` (no `requestHandler`, no `maxAttempts`), `lib/media/upload.ts:344-348` (describes `maxAttempts: 3`).
- **Evidence (installed packages):** `@smithy/node-http-handler` 4.12.1 defaults `connectionTimeout` and `requestTimeout` to 0 (disabled) (`dist-cjs/index.js:48-50,83-85`); `@smithy/core` 3.33.3 supplies `DEFAULT_MAX_ATTEMPTS = 3` (`dist-cjs/submodules/retry/index.js:432-433`). A hung R2 socket therefore has no deadline of its own; the 120 s route ceiling closes the client connection but not the handler, which is the precondition of F-29.
- **Remediation:** Pass an explicit `NodeHttpHandler` with both timeouts and an explicit `maxAttempts`.

### F-42 · Low · Checksum behaviour on the wire is decided by transitive SDK defaults and an optional argument

- **Where:** `lib/r2/client.ts:132,167-169` (`sha256?` optional; `ChecksumSHA256` sent only when present), client construction `:36-46` (neither `requestChecksumCalculation` nor `responseChecksumValidation` set).
- **Evidence:** `@aws-sdk/checksums` 3.1000.29 defaults `DEFAULT_REQUEST_CHECKSUM_CALCULATION = "WHEN_SUPPORTED"` and skips its automatic CRC32 only when an `x-amz-checksum-*` header is already present; `DeleteObjectsCommand` is wired `requestChecksumRequired: true`, forcing CRC32 regardless. Today the only `uploadToR2` caller always passes `sha256`, so PUTs carry an explicit checksum by convention, not contract; `tests/helpers/preload-base.ts:94-95` replaces the SDK wholesale, so no test observes the wire format against R2.
- **Remediation:** Make `sha256` required and set both checksum options explicitly.

### F-47 · Low · Turnstile's JSON body is asserted, not checked

- **Where:** `lib/captcha.ts:54` (`(await response.json()) as { success?: boolean }`).
- **Evidence:** Fail-closed by accident (`null` → `TypeError` → `false`; a number → `false`), but an asserted shape on third-party output; `sendOtpWhatsApp` in the same subsystem models the right form (`unknown | null` plus `typeof`, `utils/otp.ts:270-284`).
- **Tests:** `tests/integration/sign-in-controls.test.ts:394,415` cover 5xx and timeout; no malformed-body case and no test that `TEST_SECRET_KEY` is confined to development.

### F-48 · Low · An unresolved SMTP host silently defaults to plaintext `localhost:587`

- **Where:** `lib/smtp.ts:33-34`.
- **Evidence:** Unreachable today: nodemailer 10.0.1 resolves `service: 'gmail'` to `smtp.gmail.com:465` with `secure: true` before `getSocket` runs (`smtp-transport/index.js:32-36,107`), so the only caller (`utils/otp.ts:36-48`) always gets implicit TLS. A future transport built from an unset host would connect in cleartext, and with `secure` falsy nodemailer upgrades only if the peer advertises STARTTLS (no `requireTLS`).
- **Remediation:** Throw when neither `host` nor a service-resolved host is present.

### F-49 · Low · The issued OTP space is 900 000 codes, not the 1 000 000 the schema accepts

- **Where:** `utils/otp.ts:50-52` (`crypto.randomInt(100_000, 1_000_000)`), `utils/validation/otp.ts:219-225` (`^[0-9]{6}$`).
- **Evidence:** 200 000 draws: min 100 014, max 999 996, no leading zero. A 10 % reduction in guessing space, negligible against the attempt budgets; free to fix with `randomInt(0, 1_000_000).toString().padStart(6, '0')`.

### F-50 · Low · `collapseProofThrottle` drops the evaluated-guess marker

- **Where:** `utils/otp.ts:152-159` returns a fresh `CustomError` without re-marking it in the `WeakSet` populated at `:1280`.
- **Evidence:** Harmless today because the two mechanisms have disjoint call sites (`otp/verify`, `passwordless.ts:325`, `reset/handler.ts:246` versus `complete/handler.ts:155`, `two-factor-otp.ts:353`); a future surface using both would `attempt.restore()` a real guess and refund a unit of the five-attempt challenge budget.
- **Remediation:** Carry the marker across the collapse, or assert the disjointness in a test.

### F-51 · Low · Dead delivery-boundary checks

- **Where:** `utils/otp.ts:387-395` (`if (!info.messageId)`), `processOtpSend`'s `smsMessage` option.
- **Evidence:** nodemailer assigns `messageId` unconditionally on the success path (`smtp-transport/index.js:201`; typed `string`), so the guard cannot fire and `rejected` is never inspected; `smsMessage` has no caller in the tree.

### F-52 · Low · The password lockout does not cover passwordless sign-in

- **Where:** `lib/auth/login-guard.ts:43-57,150-158` (invoked from `/sign-in/email` and the re-auth routes only), `lib/auth.ts:702-803` (`session.create.before` has no lockout check), `utils/config.ts:124` (`PASSWORDLESS_ENABLED`).
- **Evidence:** Passwordless creates its session through the same `createSession` and inherits every eligibility gate except the lockout counters. Coherent as a design (the lockout bounds password guessing; passwordless has its own OTP budgets), but "the account is locked" is not a freeze while `/api/auth/passwordless/*` stays open. Owner decision to confirm.

### F-57 · Low · The library verifier's session branch would allow unlimited code guessing; it is fenced only from another file

- **Where:** `lib/auth/two-factor.ts:63-87` (`runPluginVerifier`: `if (await resolveRequestSession(ctx)) return verify()`), fenced by `lib/auth.ts:250-262` (`assertPluginVerifierOffered` throws 400 for these paths when a session resolves).
- **Evidence:** In session mode the library's `beginAttempt` is a no-op and `isSignIn` false skips the lockout (`better-auth/dist/plugins/two-factor/verify-two-factor.mjs:107-113`, `totp/index.mjs:183-201`), so the branch compares codes with no budget and no transaction. Unreachable today; two files must keep agreeing.
- **Remediation:** Make the branch throw.
- **Tests:** `tests/integration/two-factor-totp.test.ts:223` pins the `lib/auth.ts` half only.

### F-58 · Low · `/passkey/verify-registration` honours the library's `createSession` flag and the after-hook then deletes the session it minted

- **Where:** `lib/auth.ts:151-161` (body patch only for `TRUST_DEVICE_STRIPPED_PATHS`), `lib/auth/two-factor-enrolment.ts:875-910` (`revokeOtherSessions` keeps the pre-request session id), `node_modules/@better-auth/passkey/dist/index.mjs:307,384,403,411` (`createSession` accepted, session created, cookie set).
- **Failure scenario:** A client following the Better Auth passkey docs (https://www.better-auth.com/docs/plugins/passkey) passes `createSession: true`; registration succeeds and the user is signed out with a cookie pointing at a deleted row.
- **Remediation:** Extend the body patch to this path with `createSession: false`.
- **Tests:** `tests/integration/two-factor-trusted-device.test.ts:220` covers the class for the two verifier paths only.

### F-59 · Low · Passkey registration validates the WebAuthn origin against the request's own `Origin` header

- **Where:** `lib/auth/two-factor.ts:284-306` (`passkey({…})` sets no `origin`), `node_modules/@better-auth/passkey/dist/index.mjs:337,354` (`expectedOrigin = options.origin || ctx.headers.get('origin')`), versus `lib/auth/passkey-assertion.ts:21,110-121` (pins `PUBLIC_ORIGIN` and `RP_ID`).
- **Evidence:** Not exploitable now: `expectedRPID` derives from `baseURL`, the browser refuses an `rp.id` outside the page origin, and Better Auth's router-wide `originCheckMiddleware` rejects a cookie-bearing POST from a foreign `Origin`. The binding on half the ceremony rests on upstream middleware rather than a configured constant.
- **Remediation:** Pass `origin: PUBLIC_ORIGIN` and `rpID: new URL(PUBLIC_ORIGIN).hostname` to `passkey()`.

### F-60 · Low · No TOTP replay guard on any of the three verifiers

- **Where:** `db/schema.ts:455-510` (no last-used-step column), `lib/auth/two-factor-enrolment.ts:319`, `lib/auth/recovery-second-factor.ts:59`, the library's `/two-factor/verify-totp` (`@better-auth/utils/dist/otp.mjs:41-57`, window ±1).
- **Evidence:** A code observed once is accepted again for about 90 s across independent challenges and on the recovery path; single-use holds only within one challenge. Documented as-is (`docs/two-factor-flow.md:110`), so hardening rather than a broken contract.
- **Remediation:** Store the last accepted step on `two_factor_credentials` and reject `step <= stored` in all three verifiers.

### F-61 · Low · Backup codes are compared with `Array.includes`

- **Where:** `lib/auth/recovery-second-factor.ts:107` (and the library at `plugins/two-factor/backup-codes/index.mjs:39-42`), versus the constant-time compares used for TOTP and the trusted-device token (`lib/auth/trusted-device.ts:90-93`).
- **Evidence:** A theoretical side channel on a ten-character code behind a five-attempt budget and a lockout; reported for the inconsistency.

### F-62 · Low · `{ method: 'otp' }` without `contactKind` silently removes or re-defaults one of two OTP enrolments

- **Where:** `utils/validation/two-factor.ts:205-208` (`contactKind` optional), `lib/auth/two-factor-enrolment.ts:576-585,634-644` (`.find()` on a list ordered by `contactKind`, so email wins over phone).
- **Evidence:** Every other layer treats the two OTP possessions as distinct (`optionId`, `lib/auth/two-factor-challenge.ts:180-185`; `docs/two-factor-flow.md:263`); the response does not say which was removed.
- **Remediation:** Require `contactKind` when `method === 'otp'`, or key both endpoints on the published option id.

### F-63 · Low · `revokeOtherSessions` runs before `revokePendingProofs` at five of seven call sites, so the session-keyed proof sweep finds nothing

- **Where (related: F-27):** `lib/auth/rotation.ts:75-93` (`revokeVerificationArtifacts` derives `2fa-proven-<sessionId>`, `reauth-method-<sessionId>`, `reauth-passkey-<sessionId>` from a live `sessions` read); wrong order at `forgot-password/complete/handler.ts:201-202`, `forgot-password/reset/handler.ts:195-196`, `app/api/dash/users/[id]/handler.ts:800-805,981-982`, `users/me/contact-change.ts:178-179`.
- **Evidence:** Not exploitable (the orphaned rows name ids that are never reused and expire within 15 min), but the invariant the function's own warning states is not enforced by those sites, and any future keep-session change there reintroduces the bug silently.
- **Remediation:** Fix at the boundary: have `revokePendingProofs` derive the identifiers from the keep-session id it already accepts, so call order stops mattering.

### F-64 · Low · Redundant `as` casts on values the schema types already narrow

- **Where:** `lib/auth/two-factor-enrolment.ts:577,634` (`as ContactKind | undefined` on a Zod output that already is), `app/api/auth/forgot-password/second-factor/send/handler.ts:92,100` and `complete/handler.ts:143` (`as OtpChannel` after a truthiness check on `OtpChannel | null`), `lib/auth/two-factor-otp.ts:305` (earned at runtime but expressible as `z.custom<OtpChannel>(isTwoFactorOtpChannelEnabled)`).
- **Evidence:** Per the declared types the casts are no-ops; compiler confirmation would need an edit and `tsc`, which this audit did not perform.

### F-68 · Low · Refinements are dropped from the document: two update routes publish `{}` as valid and folder-name rules vanish

- **Where:** `utils/validation/media.ts:88-102` (`updateFolderSchema`, `updateFileSchema`, `folderNameSchema`, `displayNameSchema` refinements), `lib/http/openapi.ts:804-816` (`applyRequestContractRules` already injects such rules for users/permissions/OTP, not media).
- **Evidence:** `safeParse({})` is false for both update schemas while the published bodies have no `required`/`minProperties`; `"   "`, `"."`, `".."`, `"a/b"` are rejected by the server and accepted by the document.
- **Remediation:** Add the media schemas to `applyRequestContractRules` (an `anyOf` of `required` and a negative pattern express both).

### F-69 · Low · `PUT /api/dash/users/:id` publishes an undiscriminated `oneOf` selected by caller identity

- **Where:** `lib/http/openapi.ts:122-125,358-361,835`.
- **Evidence:** Branch 1 (`{name}` only) applies only when `:id` is the caller's own id, which no payload field expresses and the operation has no `description`. A generated client sending `{name}` for another user sees no client-side error and a 422 for four missing fields.
- **Remediation:** State the rule in `OPERATION_DOCS`.

### F-70 · Low · The two-factor reset publishes no 404 although the handler throws it, and no check would catch the omission

- **Where:** `lib/http/openapi.ts:207-238` (`NOT_FOUND_ROUTES` lacks the key), `app/api/dash/users/[id]/two-factor/handler.ts:48,92,123`; `openApiConsistencyProblems:2203-2215` checks status-set membership against the route table, never against what a handler can throw.
- **Remediation:** Add the key; consider deriving the status sets from a per-handler declaration so an omission fails the consistency check.

### F-71 · Low · A table route sharing a path with a Better Auth endpoint would be erased from the document

- **Where:** `lib/http/openapi.ts:2491` (table loop merges) versus `:2577` (Better Auth loop assigns `paths[full] = …`); no collision check in `openApiConsistencyProblems`. Overlap is empty today; the runtime would serve the table route while the document described the other handler.

### F-72 · Low · `format: "email"` is lost when `.regex()` follows `z.email()`

- **Where:** `utils/validation/rules.ts:156-166`; measured on Zod 4.5.4: `z.email().max(150).regex(…)` emits `allOf` of two patterns and no `format`, while the hand-written response schemas (`lib/http/openapi.ts:1424,1450`) do carry `format: email`.
- **Remediation:** `.meta({ format: 'email' })` on `emailSchema`, as `phoneSchema` does.

### F-73 · Low · A quarter of the document is repeated inline schema

- **Where:** `lib/http/openapi.ts` (`components.schemas` holds only Better Auth's `Session`, `User`, `Passkey`; `MEDIA_FILE_SCHEMA` is inlined nine times).
- **Evidence:** The six largest repeated subschemas total 79 063 of 319 524 bytes (24.7 %); generated clients emit nine anonymous duplicates of one type, and a one-field change rewrites nine places.
- **Remediation:** Promote the reused project schemas into `components.schemas` and `$ref` them; the ref machinery already exists.

### F-74 · Low · Internal file and constant names appear in the published document

- **Where:** `lib/http/openapi.ts:2600` (`routes.ts` in `info.description`), `:2512-2515` ("the before-hook in lib/auth.ts", six to twenty-four occurrences), `routes.ts:639,677` (`FOLDER_RECURSIVE_DELETE_MAX`, `UPLOAD_PURPOSES` where a client needs the value).
- **Evidence:** No environment names, credentials or absolute paths leak (scanned). The document is behind `requireDashboardAccess`, so the exposure is the auth boundary's file layout to any dashboard user.

### F-75 · Low · `info.version` is a frozen literal

- **Where:** `lib/http/openapi.ts:2594` (`version: '0.1.0'`). Two documents describing different surfaces (2FA on or off, before and after a route change) are indistinguishable by the field codegen and client caches key on. Distinct from should-ignore #7.
- **Remediation:** Derive from a content hash or the commit.

### F-76 · Low · Two unchecked casts on locally authored schema constants can empty a published schema

- **Where:** `lib/http/openapi.ts:1184,1318` (`MEDIA_*_SCHEMA.properties as Record<string, JsonSchema>`), `:1191,1337` (`.required as string[]`).
- **Evidence:** `JsonSchema` is `Record<string, unknown>`, so a restructured `MEDIA_FILE_SCHEMA` would make `MEDIA_FILE_DETAILS_SCHEMA` publish only its three own properties while `required` still names sixteen absent ones, with `additionalProperties: false` then invalidating every real response and no type error.
- **Remediation:** Build both composites from one typed object literal.

### F-81 · Low · The bootstrap role name `system-${email}` can exceed `varchar(100)`

- **Where:** `app/api/dev/sign-up/handler.ts:74`, `utils/validation/constants.ts:37,76` (`EMAIL_MAX = 150`, `ROLE_NAME_MAX = 100`).
- **Evidence:** `emailSchema` accepts 150 characters and the shortest allowed domain leaves 93 characters of local part before `system-` overflows. Development-only route (`/api/dev/*` is unrouted elsewhere), but it is the first thing a new project runs.
- **Remediation:** Key the role off `newUser.id` as `createCustomRole` does, or `.slice(0, ROLE_NAME_MAX)`.

### F-82 · Low · `idx_role_permissions_role_id` is a strict prefix of the unique index beside it

- **Where:** `db/schema.ts:876-877`.
- **Evidence:** `(role_id)` versus `ux_role_permissions_role_page (role_id, page_name)`, both non-partial; the only `role_id`-keyed reads (`lib/permissions/utils.ts:135,497-498`) are served by the composite, and the `ON CONFLICT` target at `:122` names the composite.
- **Remediation:** Drop it in a generated migration.

### F-83 · Low · `0007` flips the `two_factor_credentials.verified` default without backfilling rows created under the old default

- **Where:** `db/drizzle/0005_two_factor_tables.sql:35` (`DEFAULT true NOT NULL`), `db/drizzle/0007_real_the_watchers.sql:2` (`SET DEFAULT false`, no `UPDATE`), `db/schema.ts:464`.
- **Evidence:** Any database that held credential rows between `0005` and `0007` keeps `verified = true` on secrets no enrolment confirmed, which is the state the default was changed to exclude. Bounded to developer databases: a fresh install applies both inside one transaction with no rows, and there is no production data.

### F-84 · Low · `0008`'s data migration writes a `varchar(500)`-derived value into `varchar(150)` and labels every existing file an image

- **Where:** `db/drizzle/0008_classy_wallflower.sql:26-27` (`SET "kind" = 'image'`, `SET "display_name" = regexp_replace("r2_key", '^.*/', '')`), `0009:1-2` (`SET NOT NULL` on both).
- **Evidence:** `r2_key` is `varchar(500)` (`0000:37`); one basename over 150 characters raises `22001` and aborts the single transaction carrying every pending entry. Already applied everywhere with no production data, so no realised impact; recorded because the shape (unbounded source into a narrower target inside the one big migration transaction) will recur.
- **Remediation:** For future data migrations, bound the source (`left(…, 150)`) and derive `kind` from `mime_type`.

### F-85 · Low · No advisory lock guards either migration phase

- **Where:** `scripts/migrate.ts:72-92`; `node_modules/drizzle-orm/pg-core/dialect.js:56-60` (the ledger read precedes the transaction).
- **Evidence:** Two concurrent runs compute the same pending set; the second replays DDL behind the first's locks and fails, rolling back cleanly. Phase 2 is idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`). Mitigated today by the runbook's single maintenance-shell run; it becomes a crash loop the day `db:migrate` moves into a container entrypoint with more than one replica, which is the stated scaling direction.
- **Remediation:** `select pg_advisory_lock(<fixed bigint>)` after connecting, released in the existing `finally`.

### F-86 · Low · The Google hosted-domain branch is unreachable: `identitySchema.email` is the consumer-domain `emailSchema`

- **Where:** `lib/auth/oauth-identity.ts:47` (`email: emailSchema`), `:58-71` (`hostedDomain`), `utils/validation/rules.ts:156-166` (regex restricted to `gmail.com|outlook.com|hotmail.com|live.com|yahoo.com`).
- **Evidence:** A Workspace address at any hosted domain fails `safeParse` with `invalid_claims` before the `hd` logic runs; an `outlook.com`/`yahoo.com` Google account passes the schema and then fails `domain !== 'gmail.com' && !hostedDomain`. Net effect: only `gmail.com` accounts can complete Google sign-in, and the fourteen lines of `hd` validation are dead. Coherent as a policy; the code and `tests/integration/oauth-review-regressions.test.ts` (which pins the `hd` shape check as intended) describe a broader one.
- **Remediation:** Either drop the `hd` branch and state the gmail-only rule, or give OAuth its own address schema.

### F-88 · Low · Browser globals pass both static gates in server-only code, and the obvious `lib` fix is inert

- **Where:** `tsconfig.json:6` (`"lib": ["dom", "dom.iterable", "esnext"]`), `eslint.config.mjs:46-51` (the `globals.browser` omission only matters while `no-undef` is on, and `typescript-eslint`'s `eslint-recommended` turns it off for `.ts`; it is never enabled for `.mjs`).
- **Evidence (measured):** `eslint --print-config server.ts` → `no-undef [0]`; `tsc -p tsconfig.json --noEmit --lib esnext` → 0 errors, yet `--listFilesOnly` still contains `lib.dom.d.ts`, because `utils/images/server.ts:1` imports `jsdom` and `@types/jsdom` carries `/// <reference lib="dom" />`. No `window`/`document`/`localStorage` reference exists in server code today.
- **Remediation:** `no-restricted-globals` for `window`, `document`, `localStorage`, `sessionStorage`, `navigator` across all source; editing `lib` achieves nothing while jsdom is imported.

### F-89 · Low · ESLint's core rule set is never registered, and no `.js`/`.mjs` file is in the TypeScript program

- **Where:** `eslint.config.mjs:36-44` (no `@eslint/js` spread; `tseslintConfigs.recommended` only disables core rules), `tsconfig.json:8-9,35` (`allowJs`/`checkJs` with an `include` of `.ts/.tsx/.mts` only).
- **Evidence (measured):** `--print-config server.ts` shows every core rule absent or off (`use-isnan`, `valid-typeof`, `no-self-assign`, `no-cond-assign`, `no-duplicate-case`, `no-sparse-arrays`, …); `tsc --listFilesOnly` lists 313 project files and zero JavaScript. `tsc` covers several of those classes for `.ts`; nothing covers `scripts/require-bun.mjs` (472 lines, the `preinstall` gate, whose runtime is a machine with nothing installed yet) or `eslint.config.mjs`.
- **Remediation:** Spread `js.configs.recommended`; add `**/*.mjs` to `include` so `checkJs` and the file's JSDoc types become real.

### F-90 · Low · `find:non-null` is a gate that cannot fail, wired into nothing

- **Where:** `scripts/find-non-null-assertions.ts:61,259-265` (`--fail` required, no caller passes it), `package.json:19`; `@typescript-eslint/no-non-null-assertion` is not enabled (it lives in `stylistic`, not `recommended`).
- **Evidence (measured):** the script reports 8 occurrences (`bench/s3/multipart.test.ts`, `tests/integration/otp-verify-budget.test.ts`) and exits 0. `bench/**` is also eslint-ignored (`eslint.config.mjs:34`).
- **Remediation:** Enable the rule and delete the script, or run it with `--fail` in the pre-push `gates` group.

### F-91 · Low · `findBun()` cannot see a Bun installed as an npm `.cmd` shim on Windows, so the guard triggers the duplicate install it exists to prevent

- **Where:** `scripts/require-bun.mjs:211-239` (`execFileSync(candidate, ['--version'])` over `bun`, `<dir>/bun.exe`, `<dir>/bun`), `:415-417` (missing → `installBun` runs the official installer).
- **Evidence (measured under Node 24 with only `mybun.cmd` on PATH):** `mybun` → `ENOENT` (CreateProcess appends `.exe`, never `.cmd`); `mybun.cmd` → `EINVAL` (Node requires `shell: true` for `.cmd`/`.bat` since the CVE-2024-27980 fix). `npm install -g bun` on Windows produces exactly `bun.cmd`/`bun.ps1` and populates neither `%BUN_INSTALL%\bin` nor `~/.bun/bin`. Not measured under Bun's own `execFileSync`, so the `bun install` path is unverified; the `npm install` path (the one the guard exists for) is the measured one.
- **Failure scenario:** A developer with an npm-installed Bun runs `npm install`; the guard reports "Bun is not installed", downloads and runs the official installer, and leaves two binaries with PATH order deciding. CI and the Coolify image set `CI`/`BUN_GUARD_NO_AUTO_INSTALL`, so dev machines only.
- **Remediation:** On Windows add `bun.cmd`/`bun.ps1` candidates invoked with `{ shell: true }` (the command is a literal), or probe `PATHEXT`.

### F-92 · Low · The `dedupe` gate does not check the property it is named for

- **Where:** `lefthook.yml` (`dedupe`, fail text "a dependency resolves to more than one version"), `.github/workflows/ci.yml:69`.
- **Evidence (measured):** `bun dedupe --check` → "No duplicates — checked 473 packages", exit 0, while `bun.lock` holds 18 names at two or three versions (`eslint-visitor-keys` 5.0.1/3.4.3/4.2.1, `minimatch` 3.1.5/10.2.6, `tslib` 2.8.1/1.14.1, `@better-auth/utils` 0.4.2/0.5.0, …). `bun dedupe` reports only collapsible duplicates; incompatible ranges are invisible to it. `--check` is the right flag and the gate is correct for what it measures.
- **Remediation:** Rename the gate to what it checks; add a separate single-version check if that property is wanted.

### F-93 · Low · The dependency audit runs only on push and pull request, with no severity floor and no triage path

- **Where:** `.github/workflows/ci.yml:3-6,237-249` (`audit` job), `.github/workflows/security.yml:3-8` (the only `schedule`, running semgrep and gitleaks), `scripts/audit.ts:31` (`bun audit` with no flags).
- **Evidence:** An advisory published against an unchanged lockfile is unnoticed until the next push; Renovate's `vulnerabilityAlerts` covers this only if the app is installed and GitHub alerts are enabled. `bun audit` (1.4.2) supports `--audit-level` and repeatable `--ignore=<GHSA>`; today a single `low` advisory in any transitive dev dependency blocks every push with no way to accept it short of disabling the gate. The retry discriminator was re-verified against a black-hole registry (`ConnectionRefused` matches `TRANSPORT_FAILURE`).
- **Remediation:** Add the `audit` job to `security.yml`'s schedule; pass an explicit `--audit-level`, and record accepted advisories with `--ignore` beside the existing triage notes.

### F-94 · Low · `check-coverage.ts` accepts a stale or wrong-tier report, and its floors sit far below the measurement

- **Where:** `scripts/check-coverage.ts:48,65-69,123-138` (`FLOORS { lines: 0.54, functions: 0.68 }`, `MINIMUMS { files: 100, linesFound: 13_000, functionsFound: 750 }`; only the missing-file case fails).
- **Evidence (measured):** the gate passed against a `coverage/lcov.info` five days old, reporting 139 files / 66.71 % lines / 75.26 % functions and containing `utils/images/rgba.ts`, which the script itself identifies as a unit-tier file invisible to the integration tier the floors describe. CI ordering makes it correct there; locally or after any reordering a report from another tier or another day passes.
- **Remediation:** Fail unless the report's mtime is later than the process start (or have the runner write a provenance marker naming the tier), and raise the floors to the current CI measurement.

### F-95 · Low · The pinned runtime and the pinned types have drifted

- **Where:** `package.json:35,63` (`packageManager: bun@1.4.2`, `@types/bun: ^1.4.1` installed at 1.4.1), `renovate.json:37-42` (the `bun types` group sits behind `dependencyDashboardApproval`).
- **Impact:** Types for 1.4.2 APIs are absent while the runtime is 1.4.2.

### F-96 · Low · Two workflow settings weaken the main-branch signal

- **Where:** `.github/workflows/ci.yml:11-13` and `security.yml:13-15` (`cancel-in-progress: true` keyed on `github.ref`, so two quick pushes to `main` cancel the first commit's verification); `ci.yml:209` (`if-no-files-found: warn` on the junit artefact, so a reporter that stops producing the file leaves the job green).
- **Remediation:** `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`; `if-no-files-found: error`.

### F-97 · Low · ESLint file-scope lists are inconsistent and exclude root-level `.ts` other than three named files

- **Where:** `eslint.config.mjs:108-119` (type-aware block names `routes.ts`, `app.ts`, `server.ts`; `drizzle.config.ts` and any future root `.ts` get `parserOptions {}` and no `no-floating-promises`, measured), `:135` (`bun:` exemption scoped to `ts,mts,cjs`, so `.mjs` gets `import-x/no-unresolved` with no exemption), `:141` (drizzle rules scoped to `ts,tsx,js,mjs`, excluding `.mts`/`.cts`).
- **Remediation:** One shared list, or `**/*.{ts,mts,cts}` plus explicit root entries.

### F-98 · Low · `scripts/smoke.ts` differs in posture from the command it certifies and accepts a non-numeric port

- **Where:** `scripts/smoke.ts:29` (`Number(process.env.SMOKE_PORT ?? 3999)`, `NaN` reaches `BASE` and the child's `PORT`), `:61` (`Bun.spawn(['bun', 'server.ts'])` while `start` is `bun --bun server.ts`), `:240-241` (a signal to the smoke process itself orphans the child; bounded on a GitHub runner).
- **Remediation:** Validate the port, spawn with the deployed flags, and forward `SIGINT`/`SIGTERM` to the child.

### F-99 · Low · `--frozen-lockfile` does not fail when the lockfile is absent

- **Where:** `.github/workflows/ci.yml:38,190,244`.
- **Evidence:** Per Bun's documentation, with no lockfile at all `--frozen-lockfile` installs from `package.json` without writing one and exits 0. `bun.lock` is committed, so this needs a checkout accident or a `.gitignore` edit, but the flag is the supply-chain anchor of three jobs.
- **Remediation:** Assert `bun.lock` exists before the install step.

### F-100 · Low · A developer's `bun add` bypasses the release-age window Renovate enforces

- **Where:** `renovate.json:8` (`security:minimumReleaseAgeNpm` delays Renovate PRs only), `bunfig.toml` (no `[install] minimumReleaseAge`).
- **Evidence:** Bun's `minimumReleaseAge` (seconds) plus `minimumReleaseAgeExcludes` applies the same window to `bun add`/`bun update`, which Renovate cannot see; it affects new resolution only, never existing `bun.lock` entries. Not a Bun 1.4 change; recorded as a gap in the posture the repository already chose.

### F-104 · Low · `session.freshAge` is inert configuration

- **Where:** `lib/auth.ts:682` (`freshAge: 10 * 60 * 60`).
- **Evidence:** The option is read only by `freshSessionMiddleware`/`sensitiveSessionMiddleware`, which sit on endpoints this deployment does not serve (`session.mjs:350-453`, `update-user.mjs`, `account.mjs:263`, `password.mjs:195`) or that the app removes or re-wraps with `use: []` (`lib/auth/two-factor.ts:176-197`). The real freshness controls are `ADMIN_REAUTH_MAX_AGE_S` and `authRevokedAt`.
- **Remediation:** Remove it, or set `freshAge: 0` so the intent is unambiguous.

### F-105 · Low · `lib/auth/check-password.ts` imports a dependency the project does not declare, and the dependency gate does not notice

- **Where:** `lib/auth/check-password.ts:4` (`import { betterFetch } from '@better-fetch/fetch'`), `package.json` (absent; resolves only through `better-auth`'s own dependency on `@better-fetch/fetch@1.3.1`).
- **Evidence (measured):** `bunx knip --include unlisted` reports nothing and exits 0, so the `routes` gate that exists to catch "an unlisted dependency" (`lefthook.yml`) does not catch this one. `betterFetch` buys nothing here: the function builds its own `AbortController`, and only the `{ data, error }` shape is used.
- **Failure scenario:** `better-auth` bundles, renames or drops the package in a minor; the import fails at module load and every password-setting path (create, admin reset, self-service change, recovery complete) 500s.
- **Remediation:** Use global `fetch` (three lines), or declare the dependency at the version it is built against.

### F-106 · Low · `requireReauthSession` omits the eligibility predicate its siblings enforce

- **Where:** `lib/auth/request-context.ts:9-17` (role check only; no `deletedAt`/`isActive`), versus `lib/auth/user-eligibility.ts:18` and `lib/auth/live-session.ts:56-57`.
- **Evidence:** Harmless today because all three callers (`/reauth/methods`, `/reauth/passkey/options`, `/reauth/passkey/verify`) are in `LIVE_SESSION_PATHS`, so `assertLiveSession` already ran; a fourth caller outside that set inherits a suspended-user hole. It also resolves the session through the cookie cache.
- **Remediation:** Call `assertLiveSession` instead of re-implementing half of it.

### F-107 · Low · `verifyLoginAttempt`'s `tx` option has no caller and would silently disable the pepper rehash

- **Where:** `lib/auth/login-guard.ts:76` (`tx?: Tx`), `:391` (`if (!externalTx && result.passwordUpgrade)`); all seven callers pass no `tx`.
- **Evidence:** The first caller to use it gets argon2 inside its own larger transaction (F-102's shape) and a skipped upgrade with no signal.
- **Remediation:** Delete the option.

### F-108 · Low · `/two-factor/get-totp-uri` is unreachable for a user without a password even inside a valid passkey re-authentication window

- **Where:** `lib/auth.ts:187-208` (the window branch mints a proof only when `credential?.password` exists), versus `lib/auth/reauth-grant.ts:63-76` (`requireReauthPassword` accepts the window without a credential row).
- **Evidence:** A Google- or passkey-only account receives `401 REAUTH_REQUIRED` prompting for a password it does not have; the library's `getTOTPURIBodySchema` requires `password` because `allowPasswordless` is unset. The two re-authentication boundaries disagree (F-53 covers the opposite direction). Fails closed; only re-reading the URI is lost.
- **Remediation:** Drop the path from `BETTER_AUTH_ENDPOINTS` (the app owns enrolment) or serve the URI from an app endpoint through `requireReauthPassword`. Do not set `allowPasswordless: true`, which would remove the password check for exactly these users.

### F-109 · Low · Every credential rotation runs two sequential scans of `verifications`

- **Where:** `lib/auth/rotation.ts:51-58` (`like(identifier, '2fa-%')` cannot use the btree under a non-C collation), `:73` (`eq(verifications.value, userId)`, no index), `db/schema.ts:431-432` (indexes on `identifier` and `expires_at` only).
- **Evidence:** Password, email and phone changes, admin edits, soft deletes and 2FA resets all pay it, against a table that also holds OTP and OAuth-state rows. `recovery-state-*`/`recovery-attempts-*` rows are left behind, but are unusable once `recovery-<token>` is gone (`recovery-grant.ts:133-137`), so orphans only.
- **Remediation:** Index `value` (or store the owner in a column) and give `identifier` `varchar_pattern_ops` if the table grows.

### F-110 · Low · The lockout counter confirms a correct password on an account the post-password gates refuse

- **Where:** `lib/auth/login-guard.ts:330-335` (counter reset on a correct password), `lib/auth.ts:737-782` (inactive role, `roleAllowsLogin`, unverified contact refuse afterwards with the same 401).
- **Evidence:** Five wrong guesses lock the account; a run containing the correct guess never does, so the lockout state distinguishes the correct candidate while every response stays identical. Inherent to reset-on-success lockouts; recorded because the file otherwise takes indistinguishability seriously.
- **Remediation:** Optional; reset the counter only after the session-creation gates pass.

### F-111 · Low · HIBP padding entries with a zero count are not discarded

- **Where:** `lib/auth/check-password.ts:59-73` (`Add-Padding: true` requested; the match ignores the count field).
- **Evidence:** HIBP's padded responses include synthetic `SUFFIX:0` lines clients are documented to filter; the collision probability with a queried suffix is negligible, so this is contract compliance, one clause to fix.

### F-112 · Low · The `argon2` native dependency can be replaced by `node:crypto` with byte-for-byte parity, at the cost of PHC handling

- **Where:** `lib/auth/password.ts:1`, `package.json:83-84` (`trustedDependencies: ["argon2"]`).
- **Evidence (measured on Bun 1.4.2):** `crypto.argon2("argon2id", { message, nonce, secret: pepper, parallelism: 4, tagLength: 32, memory: 65536, passes: 3 })` reproduces the stored tag exactly (`PARITY tag equal: true`); throughput is equivalent (8 parallel: 695 ms npm, 632 ms node). `Bun.password` is not a candidate because it does not accept `secret`.
- **Trade-off:** removes the only script-running native package from the install, but `hashPassword`/`verifyPasswordDetailed` would then encode and parse the `$argon2id$…` string and `timingSafeEqual` the tag themselves (about forty lines around key material). Worth doing only if the native install is causing friction.

### F-115 · Low · `renderedNodeCount` follows `use` and marker references only, so `pattern`, `filter`, `mask` and `clipPath` instantiation is outside the ceiling it enforces

- **Where:** `utils/images/svg-optimizer.ts:291-403` (`use` at `:357`, `MARKER_ATTRIBUTES` at `:365`), `:690-695` (`SVG_MAX_RENDERED_NODES` enforced on that count).
- **Evidence:** A 400-element pattern tiled 25 million times and a `feTurbulence numOctaves="10"` plus `feGaussianBlur stdDeviation="500"` over a 100 000² filter region were both admitted (`valid=true`, ~600 ms server side). `fill="url(#p)"`/`filter="url(#f)"` are same-document fragments, so the external-reference sweep passes them. Viewer-side cost was not measured (browsers cache tiles and clamp filter regions), so the practical blast radius is unproven; the verified fact is that the enforced ceiling does not cover these constructs.
- **Remediation:** Charge `pattern`/`mask`/`clipPath`/`filter` references in `cost` (a fixed multiplier for a pattern's subtree suffices) and bound `numOctaves`, or narrow the ceiling's stated scope.

### F-118 · Low · `&lt;` in any surviving attribute value fails the upload with the generic "sanitisation failed" error

- **Where:** `utils/images/svg-optimizer.ts:739-767` (`XMLSerializer` → DOMPurify HTML re-serialisation emits a raw `<` in the attribute → `isSingleSvgRoot`'s XML re-parse fails).
- **Evidence:** `<text font-family="a&lt;b">` → refused with `فشل في تنظيف SVG` (`parsererror: disallowed character`). Fail-closed and the same mechanism that stops attribute-boundary injection; a false refusal with no diagnosis.
- **Remediation:** Re-escape `<`/`>` in attribute values before the XML re-parse, or at least distinguish this message from the DOMPurify-emptied case.

### F-119 · Low · CFB FAT-table amplification: an 8.7 KB `.doc` would allocate about 69 MB, latent while `.doc`/`.xls` stay disabled

- **Where:** `lib/media/cfb.ts:138-159` (`fatSectorNumbers`: the `MAX_FAT_SECTORS` check runs after the list is built; the DIFAT walk has no visited set), `:162-174` (`readTable` does not dedupe sector numbers), `lib/media/allowlist.ts:117-123` (`DISABLED_FILE_TYPES`).
- **Evidence (subagent):** 4 096-byte sectors, `numDifatSectors = 3`, one self-referencing DIFAT sector → 3 178 FAT sectors → 3.25 M table entries; RSS 20 → 89 MB, 38 ms per call; `fileTypeFor('application/msword')` is refused today. The allowlist's statement that re-enabling a type is "deleting it from this set; nothing else changes" is what makes this worth recording.
- **Remediation:** Move the cap inside the DIFAT loop, add a visited set, dedupe in `readTable`.

### F-120 · Low · `utils/images/rgba.ts` throws plain `Error` (→ 500) on any PNG shape Bun's encoder does not emit today, and has no unit test

- **Where:** `utils/images/rgba.ts` (`decodePng`: five filter cases, `colourType`/`bitDepth`/`interlace` refusals, `'short IDAT'`), consumed by the blurhash path.
- **Evidence:** It holds because Bun's PNG encoder emits `bitDepth=8 colourType=6 interlace=0` for every shape tried, including greyscale input; a Bun release that emits palette or 16-bit output turns every blurhash into a 500 rather than a `CustomError`.
- **Remediation:** Convert the refusals to `CustomError` (422) and pin the accepted shape in a unit test.
