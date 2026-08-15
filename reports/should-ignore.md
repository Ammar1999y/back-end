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

# Known Issues — Will Be Fixed Later

42. **Unauthenticated Upload** — `app/api/upload/image/route.ts` — No auth or
    rate limiting on upload endpoint
43. **Pool-Per-Transaction** — `db/ws.ts` — Creates and destroys a DB connection
    pool on every write call
44. **Swallowed Pool Cleanup Errors** — `db/ws.ts`
45. **No Request Size Limit** — All POST/PUT handlers
46. **No Session, Audit Log, Deleted Users, Temp Files Cleanup** — No cron jobs
    for stale data
47. **No CSRF Protection** — All POST/PUT/DELETE endpoints
48. **Email Provider Allowlist Restrictive** — `utils/validation/rules.ts` —
    Blocks corporate/custom domain emails
49. **No Optimistic Locking on Updates** — All PUT endpoints — Last write wins
    with no conflict detection
50. **Bulk Session Operations Inside Transaction Hold Role Lock** —
    `app/api/dash/permissions/[id]/route.ts` — Blocks concurrent requests at
    scale
51. **Login Lock Counters on Users Table** — `db/schema.ts` — `FOR UPDATE`
    contention; should move to Redis
52. **Session Revocation Gaps After Deactivation** — `lib/auth.ts`,
    `lib/permissions/checker.ts` — Cookie cache stale window + concurrent login
    race
53. **GIN Indexes Built Without `CONCURRENTLY`** —
    `db/migrations/001_add_trgm_indexes.sql` — Blocking on live tables
54. **External OTP Delivery Inside DB Transaction** — `utils/otp.ts:306` —
    `sendOtp()` runs inside `withTransaction`, holding a DB connection and row
    lock during the full external HTTP call; needs benchmarking before splitting
55. **OTP Verify Budget Uses Per-Proof Anchored Windows** — `utils/otp.ts`,
    `db/schema.ts` — the 15-failure budget is the sum of independently anchored
    counters stored on proof rows, not a literal rolling 24-hour window, so two
    full budgets can fall inside one moving 24 hours; and deleting a proof row
    on successful verification or credential rotation forgives its earlier
    failures. Kept for now — see `TODO.md` item 12. Revisit if a strict
    identity-wide any-24-hours guarantee is needed, or if the six-hour block is
    shortened.
56. **Generic `Error.message` Is Retained in Server Logs** — `utils/index.ts`,
    `utils/api-response.ts` — the serializer keeps free-text messages so an
    unexpected library failure stays diagnosable; clients never receive them
    raw, only a fixed generic 500. Every source demonstrated to embed sensitive
    data in a message is filtered where it is thrown — Drizzle bound parameters,
    OTP provider payloads, and both Redis store boundaries — and no
    project-authored error interpolates a credential. The residual risk is a
    future dependency doing the same in text nobody has audited yet. Accepted
    for the development stage with restricted log access and periodic deletion;
    audit each new integration, and settle access and retention before
    production hardening.
