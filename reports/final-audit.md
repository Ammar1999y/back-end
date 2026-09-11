# Consolidated final audit

## Findings

### C-001 · High · User creation and bulk session revocation bypass the re-authentication class

- **Locations:** `app/api/dash/users/handler.ts:147` (`POST`); `app/api/dash/users/[id]/sessions/handler.ts:94-98` (`authorizeSessionAccess`); `lib/http/session.ts:38-70`.
- **Evidence and failure scenario:** `requirePermission` enforces the re-authentication window only when `reauth: true` is supplied. The user-create and session-management routes omit it, although password changes, role changes, deletion, and 2FA reset require it. An attacker with a stolen administrator session can create a new user with a chosen password and an in-scope role, converting transient cookie theft into an independent credential that survives rotation of the compromised account. The same stale session can also revoke every in-scope user's sessions.
- **Impact:** Persistent account takeover and broad availability impact through operations in the same sensitive mutation class as already-protected actions.
- **Remediation:** Require re-authentication on user creation and on bulk session deletion. Split session listing from deletion if self-service device listing must remain ungated, and add a route-table test that asserts every sensitive route returns `401 REAUTH_REQUIRED` before the window opens.

### C-002 · High · A small set of known addresses can exhaust the deployment-wide OTP delivery budget for a day

- **Locations:** `lib/rate-limit/api.ts:137,143,152-159,191-201`; `utils/otp.ts:759`; anonymous OTP send handlers.
- **Evidence and failure scenario:** Every OTP purpose and destination drains one global `otp.send.global:<contactKind>` pool capped at 2,000/day. Per-destination limits are separated by surface, but the global pool is not. Nine known addresses can consume about 2,160 email units/day by exhausting recovery and passwordless quotas hourly. Once the pool is empty, anonymous routes continue returning the generic success response while sending nothing, and authenticated email-OTP or recovery second-factor sends fail. The fixed UTC window documented as a deferred issue also permits two full budgets across midnight.
- **Impact:** Deployment-wide denial of recovery, passwordless sign-in, and email-based second-factor sign-in at low attacker cost.
- **Remediation:** Reserve independent global capacity for recovery and second-factor purposes; place verification, passwordless, and contact-change traffic in a discretionary pool. Add a per-destination daily charge cap after eligibility and emit a distinct `otp.budget.exhausted` operational event.

### C-003 · High · The migration command reports success for schema states Drizzle cannot reconcile

- **Locations:** `scripts/migrate.ts:78-80`; installed `drizzle-orm/pg-core/dialect.js:56-71`; installed `drizzle-orm/migrator.js:22-23`.
- **Evidence and failure scenario:** The installed migrator selects only the newest ledger timestamp and applies journal entries with a larger `when`; it writes migration hashes but never compares them. A code rollback behind the database, an edited applied SQL file, or a branch migration with an older timestamp therefore prints `ok` and `up to date` while leaving schema and code divergent. A common two-branch merge can permanently skip the second migration on upgraded environments while fresh installs apply both.
- **Impact:** Silent, deployment-wide schema divergence; the first request that uses the missing change fails after deployment rather than during the migration gate.
- **Remediation:** After migration, require strictly increasing journal timestamps, ledger row count parity, and a SHA-256 match between every ledger hash and on-disk SQL file. Refuse deployment on any mismatch.

### C-004 · High · SVG pre-parse regexes permit event-loop denial of service

- **Locations:** `utils/images/svg-optimizer.ts:437-481` (`sanitizeSvg`).
- **Evidence and failure scenario:** Four synchronous regex passes over comments, CDATA, processing instructions, and tags become quadratic on unterminated markup. On Bun 1.4.2, doubling adversarial input from 8 KB to 16 KB to 32 KB approximately quadrupled execution time; a roughly 410 KB admitted upload took tens of seconds. Any authenticated low-privilege media editor can submit these inputs at the upload rate and block every request in the process; the route timeout cannot interrupt synchronous JavaScript.
- **Impact:** Process-wide availability loss from one authenticated account.
- **Remediation:** Remove the redundant strip passes and count nodes after XML parsing, or replace all pre-parse expressions with proven linear scans. Add near-limit unterminated comment, CDATA, processing-instruction, and tag cases.

### C-005 · High · Unbounded attacker-controlled ICC profiles survive image transcoding

- **Locations:** `lib/r2/optimize-image.ts:81-90,146-166,290-330`.
- **Evidence and failure scenario:** Bun 1.4 intentionally preserves ICC profiles during transcoding. The pipeline prices only pixels and repeatedly decodes/encodes each quality rung, so a small image carrying a highly compressed, very large ICC profile can allocate hundreds of megabytes and still end in `422 targetUnreachable`. Smaller arbitrary profiles are copied into publicly served WebP files even though the pipeline otherwise assumes metadata was stripped. A low-resolution image therefore bypasses both pixel and edge budgets.
- **Impact:** Realistic VPS memory exhaustion and an unintended public metadata/covert-data channel.
- **Remediation:** Enforce an ICC policy before encoding: strip profiles if supported, otherwise parse and reject profiles above a small explicit bound. Charge profile expansion/encode work independently of pixels and assert the chosen metadata policy in tests. Bun's preservation behavior is documented in the [Bun 1.4 release notes](https://bun.com/blog/bun-v1.4).

### C-006 · Medium · Redirected Google sign-in rejects every local second-factor challenge

- **Locations:** `lib/auth/oauth.ts:332,439`; `lib/auth/two-factor-challenge.ts:685`; `docs/oauth-sign-in.md:61`.
- **Evidence and failure scenario:** A Google callback with a local 2FA requirement stores an outcome containing `twoFactorRedirect`, methods, options, and a default method, but no `success` field. `GET /api/auth/oauth/result` consumes both verification records and then rejects any body without `success === true`. The routed reproduction returned a callback 302 followed by a 401 result; the consumed result cannot be retried.
- **Impact:** The documented redirected Google flow is unusable for every account requiring local 2FA; direct JSON delivery and non-2FA accounts are unaffected.
- **Remediation:** Define and validate a complete stored OAuth outcome union that includes both the successful-session envelope and the existing 2FA challenge envelope. Cover `callbackURL` and local 2FA together.

### C-007 · Medium · Concurrent factor enrollment can activate an authenticator the user did not prove or no longer owns

- **Locations:** `lib/auth/two-factor-enrolment.ts:249,302-330,722,890`; `lib/auth/two-factor.ts:245`.
- **Evidence and failure scenario:** TOTP confirmation verifies secret A before taking the user lock; a concurrent start can replace it with B, after which confirmation marks the unchanged credential ID verified and enables TOTP. A routed interleaving produced `secretReplaced:true` and `unprovenSecretVerified:true`. Passkey registration persists the credential before the local activation hook; another request can delete it before the hook locks the user, and the hook then enables passkey-only 2FA with zero passkeys. Concurrent disable can similarly make the TOTP update affect zero rows while activation continues.
- **Impact:** Users can be told enrollment succeeded and then be locked out of their next sign-in. Reach is bounded to overlapping factor management on one account.
- **Remediation:** Under the user lock, revalidate the exact secret/version or passkey ID and owner, and require a successful guarded update/read before changing method intent, the user flag, or sessions. Return finalization failure to the registration caller and test replacement/deletion between proof or persistence and activation.

### C-008 · Medium · Graceful shutdown aborts every in-flight request older than five seconds

- **Locations:** `server.ts:144-158`; `lib/shutdown.ts:8-13`; `app.ts:178-182`; long-route definitions in `routes.ts:534,684`.
- **Evidence and failure scenario:** `app.stop()` waits for busy requests, but `stopServer` races it against a fixed five-second sleep and then calls `app.stop(true)`. A focused Bun 1.4.2 reproduction reset a handler still running after the grace period. During a Coolify deploy, an image upload or other legitimate long route can therefore lose its connection after five seconds even though route and shutdown budgets allow up to 120/135 seconds.
- **Impact:** Bounded but routine deployment-time request failure, with pending media rows or objects left for later cleanup.
- **Remediation:** Escalate only when `app.server.pendingRequests === 0`; otherwise continue waiting in bounded increments until the overall shutdown budget expires. Add a process test in which a request exceeds `gracefulStopMs` but completes before the shutdown deadline.

### C-009 · Medium · Unicode astral search terms bypass the trigram scan floor

- **Locations:** `db/queries/data-table.ts:114-118`; `lib/data-table/filter-columns.ts:162-166`; `lib/data-table/parsers.ts:32-33`.
- **Evidence and failure scenario:** Both guards use JavaScript `.length`, so two astral characters count as four UTF-16 code units and pass the three-character floor. PostgreSQL `pg_trgm` produces no trigrams for a two-code-point term and uses a sequential scan, as verified for `ILIKE '%😀😀%'`. An authorized user can force unindexed list and count scans on users, roles, and files.
- **Impact:** Table-size-dependent availability degradation; the intended scan guard is bypassable by construction.
- **Remediation:** Measure Unicode code points in one shared helper, for example `[...term].length`, and use it in both global search and column filters.

### C-010 · Medium · User update applies re-authentication before deciding whether the operation is self-service or authorized

- **Locations:** `app/api/dash/users/[id]/handler.ts:818-855`; `lib/http/session.ts:62-70`.
- **Evidence and failure scenario:** The route requests `users.edit` with `throwError:false, reauth:true` before branching. A user renaming only themselves receives `401 REAUTH_REQUIRED`, although the self schema permits only `name`; an unauthorized caller targeting someone else receives 401 before the correct 403, contrary to the gate's information-ordering contract.
- **Impact:** Broken self-service behavior and incorrect authentication/authorization status ordering.
- **Remediation:** Check permission without re-authentication, branch on self versus admin, and require the window only after an authorized admin edit is established.

