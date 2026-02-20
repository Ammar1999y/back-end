# API Security and Production Readiness Review

Scope:
- `app/api/auth/[...all]/route.ts`
- `app/api/dash/**`
- Supporting code required to evaluate those handlers (`lib/auth.ts`, `lib/permissions/checker.ts`, validation/schema files)

## Executive Summary

This codebase has a solid baseline (schema constraints, explicit permission checks, transactions in several write paths), but there are **production-blocking issues** around privilege escalation, brute-force protection, and concurrency safety.

Top risks to fix first:
1. **Privilege escalation to super admin** in user update flow.
2. **No effective brute-force/rate-limit protection** on sign-in.
3. **Race conditions on role deletion** that can silently null user roles.

---

## 1. Security Vulnerabilities

### 🔴 Critical: Privilege escalation via user role update
**Where**: `app/api/dash/users/[id]/route.ts:195`, `app/api/dash/users/[id]/route.ts:205`

`PUT /api/dash/users/[id]` does not validate the target role before assigning `roleId`. A caller with `users.edit` can assign the `superAdmin` role ID to another user.

What can happen:
- A non-super-admin operator with edit permission can promote any dashboard user to super admin.

Fix:
- In the transaction, resolve the target role and enforce:
  - role exists
  - `roleName !== SUPER_ADMIN_ROLE`
  - `scope === 'standard'` for normal assignments
  - optionally `isActive = true`

```ts
const targetRole = await tx.query.roles.findFirst({
  where: (r, { and, eq, ne }) =>
    and(
      eq(r.id, validatedData.roleId),
      eq(r.scope, 'standard'),
      eq(r.isActive, true),
      ne(r.roleName, SUPER_ADMIN_ROLE)
    ),
  columns: { id: true },
});
if (!targetRole) throw new CustomError('Invalid role selection', 422);
assignedRoleId = targetRole.id;
```

### 🔴 Critical: Brute-force protection is effectively off on auth endpoints
**Where**: `lib/auth.ts:196`, `lib/auth.ts:244`, exposed by `app/api/auth/[...all]/route.ts:4`

`better-auth` rate limiting is disabled, and captcha is configured for `/sign-up/email` only, while allowed login path is `/sign-in/email`.

What can happen:
- Credential stuffing and password guessing at scale.
- Increased account takeover risk and infrastructure abuse.

Fix:
- Enable `rateLimit` in production with persistent storage (Redis/Upstash).
- Add strict custom limits for `/sign-in/email`.
- Add bot challenge and/or progressive delays on sign-in.

### 🟠 High: Authorization trusts cached `roleName` from session metadata for super-admin bypass
**Where**: `lib/permissions/checker.ts:35`, `lib/permissions/checker.ts:40`

Super-admin bypass relies on `session.metadata.roleName`, not authoritative role data. Stale metadata can lead to incorrect authorization decisions after role changes.

What can happen:
- User keeps elevated access longer than intended after role downgrade.

Fix:
- For privileged bypass decisions, use DB-authoritative role lookup (or role versioning with strict invalidation).
- Keep metadata for optimization only, not for privilege elevation checks.

### 🟠 High: Missing strict role validation in create/update user flows
**Where**: `app/api/dash/users/route.ts:91`, `app/api/dash/users/route.ts:137`, `app/api/dash/users/[id]/route.ts:195`

Current checks only block the explicit `superAdmin` name in one path and do not consistently enforce role scope/active state/existence.

What can happen:
- Assigning inactive/system roles.
- Invalid role IDs causing server errors.
- Future role model changes reopening privilege bugs.

Fix:
- Centralize role assignment policy and enforce it identically in POST and PUT.

---

## 2. Race Conditions and Concurrency

### 🟠 High: TOCTOU race when deleting roles
**Where**: `app/api/dash/permissions/[id]/route.ts:225`, `app/api/dash/permissions/[id]/route.ts:241`

Flow is `check users exist -> delete role` without transaction/locking. A concurrent assignment can happen between those queries.

