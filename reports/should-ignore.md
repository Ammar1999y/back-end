# Not Real Issues / Ignored

1. **`validateAssignableRole` No Lock** — `lib/permissions/utils.ts` — No FOR
   UPDATE lock when validating role assignment
2. **JSONB Permissions No DB-Level Shape Constraint** — `db/schema.ts` — The
   `permissions` JSONB column accepts any valid JSON; direct DB writes can
   insert malformed data
3. **Session Token Stored Plaintext** — `db/schema.ts`
4. **`fileContextTablesEnum` Placeholder** — `db/schema.ts` — Only accepts empty
   string; file context tracking non-functional
5. **Only First Zod Error Returned** — All POST/PUT handlers
6. **Dead Code `auditFields`** — `db/schema.ts`
7. **No API Versioning** — All endpoints at `/api/dash/*` with no version prefix
8. **No Health Check Endpoint**
9. **User GET Exposes Role Permissions Without `permissions:view`**
10. **Multi-Tenant Boundary Not Present** — Conditional, depends on future
    requirements
11. **Dont add any new checks for user email & password in the schema**
12. **No API Path to Clear All Permissions From a Role** — By design; frontend
    sends all permissions as `false`
13. **Permissions UPDATE Has No Path to Remove All Permissions**
14. **Login Lock Check Uses Case-Sensitive Email Comparison** —
    `lib/auth/login-guard.ts`
15. **roleName Uniqueness Is Case-Sensitive**
16. **TOCTOU: Permission Scope Validation Outside Transaction (POST Handlers)**
    — Low probability; no real harm
17. **Missing DB-Level Minimum Length Constraints on Text Columns**
18. **Search Input Silently Truncated at 200 Characters** —
    `db/queries/data-table.ts` — Search over 200 chars is discarded instead of
    truncated
19. **Creating Custom Roles Without Permissions Throws DB Crash** —
    `app/api/dash/users/route.ts` — Empty permissions array causes HTTP 500
20. **User Count Subquery Scans Full Users Table** —
    `app/api/dash/permissions/route.ts` — Slow at 100k+ users
21. **Role Reactivation Bypasses `delete` Permission Gate** —
    `app/api/dash/permissions/[id]/route.ts`
22. **`ROLE_NAME_MIN = 1` Is Extremely Permissive** —
    `utils/validation/constants.ts`
23. **Dead Code in `resolveUserUniqueViolation`** — `utils/api-response.ts` —
    Checks for nonexistent `ux_users_phone_number` constraint
24. **`chk_size_bytes_positive` Allows Zero-Byte Files** — `db/schema.ts`
25. **`checkMultiplePermissions` Uses Two DB Round-Trips** —
    `lib/permissions/checker.ts`
26. **Dynamic Configuration Coupling in Schema** — `db/schema.ts` —
    `chk_active_user_has_role` tied to runtime flag
27. **`standardRoleFilter` Duplicated in Raw SQL** —
    `app/api/dash/permissions/[id]/route.ts`
28. **`sessions.metadata` Has No DB-Level Type Constraint** — `db/schema.ts`
29. **`count(*)` Bottleneck in Paginated Endpoints** — At scale only
30. **Hardcoded Provider String in Schema Constraint** — `db/schema.ts` — Uses
    `'credential'` instead of `CREDENTIAL_PROVIDER_ID`
31. **Custom Role Deletion Without Exclusivity Check** —
    `app/api/dash/users/[id]/route.ts`
32. **`chk_active_user_has_role` Enforces Stronger Invariant Than Documented** —
    `db/schema.ts`
33. **`users.edit` Can Suspend/Reactivate Accounts Without `users.delete`** —
    `app/api/dash/users/[id]/route.ts`
34. **`REQUIRE_ROLE_FOR_LOGIN` Flag Creates Silent Behavior Divergence** —
    Controls 4 behaviors with no documentation
35. **GIN Indexes Built Without `CONCURRENTLY`** —
    `db/migrations/001_add_trgm_indexes.sql`