### C-011 · Medium · Production can publish cached media without any revocation mechanism

- **Locations:** `lib/cloudflare/purge.ts:7,73-82`; `lib/media/visibility.ts:101-105`; `lib/media/lifecycle.ts:159-166`; `lib/r2/client.ts:459-460`; `lib/env.server.ts:98-121`.
- **Evidence and failure scenario:** Purge credentials are optional even when a public R2 URL is configured. The unconfigured purge returns an empty failure list, which unpublish and delete treat as success, while public images use `max-age=31536000, immutable`. On a Cloudflare-cached custom domain, unpublish removes the origin object and returns 200 but the edge can serve the supposedly private bytes for a year.
- **Impact:** The media privacy control is ineffective for cached copies, without API or operational warning.
- **Remediation:** In production, require purge credentials whenever the public origin is cached, with an explicit opt-out only for a proven uncached origin. Expose purge capability to the admin UI before publishing.

### C-012 · Medium · Stale visibility cleanup can delete both copies of an otherwise active file

- **Locations:** `lib/media/visibility.ts:86-105,233-238,298-313`.
- **Evidence and failure scenario:** Recovery reads the row's current bucket and starts an external delete without fencing it against a delayed publish. A stale sweep can begin deleting the public target while the row remains private; the original publish then flips the row to public and deletes the private source; the sweep finishes deleting public. A production-function reproduction ended with an active public row and neither object present.
- **Impact:** Irreversible loss of one file under an uncommon but possible stalled-transition race, including across workers.
- **Remediation:** Give each transition/recovery attempt an identity and fence destructive storage operations with ownership of that transition. A marker re-read or clearing the marker before deletion is insufficient once external deletion is already in flight. Keep storage I/O outside ordinary short transactions, but prevent a bucket from becoming authoritative while an older deletion of it can still complete.

### C-013 · Medium · Password reset performs HIBP and Argon2 work before validating the account or code

- **Locations:** `app/api/auth/forgot-password/reset/handler.ts:94-124`; `lib/auth/password.ts:5-12`.
- **Evidence and failure scenario:** Every syntactically valid request performs an outbound breach check and a 64 MiB Argon2id hash before user lookup or OTP verification. The measured hash rate was about nine concurrent hashes/second on the audit host. Multiple IPv6 `/64` buckets can saturate the shared hashing pool and delay sign-in, password changes, and admin creation while also driving HIBP into its accepted fail-open mode.
- **Impact:** Public, captcha-gated CPU and outbound-request amplification against authentication availability.
- **Remediation:** Price this route's pre-proof work with the existing weighted per-IP limiter or materially lower its limit. Preserve account-independent ordering to avoid an existence oracle.

### C-014 · Medium · Password recovery can commit after the account is suspended or deleted

- **Locations:** `app/api/auth/forgot-password/reset/handler.ts:102-211`; `app/api/auth/forgot-password/complete/handler.ts:100-219`; correct pattern at `utils/otp.ts:833-849`.
- **Evidence and failure scenario:** Both routes check eligibility before entering the verification transaction. `processOtpVerify` later locks the user row but does not re-check `deletedAt` or `isActive`; the completion callbacks re-read only factor/account records. If an administrator suspends a compromised account while a valid reset is in flight, the reset serializes after suspension and still rewrites the password.
- **Impact:** A containment action does not freeze credential rotation; the new password becomes usable immediately if the account is reactivated.
- **Remediation:** Re-read the user under the held lock with the full active/non-deleted eligibility predicate and collapse failure to the generic invalid-or-expired response on both reset paths.

### C-015 · Medium · The advertised OTP resend countdown contradicts the exponential server ladder

- **Locations:** anonymous send handlers in `app/api/auth/otp/send/handler.ts`, `passwordless/send/handler.ts`, and `forgot-password/send/handler.ts`; ladder in `utils/otp.ts:55-58,640-648`.
- **Evidence and failure scenario:** Every generic response advertises 30 seconds, while the row-level delay doubles after each send. A client following the contract sends at 0, 30, and 60 seconds; the third attempt is refused internally, still returned as generic success, and still consumes a destination quota unit. Repetition exhausts the five-per-hour quota and eventually produces a real 429. This materially disproves the ignore-list rationale that every case is an identical 200 and that the constant countdown is sufficient.
- **Impact:** Ordinary clients lose roughly every second code request and consume their hourly quota without delivery.
- **Remediation:** Either flatten the anonymous-surface ladder to the published constant or publish a conservative constant that remains true for the whole cycle. Do not return per-row timing that could become an account oracle.

### C-016 · Medium · The 15-minute re-authentication window satisfies destructive 2FA operations that documentation says require a password every time

- **Locations:** `lib/auth/reauth-grant.ts:63-76`; `lib/auth.ts:186-208`; `lib/auth/admin-reauth.ts:23`; `docs/two-factor-flow.md:309-313`.
- **Evidence and failure scenario:** App-owned 2FA disable, method removal, backup-code generation/acknowledgement, TOTP start, and passkey grants accept the existing admin re-authentication window; `get-totp-uri` can disclose the secret on that window. The behavior document promises a fresh password for every transition. A session-only attacker acting during the owner's open window can retrieve the TOTP secret and disable 2FA.
- **Impact:** The documented containment guarantee is false across the entire 2FA-management class.
- **Remediation:** Settle one contract. Prefer literal current-password proof for factor removal and TOTP-secret disclosure; otherwise correct the behavior document and UI to state that the 15-minute grant authorizes these operations.

### C-017 · Medium · Sign-in and recovery second factors share one mutable OTP proof row

- **Locations:** `lib/auth/two-factor-otp.ts:198,341,398`; recovery second-factor handlers; unique key at `db/schema.ts:963-967`.
- **Evidence and failure scenario:** Both purposes use `purpose:'two_factor'`, so send cooldowns, cycle blocks, and daily failed-verify counters share one `verification_sessions` row. An attacker who knows the password can exhaust the sign-in challenge's sends or guesses and thereby block the victim's password-recovery second factor as well.
- **Impact:** A first-factor holder can deny the victim both sign-in and recovery; administrative destructive reset becomes the only exit.
- **Remediation:** Introduce a distinct `recovery_second_factor` proof purpose for both recovery handlers, matching their already-separated limiter surface.

### C-018 · Medium · Bulk session revocation leaves trusted-device bypasses active

- **Locations:** `app/api/dash/users/[id]/sessions/handler.ts:279-336`; `lib/auth/trusted-device.ts:100-112`; `lib/auth/two-factor-challenge.ts:604-621`.
- **Evidence and failure scenario:** Bulk revocation deletes sessions only. Trusted-device records/cookies are removed by destructive 2FA state changes, not by the containment route. After an operator signs out all sessions for suspicious activity, an attacker retaining the password and trusted-device cookie can sign in again with 2FA skipped.
- **Impact:** The primary non-destructive account-containment action does not contain a trusted-device compromise.
- **Remediation:** Revoke trusted devices and pending proofs with bulk session revocation, or add a distinct non-destructive "revoke trusted devices" operation and make the containment workflow invoke it.

### C-019 · Medium · The 2FA rollout preflight can certify a configuration that strands users

- **Locations:** `scripts/check-two-factor-rollout.ts:34-98`; runtime parsing in `utils/validation/two-factor.ts:41-48` and `utils/validation/env-list.ts:33-45`.
- **Evidence and failure scenario:** Runtime configuration removes phone channels when `PHONE_ENABLED` is false and rejects duplicate enum entries. The preflight does neither, duplicates its own method/channel sets, and does not match the active-user predicate. It can report zero stranded accounts for `otp,totp` plus `email,sms` while the runtime silently removes SMS and later refuses phone-only users.
- **Impact:** A deployment gate gives a false safety result for a supported security configuration.
- **Remediation:** Reuse the runtime enum-list parser and effective-channel calculation in the preflight, including `PHONE_ENABLED` and the same eligibility predicate.

### C-020 · Medium · Better Auth success response schemas are wrong for both verification endpoints

- **Locations:** `lib/http/openapi.ts:1999-2014`; generated Better Auth schema; installed Better Auth TOTP and backup-code handlers.
- **Evidence and failure scenario:** `/two-factor/verify-totp` publishes `{status:boolean}` while returning `{token,user}`; `/two-factor/verify-backup-code` publishes required `{user,session}` while returning `{token,user}`. A generated client reads an absent `status`, and a response validator rejects every successful backup-code sign-in.
- **Impact:** Deterministic contract failure on two authentication completion paths when 2FA is enabled.
- **Remediation:** Add an authoritative `BETTER_AUTH_RESPONSES` override table parallel to request overrides and make consistency checks require an override or an explicit attestation for every served success response.

### C-021 · Medium · OpenAPI marks session-required Better Auth management routes as public

