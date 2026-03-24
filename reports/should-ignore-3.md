### 6.2 🟢 Low | ⚠️ Always — `rolePermissions` Lacks a CHECK on `permissions` JSONB Shape

**Source:** Claude Opus

**Location:** [db/schema.ts:332-353](db/schema.ts#L332-L353)

**Problem:** The `permissions` JSONB column accepts any valid JSON. Malformed
data inserted directly (bypassing the API) could break permission checking which
relies on `=== true` comparisons.

**Fix:**

```sql
CHECK (
  permissions IS NOT NULL
  AND jsonb_typeof(permissions) = 'object'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_each(permissions) AS kv
    WHERE jsonb_typeof(kv.value) <> 'boolean'
  )
)
```

---

### 4.3 🟢 Low | ⚠️ Always — Search Input Silently Truncated at 200 Characters

**Source:** Claude Opus

**Location:** [db/queries/data-table.ts:63-66](db/queries/data-table.ts#L63-L66)

**Problem:** If a search string exceeds 200 characters, it is silently discarded
(empty string = no search). The client receives a full unfiltered result set
with no indication the search was ignored.

**Fix:** Truncate to the limit instead of discarding:

```ts
const search = rawSearch.length > 0 ? rawSearch.slice(0, MAX_SEARCH_LENGTH) : '';
```

---

### 4.1 🟡 Medium | ⚠️ Always — Creating Custom Roles Without Permissions Throws DB Crash

**Source:** Gemini

**Location:** `app/api/dash/users/route.ts:133-134`,
`app/api/dash/users/[id]/route.ts`

**Problem:** If an administrator selects a custom role but passes an empty
`permissions` array, the fallback logic feeds the raw literal string
`__custom__` into `users.roleId`, which expects a valid UUID. This produces a
Postgres `22P02` error and a dirty HTTP 500 instead of a clean 400.

**Fix:** Reject empty arrays for custom role configurations:

```ts
if (isCustomRole && !validatedData.permissions?.length) {
  throw new CustomError(MSG_INVALID_INPUT, HTTP_STATUS.BAD_REQUEST);
}
```

---

### 3.2 🟡 Medium | 📈 At Scale — Permissions GET: User Count Subquery Scans Full Users Table

**Sources:** Gemini (primary), Claude Opus (supporting)

**Location:**
[permissions/route.ts:64-72](app/api/dash/permissions/route.ts#L64-L72)

**Problem:** The user count subquery groups and counts the entire non-deleted
`users` table, then LEFT JOINs against the tiny paginated result.

**Impact:** The existing `idx_users_role_active` partial index covers this with
an index-only scan at moderate scale. Becomes noticeable at 100k+ users.

**Fix (when needed):** Replace the materialized subquery with a correlated
subquery scoped to the paginated rows:

```ts
usersCount: db
  .select({ count: count() })
  .from(users)
  .where(and(eq(users.roleId, roles.id), isNull(users.deletedAt)));
```

---

### 1.3 🟡 Medium | ⚠️ Always — Role Reactivation Bypasses `delete` Permission Gate

**Source:** Claude Opus

**Location:**
[permissions/[id]/route.ts:190-197](app/api/dash/permissions/[id]/route.ts#L190-L197)

**Problem:** Deactivating a role (`isActive: true → false`) correctly requires
`permissions:delete`. However, reactivating a role (`isActive: false → true`)
only requires `permissions:edit`. This creates a permission asymmetry: Admin B
(with `edit` but not `delete`) can reverse a security lockout performed by a
more privileged Admin A.

**Mitigating factor:** `validateRolePermissionScope` still enforces that Admin B
holds all permissions contained in the role. The blast radius is limited to
undoing deactivation, not escalating privileges.

**Fix:**

```ts
if (
  !existingRole.isActive &&
  validatedData.isActive === true &&
  !isSuperAdmin &&
  actorPermissions?.['permissions']?.['delete'] !== true
) {
  throw new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);
}
```

---

### 3.1 🟠 High | 📈 At Scale — `accounts` Table Missing Index on `userId`

**Source:** Gemini

**Location:** `db/schema.ts` (accounts indexes),
`app/api/dash/users/[id]/route.ts:510`

**Problem:** During user deletion, the cascade logic runs:

```ts
tx.delete(accounts).where(eq(accounts.userId, userId));
```

The `accounts` table only has a composite index where `provider_id` is the
leading column: `ux_accounts_provider_user(providerId, userId)`. PostgreSQL
cannot use this index efficiently without the leading column in the `WHERE`.

**Impact:** Sequential table scan on every user deletion. Invisible early, but
causes latency spikes and lock pile-ups at scale (100k+ accounts).

**Fix:** Add a dedicated index:

```ts
index('idx_accounts_user_id').on(t.userId),
```

---

### 7.3 🟢 Low — `ROLE_NAME_MIN = 1` Is Extremely Permissive

**Location:** `utils/validation/constants.ts:22`

**Problem:** A role named `"a"` passes all validation. While not a security
issue, single-character role names would be confusing in the UI.

**Fix:** Raise to `ROLE_NAME_MIN = 2` or `3`.

---

### 6.2 🟢 Low | ⚠️ Always — Dead Code in `resolveUserUniqueViolation`

**Location:** `utils/api-response.ts:92`

**Problem:** The function checks for a `ux_users_phone_number` constraint and
returns `MSG_PHONE_EXISTS`. No `phone_number` column exists in the schema, so
this branch is unreachable.

**Fix:** Remove the condition and the `MSG_PHONE_EXISTS` constant.

---

### 5.3 🟢 Low | 🧪 Early Stage — `chk_size_bytes_positive` Allows Zero-Byte Files

**Location:** `db/schema.ts:266`

**Problem:** The `files` table checks `size_bytes >= 0`. Zero-byte files in R2
typically correspond to broken chunk streams or client disconnections.

**Fix:** Change to `size_bytes > 0` unless zero-byte files are intentionally
used by the system.

---

### 3.4 🟢 Low | ⚠️ Always — `checkMultiplePermissions` Uses Two DB Round-Trips

**Location:** `lib/permissions/checker.ts:192-268`

**Problem:** When `shouldForceDB = true`, `checkMultiplePermissions` executes
two separate queries (one for user data, one for permissions), whereas the
single-check variant `checkUserPermission` achieves the same in one JOIN query.

**Fix:** Mirror the `checkUserPermission` pattern — join `users`, `roles`, and
`rolePermissions` in a single query when `shouldForceDB = true`.

---

### 2.2 🟢 Low | 📈 At Scale — Dynamic Configuration Coupling in Schema Requires Code-DB Sync

**Location:** `db/schema.ts:148`

**Problem:** The `chk_active_user_has_role` check constraint is conditionally
injected based on `REQUIRE_ROLE_FOR_LOGIN`. If this constant changes from `true`
to `false` in application code, the database retains the stale constraint until
a new migration is manually run.

**Impact:** Application deploys may unexpectedly crash when inserting users due
to hidden mismatches between runtime expectations and compiled DB migrations.

**Fix:** Avoid conditionally attaching database schemas to runtime flags.
Register the schema independently or use a separate migration flag strictly for
schema generation.

### 1.3 🟠 High | ⚠️ Always — Email Change Without Verification or Session Invalidation

**Location:** `app/api/dash/users/[id]/route.ts:163-237`

**Problem:** The self-edit path allows changing the email address with no
verification flow and no session invalidation. The only checks are format
validation (Zod) and the database unique index. A user can:

1. Change their email to any valid address they don't own
2. Continue using their existing session (sessions are only invalidated on
   password change)
3. Other active sessions for the same user continue to carry the old email in
   cached session metadata for up to 10 minutes (`cookieCache.maxAge: 600`)

**Impact:** Account squatting — in a system where email is the identity anchor,
allowing email changes without verification is a design risk. If password reset
is added later, the user now owns that email identity. The stale email in other
sessions also creates audit logging risks.

**Fix (layered approach):**

1. **Minimum:** Call `refreshUserSessions` after email change and invalidate
   other sessions:
   ```ts
   if (parsed.data.email !== session?.user.email) {
     await refreshUserSessions(targetId, tx);
   }
   ```
2. **Recommended:** Implement a `pending_email` + `email_verification_token`
   flow. Send a verification email to the new address. Only apply the update to
   `users.email` when the token is verified.
3. **Optional:** Require current password for email changes as an additional
   safeguard.

---

### 7.2 🟢 Low — `standardRoleFilter` Duplicated in Raw SQL

**Location:** `app/api/dash/permissions/[id]/route.ts:337-341`

**Problem:** The DELETE handler uses a raw SQL query that duplicates conditions
from `standardRoleFilter()`. A `SYNC` comment notes this, but if the filter
changes, the raw SQL must be updated manually.

**Fix:** Consider extracting the filter conditions into shared constants if the
filter changes frequently.

---

### 5.1 🟡 Medium | ⚠️ Always — `sessions.metadata` Has No DB-Level Type Constraint

**Location:** `db/schema.ts:179`

**Problem:** The `metadata` JSONB column accepts any valid JSON. The
`SessionMetadata` type is only enforced at the TypeScript level via
`$type<SessionMetadata>()`. If a bug or direct DB access writes malformed
metadata, `sanitizeCachedPermissions` would silently return empty permissions,
effectively locking the user out of all resources until cache expires.

**Fix:** Add a CHECK constraint:

```sql
CHECK (
  metadata IS NULL
  OR (
    jsonb_typeof(metadata) = 'object'
    AND (metadata->>'roleId' IS NULL OR jsonb_typeof(metadata->'roleId') = 'string')
  )
)
```

---

### 3.1 🟡 Medium | 📈 At Scale — `count(*)` Bottleneck in Paginated Endpoints

**Location:** `app/api/dash/users/route.ts:89-93`,
`app/api/dash/permissions/route.ts:65-73`

**Problem:** Two related performance issues in list endpoints:

1. **Users:** The total count query executes `count(*)` with a JOIN.
   PostgreSQL's MVCC means `count(*)` must traverse the entire matching dataset
   — effortless at 5,000 rows, but multi-second latency spikes at 1M+ accounts.

2. **Permissions:** The `userCounts` subquery does `GROUP BY roleId` over all
   non-deleted users, then LEFT JOINs against the paginated roles result. This
   materializes the full partial index on every page load.

**Fix (when needed):**

- **Short-term:** For permissions, use a correlated subquery so only roles in
  the current page are counted:
  ```ts
  usersCount: sql<number>`(
    SELECT COUNT(*) FROM users
    WHERE role_id = ${roles.id} AND deleted_at IS NULL
  )`.mapWith(Number),
  ```
- **Long-term:** For users, consider cursor-based pagination (`hasNextPage` via
  `LIMIT limit + 1`) or estimate totals using `pg_class.reltuples`.

---

### 5.1 🟡 Medium | 🧪 Early Stage — Hardcoded Provider String in Schema Constraint

**Location:** `db/schema.ts:213` **Source:** Gemini

**Problem:** The `chk_credential_password` constraint hardcodes `'credential'`:

```sql
provider_id <> 'credential' OR password IS NOT NULL
```

If Better Auth updates the naming convention (e.g., pivoting to `email-hash`),
the database constraint remains bound to `'credential'`. Valid SSO
authentications could reject logins, or credential registrations could silently
bypass password verification.

**Fix:** Use the constant already defined in the codebase:

```sql
sql`provider_id <> '${CREDENTIAL_PROVIDER_ID}' OR password IS NOT NULL`
```

---

### 4.1 🟠 High | 📈 At Scale — Missing B-Tree Indexes for DataTable Sort Columns

**Location:** `db/schema.ts` (users and roles table definitions) **Source:**
Gemini

**Problem:** The Data Table accepts dynamic sort parameters for columns like
`name`, `email`, and `createdAt`. While `gin_trgm_ops` indexes exist for fuzzy
search, there are no B-Tree indexes for standard sort operations. The sole index
on `roles.createdAt` (`idx_roles_scope_active_created`) has an `isActive`
prefix, making it useless for general pagination sorts.

**Impact:** Once user counts exceed ~100K-1M, paginating requests ordered by
`name` or `createdAt` will exceed `work_mem` and spill to disk-based filesorts.

**Fix:**

```ts
index('idx_users_name').on(t.name),
index('idx_roles_createdAt_base').on(t.createdAt),
```

---

### 2.1 🟠 High | ⚠️ Always — Custom Role Deletion Without Exclusivity Check

**Location:** `app/api/dash/users/[id]/route.ts:376-378` **Source:** Opus

**Problem:** When switching a user from a custom role to a standard role, the
handler unconditionally deletes the old custom role:

```ts
if (isCurrentlyCustom && lockedUser.roleId !== assignedRoleId) {
  await tx.delete(roles).where(eq(roles.id, lockedUser.roleId));
}
```

This assumes a 1:1 mapping between custom roles and users. The schema allows
multiple users to share a custom role (no unique constraint on `role_id`). If a
bug or direct DB manipulation assigns the same custom role to multiple users,
the delete would fail with an FK violation (since
`REQUIRE_ROLE_FOR_LOGIN = true` sets `onDelete: 'restrict'`), but this error is
not caught — it falls through to a generic 500.

**Fix:** Use a guarded delete and handle FK violations:

```ts
if (isCurrentlyCustom && lockedUser.roleId !== assignedRoleId) {
  await tx.execute(sql`
    DELETE FROM roles
    WHERE id = ${lockedUser.roleId}
      AND NOT EXISTS (
        SELECT 1 FROM users
        WHERE role_id = ${lockedUser.roleId}
          AND deleted_at IS NULL
          AND id <> ${userId}
      )
  `);
}
```

---

### 2.4 🟡 Medium | ⚠️ Always — `chk_active_user_has_role` Enforces a Stronger Invariant Than Documented

**Location:** `db/schema.ts:148-155`, `lib/permissions/constants.ts:1-8`
**Source:** Codex

**Problem:** The comment says: when `REQUIRE_ROLE_FOR_LOGIN` is enabled, users
must have an active role to log in. The database CHECK enforces something
broader:

```sql
deleted_at IS NOT NULL OR role_id IS NOT NULL
```

Every non-deleted user must always have a role, even if they are inactive and
unable to log in. This blocks future lifecycle changes like suspending a user
and reclaiming their role, staged offboarding, or backfill scripts that
temporarily clear role assignments.

**Fix:** If the real invariant is "active, non-deleted users must have a role",
encode that directly:

```sql
deleted_at IS NOT NULL OR is_active = false OR role_id IS NOT NULL
```

If the stronger invariant is intentional, rename the constraint and update the
comment to match reality.

---

### 1.2 🟠 High | ⚠️ Always — `users.edit` Can Suspend/Reactivate Accounts Without `users.delete`

**Location:** `app/api/dash/users/[id]/route.ts:360-412` (`handleAdminEdit`)
**Source:** Codex

**Problem:** The non-self update path only requires `users.edit` before calling
`handleAdminEdit()`. Inside that function, there is no additional authorization
gate around `validatedData.isActive`. An admin with only `users.edit` can:

- Forcibly lock out another user by setting `isActive: false`
- Terminate that user's active sessions
- Restore a previously disabled account by setting `isActive: true`

This is the same class of privilege-boundary issue already handled for role
deactivation in `permissions/[id]/route.ts`, but remains open on the user
endpoint.

**Fix:** Require `users.delete` (or a dedicated `users.suspend` permission) for
activation state changes:

```ts
const isDeactivation = lockedUser.isActive && validatedData.isActive === false;
const isReactivation = !lockedUser.isActive && validatedData.isActive === true;

if (
  (isDeactivation || isReactivation) &&
  !isSuperAdmin &&
  actorPermissions?.users?.delete !== true
) {
  throw new CustomError(
    MSG_INSUFFICIENT_PERMISSIONS,
    HTTP_STATUS.FORBIDDEN
  );
}
```

---

### 7.1 🟡 Medium | ⚠️ Always — `REQUIRE_ROLE_FOR_LOGIN` Flag Creates Silent Behavior Divergence

**Location:** `lib/permissions/constants.ts:9`, `db/schema.ts:111-113`,
`app/api/dash/users/route.ts` **Source:** Sonnet

**Problem:** This constant controls four distinct system behaviors:

1. **FK constraint** (`onDelete: 'restrict'` vs `'set null'`)
2. **DB CHECK constraint** (`chk_active_user_has_role`)
3. **Auth session creation** (whether roleless sessions are allowed)
4. **Admin visibility** (INNER JOIN silently excludes roleless users —
   undocumented)

Changing the flag requires a DB migration for points 1–2, but the migration
doesn't address point 4. A developer enabling `false` would deploy successfully
and discover weeks later that some users are invisible in the admin panel.

**Fix:** Create a single checklist comment or ADR listing all four behavioral
changes. Consider extracting the INNER JOIN into a conditional based on the
flag, or switching to `LEFT JOIN` with explicit `roleId` filtering.

### F-04 🟠 High — Migration Builds GIN Indexes Without `CONCURRENTLY`

**Location:**
[db/migrations/001_add_trgm_indexes.sql:5-19](db/migrations/001_add_trgm_indexes.sql#L5-L19)

**Reported by:** Codex (🟠 H-2)

**Problem:** All four `CREATE INDEX` statements in the migration use standard
(blocking) index creation. On hot production tables, this takes an
`ACCESS EXCLUSIVE` lock that blocks all writes during the index build.

**Impact:** High-traffic deploys experience write stalls, elevated latency, or
partial outage during migration windows. GIN indexes on text columns can take
significant time to build on large tables.

**Fix:**

Use `CREATE INDEX CONCURRENTLY` in a non-transactional migration step:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_name_trgm
  ON users USING gin (name gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email_trgm
  ON users USING gin (email gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_roles_role_name_trgm
  ON roles USING gin (role_name gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_roles_description_trgm
  ON roles USING gin (description gin_trgm_ops)
  WHERE description IS NOT NULL;
```

Note: `CONCURRENTLY` cannot run inside a transaction block. Ensure the migration
runner executes this file outside of a transaction wrapper.


### 4.2 🟡 Medium | ⚠️ Always — File Context Tables Enum Is an Empty Scaffold

**Location:** `db/schema.ts:87-92`

**Reported by:** Gemini 🟡

**Problem:** `fileContextTablesEnum` is initialized as `['']`, rendering the
`contextTable` tracking field on uploaded files useless. The system cannot trace
which files belong to which domains, leading to orphan files.

**Fix:** Populate the enum with actual consumer tables (e.g.,
`['users', 'projects', 'sections']`), or convert to a loose `varchar` if context
domains are fully dynamic.

---

### 🟡 Medium | 📈 At Scale — `withTransaction` Creates a New Neon Pool Per Call

### 🟢 Low | 📈 At Scale — Roles Dropdown Has Silent 1000-Row Ceiling