36. **Roles Dropdown Has Silent 1000-Row Ceiling**
37. **Missing Table Partitioning on `sessions` and `audit_logs`**
38. **Audit Logs Missing `created_at` Index**
39. **Read Endpoints Skip Scope Checks** — `app/api/dash/users/route.ts`,
    `app/api/dash/permissions/route.ts` — GET endpoints skip scope validation
40. **`handleAdminEdit` Inner Join Hides Roleless Users** — Not a real issue;
    roleless users are not dashboard users
41. **Schema Does Not Enforce Custom Role Ownership** — Not a real issue; custom
    roles are inherently per-user
42. **Final Administrator Lockout** — `app/api/dash/users/[id]/route.ts` —
    Dashboard owner has `system` role with full access; system role cannot be
    deleted
43. **OFFSET Pagination Bottleneck** — `app/api/dash/users/route.ts`,
    `app/api/dash/permissions/route.ts` — Acceptable at current scale
44. **Double `validateRolePermissionScope` Call** —
    `app/api/dash/users/[id]/route.ts` — Two round-trips per admin edit;
    unnecessary optimization complexity
45. **Synchronous Password Hashing Blocks Event Loop** —
    `app/api/dash/users/route.ts`, `app/api/dash/users/[id]/route.ts` — Not a
    bottleneck at current scale
46. **`pageName` PostgreSQL Enum Blocks Schema Evolution** — `db/schema.ts` —
    Acceptable trade-off for current page set
47. **GDPR Email in Audit Logs** — `app/api/dash/users/[id]/route.ts` — Email in
    `audit_logs.old_data` needed for investigation; not applicable yet
48. **FK Violation Handler Falls Through to 500** —
    `app/api/dash/users/route.ts`, `app/api/dash/users/[id]/route.ts` — 500 is
    correct; unexpected FK violations are code bugs that should be prioritized
    in monitoring
49. **Destructive Soft-Delete Prevents Recovery** —
    `app/api/dash/users/[id]/route.ts` — Email preserved in
    `audit_logs.old_data`; practical emails < 100 chars; `accounts` hard-delete
    is a security feature
50. **Session Revocation UUID Validation Gate** —
    `app/api/dash/users/[id]/route.ts` — Session ID type is fixed throughout the
    app; `validID` maintained to support current and future formats
51. **Self-Edit Password Change Skips Session Revocation** —
    `app/api/dash/users/[id]/route.ts` — Same reasoning as #70; `validID` always
    matches session ID format
52. **H2: HIBP check fails open silently and has no HTTP timeout** —
    `lib/auth/check-password.ts:18-59` — `checkPasswordCompromise` retries the
    HIBP API up to 3 times and falls through silently on exhaustion with no
    `AbortSignal`; during an HIBP outage, compromised passwords are silently
    accepted and admin operations stall 10–30s on user-creation hot path
53. **Better Auth `password.verify: () => true` Stub** — `lib/auth.ts:26-47` —
    Built-in verify is stubbed; the before-hook runs the real
    `verifyLoginAttempt` and only 3 paths are allowlisted (`/get-session`,
    `/sign-out`, `/sign-in/email`) — all others 404. Safe today; latent bypass
    only if a future password-bearing path is added to `ALLOWED_PATHS` without
    wiring verification. Mitigate later with a regression test.
54. **TOCTOU Between Re-auth Verify Tx and Mutation Tx** —
    `app/api/dash/users/me/change-password/handler.ts`,
    `app/api/dash/users/me/change-email/handler.ts` — `verifyLoginAttempt` runs
    in its own short tx before the mutation tx, so two concurrent
    self-credential changes can both pass verify (last-write-wins). Acknowledged
    by in-code TODO; self-contention on one's own credential is rare.
55. **`audit_logs` Missing `user_id` Index** — `db/schema.ts` — "All actions by
    user X" forensic query full-scans the table; slow only at 1M+ rows.