What can happen:
- Role deletion succeeds and `users.role_id` becomes `NULL` (`ON DELETE SET NULL`) for users assigned in the race window.

Fix:
- Make delete conditional and atomic in one transaction.
- Use `DELETE ... WHERE id = ? AND NOT EXISTS (...) RETURNING id`.

### 🟠 High: User delete + custom role cleanup is non-atomic
**Where**: `app/api/dash/users/[id]/route.ts:295`, `app/api/dash/users/[id]/route.ts:299`

User deletion and custom-role cleanup are separate operations outside a transaction.

What can happen:
- Partial failure leaves orphan custom roles.
- Concurrent edits/deletes can produce inconsistent role state.

Fix:
- Wrap read + delete user + delete custom role in one transaction.
- Consider explicit lock on target user row (`FOR UPDATE`) before mutation.

### 🟡 Medium: Concurrent updates can cause lost updates on permissions
**Where**: `app/api/dash/users/[id]/route.ts:172`, `app/api/dash/permissions/[id]/route.ts:148`

Both flows do delete-and-reinsert permission sets without optimistic concurrency.

What can happen:
- Last writer wins silently; one admin may overwrite another's changes.

Fix:
- Add optimistic locking (`updatedAt` precondition/version column) or explicit row locking on role/permission rows during update.

---

## 3. Performance and Efficiency

### 🟠 High: Unbounded list endpoints (no pagination)
**Where**: `app/api/dash/users/route.ts:28`, `app/api/dash/permissions/route.ts:29`, `app/api/dash/roles/route.ts:24`

List endpoints can return all rows.

What can happen:
- Slow queries, large payloads, memory pressure, API timeouts under growth.

Fix:
- Add cursor or offset pagination with max page size cap.

### 🟠 High: New DB pool per write request
**Where**: `app/api/dash/users/route.ts:105`, `app/api/dash/users/[id]/route.ts:147`, `app/api/dash/permissions/route.ts:81`, `app/api/dash/permissions/[id]/route.ts:107`, `db/ws.ts:6`

Creating and closing a fresh `Pool` for each write endpoint causes connection churn.

What can happen:
- Higher latency and possible connection exhaustion under load.

Fix:
- Use a shared/singleton pool-backed DB client for transactional routes.

### 🟡 Medium: Over-fetch + app-side filtering
**Where**: `app/api/dash/users/route.ts:51`

Super admins are filtered in JS after query.

What can happen:
- Unnecessary DB/network/CPU work.

Fix:
- Push filtering into SQL/ORM query (join or subquery filter by role name/scope).

### 🟡 Medium: Likely index gaps for sort/filter patterns
**Where**: query patterns in `app/api/dash/users/route.ts:29`, `app/api/dash/permissions/route.ts:41`; schema in `db/schema.ts`

Common filters/sorts (`roles.scope`, `roles.createdAt`, `users.createdAt` with dashboard list operations) are not clearly indexed.

Fix:
- Add targeted indexes after checking `EXPLAIN ANALYZE` on production-like data.

---

## 4. Data Integrity and Correctness

### 🟠 High: `roleId = "custom"` can pass validation and reach DB layer
**Where**: `utils/validation/auth.ts:30`, `app/api/dash/users/route.ts:114`, `app/api/dash/users/[id]/route.ts:168`

`custom` is a sentinel, but logic only creates custom role when `permissions?.length` is truthy.
If `roleId = custom` and permissions empty/missing, code falls through to assigning a non-UUID `roleId`.

What can happen:
- Runtime DB errors (`invalid input syntax for uuid`) and unreliable behavior.

Fix:
- Add schema-level conditional rule: if `roleId === custom`, `permissions` must be non-empty.

### 🟡 Medium: Role permission clearing behavior is ambiguous
**Where**: `app/api/dash/permissions/[id]/route.ts:141`

If client sends `permissions: []`, the `length` check skips deletion/update, preserving old permissions.

What can happen:
- Silent mismatch between user intent and persisted state.

Fix:
- Distinguish `undefined` (no change) from empty array (explicit clear).

