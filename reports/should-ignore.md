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
52. **F-8: Acting admin's permissions not re-verified inside `handleAdminEdit`** —
    `app/api/dash/users/[id]/handler.ts` — Cookie-cached actor permissions can
    be stale by ms-scale window relative to a concurrent demotion. A demoted
    admin slipping one extra mutation through within ~ms of revocation is not
    materially different from acting one second before revocation. The fix
    (re-read actor role + permissions under `FOR SHARE` inside every admin
    mutation tx) costs an extra round-trip on every write to close a window
    that opens to an attacker only under a precisely-timed race. Cost > benefit.
53. **H2: HIBP check fails open silently and has no HTTP timeout** —
    `lib/auth/check-password.ts:18-59` — `checkPasswordCompromise` retries the
    HIBP API up to 3 times and falls through silently on exhaustion with no
    `AbortSignal`; during an HIBP outage, compromised passwords are silently
    accepted and admin operations stall 10–30s on user-creation hot path

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
54. **Email Change Without Ownership Verification** —
    `app/api/dash/users/me/change-email/route.ts` — New email is not verified
    via OTP before updating; `emailVerified` stays `true` after change
55. **External OTP Delivery Inside DB Transaction** — `utils/otp.ts:306` —
    `sendOtp()` runs inside `withTransaction`, holding a DB connection and row
    lock during the full external HTTP call; needs benchmarking before splitting