56. **Phone-number CHECK Regex Hardcodes Saudi Format** — `db/schema.ts` —
    `chk_phone_number_format` enforces `^9665[0-9]{8}$`; future international /
    non-mobile support would require a migration. Acceptable for current local
    launch (does not contradict #11, which is about email/password checks).
57. **User-delete ↔ Role-delete Opposite Lock Order** —
    `app/api/dash/users/[id]/handler.ts`,
    `app/api/dash/permissions/[id]/handler.ts` — user→role vs role→users lock
    acquisition can deadlock under concurrent destructive admin actions;
    PostgreSQL aborts one transaction (no corruption). Intermittent only.
58. **OTP Send Collapses 429 to Generic 200 (by design)** —
    `app/api/auth/otp/send/handler.ts` — masking `TOO_MANY_REQUESTS` is a
    deliberate privacy contract: the endpoint returns an identical
    `200 + nextAllowedIn:30` for every case (real / fake / verified / throttled)
    so timing and status leak nothing. Enforced by the test "per-identifier hour
    limit never leaks 429 to client (collapsed to 200)". The client already gets
    a constant `nextAllowedIn` for its countdown. Surfacing 429 would break this
    contract — not worth the UX gain.
59. **Explicit Empty Filter Array Treated As "No Filter"** —
    `lib/data-table/filter-columns.ts` — chosen UI semantics, not a SQL
    identity: `col IN ()` matches nothing, so this is a deliberate reading of an
    empty selection as "chip not filled in yet" rather than "match nothing". The
    literal reading shows an empty table for a chip the user has not used, and a
    422 turns it into an error. Not the dropped-predicate case the strict filter
    contract exists for — there a real condition vanished; here none was
    expressed, and the caller's base authorization predicate is untouched either
    way.
60. **Filter `variant` Not Bound To The Column Descriptor** —
    `lib/data-table/column-specs.ts` — `variant` describes how the client
    renders a control; it is validated for membership then never read, so it
    reaches no SQL. Binding it would make the server an authority on UI
    rendering, and a boolean column rendered as a multiSelect is legitimate.
61. **`OTP_AUTO_VERIFY` Enabled With No Environment Guard** — `utils/config.ts`
    — documented development bypass while no OTP provider is configured;
    flipping it is covered by the pre-production `TODO` sweep. Never reaches
    `passwordless_login` / `forgot_password` (both always issue a real code), so
    the blast radius is contact-verification and the authenticated
    contact-change commits.
62. **Session Pagination Has No Matching Index** — `db/schema.ts`,
    `app/api/dash/users/[id]/sessions/pagination.ts` — the `(createdAt, id)`
    keyset cursor is correct; only the index shape is questioned. More than 50
    live sessions per user is unrealistic for an admin dashboard, and a
    session-purge cron is already planned. Add `(user_id, created_at, id)` only
    if a real query plan justifies it.
63. **Trusted IP Header Is Not Yet Pinned To The Deployment** — `lib/audit.ts`,
    `lib/rate-limit/api.ts`, `lib/auth.ts` — `TRUSTED_IP_HEADERS` accepts both
    `cf-connecting-ip` and `x-vercel-forwarded-for`, which has two consequences:
    on a Vercel-only deployment a client-supplied Cloudflare header wins unless
    the edge strips it, and when neither header is present `ipIdentifier` throws
    503 — so local dev, a bare VPS, Docker and `next start` return 503 on every
    sign-in, since the sign-in hook calls it. The fail-closed 503 is intended
    and diagnosable (it keeps its own status and message, and the missing
    headers are logged). Both follow from one unmade decision, and both are
    settled by the same step: pick exactly ONE header for the target deployment
    and enforce the matching ingress boundary. Already flagged by the `TODO`
    above every such site; belongs on the pre-production checklist.
64. **Custom IPv6 `/64` Bucketing in `ipBucket`** —
    `lib/rate-limit/api.ts:35-63` — manual `::` expansion; verified correct for
    all valid inputs and `getClientIp` blocks malformed ones upstream. The only
    proposed remedy adds the `ip-address` dependency — supply-chain/maintenance
    risk with no real defect fixed. Leave as-is.

65. **`ipIdentifier`'s Failure Log Emits Present, IP-Bearing Headers** —
    `lib/rate-limit/api.ts` — When `cf-connecting-ip` is absent or fails
    `IP_SCHEMA`, the failure log includes the VALUES of `x-forwarded-for`,
    `host` and `user-agent`, which in exactly that case is the header most
    likely to carry the real client address. The one-line alternative is to log
    the header NAMES that were absent instead of their values. Not applied: the
    logs are internal, the branch is unreachable in production
    (`cf-connecting-ip` is always injected by the edge), and the diagnostic
    value of seeing what the proxy actually sent is worth more here than the
    theoretical exposure. Revisit if logs ever leave the host — the same trigger
    as #8.

66. **OPTIONS Requests Produce No Access-Log Line** — `app.ts` — Both OPTIONS
    answers short-circuit in an `onRequest` hook before `onAfterResponse`, so
    preflight volume and OPTIONS-based path scanning are invisible in the log.
    An observability gap, not a correctness defect: nothing is mis-handled, and
    the scanning it would reveal is already bounded by the per-IP admission gate
    and, for path-prefix tricks, by the hostname floor in `app.ts`. Adding a log
    call to a hook that runs before every request — including every preflight —
    to record requests that carry no application semantics is not a trade worth
    making at this size.

67. **Benchmark Dependencies (`uuid`, `sharp`) Removed from Root Manifest** —
    `bench/uuid/`, `bench/image/`, `knip.jsonc` — Benchmark-only comparison
    packages were removed to avoid root dependency bloat. Key decision
    measurements are already recorded; if benchmarks need to be re-run,
    dependencies can be installed on-demand and removed.

# Known Issues — Will Be Fixed Later

1. **Race Condition: Stale Login / OTP Proof Can Issue Session After Credential Rotation**
   - **Locations:** `lib/auth.ts`, `lib/auth/passwordless.ts`, `app/api/auth/forgot-password/reset/handler.ts`, `utils/otp.ts`
   - **Summary:** Proof validation (password / OTP) and session insertion do not share an atomic validity check (`authVersion`). If credentials are rotated concurrently, a pre-verified proof can still create an active session or execute a password reset immediately after existing sessions were revoked. Planned fix introduces an incremental `authVersion` check across rotation boundaries.

2. **No Explicit Database `statement_timeout` Configured**
   - **Locations:** `db/index.ts` / connection settings
   - **Summary:** PostgreSQL connections do not enforce a runtime `statement_timeout`. Runaway or unindexed queries under heavy load could hold pooled connections indefinitely. Deferred until p99 production query durations are measured to set an appropriate ceiling.

3. **No Optimistic Locking on Concurrent Entity Updates**
   - **Locations:** All admin update endpoints (`PUT /api/dash/*`)
   - **Summary:** Entity updates lack version/timestamp checks (`updatedAt`). If two administrators concurrently modify the same user or role, the last write silently overwrites the previous write without conflict detection.

4. **Bulk Session Invalidation Inside Transaction Holds Role Lock**
   - **Locations:** `app/api/dash/permissions/[id]/route.ts`, `lib/permissions/utils.ts`
   - **Summary:** Role deactivation and permission metadata updates run bulk session deletions/updates inside the main transaction while holding an exclusive `FOR UPDATE` lock on the role row. At scale, this increases lock contention; planned mitigation moves bulk session operations post-commit or adopts timestamp-based staleness checks.

5. **Stale Cookie Cache Extends Read Access Post-Deactivation**
   - **Locations:** `lib/auth.ts`, `lib/permissions/checker.ts`
   - **Summary:** Better Auth caches session cookies for up to 5 minutes (`maxAge: 300`). While write/mutation paths strictly verify live database sessions (`assertLiveSession`), read-only endpoints evaluate against the cookie cache, allowing deactivated users up to 5 minutes of read access until cache expiration.

6. **Missing Out-of-Band Security Alert on Credential Rotation**
   - **Locations:** `app/api/dash/users/me/change-password/handler.ts`, `app/api/dash/users/me/change-email/handler.ts`
   - **Summary:** Changing passwords or primary email addresses does not send an out-of-band security notice to the previous email address. In a session hijack scenario, the legitimate owner is not alerted when credentials change.

7. **Audit Logs Stored Exclusively in Primary Application Database**
   - **Locations:** `lib/audit.ts`, `db/schema.ts`
   - **Summary:** Audit logs reside solely in the application PostgreSQL database under the same database role with no secondary append-only sink (e.g. S3 Object Lock, CloudWatch). An attacker with direct database access could tamper with logs without an off-host immutable audit record. Planned asynchronous export via scheduled maintenance tasks.

8. **Third-Party `Error.message` Retained Verbatim in Internal Server Logs**
   - **Locations:** `utils/index.ts` (`serializeErrorLike`), `utils/api-response.ts`
   - **Summary:** The log serializer strips sensitive fields from structured objects but keeps raw `error.message` text from third-party libraries (e.g., S3 SDK, fetch calls). While logs are strictly internal and known libraries do not leak secrets in messages, unmapped future errors could theoretically expose un-sanitized context.

9. **Soft-Deleted Users Accumulate Without Automated Cleanup**
   - **Locations:** `db/schema.ts`
   - **Summary:** Soft-deleted user records (`deletedAt IS NOT NULL`) are retained indefinitely in the database without an automated maintenance cron job to archive or purge them after a defined retention window.

10. **Email Validation Provider Allowlist Restricts Custom Domains**
    - **Locations:** `utils/validation/rules.ts`
    - **Summary:** The validation schema enforces an allowlist of consumer email domains (e.g. Gmail, Outlook), blocking business and custom domain email addresses until domain policy requirements are finalized for general launch.

11. **Audit Logs Missing Dedicated Forensic Query Indexes**
    - **Locations:** `db/schema.ts`
    - **Summary:** The `audit_logs` table currently lacks composite indexes for specialized forensic queries (e.g., filtering all historical actions by a specific user across time ranges), to be added when log volume warrants optimization.

12. **Daily OTP Spend Breaker Allows 2x the Budget Across a Window Boundary**
    - **Locations:** `lib/rate-limit/api.ts` (`enforceOtpGlobalSendBudget`), `lib/rate-limit/index.ts`
    - **Summary:** `OTP_GLOBAL_SEND_CAP_PER_DAY` uses a FIXED 24h window anchored on UTC midnight (`windowStart = now - (now % windowMs)`), so 2000 charges at `23:59:59.999Z` and 2000 more at `00:00:00.000Z` dispatch 4000 paid messages inside one second and leave the whole of day two at zero. A cap that can be doubled in a burst is not a strict daily cap. Deferred: the fix is a sliding window, which is a change to the shared limiter primitive rather than to this one budget. See `TODO.md`.

13. **The Global OTP Budget Is Charged From Inside the PostgreSQL Transaction**
    - **Locations:** `utils/otp.ts` (`processOtpSend`), `lib/rate-limit/api.ts`
    - **Summary:** `enforceOtpGlobalSendBudget` is the last statement inside `withTransaction`, so a synchronous `bun:sqlite` write happens while holding a `FOR UPDATE` row lock, an advisory lock and one of `MAX_POOL_CONNECTIONS` (10). Under SQLite writer contention that statement was measured blocking for 2 282 ms. It is the one limiter call in the codebase made while holding PostgreSQL locks, and the comment directly below it explains why `sendOtp` was moved OUT of the transaction for exactly this reason. Secondarily, the charge is not atomic with the commit: a successful charge followed by a failed COMMIT permanently burns one unit of the daily budget with nothing sent, and there is deliberately no refund primitive. Deferred: moving it out needs a decision about what happens between the charge and the commit, which is the same problem the absent refund primitive describes. See `TODO.md`.

14. **`@knipignore` Masks Dead Exports and Unused Helpers**
    - **Locations:** `app.ts`, `lib/data-table/config.ts`, `utils/validation/rules.ts`, `utils/index.ts`, `knip.jsonc`
    - **Summary:** `@knipignore` tags mask several unused exports and dormant helpers. Dead export cleanup and knip suppression pruning will be handled upon project completion.