### 🟢 Low: Response timestamps are fabricated, not DB values
**Where**: `app/api/dash/permissions/route.ts:111`, `app/api/dash/permissions/[id]/route.ts:160`

Handlers return `new Date().toISOString()` instead of DB-returned timestamps.

What can happen:
- Client sees inaccurate metadata; harder debugging and caching correctness.

Fix:
- Return values from `RETURNING` clause or re-read updated row.

---

## 5. Error Handling and Response Quality

### 🟡 Medium: Some client-caused DB errors become generic 500
**Where**: `app/api/dash/users/route.ts:192`, `app/api/dash/users/[id]/route.ts:256`, `app/api/dash/permissions/[id]/route.ts:194`

Invalid foreign keys/UUID formats or bad JSON parse are generally mapped to 500.

What can happen:
- Poor API contract and noisy incident signals.

Fix:
- Map expected DB error codes (e.g., FK violation, invalid text representation) to 400/422.

### 🟡 Medium: Post-commit session refresh failure returns error after successful write
**Where**: `app/api/dash/users/[id]/route.ts:227`, `app/api/dash/permissions/[id]/route.ts:165`

Writes commit inside transaction, then session refresh runs outside it. If refresh fails, API may return error even though DB mutation succeeded.

What can happen:
- Client retries and creates duplicate operational load/confusion.

Fix:
- Treat session refresh as best-effort async job, or return success with warning and enqueue retry.

---

## 6. Code Quality and Maintainability

### 🟡 Medium: Repeated policy logic across handlers
**Where**: multiple files under `app/api/dash/`

Role assignment/super-admin protection logic is duplicated and inconsistent (already caused one critical bug).

Fix:
- Extract centralized policy helpers:
  - `resolveAssignableRole(...)`
  - `assertNotSystemRole(...)`
  - `updateRolePermissionsAtomically(...)`

### 🟢 Low: Redundant nested try/catch blocks
**Where**: transactional handlers in `app/api/dash/users/route.ts`, `app/api/dash/users/[id]/route.ts`, `app/api/dash/permissions/route.ts`, `app/api/dash/permissions/[id]/route.ts`

`catch (e) { throw e; }` adds noise without changing control flow.

Fix:
- Keep single `try/finally` around transaction for pool/resource cleanup.

---

## 7. Independent Expert Insights

### 🟠 High: Horizontal scaling risk from cached-permission model
Using session metadata caching for permissions is good for speed, but authorization correctness currently depends on immediate refresh succeeding. In multi-instance production, cache invalidation lag or refresh failure can produce inconsistent authorization across requests.

Recommendation:
- Add role/permission versioning in session metadata and enforce periodic DB revalidation for privileged operations.
- Publish permission-change events to a queue for robust multi-instance invalidation.

### 🟠 High: Missing auditable trail for admin mutations
I did not find endpoint-level audit logging for critical admin actions (user role changes, role permissions updates, deletes), despite an `audit_logs` schema existing.

Recommendation:
- Log actor, target, old/new values, request ID, and IP/user-agent for each admin mutation.

---

## Prioritized Remediation Plan

1. Patch `PUT /api/dash/users/[id]` role assignment checks (block super admin/system/inactive roles).
2. Enable sign-in rate limiting and bot protection now.
3. Make role delete and user delete flows transactional/atomic.
4. Enforce `custom` role input invariants in schema.
5. Add pagination and pool reuse improvements.
6. Add optimistic concurrency for permission updates.
7. Add admin audit logs and stronger permission cache invalidation strategy.

---

## Reviewed Files

- `app/api/auth/[...all]/route.ts`
- `app/api/dash/roles/route.ts`
- `app/api/dash/users/route.ts`
- `app/api/dash/users/[id]/route.ts`
- `app/api/dash/permissions/route.ts`
- `app/api/dash/permissions/[id]/route.ts`
- `lib/auth.ts`
- `lib/permissions/checker.ts`
- `utils/validation/auth.ts`
- `utils/validation/permissions.ts`
- `db/schema.ts`