- **Locations:** `lib/http/openapi.ts:2517-2521`; session middleware registrations in `lib/auth/two-factor-enrolment.ts:202-822` and `lib/auth/trusted-device.ts:228-291`.
- **Evidence and failure scenario:** Eighteen 2FA/passkey/trusted-device operations publish `security: []` although runtime middleware returns 401 without a session. Generated clients can omit the cookie for the entire management surface and fail deterministically.
- **Impact:** Broad API-contract breakage; runtime authorization remains intact.
- **Remediation:** Put session requirements in the authoritative Better Auth endpoint metadata and generate the cookie security requirement from it. Elysia supports route-level `detail.security`, but these endpoints are served through one Better Auth wildcard, so moving to `@elysia/openapi` would not infer the hidden subroutes and would weaken the framework-neutral manifest. Keep the shared boundary and assert that every runtime 401-capable management operation publishes session security. See [Elysia OpenAPI security configuration](https://elysiajs.com/patterns/openapi#security-configuration).

### C-022 · Medium · OpenAPI conversion drops or misstates Zod transforms, refinements, and email metadata

- **Locations:** `utils/validation/rules.ts:156-166`; media refinements in `utils/validation/media.ts:88-102`; conversion/override logic in `lib/http/openapi.ts:534-544,804-816`.
- **Evidence and failure scenario:** Email, name, folder, and file schemas normalize before validation, but the document describes post-transform constraints as if they applied to raw input. Valid mixed-case or space-padded emails are rejected by document validators; update-folder and update-file publish `{}` as valid; folder-name rules disappear; and `.regex()` removes `format:'email'`. Eleven routes are affected.
- **Impact:** Generated clients and gateways reject valid calls or accept payloads that the server deterministically rejects.
- **Remediation:** Extend the existing metadata/contract override boundary to every transformed or refined field, including a case-insensitive email pattern, normalization description, `format:'email'`, media `minProperties`/`anyOf`, and forbidden-name patterns. Elysia's Standard Schema support still delegates Zod OpenAPI conversion to `z.toJSONSchema`, so adopting the native plugin alone does not recover these semantics. See [Elysia's Zod OpenAPI mapping](https://elysiajs.com/patterns/openapi#standard-schema-with-openapi).

### C-023 · Medium · CI does not detect drift between `db/schema.ts` and generated migrations

- **Locations:** `package.json`; `lefthook.yml`; `.github/workflows/ci.yml`; `tests/helpers/provision.ts:103-124`.
- **Evidence and failure scenario:** Migration generation is manual and neither local gates nor CI run a schema-drift check. The schema embeds runtime constants in checks, column widths, FK behavior, and enums. Raising an OTP maximum without generating SQL leaves the database enforcing the old limit and turns later valid writes into 500s. The reports verified no current drift; the defect is the absent gate.
- **Impact:** A future schema/code mismatch can pass every existing check and fail only in a deployed database.
- **Remediation:** In CI, copy Drizzle metadata to a temporary output, run `drizzle-kit generate`, and fail if it emits any SQL or changes journal metadata.

### C-024 · Medium · `page_name` evolution is hidden behind unearned assertions and lacks a database parity test

- **Locations:** `db/schema.ts:140-158`; write sites in `app/api/dev/sign-up/handler.ts:85-86` and `lib/permissions/utils.ts:111`.
- **Evidence and failure scenario:** `Object.keys(DASHBOARD_PAGES)` is double-asserted as a non-empty `DashboardPage` tuple, and string values are asserted into the enum column type. Source, Drizzle enum, and database match today, but only `provider_id` has a database-label test. Adding a dashboard page satisfies TypeScript while the first permission write can fail with PostgreSQL `22P02` if no enum migration was generated.
- **Impact:** A normal feature addition can produce a runtime-only permissions failure.
- **Remediation:** Derive the page map from one typed literal without double assertions and add one catalog test comparing every exported `pgEnum.enumValues` with PostgreSQL labels.

### C-025 · Medium · Folder deletion and file moves are not coordinated as one tree mutation class

- **Locations:** `lib/media/lifecycle.ts:218,327-414`; `lib/media/files.ts:142-188`; `lib/media/folders.ts:504-520`.
- **Evidence and failure scenarios:** Recursive deletion commits its subtree/file-ID plan before marking files, while moves do not take the tree lock or revalidate planned membership. A file successfully moved outside the subtree in that gap is still deleted; this was reproduced with both its row and object gone. In the opposite direction, a move into a concurrently deleted folder loses with an unmapped `23503` and returns 500. A concurrent insert/move can also make final folder deletion raise `23503` after objects were already removed.
- **Impact:** Data loss for successfully moved files and partial/destructive 500 outcomes under ordinary overlapping organization operations.
- **Remediation:** Resolve the subtree and mark its files deleting in one transaction under the shared tree/folder locks. Make move/update participate in the same lock order and revalidate current membership before deletion. Map the specific FK race to the existing folder-not-found/folder-not-empty contract, while leaving object cleanup after commit.

### C-026 · Medium · Email sign-in preserves an unvalidated client `callbackURL`

- **Locations:** `lib/auth.ts:600-611`; installed Better Auth dispatch and email sign-in route; `lib/http/openapi.ts:500`.
- **Evidence and failure scenario:** The before-hook returns a replacement-looking body, but Better Auth merges it with the original and retains undeclared keys. Its email sign-in route accepts `callbackURL` without the origin check used by sibling redirect endpoints and returns it in `Location`/`url`. A normal login page that forwards an untrusted `?next=` value can therefore create an open post-login redirect.
- **Impact:** Phishing/open-redirect exposure after successful authentication; cross-origin direct injection remains constrained by CSRF/origin controls.
- **Remediation:** Explicitly remove or reject `callbackURL` in the sign-in hook and add a regression case proving undeclared keys do not survive body patching.

### C-027 · Medium · Argon2 verification holds a user lock and pooled PostgreSQL connection for the entire hash

- **Locations:** `lib/auth/login-guard.ts:190-201,274-277,382-384`; `db/limits.ts:14-23`.
- **Evidence and failure scenario:** Login takes `FOR UPDATE` and then awaits password verification inside the transaction. Concurrent Argon2 work measured up to roughly 0.9 seconds for eight hashes; ten sign-ins can hold the entire pool while other auth, media, and admin transactions wait. More Bun processes multiply database connection pressure without raising the per-process hash capacity.
- **Impact:** Authentication bursts can cause unrelated transactional availability failures and long lock contention.
- **Remediation:** Read the hash/counters in a short transaction, verify outside it, then update counters or upgrade the hash in a second transaction guarded by compare-and-swap on the password hash.

### C-028 · Medium · Per-path auth limits share coarse two-segment counters

- **Locations:** `app.ts:438-441`; `lib/http/pre-auth.ts:10,29-37`; path budgets in `lib/auth/allowed-paths.ts`.
- **Evidence and failure scenario:** Known Better Auth paths omit an explicit scope and fall back to a scope containing only the first two path segments. Twelve `/two-factor/*` endpoints with nominal limits of 20, 30, and 60 therefore share one counter; higher-budget reads can consume the pool and make the lower-budget OTP send fail behind shared NAT.
- **Impact:** Supported 2FA flows can self-throttle or interfere with other users at the same address.
- **Remediation:** Pass a stable full-subpath scope for every known Better Auth endpoint; keep the one fixed unknown-prefix scope only for unrecognized paths.

### C-029 · Medium · Legal line-wrapped SVG data URIs are silently removed

- **Locations:** `utils/images/svg-optimizer.ts:46,656-659`.
- **Evidence and failure scenario:** XML normalizes a newline in an attribute to a space, but `SAFE_DATA_URI` accepts no whitespace in base64. Common 76-column wrapping therefore causes the sanitizer to drop the entire `<image>` while returning `isValid:true`; the unwrapped equivalent is retained.
- **Impact:** A valid upload is stored with content missing while the API reports success.
- **Remediation:** Normalize ASCII whitespace in the base64 payload before validation, or reject the upload with a specific reason. Do not silently remove the image.

### C-030 · Medium · The image target ladder rejects ordinary high-detail images after performing every encode

- **Locations:** `lib/r2/optimize-image.ts:245-249,290-330`.
- **Evidence and failure scenario:** The fixed 200 KiB target with an 800 px/quality 50 floor is unreachable for dense screenshots, dithered art, and noise. Measured 900-2000 px inputs took about 3.3-13.6 seconds across all rungs before 422. The upload budget charges pixels, not ladder work, so these are also the cheapest requests per encoder-second.
- **Impact:** Valid image classes are unsupported and consume disproportionate CPU before refusal.
- **Remediation:** Either accept the best bounded rung when the target is unreachable or lower the floor so the contract is attainable; price the number of encode attempts rather than pixels alone.

### C-031 · Medium · Retention can delete a freshly resent, unexpired OTP

- **Locations:** `db/maintenance.ts:230`; `utils/otp.ts:692`.
- **Evidence and failure scenario:** The sweep deletes an unconsumed verification session based on its original `createdAt`. Resend reuses that session and refreshes `lastSentAt` and code expiry but not `createdAt`. A user returning after one day can receive a new code immediately before the nightly sweep deletes its session and cascades the still-valid code.
- **Impact:** Contact verification/change, passwordless sign-in, recovery, and OTP second-factor users can receive a code that cannot succeed.
- **Remediation:** Base abandonment on current activity and proof expiry, and coordinate candidate deletion with the send transaction so a row cannot become active after selection.

### C-032 · Medium · A successful TOTP remains reusable for a second authentication

- **Locations:** `lib/auth/two-factor.ts:188`; `lib/auth/recovery-second-factor.ts:39-60`; no replay state in `db/schema.ts:455-510`.
- **Evidence and failure scenario:** Both the Better Auth sign-in verifier and local recovery verifier validate the code without atomically reserving the accepted time step. A routed reproduction completed two distinct password challenges with the same code and received 200 twice. The configured ±1 window can keep that observed code acceptable for roughly 90 seconds.
- **Impact:** An attacker with the password and a recently observed code can create another session after the owner has already used the code. This is a bounded but real MFA replay weakness and conflicts with RFC 6238's replay guidance.
- **Remediation:** Persist and atomically advance the last accepted TOTP step per credential across sign-in, enrollment confirmation, and recovery, rejecting any step at or below the stored value while retaining the clock-tolerance window. See [RFC 6238 §5.2](https://www.rfc-editor.org/rfc/rfc6238.html#section-5.2).

### C-033 · Medium · Backup-code acknowledgement can activate a replacement set the user never saved

- **Locations:** `lib/auth/two-factor-enrolment.ts:449,479`.
- **Evidence and failure scenario:** Generation returns codes without a set/version identity, and acknowledgement marks whichever set is current. If tab A saves set A, tab B generates set B, and tab A acknowledges, the server acknowledges B, enables the method, and revokes sessions. The routed reproduction acknowledged version 2 while every saved version-1 code returned 401.
- **Impact:** The user is told recovery is configured but possesses no usable recovery codes; backup-code-only accounts can be stranded.
- **Remediation:** Return a set identifier/version with generated codes and require the same value on acknowledgement under the existing user lock. Reject stale acknowledgements.

### C-034 · Low · `mapResponse` uses Elysia's deprecated response alias

- **Locations:** `app.ts:300-301`; installed `elysia/dist/types.d.ts:547-561`.
- **Evidence and impact:** Elysia 1.4.30 still assigns both `response` and `responseValue`, but its public type marks `response` deprecated. This hook is the single exit that reapplies security headers and timing to native responses; removal would compile-fail, but the file already uses `responseValue` in `onAfterResponse`.
- **Remediation:** Destructure `responseValue` in `mapResponse`. This is a concrete native Elysia improvement with no additional framework coupling because the code is already inside the Elysia adapter. The [Elysia lifecycle documentation](https://elysiajs.com/essential/life-cycle#map-response) uses `responseValue` for this hook.

### C-037 · Low · The SQLite driver retains statement tracking that Bun 1.4 made redundant

- **Locations:** `lib/sqlite/driver.ts:136-188`.
- **Evidence and impact:** The wrapper maintains a live statement set, finalization flags, and a close loop before calling `db.close(true)`. Bun 1.4.2 and its local types confirm that `close(true)` already finalizes cached and prepared statements; focused checks showed both become unusable and later `finalize()` remains safe. The extra lifecycle state now adds maintenance cost without preventing a current leak.
- **Remediation:** Keep explicit per-statement finalization where useful, but delegate connection-wide cleanup to `db.close(true)` and remove the redundant registry/state. This behavior is documented in the [Bun 1.4 release notes](https://bun.com/blog/bun-v1.4).

### C-038 · Low · Operator documentation contains contradictory obsolete routes and body limits

- **Locations:** `docs/framework-migration.md:111-135`; `reports/coolify-deployment.md:820,995,1796`.
- **Evidence and failure scenario:** Migration docs still name removed internal/email routes, an 8 MiB ceiling, and `/api/upload/image`; the application uses a 12 MiB request ceiling and two real upload routes. The deployment runbook's current proxy table specifies 12,582,912 bytes, but a later explanation and final checklist still prescribe 1,114,112 bytes. Following the checklist makes a valid 2 MiB PDF fail at Traefik with 413.
- **Impact:** Operators can deploy a proxy contract narrower than the application and troubleshoot endpoints that do not exist.
- **Remediation:** Replace all stale route names and consolidate the upload limit on 12,582,912 bytes, clearly distinguishing the 10 MiB document limit from multipart overhead and the lower image limit.

### C-039 · Low · `isEmpty`/`isNotEmpty` emit non-sargable SQL and bypass the scan-only gate

- **Locations:** `db/queries/index.ts:22-34`; `lib/data-table/filter-columns.ts:132-159`.
- **Evidence and impact:** Text emptiness is emitted as a `CASE` expression; PostgreSQL used a sequential scan where `column IS NULL OR column = ''` used the btree through `BitmapOr`. No-value operators return before `allowScanOnly` is evaluated, so adding them to the scan-only set would have no effect.
- **Remediation:** Emit the sargable boolean expression and apply the scan-only policy before the no-value early return.

### C-040 · Low · The media `unfiled` search scope cannot use its trigram index

- **Locations:** `db/migrations/002_media_trgm_indexes.sql:4-6`; `lib/media/lifecycle.ts:60-61`; `app/api/dash/media/handler.ts:122-127`.
- **Evidence and impact:** The index predicate requires `folder_id IS NOT NULL`, while the `unfiled` scope requires `folder_id IS NULL`. Once usage sources arm this currently dormant scope, every unfiled search performs a sequential scan plus reference checks.
- **Remediation:** Remove the folder predicate, add an unfiled partial index, or explicitly constrain the unfiled set and document the intentional scan based on measured plans.

### C-041 · Low · Negated date filters omit `NULL` rows

- **Locations:** `lib/data-table/filter-columns.ts:206-227`.
- **Evidence and failure scenario:** Date `ne` emits only `< start OR >= next`, whereas negated text, boolean, number, and array branches also include `IS NULL`. No currently registered date field is nullable, but several nullable timestamps are natural candidates on the same tables. Registering one makes "not on day X" silently hide rows with no date.
- **Impact:** Latent shared-filter correctness defect.
- **Remediation:** Emit `OR isNull(column)` for date `ne` and cover the branch before registering nullable timestamps.

### C-042 · Low · `select` descriptors can omit the value set required for safe enum SQL

- **Locations:** `lib/data-table/column-specs.ts:39-46`; `lib/data-table/filter-columns.ts:63-78`.
- **Evidence and impact:** `values` is optional for `select`/`multiSelect`, so such a descriptor is treated as string-like and any member is accepted. On a PostgreSQL enum, `isEmpty` can compare against `''` and fail with `22P02`. Current select specs all supply values, leaving a latent shared-query 500 and an avoidable type-system hole.
- **Remediation:** Make `FilterColumnSpec` a discriminated union in which closed-set variants require `values`.

### C-043 · Low · The default page size can exceed an explicit maximum

- **Locations:** `lib/data-table/parsers.ts:354`; `db/queries/data-table.ts:87`.
- **Evidence and failure scenario:** Omitted `perPage` always defaults to 10 even when `maxPerPage` is 1 or 5; only a supplied value is clamped/rejected. The shared parser returned `perPage:10, limit:10` for `maxPerPage=1`.
- **Impact:** Bounded but deterministic pagination-contract violation across users, permissions, and media lists.
- **Remediation:** Default to `Math.min(DEFAULT_PER_PAGE, maxPerPage)` and add the absent-parameter/below-default combination to parser tests.

### C-044 · Low · An invalid sort key discards the handler's default sort

- **Locations:** `lib/data-table/parsers.ts:377-384`; `db/queries/data-table.ts:143-145`.
- **Evidence and impact:** The parser supplies the default only before the later allowlist filter. A real table column outside the filter spec, or an unknown ID, leaves only UUID ordering instead of the declared `createdAt` sort. It is masked today because UUID v7 roughly follows creation time, but a different default or key silently changes pagination order.
- **Remediation:** Apply default sorting after allowlist filtering, or give the parser the same permitted column IDs so its fallback is authoritative.

### C-045 · Low · Data-table OpenAPI constraints are manually copied and incomplete

- **Locations:** route parameter documentation in `routes.ts:114-125,238-240,366,507-509`; parser bounds in `lib/data-table/parsers.ts`.
- **Evidence and impact:** Allowed sort/filter IDs are prose copied separately from handler spec maps; limits for sort items, filters, filter values, IDs, values, and per-column operators are unpublished. A generated client can construct a 21-filter request that the schema accepts but runtime rejects, and media coverage does not check drift.
- **Remediation:** Derive IDs/operators from the actual descriptor maps, publish all enforced caps, and add media to the contract checks.

### C-046 · Low · `getColumn` forces unearned type assertions through the shared query layer

- **Locations:** `lib/data-table/filter-columns.ts:424-441`; `db/queries/data-table.ts:125-160`.
- **Evidence and impact:** The helper accepts `keyof T`, widens it to string, structurally probes the result, and double-asserts it as a Drizzle column; every caller adds more assertions. Drizzle exports the runtime/type guard required to prove this shape.
- **Remediation:** Accept a string key and use Drizzle's exported `is(value, Column)` guard, returning the library's column type without assertions.

### C-047 · Low · Business-timezone date-filter behavior has no default-path regression test

- **Locations:** `lib/data-table/filter-columns.ts:111-118` (`dayBounds`); default-zone helpers in `utils/time.ts:90-179`; `tests/unit/time-dst.test.ts`.
- **Evidence and impact:** All 51 time tests pass an explicit zone, while production filters rely on the `BUSINESS_TIMEZONE` default. The current implementation produced correct Minsk boundaries independently of process timezone, but a hard-coded UTC edit would shift every date filter without failing the suite.
- **Remediation:** Exercise every date operator through the default timezone path, including calendar-relative `lte`/`gt` behavior.

### C-048 · Low · JSON routes inherit the multipart-sized 12 MiB body ceiling

- **Locations:** `app.ts:175,246`; `lib/http/request.ts:134-142`.
- **Evidence and failure scenario:** `safeReadJson` buffers and parses the whole request and has no route-specific byte limit; all JSON routes inherit the server ceiling sized for a 10 MiB document plus multipart framing. Authenticated or captcha-holding callers can force repeated 12 MiB `JSON.parse` operations even though schemas permit only kilobytes.
- **Impact:** Rate-bounded event-loop and memory amplification.
- **Remediation:** Add a bounded JSON reader/body policy sized to the largest JSON schema while retaining 12 MiB only for multipart. Elysia's native schema parsing occurs before `beforeHandle`, so switching these handlers to automatic parsing would lose the current body-after-admission ordering; keep the explicit framework-independent reader.

### C-049 · Low · User detail exposes session metadata on a cookie-cached write-tier grant

- **Locations:** `app/api/dash/users/[id]/handler.ts:81-199`; child session route at `app/api/dash/users/[id]/sessions/handler.ts:94-98`.
- **Evidence and failure scenario:** The parent GET checks cached `users.view`, then reads cached `users.edit` to decide whether to return another user's IP address, user agent, and session cursor. The child route checks edit permission live from the database. After edit revocation, the parent can continue returning metadata for five minutes while the child refuses access.
- **Impact:** Bounded extension of stale read access and inconsistent authorization across one resource.
- **Remediation:** Force a database-backed check for the write-tier decision, or make the whole detail GET use `forceDB:true`.

### C-050 · Low · "New password must differ" is skipped when re-authentication uses an existing window

- **Locations:** `app/api/dash/users/me/change-password/handler.ts:59-92`.
- **Evidence and failure scenario:** Plaintext comparison happens only when `currentPassword` is supplied. With an open re-authentication window, a user can submit only the existing password as `newPassword`; the server rehashes it, revokes sessions/proofs, and reports a change that did not occur.
- **Impact:** Incorrect rotation/audit semantics and unnecessary user disruption.
- **Remediation:** Verify `newPassword` against the stored hash on both proof branches and return the existing same-password error.

### C-051 · Low · User creation performs expensive password work before role-scope rejection

- **Locations:** `app/api/dash/users/handler.ts:178-192`.
- **Evidence and impact:** HIBP lookup and Argon2id hashing precede assignable-role and permission-scope checks. An authorized actor without authority for the requested role can cause one outbound request and one 64 MiB hash per rejected call, up to the route limit, amplifying a cheap authorization failure into bounded CPU and outbound work.
- **Remediation:** Perform non-locking role/scope validation before password work and repeat the checks inside the transaction as the authoritative decision.

### C-052 · Low · An unlocked reachability check still locks role-permission rows

- **Locations:** `lib/permissions/utils.ts:492-499`; callers in user detail/session handlers.
- **Evidence and impact:** Callers pass `lock:false`, but `validateRolePermissionScope` always appends `FOR SHARE`. Read-only autocommit paths therefore take row locks and the option does not match its contract.
- **Remediation:** Thread the lock decision into scope validation or derive it from the operation type.

### C-053 · Low · Role-presence guards ignore the fresh role ID returned by the same permission check

- **Locations:** `app/api/dash/users/[id]/handler.ts:104-108,843`; `app/api/dash/users/[id]/sessions/handler.ts:115-116`; `lib/permissions/checker.ts:154-195`.
- **Evidence and impact:** Forced database checks return a current `roleId`, but three guards read the cookie-cached value. The current require-role configuration masks this. If the supported flag is disabled, a newly granted role is refused and a removed role can pass a stale guard.
- **Remediation:** Use the database-backed `roleId` already returned by `requirePermission`.

### C-054 · Low · Permission matrices are asserted total although storage intentionally permits partial matrices

- **Locations:** `app/api/dash/permissions/handler.ts:188`; `app/api/dash/permissions/[id]/handler.ts:256`; `lib/permissions/utils.ts:113`; `db/schema.ts:867`; `utils/validation/rules.ts:145-154`.
- **Evidence and impact:** Normalization creates partial action records, yet the column/readers assert `Record<PermissionAction,boolean>`. Current consumers sanitize before use, masking the type error. The UUID preprocess also falls back to numeric `0` and asserts a narrower Zod pipe.
- **Remediation:** Type stored matrices as `Partial<Record<...>>`, keep normalization at the boundary, return a string invalid sentinel, and remove unearned Zod assertions.

### C-055 · Low · Administrative side effects are not audited at the shared mutation boundaries

- **Locations:** `app/api/dash/users/handler.ts:228-234`; `app/api/dash/users/[id]/handler.ts:683-684,800-805,981-984`; `app/api/dash/permissions/[id]/handler.ts:348-357,484-487`.
- **Evidence and impact:** Admin flows create/delete credential accounts, strip OTP factor intent, revoke sessions, and detach roles without the events emitted by dedicated session, 2FA, or credential routes. Investigators see the initiating user/role event but not consistently the security-relevant side effects.
- **Remediation:** Audit at shared boundaries such as method removal and session revocation, or include explicit effect counts/details in the causing event.

### C-056 · Low · Upload byte gates disagree on normalized versus raw content type

- **Locations:** `lib/media/upload.ts:207-247`; `utils/images/raster-bytes.ts:30-34`; `lib/r2/upload-helper.ts:68`.
- **Evidence and failure scenario:** Type lookup normalizes `Content-Type`, while magic-byte and SVG checks use the raw string. `image/webp; charset=utf-8` bypassed animation detection and `image/svg+xml; charset=utf-8` bypassed SVG sanitization, then happened to be rejected later by another raw-string check. Normalizing that later check would silently open both gaps.
- **Impact:** Security validation depends on accidental disagreement between modules.
- **Remediation:** Normalize once at admission and pass the resolved file-type descriptor to every downstream validator.

### C-057 · Low · Multipart accounting ignores extra buffered parts

- **Locations:** `lib/media/upload.ts:153-168,224,260-281`; `lib/http/request.ts:148-153`.
- **Evidence and failure scenario:** The code enforces one file only for the named field, while `request.formData()` buffers every part and the budget charges only the selected file. A request can include a 1 KiB admitted document plus roughly 11 MiB of other parts and pay one document unit after all data is parsed.
- **Impact:** Authenticated, rate-bounded memory/body-parser amplification and a mismatch with the documented one-file contract.
- **Remediation:** Count all `File` parts, reject extras, and charge/admit based on request or part bytes before buffering; consider a semaphore around form parsing.

### C-058 · Low · Media deletion and visibility routes can outlive their connection ceiling

- **Locations:** `routes.ts:624-643`; `server.ts:135`; `lib/cloudflare/purge.ts:10-12,86-90`; `lib/media/lifecycle.ts:160`.
- **Evidence and failure scenario:** Recursive deletion can purge seven sequential 30-URL batches with two 10-second attempts each, up to 140 seconds, but the route inherits a 60-second ceiling. Large file deletion and visibility changes can similarly approach or exceed the ceiling.
- **Impact:** Clients lose the operation result while destructive work continues server-side.
- **Remediation:** Derive route timeouts from worst-case batch arithmetic, or move purge/cleanup out of the request and return an explicit pending state.

### C-059 · Low · Direct file deletion accepts a `pending` row

- **Locations:** `lib/media/lifecycle.ts:233-243`; sibling active-state guards in `lib/media/files.ts:108-113` and `lib/media/lifecycle.ts:358`.
- **Evidence and impact:** `deleteFiles` rejects `deleting` and visibility transitions but not `pending`. If deletion marks/removes a just-created row while upload later finishes, the object can be written after the row is gone and remains discoverable only by reconciliation.
- **Remediation:** Require `status === 'active'` at the shared deletion-selection boundary.

### C-060 · Low · An unregistered plain file foreign key can lose bytes before PostgreSQL refuses row deletion

- **Locations:** `lib/media/lifecycle.ts:137-180,471-487`; `lib/media/usages.ts:185-194`.
- **Evidence and failure scenario:** Object deletion precedes row deletion. A future project table that references `files(id)` without the required composite usage shape and registration is invisible to `unreferenced`; PostgreSQL blocks only the final row delete after bytes are gone.
- **Impact:** The starter kit can turn an omitted integration registration into irreversible media loss.
- **Remediation:** Validate supported file-reference FK shapes from the catalog at boot/CI, or delete/mark the row transactionally before external cleanup so a failure leaves an orphan object rather than lost bytes.

### C-061 · Low · Rename and move are allowed during a visibility transition

- **Locations:** `lib/media/files.ts:96-117`; `lib/media/visibility.ts:177-202`.
- **Evidence and failure scenario:** File edit locks require active status but ignore `transition`. A rename during publish can leave the copied object's `Content-Disposition` using the old name while the database and newly signed downloads use the new one.
- **Impact:** Bounded metadata inconsistency and violation of the documented in-processing state.
- **Remediation:** Reject edits while `transition` is set.

### C-062 · Low · The document upload budget lacks the image budget's configuration invariant

- **Locations:** `lib/media/upload.ts:104-124`; `lib/rate-limit/index.ts:47-57`.
- **Evidence and impact:** Image maximum cost is asserted against its budget at module load; document maximum cost is not. Raising the document limit above the 60 MiB budget makes maximum-sized valid uploads permanently return 429 because the limiter refuses costs larger than its capacity.
- **Remediation:** Add the equivalent load-time invariant for document size versus document-byte budget.

### C-063 · Low · Anonymous storage health exposes subsystem state without an admission limit

- **Locations:** `routes.ts:688-707`; `app/api/health/storage/handler.ts`.
- **Evidence and impact:** The anonymous response exposes SQLite journal/schema/busy-timeout/synchronous state and PostgreSQL reachability, and each request performs synchronous SQLite pragma reads. The deep writable check is token-protected and the PostgreSQL probe is single-flight, but anonymous probing remains unbounded.
- **Remediation:** Apply a generous IP limit and return only overall status anonymously; keep detailed checks behind the maintenance token.

### C-064 · Low · Keyless S3 bulk-delete errors are counted as successful deletions

- **Locations:** `lib/r2/client.ts:223-228`.
- **Evidence and impact:** The SDK permits an error entry without `Key`. The implementation builds a refused-key set only from keyed errors and labels every other requested key deleted, allowing database finalization to remove rows for objects whose deletion was not confirmed.
- **Remediation:** Treat any keyless error as an unconfirmed failure for the whole chunk.

### C-065 · Low · Cloudflare purge has no deployment-wide spend breaker

- **Locations:** `lib/cloudflare/purge.ts`; breaker precedent in `lib/rate-limit/api.ts:191-201`.
- **Evidence and failure scenario:** Route limits permit hundreds of purge calls per minute through bulk file/folder operations and visibility changes. Exhausting provider quota makes later privacy/deletion operations leave edge copies live or rows pending, with no application-wide admission control.
- **Impact:** Authenticated quota exhaustion can degrade media revocation for all users.
- **Remediation:** Add a shared global limiter charged per outbound purge call, calibrated to the verified Cloudflare plan ceiling.

### C-066 · Low · The S3 client has no request/connection timeout and relies on an implicit retry default

- **Locations:** `lib/r2/client.ts:36-46`; contradictory comment in `lib/media/upload.ts:344-348`.
- **Evidence and impact:** Installed Smithy defaults both connection and request timeout to zero; the SDK happens to default to three attempts although the client never sets it. A hung R2 socket can outlive the route connection and is a prerequisite for the visibility race.
- **Remediation:** Configure an explicit request handler with connection and request deadlines and set `maxAttempts` explicitly.

### C-067 · Low · S3 checksum behavior is an optional convention rather than a client contract

- **Locations:** `lib/r2/client.ts:36-46,132,167-169`.
- **Evidence and impact:** `sha256` is optional and client checksum calculation/validation options are left to transitive SDK defaults. The only current upload caller passes a digest, but the type permits a future caller to silently change wire integrity behavior; SDK calls are fully stubbed in tests.
- **Remediation:** Require the digest in the upload boundary and set request checksum calculation and response validation explicitly.

### C-068 · Low · Turnstile response JSON is asserted rather than validated

- **Locations:** `lib/captcha.ts:54`.
- **Evidence and impact:** Third-party JSON is asserted as `{success?:boolean}`. Malformed shapes currently fail closed by incidental property access/catch behavior, but the code violates the repository's runtime-verification rule for external values and can change behavior during refactoring.
- **Remediation:** Treat the body as `unknown` and explicitly check for a non-null object and boolean `success`; cover malformed JSON shapes.

### C-069 · Low · SMTP silently falls back to plaintext localhost when no host resolves

- **Locations:** `lib/smtp.ts:33-34`.
- **Evidence and impact:** The current Gmail service always resolves a TLS host before this code, making the branch dormant. A future transport configured without `service`/`host` connects to `localhost:587` with opportunistic STARTTLS rather than failing configuration, silently weakening transport expectations.
- **Remediation:** Throw during configuration when neither an explicit nor service-resolved host exists; require TLS for non-implicit-TLS transports.

### C-070 · Low · OTP generation uses only 900,000 of the accepted six-digit values

- **Locations:** `utils/otp.ts:50-52`; `utils/validation/otp.ts:219-225`.
- **Evidence and impact:** Generation starts at 100,000 and never emits leading-zero codes, while validation accepts all six digits. This reduces entropy by 10%; attempt limits keep the practical impact low.
- **Remediation:** Generate `0..999999` and left-pad to six digits.

### C-071 · Low · OTP delivery contains dead boundary checks and an unused SMS option

- **Locations:** `utils/otp.ts:387-395`; `processOtpSend` options.
- **Evidence and impact:** Nodemailer types and implementation always assign `messageId` on success, making the missing-ID branch unreachable, while rejected recipients are not inspected. The `smsMessage` option has no caller. These paths imply guarantees or flexibility the boundary does not provide.
- **Remediation:** Remove dead branches/options or replace them with checks for provider outcomes that can actually occur.

### C-072 · Low · A library verifier branch would allow unbudgeted code guesses if its external fence drifts

- **Locations:** `lib/auth/two-factor.ts:63-87`; current fence in `lib/auth.ts:250-262`.
- **Evidence and impact:** `runPluginVerifier` directly invokes the plugin verifier when a session resolves; in that mode the plugin's attempt budget and sign-in lockout do not run. Another file currently rejects these session-mode paths first, leaving a security invariant split across modules.
- **Remediation:** Make the unsafe session branch fail closed inside `runPluginVerifier`, preserving defense at the boundary that owns verification.

### C-073 · Low · Passkey registration can mint and then immediately delete a session

- **Locations:** `lib/auth.ts:151-161`; `lib/auth/two-factor-enrolment.ts:875-910`; installed passkey plugin registration handler.
- **Evidence and failure scenario:** The documented client can send `createSession:true`. Better Auth creates a session and cookie, then the local enrollment hook revokes all sessions except the pre-request session, deleting the newly created row and leaving the browser with an invalid cookie.
- **Impact:** Successful passkey registration unexpectedly signs the user out.
- **Remediation:** Strip or force `createSession:false` on `/passkey/verify-registration`, as already done for verifier paths.

### C-074 · Low · Passkey registration derives expected origin from the request header

- **Locations:** `lib/auth/two-factor.ts:284-306`; installed passkey plugin; fixed-origin precedent in `lib/auth/passkey-assertion.ts:21,110-121`.
- **Evidence and impact:** The plugin is not given an explicit origin, so registration trusts the request's `Origin` as `expectedOrigin`. Browser RP-ID rules and Better Auth origin middleware currently prevent exploitation, but half of the WebAuthn ceremony depends on an upstream fence while assertion uses `PUBLIC_ORIGIN` directly.
- **Remediation:** Configure the plugin with `origin: PUBLIC_ORIGIN` and `rpID: new URL(PUBLIC_ORIGIN).hostname`.

### C-075 · Low · OTP factor-management requests can ambiguously target one of two contacts

- **Locations:** `utils/validation/two-factor.ts:205-208`; `lib/auth/two-factor-enrolment.ts:576-585,634-644`.
- **Evidence and impact:** `{method:'otp'}` allows omitted `contactKind`, and the handler chooses the first ordered intent, currently email. With email and phone OTP enrolled, disable/default operations can silently affect the wrong possession and do not identify it in the response.
- **Remediation:** Require `contactKind` whenever `method === 'otp'`, or accept the already-published stable option ID.

### C-076 · Low · Credential-rotation proof cleanup depends on call order that most callers violate

- **Locations:** `lib/auth/rotation.ts:51-93`; affected callers in forgot-password, admin-user, and contact-change handlers.
- **Evidence and impact:** `revokePendingProofs` discovers session-keyed verification identifiers by reading live sessions. Five callers revoke sessions first, so the proof sweep cannot find those IDs; orphan proofs expire within 15 minutes and session IDs are not reused, limiting current impact, but the shared function's invariant is not enforced.
- **Remediation:** Derive proof identifiers from the explicit kept/removed session IDs or make one shared rotation function perform both operations in the correct order.

### C-077 · Low · User-update OpenAPI cannot express the caller-identity-dependent body contract

- **Locations:** `lib/http/openapi.ts:122-125,358-361,835`.
- **Evidence and impact:** `PUT /api/dash/users/:id` publishes an undiscriminated `oneOf`; the `{name}` branch is valid only when the path ID is the caller. A generated client can validate `{name}` for another user and then receive a server 422 for missing admin fields.
- **Remediation:** Document the caller-identity discriminator in the operation description and generated client guidance while preserving the runtime schemas.

### C-078 · Low · The 2FA reset route omits its reachable 404 from OpenAPI

- **Locations:** `lib/http/openapi.ts:207-238,2203-2215`; `app/api/dash/users/[id]/two-factor/handler.ts:48,92,123`.
- **Evidence and impact:** The handler can throw not-found, but the route is absent from `NOT_FOUND_ROUTES`, and consistency checks compare only declared tables rather than handler outcomes. Clients cannot model one real result.
- **Remediation:** Add the route and move reachable status declarations closer to handler/route metadata so omissions fail consistency checks.

### C-079 · Low · OpenAPI path collisions silently overwrite table routes with Better Auth routes

- **Locations:** `lib/http/openapi.ts:2491,2577`.
- **Evidence and impact:** Table routes merge into `paths`, while the later Better Auth loop assigns a complete path item. No collision exists today, but adding one would leave runtime serving the static route while the document describes the wildcard-owned operation.
- **Remediation:** Reject path/method collisions during document consistency validation.

### C-080 · Low · Repeated inline OpenAPI schemas materially inflate the document and generated clients

- **Locations:** `lib/http/openapi.ts:1096-1543` (`MEDIA_FILE_SCHEMA` and response-schema reuse).
- **Evidence and impact:** The six largest repeated subschemas occupy about 79 KB of a 320 KB document; the media file schema alone is inlined nine times. Code generators emit duplicate anonymous types and one logical change rewrites many unrelated document locations.
- **Remediation:** Promote stable project schemas into `components.schemas` and reference them with the existing `$ref` machinery.

### C-081 · Low · Published API prose exposes implementation names instead of client contracts

- **Locations:** `lib/http/openapi.ts:2512-2515,2600`; `routes.ts:639,677`.
- **Evidence and impact:** Operation descriptions name `lib/auth.ts`, `routes.ts`, and constant identifiers such as `FOLDER_RECURSIVE_DELETE_MAX`/`UPLOAD_PURPOSES` where clients need behavior and concrete values. The document is authenticated, so this is maintainability/document quality rather than a material information leak.
- **Remediation:** Replace source identifiers with stable behavioral language and emitted values.

### C-082 · Low · The generated OpenAPI version is a frozen literal

- **Locations:** `lib/http/openapi.ts:2594`.
- **Evidence and impact:** Documents with different routes/configured 2FA surfaces all report `0.1.0`, so generators and caches cannot distinguish incompatible revisions.
- **Remediation:** Derive an artifact version from the application version plus document content or commit identity; this does not require URL-level API versioning.

### C-083 · Low · Unchecked schema-object casts can generate an internally impossible media schema

- **Locations:** `lib/http/openapi.ts:1184-1191,1318-1337`.
- **Evidence and impact:** Generic `JsonSchema` objects are asserted to contain typed `properties` and `required`. Refactoring the base media schema could publish a composite whose required keys are absent while `additionalProperties:false` rejects every real response, with no type error.
- **Remediation:** Define shared media properties and required keys once in typed literals and build each schema from that source without casts.

### C-084 · Low · Development bootstrap can generate a role name longer than its column

- **Locations:** `app/api/dev/sign-up/handler.ts:74`; bounds in `utils/validation/constants.ts:37,76`.
- **Evidence and impact:** `system-${email}` can exceed `varchar(100)` because valid emails extend to 150 characters. The development-only bootstrap then fails on the first setup of a project using such an address.
- **Remediation:** Name the role from the new user ID, as normal custom roles do, or apply the role-name bound explicitly.

### C-085 · Low · A redundant role-permission index duplicates the prefix of a unique index

- **Locations:** `db/schema.ts:876-877`.
- **Evidence and impact:** `(role_id)` is a strict prefix of unique `(role_id,page_name)`, and all observed role-keyed reads/conflicts can use the composite index. The extra index adds write and storage cost without a distinct query.
- **Remediation:** Drop `idx_role_permissions_role_id` in a generated migration.

### C-086 · Low · Migration 0007 changed the verification default without repairing existing rows

- **Locations:** `db/drizzle/0005_two_factor_tables.sql:35`; `db/drizzle/0007_real_the_watchers.sql:2`; `db/schema.ts:464`.
- **Evidence and impact:** Rows inserted between the two migrations retain `verified=true` even though 0007 changed the default to prevent unconfirmed credentials being active. Fresh installs are safe because both run in one empty migration sequence; affected developer/staging databases can retain incorrect state.
- **Remediation:** Add an explicit repair migration for unconfirmed legacy rows if such databases remain supported, and require future semantic-default changes to include a data decision.

### C-087 · Low · Migration phases have no advisory lock

- **Locations:** `scripts/migrate.ts:72-92`; installed Drizzle migrator ledger read.
- **Evidence and impact:** Two concurrent processes read the same pending set before either transaction begins; the second waits on DDL and then replays it, fails, and rolls back. The current runbook executes one maintenance shell, but moving migration to a multi-replica entrypoint produces avoidable crash loops.
- **Remediation:** Acquire one fixed PostgreSQL advisory lock for both migration phases and release it in the existing `finally` block.

### C-088 · Low · CI and pre-push never run the existing security configuration matrix

- **Locations:** `package.json:13,33`; `.github/workflows/ci.yml:61,200,215`; `lefthook.yml`.
- **Evidence and impact:** Only `test:all`/`test:matrix` invoke the matrix tier, and neither CI nor pre-push calls it. This is the only tier that boots disabled, TOTP-only, backup-only, passkey-only, OTP-email, and OTP-WhatsApp configurations with module-load settings; a focused matrix test passed across all six, confirming the tier is runnable.
- **Remediation:** Run `bun run test:matrix` in the database-backed CI job. This is Low because no current configuration failure was demonstrated, but the omitted coverage is security-sensitive.

### C-089 · Low · Browser globals are not prohibited in server-only TypeScript

- **Locations:** `tsconfig.json:6`; `eslint.config.mjs:46-51`; server imports involving jsdom.
- **Evidence and impact:** TypeScript includes DOM types, and importing jsdom reintroduces `lib.dom` even when `--lib esnext` is passed. ESLint's `no-undef` is disabled for TypeScript. No browser-global misuse exists today, so both static gates would miss the first one.
- **Remediation:** Add `no-restricted-globals` for browser-only globals across server source; changing `tsconfig.lib` alone is ineffective.

### C-090 · Low · ESLint core rules are never enabled and JavaScript files are outside TypeScript checking

- **Locations:** `eslint.config.mjs:36-44`; `tsconfig.json:8-9,35`; `scripts/require-bun.mjs`.
- **Evidence and impact:** The configuration does not spread `@eslint/js` recommended rules, and `allowJs/checkJs` has no effect because include patterns omit `.js/.mjs`. Root scripts, including the preinstall runtime gate, therefore miss both rule families.
- **Remediation:** Enable `js.configs.recommended` and include checked JavaScript/module files in the TypeScript project.

### C-091 · Low · The non-null assertion gate cannot fail and is not part of any gate group

- **Locations:** `scripts/find-non-null-assertions.ts:61,259-265`; `package.json:19`; `lefthook.yml`.
- **Evidence and impact:** The script exits nonzero only with `--fail`, but no caller supplies it; the ESLint non-null rule is also off. Existing occurrences therefore produce an informational success and CI/pre-push never run it.
- **Remediation:** Enable the ESLint rule and remove the script, or invoke the script with `--fail` from an enforced gate.

### C-092 · Low · The Bun preinstall guard misses npm `.cmd` shims on Windows

- **Locations:** `scripts/require-bun.mjs:211-239,415-417`.
- **Evidence and failure scenario:** Node npm installs `bun.cmd`/`bun.ps1`, while the guard probes `bun`, `bun.exe`, and extensionless paths through `execFileSync`. Node on Windows neither resolves `.cmd` automatically nor executes it without a shell, so `npm install` can report Bun missing and install a second copy whose PATH order decides behavior.
- **Impact:** Development-only runtime duplication and version ambiguity; CI auto-install is disabled.
- **Remediation:** Probe `PATHEXT` and invoke literal `.cmd`/`.ps1` candidates safely, or explicitly detect the npm global shim directory.

### C-093 · Low · The `dedupe` gate's name and failure contract overstate what Bun checks

- **Locations:** `lefthook.yml`; `.github/workflows/ci.yml:69`; `bun.lock`.
- **Evidence and impact:** `bun dedupe --check` reports no duplicates while the lock contains multiple incompatible versions; Bun checks only duplicates that can be collapsed. The command is correct for that narrower purpose, but its message claims any package resolving to multiple versions fails.
- **Remediation:** Rename the gate/message to collapsible duplicates, and add a separate allowlisted single-version policy only if that stronger invariant is intended.

### C-094 · Low · Dependency audit is unscheduled and has no severity/exception policy

- **Locations:** `.github/workflows/ci.yml:3-6,237-249`; `.github/workflows/security.yml:3-8`; `scripts/audit.ts:31`.
- **Evidence and impact:** `bun audit` runs only on push/PR, so advisories against an unchanged lockfile wait for the next code event. No severity floor or documented ignore path exists, allowing one low advisory to block all pushes without a review mechanism.
- **Remediation:** Schedule the audit, set an explicit `--audit-level`, and record reviewed exceptions with repeatable `--ignore` entries and rationale.

### C-095 · Low · Coverage gating accepts stale or wrong-tier reports

- **Locations:** `scripts/check-coverage.ts:48,65-69,123-138`.
- **Evidence and impact:** The gate accepted a five-day-old report from a tier containing files outside the tier its thresholds describe. CI ordering currently produces the right file, but local/reordered runs can pass on unrelated evidence; thresholds are also materially below current measurements.
- **Remediation:** Require report provenance and creation after the current run began, and recalibrate floors to the maintained baseline with an explicit margin.

### C-096 · Low · Pinned Bun runtime and Bun types are on different patch versions

- **Locations:** `package.json:35,63`; `bun.lock`.
- **Evidence and impact:** Runtime is pinned to Bun 1.4.2 while `@types/bun` resolves to 1.4.1, leaving new/fixed 1.4.2 API declarations unavailable and allowing compile-time/runtime drift.
- **Remediation:** Pin Bun types to the runtime patch and update them as one dependency group without manual approval drift.

### C-097 · Low · Workflow cancellation and artifact settings weaken the main-branch signal

- **Locations:** `.github/workflows/ci.yml:11-13,209`; `.github/workflows/security.yml:13-15`.
- **Evidence and impact:** `cancel-in-progress:true` keyed by ref cancels verification of an earlier main-branch commit when another push arrives, and missing JUnit output is only a warning. A reporter failure can therefore leave tests green without their expected evidence.
- **Remediation:** Cancel only pull-request supersessions and make missing test artifacts an error.

### C-098 · Low · ESLint file globs apply inconsistent rule sets

- **Locations:** `eslint.config.mjs:108-141`.
- **Evidence and impact:** Type-aware rules name only three root `.ts` files, leaving `drizzle.config.ts` and future root files without floating-promise checks; Bun builtin exemptions omit `.mjs`; Drizzle rules omit `.mts/.cts`.
- **Remediation:** Define one shared extension/root source set and reuse it across type-aware, import, and Drizzle blocks.

### C-099 · Low · The smoke harness does not faithfully execute or terminate the production command

- **Locations:** `scripts/smoke.ts:29,61,240-241`; `package.json:7`.
- **Evidence and impact:** `SMOKE_PORT` accepts `NaN`, the child runs `bun server.ts` rather than deployed `bun --bun server.ts`, and signals to the smoke process are not forwarded while it awaits the child. The check can certify a different runtime posture or orphan its server on interruption.
- **Remediation:** Validate the port, invoke the exact production command/flags, and forward termination signals while awaiting child exit.

### C-100 · Low · Frozen install succeeds when the lockfile is absent

- **Locations:** `.github/workflows/ci.yml:38,190,244`.
- **Evidence and impact:** On the pinned Bun version, `--frozen-lockfile` installs from `package.json` when no lockfile exists and exits successfully. A checkout or ignore mistake therefore removes the intended supply-chain anchor without failing any of three install jobs.
- **Remediation:** Assert that `bun.lock` exists before every frozen install.

### C-101 · Low · Local dependency changes bypass the repository's release-age policy

- **Locations:** `renovate.json:8`; `bunfig.toml`.
- **Evidence and impact:** Renovate delays newly released packages, but `bun add`/`bun update` have no matching `minimumReleaseAge`. Developers can resolve a release during the very window the repository policy intends to avoid.
- **Remediation:** Configure Bun's install-level `minimumReleaseAge` and explicit excludes so local and automated resolution enforce the same policy.

### C-102 · Low · Better Auth `session.freshAge` is inert configuration

- **Locations:** `lib/auth.ts:682`; installed Better Auth middleware/endpoints.
- **Evidence and impact:** The option is consumed only by freshness middleware on endpoints this deployment does not serve or has rewrapped without that middleware. Actual freshness is enforced by the admin re-authentication window and `authRevokedAt`, so the value suggests a ten-hour control that does nothing.
- **Remediation:** Remove the option or set it to zero with the real freshness policy documented at its authoritative boundary.

### C-103 · Low · Password compromise checking imports an undeclared transitive dependency

- **Locations:** `lib/auth/check-password.ts:4`; `package.json`; dependency gates.
- **Evidence and impact:** The app imports `@better-fetch/fetch` directly but receives it only through Better Auth. Knip's unlisted check does not report it. If Better Auth bundles, renames, or removes that dependency, the module fails to load and every password-setting path breaks.
- **Remediation:** Use the global `fetch` already sufficient for this code, or declare and pin the direct dependency explicitly.

### C-104 · Low · `requireReauthSession` implements only part of the shared live-session eligibility contract

- **Locations:** `lib/auth/request-context.ts:9-17`; complete predicates in `lib/auth/user-eligibility.ts:18` and `lib/auth/live-session.ts:56-57`.
- **Evidence and impact:** The helper checks role presence but not active/deleted state and can use the cookie cache. All three current callers are separately protected by `LIVE_SESSION_PATHS`, but a new caller outside that set would silently admit a suspended user.
- **Remediation:** Delegate to `assertLiveSession` instead of duplicating a partial eligibility check.

### C-105 · Low · An unused transaction option silently disables password-hash upgrades

- **Locations:** `lib/auth/login-guard.ts:76,391`; all `verifyLoginAttempt` callers.
- **Evidence and impact:** No caller supplies `tx`, but the option moves expensive verification into the caller's transaction and suppresses the pepper/hash upgrade with no signal. The first future use would inherit both defects.
- **Remediation:** Remove the unused option and retain one supported transaction boundary.

### C-106 · Low · Passwordless users cannot retrieve their TOTP URI after valid passkey re-authentication

- **Locations:** `lib/auth.ts:187-208`; `lib/auth/reauth-grant.ts:63-76`.
- **Evidence and impact:** The Better Auth body patch creates the synthetic password proof only when a password credential exists, while the app's re-auth grant accepts a valid passkey window. Google/passkey-only users therefore receive `401 REAUTH_REQUIRED` for `get-totp-uri` and are prompted for a password they do not have.
- **Remediation:** Serve URI retrieval from the app-owned enrollment boundary using the shared re-auth grant, or remove the unreachable library route. Do not enable a library option that would waive proof.

### C-107 · Low · Lockout state can confirm a correct password for an otherwise ineligible account

- **Locations:** `lib/auth/login-guard.ts:330-335`; post-password gates in `lib/auth.ts:737-782`.
- **Evidence and failure scenario:** A correct password resets the failure counter before inactive-role/contact gates return the same generic refusal. An attacker can distinguish a correct candidate by whether subsequent attempts encounter lockout, even though the account cannot currently sign in.
- **Impact:** Bounded password oracle for suspended, role-ineligible, or unverified accounts; reuse/reactivation makes the result valuable.
- **Remediation:** Reset the failure counter only after all session-creation eligibility gates succeed, while preserving indistinguishable client responses.

### C-108 · Low · Escaped `<` in a surviving SVG attribute causes a generic false rejection

- **Locations:** `utils/images/svg-optimizer.ts:739-767`.
- **Evidence and impact:** XML serialization and DOMPurify HTML reserialization can turn `&lt;` inside an attribute into raw `<`; the final XML parse then fails. A legal value such as `font-family="a&lt;b"` receives the generic sanitization-failed response.
- **Remediation:** Re-escape XML attribute delimiters before the final parse, or return a precise unsupported-attribute error while preserving fail-closed behavior.

### C-109 · Low · The disabled CFB parser permits FAT-table amplification if legacy formats are re-enabled

- **Locations:** `lib/media/cfb.ts:138-174`; `lib/media/allowlist.ts:117-123`.
- **Evidence and impact:** FAT-sector limits run after building the list, the DIFAT walk has no visited set, and table reads do not deduplicate sectors. A crafted 8.7 KB document produced roughly 3.25 million table entries and about 69 MB RSS growth in the audit reproduction. DOC/XLS are currently disabled, but the allowlist claims re-enabling requires only removing them from a set.
- **Remediation:** Enforce the cap inside the DIFAT loop, detect revisits, and deduplicate before allocation before any legacy type can be enabled.

### C-110 · Low · The PNG-to-RGBA helper turns an encoder-shape change into a 500

- **Locations:** `utils/images/rgba.ts:78-176` (`decodePng` and its blurhash conversion caller).
- **Evidence and impact:** The decoder throws plain `Error` for unsupported bit depth, color type, interlace, filters, or short IDAT. Bun currently emits the one accepted RGBA shape, but a runtime encoder change would make every affected blurhash request return 500, and no unit test pins the required output shape.
- **Remediation:** Convert unsupported media shapes to the API's 422 error contract and add a focused encoder/decoder compatibility test.

### C-111 · Low · The remember-me flag documents the opposite disabled behavior

- **Locations:** `utils/config.ts:104`; `lib/auth/remember-me.ts:20`.
- **Evidence and impact:** Configuration says `HONOUR_REMEMBER_ME=false` forces short sessions, but the shared reader returns `true` unconditionally in that state and selects remembered-session behavior for password, passwordless, Google, and their 2FA continuations. The current value is true, so the defect activates only when an operator follows the documented switch and then issues long-lived sessions instead of short ones.
- **Remediation:** Decide the disabled policy once, align implementation and documentation, and cover all shared sign-in paths with the flag false.

### C-112 · Low · Production comments retain prohibited change history and narration

- **Locations:** Representative examples at `lib/permissions/checker.ts:47`, `lib/permissions/utils.ts:82`, `app.ts:404`, and `lib/sqlite/driver.ts:16`.
- **Evidence and impact:** Comments discuss missing historical exports, superseded MVCC explanations, framework/driver migrations, and dependency-version history rather than current non-local constraints. This conflicts with `AGENTS.md` and can preserve obsolete justification, as the redundant SQLite lifecycle does.
- **Remediation:** Sweep the class: remove history, code narration, and version stories while retaining only external constraints, non-local invariants, and deliberate choices not recoverable from code.

### C-113 · Low · Storage benchmarks no longer reproduce current storage boundaries

- **Locations:** `bench/s3/shared/clients.ts:33`; `bench/s3/live-r2.ts:117`; `bench/s3/production-ops.test.ts:73`; `bench/s3/candidate.test.ts:139`; SQLite benchmark schema/report; current `lib/r2/client.ts` and `lib/rate-limit/store.ts`.
- **Evidence and impact:** S3 benchmark guards expect region `weur` while production uses `auto`, expect three send sites while six exist, and claim a visibility copy has no caller. Two focused source-guard tests fail on those mismatches. The SQLite benchmark still creates a retired `auth_rate_limit` table, labels Node/Next as current production, and uses pre-weighted limiter SQL although the app runs Bun with a different schema.
- **Remediation:** Align benchmark clients, schemas, operation inventories, and runtime claims with current shared boundaries, or label and retire the harnesses as historical before using their results for decisions.

### C-114 · Low · Disabled upload types lose filename extensions on existing downloads

- **Locations:** `lib/media/files.ts:285`; `lib/media/allowlist.ts:166`; `lib/media/visibility.ts:61`.
- **Evidence and failure scenario:** `downloadFilename` uses the enabled-upload allowlist rather than the complete known-type table. A stored DOC/XLS renamed to `report` downloads as `report` after that type is disabled, while an enabled PDF becomes `report.pdf`; signed downloads and visibility-copy headers share the helper.
- **Impact:** Existing content loses file association when admission policy changes.
- **Remediation:** Resolve stored metadata from the complete type registry and reserve the enabled subset for new-upload admission.

### C-115 · Low · Password and OTP benchmarks report concurrency they never achieve

- **Locations:** `bench/password/run.mjs:171,302`; `bench/otp/run.mjs:91`; `bench/password/README.md:187`.
- **Evidence and impact:** Pools stop after `count` operations but label output with requested concurrency even when `concurrency > count`. Recorded rows claim 32-way concurrency from 16 operations; focused probes measured an actual peak of 16. Short soak runs similarly report four despite fewer operations.
- **Remediation:** Require enough work to sustain every requested concurrency, measure/report achieved concurrency, and rerun or relabel affected capacity conclusions.

### C-116 · Low · Email-change OpenAPI instructions branch on fields the start operation never returns

- **Locations:** `lib/http/openapi.ts:1578`; `app/api/dash/users/me/change-email/handler.ts:147,178`.
- **Evidence and impact:** Prose tells clients to branch on `data.verified`, but start returns `{otpSent:true}` or `{autoVerified:true}`; only completion returns `{verified:true}`. A client following the prose never advances to code entry and cannot recognize an auto-verified change/session revocation.
- **Remediation:** Document start using `otpSent`/`autoVerified` and completion using `verified`, preserving existing response contracts.

### C-117 · Low · The SQLite denial benchmark mistakes zero row changes for freedom from writer contention

- **Locations:** `bench/sqlite/FINAL-REPORT.md:162,171`; `bench/sqlite/shared/schema.mjs:83`.
- **Evidence and impact:** The report says a refused UPSERT acts like a non-contending primary-key read. With another connection holding `BEGIN IMMEDIATE`, a plain SELECT succeeded while both benchmark and production denial UPSERTs returned `SQLITE_BUSY`; an INSERT starts a write transaction even when the conflict condition performs no update. The existing test proves zero changed rows, not absence of writer serialization.
- **Remediation:** Correct the benchmark conclusion and add a held-writer refusal case; continue describing the benefit as avoided mutation/WAL growth only.
