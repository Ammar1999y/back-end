# Consolidated final audit

## Findings

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

### C-026 · Medium · Email sign-in preserves an unvalidated client `callbackURL`

- **Locations:** `lib/auth.ts:600-611`; installed Better Auth dispatch and email sign-in route; `lib/http/openapi.ts:500`.
- **Evidence and failure scenario:** The before-hook returns a replacement-looking body, but Better Auth merges it with the original and retains undeclared keys. Its email sign-in route accepts `callbackURL` without the origin check used by sibling redirect endpoints and returns it in `Location`/`url`. A normal login page that forwards an untrusted `?next=` value can therefore create an open post-login redirect.
- **Impact:** Phishing/open-redirect exposure after successful authentication; cross-origin direct injection remains constrained by CSRF/origin controls.
- **Remediation:** Explicitly remove or reject `callbackURL` in the sign-in hook and add a regression case proving undeclared keys do not survive body patching.

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
