# Production Security & Code Review — `app/api/dash/*` + `app/api/auth/*`

Reviewer: Senior Backend / Security / DB Architect
Scope: `app/api/dash/**`, `app/api/auth/**`, `db/schema.ts`,
`db/migrations/001_add_trgm_indexes.sql`, and the supporting libraries they
depend on (`lib/auth/**`, `lib/permissions/**`, `lib/rate-limit/**`,
`lib/http/**`, `lib/captcha.ts`, `lib/audit.ts`, `utils/otp.ts`, `db/ws.ts`).

All issues already listed in [`reports/should-ignore.md`](should-ignore.md) were
filtered out of this report.

---

## TL;DR

The codebase is unusually well-architected for its stage. Login, permission
checks, and OTP flows already use atomic transactions with row-level locking,
timing-equalized failure paths, Redis-backed rate limiting, captcha gating, and
a strong fail-closed session-creation hook. The permission model correctly
distinguishes cache-path reads from DB-forced writes and enforces delegation
scope on grants.

The remaining gaps are focused and real — the highest-impact ones are:

1. 🔴 **`POST /api/dash/users` creates credentials without `checkPasswordCompromise`** — the rest of the system consistently calls it; this one handler is the only write path that skips it.
2. 🟠 **System-role users are 404'd from their own profile endpoint** — dashboard owner can log in but cannot fetch `GET /api/dash/users/:ownId`.
3. 🟠 **`verifyLoginAttempt` runs inside the outer transaction for `change-password` / `change-email`** — argon2 verification (~150–400ms) happens while holding `FOR UPDATE` on the user row, blocking the user's other sessions/logins.
4. 🟠 **Admin email change does not invalidate target user's sessions or session-cookie cache** — only role/active-flag/password changes trigger session refresh or deletion; an email swap by an admin leaves the victim signed in with stale identity metadata for up to 5 min (cookie cache) + 28 days (session TTL).
5. 🟠 **`refreshUserSessions` / `refreshRoleSessions` happen inside the write transaction** — raw SQL update against all matching session rows runs while the role row is still locked, which holds locks longer than necessary on large user sets.

Everything else below is context / smaller items.

---

## 1. Security Vulnerabilities

### 🔴 1.1 — `POST /api/dash/users` skips `checkPasswordCompromise` ⚠️ Always

**File:** [app/api/dash/users/handler.ts:166](app/api/dash/users/handler.ts#L166)

```ts
const hashedPassword = await hashPassword(validatedData.password);
```

Every *other* credential write path in the app runs the HIBP k-anonymity check
first:

- [app/api/dash/users/[id]/handler.ts:301](app/api/dash/users/%5Bid%5D/handler.ts#L301) — admin password update
- [app/api/dash/users/me/change-password/handler.ts:62](app/api/dash/users/me/change-password/handler.ts#L62) — self password change
- The Better Auth `haveIBeenPwned` plugin — covers `/sign-in/email` only (no sign-up route is exposed)

**What could happen if ignored:** An admin can onboard a user with a password
that is already in a known breach corpus (e.g. `P@ssw0rd123`, `admin2024`,
etc.). That account is then a pre-compromised foothold. Consistency matters:
if the product policy is "no compromised passwords anywhere," this one handler
silently violates it.

**Fix:**

```ts
// app/api/dash/users/handler.ts — POST
await checkPasswordCompromise(validatedData.password);
const hashedPassword = await hashPassword(validatedData.password);
```

Do it *before* hashing so you don't pay the argon2 cost on a password you'll
reject.

---

### 🟠 1.2 — Self-`GET` on a `system`-scoped user returns 404 ⚠️ Always

**File:** [app/api/dash/users/[id]/handler.ts:141-145](app/api/dash/users/%5Bid%5D/handler.ts#L141-L145)

```ts
if (isProtectedSystemRole(userData.role))
  throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

if (!userData.roleId)
  throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
```

These checks fire *after* the `isSelf` short-circuit, which means a dashboard
owner whose role scope is `system` (per [app/api/dev/sign-up/handler.ts](app/api/dev/sign-up/handler.ts)
— this is the only path that creates system users, and it's exactly how the
first owner is created) cannot call `GET /api/dash/users/:ownId` on themselves.
They can log in, but the profile page powering "view my profile" will 404.

**What could happen if ignored:** Hidden usability/security bug — a real admin
gets an unexplained 404 on their own page, which is confusing and leads to
workarounds (e.g. disabling the guard, which is worse). The guard was clearly
written to stop *other* admins from exposing system users' details; it should
exempt the self-view.

**Fix:**

```ts
if (!isSelf && isProtectedSystemRole(userData.role))
  throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
```

The same logic applies to the role-name leak: when self-viewing, return their
own role details. When not self and the target is system-scoped, 404.

---

### 🟠 1.3 — Admin email change leaves victim sessions valid 📈 At Scale / ⚠️ Always for trust

**File:** [app/api/dash/users/[id]/handler.ts:403-500](app/api/dash/users/%5Bid%5D/handler.ts#L403-L500)

`handleAdminEdit` computes:

```ts
const shouldDeleteAllSessions =
  !!password || (lockedUser.isActive && validatedData.isActive === false);
const shouldRefreshSessions =
  !shouldDeleteAllSessions && (roleChanged || customPermsChanged);
```

Neither branch fires on a pure email change. So an admin can change a user's
email without:

- Deleting the target user's active sessions (they keep browsing).
- Refreshing session metadata (Better Auth cookie cache keeps the old email for
  up to 5 minutes; the DB session still holds stale `user.email` via
  Better Auth's internal cache).

The code does set `emailVerified: false` (line 411), but that flag isn't
enforced anywhere else in the session path — the session hook
([lib/auth.ts:186-195](lib/auth.ts#L186-L195)) only checks `isActive`, not
`emailVerified`.

Compare with the self change-email flow, which is much stricter:
[app/api/dash/users/me/change-email/handler.ts:118-146](app/api/dash/users/me/change-email/handler.ts#L118-L146)
— it deletes all *other* sessions, clears `verificationSessions`, and forces
`disableCookieCache: true`.

**What could happen if ignored:** If admin tooling is used to recover or steal
an account by swapping the email field, the victim's live sessions continue
serving their data under the new email on the next auth refresh. Worse, the
admin who performed the swap now has a user whose `emailVerified=false` but
whose sessions still identify them as the old account. Real-world risk:
account takeover by an insider, delayed detection.

**Fix:** Treat an email change as significant identity mutation:

```ts
const shouldDeleteAllSessions =
  !!password
  || (lockedUser.isActive && validatedData.isActive === false)
  || emailChanged;
```

Or, if you want to preserve the admin's ability to fix a typo without logging
everyone out, gate it: if the new email differs in more than casing/domain,
force session deletion.

---

### 🟡 1.4 — Captcha only gates `/sign-in/email` 🧪 Early Stage → ⚠️ Always later

**File:** [lib/auth.ts:276](lib/auth.ts#L276)

```ts
captcha({
  provider: 'cloudflare-turnstile',
  ...
  endpoints: ['/sign-in/email'], // TODO: add the proper endpoints
}),
```

OTP send is captcha-gated manually in the handler
([app/api/auth/otp/send/handler.ts:41](app/api/auth/otp/send/handler.ts#L41)),
which is good. But OTP *verify* is not captcha-gated — only rate-limited to 10
attempts/IP/min. Between the per-session 3-attempt brute-force cap and the
rate limit, this is acceptable early on, but a shared-NAT attacker (e.g. a
corporate/cellular exit node) can attempt codes for any number of user emails
they know by rotating the target.

**What could happen if ignored:** Mass-enumeration of OTP codes against known
email lists is tractable for 6-digit codes given the 10-min TTL, especially
under shared-egress conditions.

**Fix:** Add captcha to `/auth/otp/verify` once the user-facing flow ships.

---

### 🟡 1.5 — Audit log `oldData`/`newData` unbounded size 🧪 Early Stage → 📈 At Scale

**Files:** [lib/audit.ts](lib/audit.ts), all `PUT`/`DELETE` handlers.

`auditLog` stores full row snapshots as JSONB with no size cap. Today the
tables are narrow, so snapshots are small. Two concerns surface later:

1. If anyone ever adds a large jsonb column (e.g. full permission snapshots
   already sometimes serialized into `oldData.permissions` — see
   [app/api/dash/permissions/[id]/handler.ts:257-278](app/api/dash/permissions/%5Bid%5D/handler.ts#L257-L278)),
   the audit row can reach several KB. With thousands of edits, audit_logs
   dwarfs the data it audits.
2. There is no schema-level limit on `oldData`/`newData` jsonb size; a bug in
   `stripSensitive` (or a future caller that bypasses it) can easily write
   multi-MB payloads.

**Fix:** Add a size sanity check at the boundary. Something like:

```ts
// lib/audit.ts
const MAX_AUDIT_JSON_BYTES = 32_768;

function clampJson(value: unknown): unknown {
  if (value == null) return value;
  const serialized = JSON.stringify(value);
  if (serialized.length <= MAX_AUDIT_JSON_BYTES) return value;
  return { _truncated: true, preview: serialized.slice(0, 1024) };
}
```

Apply to `oldData`, `newData`, `changedFields` before the insert.

---

### 🟡 1.6 — No global security response headers 🧪 Early Stage

No Next.js `middleware.ts` or `next.config.js headers()` entry sets CSP,
`X-Content-Type-Options`, `X-Frame-Options` / frame-ancestors, `Referrer-Policy`,
or `Strict-Transport-Security`. The APIs return JSON so many headers are
best-effort for defence-in-depth, but HSTS + `X-Content-Type-Options: nosniff`
+ a minimal CSP for `/api/*` (so errors don't render as HTML) are cheap wins.

**Fix:** Add to `next.config.js`:

```js
async headers() {
  return [{
    source: '/:path*',
    headers: [
      { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-Frame-Options', value: 'DENY' },
    ],
  }];
}
```

---

### 🟢 1.7 — `/api/dev/sign-up` guarded by a single `NODE_ENV` check 🧪 Early Stage

**File:** [app/api/dev/sign-up/handler.ts](app/api/dev/sign-up/handler.ts)

The endpoint creates a `scope: 'system'` role with every permission and binds
it to a new user. The only guard is `if (process.env.NODE_ENV !== 'development')`.

A single misconfiguration in a Vercel preview or a forgotten environment flag
turns this into "remote root via POST." Defence-in-depth here is cheap: add a
second flag.

**Fix:**

```ts
if (
  process.env.NODE_ENV !== 'development'
  || process.env.ENABLE_DEV_ENDPOINTS !== 'true'
) {
  return apiError({ message: MSG_PAGE_NOT_FOUND, status: HTTP_STATUS.NOT_FOUND });
}
```

Also prefer `404` over `403` so the path doesn't advertise itself to scanners.

---

## 2. Race Conditions & Concurrency

### 🟠 2.1 — `verifyLoginAttempt` inside the outer transaction (change-email / change-password) 📈 At Scale

**Files:**
- [app/api/dash/users/me/change-email/handler.ts:59-74](app/api/dash/users/me/change-email/handler.ts#L59-L74)
- [app/api/dash/users/me/change-password/handler.ts:67-82](app/api/dash/users/me/change-password/handler.ts#L67-L82)

```ts
await withTransaction(async (tx) => {
  await verifyLoginAttempt({
    userId,
    password: parsed.data.currentPassword,
    skipTimingGuard: true,
    tx,
  });
  // ... 100+ lines of row selection, updates, session deletes, audit ...
});
```

`verifyLoginAttempt` acquires `FOR UPDATE` on the user row and then runs argon2
verification. Argon2 with sane parameters is 100–400ms. That entire time, the
user row is locked *and* this outer transaction is still open, blocking:

- Any other login attempt for the same user
- Any concurrent `PUT /dash/users/:sameUserId` (admin edits)
- Any failed-login increment

**What could happen if ignored:** Low concurrency hides this, but the moment
a user has two browser tabs auto-retrying an expired session plus a password
change in a third, you get lock-timeout errors or serial response times
measured in seconds. At scale, a wave of "change my password" operations
(e.g. after a breach disclosure) thrashes the pool.

**Fix:** Move the credential check out of the outer transaction. Verification
needs its own short-lived transaction for the lock/increment semantics; the
*mutation* transaction doesn't need to include it.

```ts
// Outside the withTransaction block:
try {
  await verifyLoginAttempt({
    userId,
    password: parsed.data.currentPassword,
    skipTimingGuard: true,
  });
} catch (e) {
  if (e instanceof LoginRejected)
    throw new CustomError(userMsg.currentPasswordIncorrect, HTTP_STATUS.BAD_REQUEST);
  throw e;
}

await withTransaction(async (tx) => {
  // ... the actual email/password update
});
```

Yes, there's a theoretical window where the password changes between
verification and the update transaction. Practical impact: zero — the password
is the user's own, they are the only ones racing themselves. If you are
paranoid, re-lock the accounts row in the outer transaction and bail if the
password hash changed since verification.

---

### 🟠 2.2 — `refreshUserSessions` / `refreshRoleSessions` run inside the mutation transaction 📈 At Scale

**Files:**
- [app/api/dash/users/[id]/handler.ts:493](app/api/dash/users/%5Bid%5D/handler.ts#L493) — `refreshUserSessions`
- [app/api/dash/permissions/[id]/handler.ts:306](app/api/dash/permissions/%5Bid%5D/handler.ts#L306) — `refreshRoleSessions`
- [lib/permissions/utils.ts](lib/permissions/utils.ts) — the raw `UPDATE sessions … WHERE user_id IN (SELECT id FROM users WHERE role_id = :id)` implementation

Changing a standard role's name or permissions locks the `roles` row with
`FOR UPDATE`, then inside the same transaction issues an `UPDATE sessions`
statement that can touch thousands of rows depending on how many users share
that role.

**What could happen if ignored:** With 10k+ users on a single role,
`UPDATE sessions SET metadata = … || …::jsonb WHERE user_id IN (...)` can run
hundreds of milliseconds while holding the role lock plus write locks on every
affected session row. Other sessions for those users (e.g. new logins)
block-wait. This is acknowledged partially for the delete path in
[should-ignore.md](should-ignore.md) #50 but the *refresh* path isn't called
out there and has the same shape.

**Fix (phased):**
1. Short-term: ensure the trigram index `idx_sessions_user_expires` covers the
   `WHERE expires_at > NOW()` filter (it does — see
   [db/schema.ts:203](db/schema.ts#L203)) and batch the update with
   `LIMIT + RETURNING` loop if the user set is large.
2. Medium-term: move session-metadata refresh out of the critical path. Write
   a `role_version` bump on the role, have the session read path compute
   permissions lazily when `session.metadata.role_version < roles.version`.

---

### 🟠 2.3 — User `DELETE`: role lookup reads without a lock after user is locked 🧪 Early Stage

**File:** [app/api/dash/users/[id]/handler.ts:583-598](app/api/dash/users/%5Bid%5D/handler.ts#L583-L598)

```ts
const [lockedUser] = await tx.select({...}).from(users)
  .where(...).for('update');
// ...
const [userRole] = await tx.select({ roleName, scope }).from(roles)
  .where(and(eq(roles.id, lockedUser.roleId), nonSystemRoleFilter()));
//             ^^^^ no FOR SHARE / FOR UPDATE
```

Between the two queries, another transaction can edit the role (e.g. flip it
to `system` scope, or rename it) and commit. The DELETE then proceeds with
outdated `userRole.roleName`/`userRole.scope`, which is what ends up in the
audit log and what gates the `scope === CUSTOM_ROLE_VALUE` role-deletion
branch.

**What could happen if ignored:** In the worst case (extremely unlikely given
current admin workflows) you could delete a custom role that just got
converted, or fail to delete one that just became custom. The realistic impact
is a stale audit entry. Still worth a two-line fix.

**Fix:** Add `.for('share')` to the role lookup, or join it into the first
query.

```ts
const [lockedUser] = await tx
  .select({
    userId: users.id,
    userEmail: users.email,
    roleId: users.roleId,
    roleName: roles.roleName,
    roleScope: roles.scope,
  })
  .from(users)
  .innerJoin(roles, eq(users.roleId, roles.id))
  .where(and(eq(users.id, userId), isNull(users.deletedAt), nonSystemRoleFilter()))
  .for('update', { of: users })
  .for('share', { of: roles });
```

---

### 🟡 2.4 — `permissions/[id] PUT`: session deletion subquery not locked 📈 At Scale

**File:** [app/api/dash/permissions/[id]/handler.ts:280-289](app/api/dash/permissions/%5Bid%5D/handler.ts#L280-L289)

```ts
if (existingRole.isActive && validatedData.isActive === false) {
  await tx.delete(sessions).where(
    inArray(sessions.userId,
      tx.select({ id: users.id }).from(users)
        .where(and(eq(users.roleId, roleId), isNull(users.deletedAt)))
    )
  );
}
```

The inner `SELECT id FROM users WHERE role_id = :roleId AND deleted_at IS NULL`
runs without a lock. A concurrent reassignment (`PUT /users/:id` changing
`roleId`) can commit between subquery and delete, leaking sessions belonging
to users who *just* moved off this role.

The role itself is locked with `FOR UPDATE` earlier in the same transaction
([line 176](app/api/dash/permissions/%5Bid%5D/handler.ts#L176)), but *users*
aren't; and admin edits only lock the user they are editing.

**What could happen if ignored:** When deactivating a role, a couple of users
whose role was reassigned in-flight keep active sessions — low severity
(they'll still be re-validated at next request via the session hook if their
new role is also inactive), but documenting a bounded anomaly.

**Fix:** Either (a) accept the anomaly and document it (session revalidation
catches it), or (b) use `FOR UPDATE SKIP LOCKED` on the user subquery, or
(c) target sessions via a CTE that also locks the user rows.

---

## 3. Performance & Efficiency

### 🟠 3.1 — User-list `innerJoin(roles)` + `nonSystemRoleFilter()` prevents `idx_users_role_active` from being used optimally 📈 At Scale

**File:** [app/api/dash/users/handler.ts:77-110](app/api/dash/users/handler.ts#L77-L110)

The filter is `isNull(users.deletedAt) AND nonSystemRoleFilter()` where
`nonSystemRoleFilter = ne(roles.scope, 'system')`. Because the predicate is on
`roles.scope`, not `users.role_id`, PostgreSQL must join and then filter,
which means the partial index `idx_users_role_active (role_id) WHERE deleted_at IS NULL`
mostly helps only when combined with a sort.

At 100k+ users this still works because roles has a scope index, but under
load you'll want to materialize a view like "dashboard-visible users" or add
a `users.is_dashboard_user boolean` maintained by the role-change flow, and
index that directly.

**Fix (deferred, at scale):** Denormalize `scope` onto `users` during role
assignment, or create a filtered index on `users(role_id)` that excludes
users whose current role is system — but that requires a cross-table index,
which Postgres doesn't support natively. Most tractable: add a column.

---

### 🟠 3.2 — `GET /users/[id]` runs user + sessions in sequence 🧪 Early Stage

**File:** [app/api/dash/users/[id]/handler.ts:108-186](app/api/dash/users/%5Bid%5D/handler.ts#L108-L186)

The user query and the sessions query are awaited sequentially even though
they are independent. They can run under a single `Promise.all` when
`canViewSessions` is true.

**Fix:** Trivial.

```ts
const [userData, sessionRows] = await Promise.all([
  userQueryPromise,
  canViewSessionsSync ? sessionsQueryPromise : Promise.resolve(undefined),
]);
```

The `canViewSessions` check currently depends on `isSelf || actorViewPermissions.edit`,
both of which are known before the user query. Hoist that check up, then
parallelize.

---

### 🟡 3.3 — `checkMultiplePermissions` is fine, but `requirePermission` → cache-refresh path double-queries 📈 At Scale

**File:** [lib/permissions/checker.ts](lib/permissions/checker.ts), consumed by every write handler.

On a write request that has `throwError: false`, the handler first calls
`requirePermission(... action:'edit' ...)` which correctly goes to DB (writes
force DB), then *also* calls things like `validateRolePermissionScope` which
re-queries `rolePermissions`. Two round-trips per admin edit is fine today;
collapsing into one selected-columns query that returns both the actor's
permissions and the target role's permissions would save a round-trip per
write.

---

### 🟢 3.4 — `roles` "active + standard" dropdown keeps `LIMIT 1000` 🧪 Early Stage

**File:** [app/api/dash/roles/handler.ts:37](app/api/dash/roles/handler.ts#L37)

Already tracked in [should-ignore.md](should-ignore.md) #36 — noting that
once you breach 1k standard roles you'll need server-side search with
typeahead, not a LIMIT bump.

---

## 4. Data Integrity & Correctness

### 🟠 4.1 — `emailVerified` flipped to `false` on admin edit, but Better Auth cookie cache serves the old session metadata for up to 5 minutes ⚠️ Always

Covered in §1.3. Consequence is behavioral — the `emailVerified` flag reset is
not actually enforced anywhere on the session path (only `isActive` and
`role.isActive` are checked in [lib/auth.ts:186-195](lib/auth.ts#L186-L195)),
so it's currently cosmetic. Either enforce it (block session creation when
`emailVerified` is `false` and policy requires verification) or drop the field
from the update path to avoid the misleading guarantee.

---

### 🟡 4.2 — `handleAdminEdit` accepts empty `validatedData.permissions` for custom role transitions → creates degenerate roles 🧪 Early Stage

**File:** [app/api/dash/users/[id]/handler.ts:367-401](app/api/dash/users/%5Bid%5D/handler.ts#L367-L401)

The branch

```ts
if (isCustomRole && validatedData.permissions?.length) { ... }
else { assignedRoleId = validatedData.roleId as EntityID; }
```

falls through to `else` when `isCustomRole` is true but `permissions` is
empty. At that point `assignedRoleId = "custom"` (the sentinel literal), which
will then be passed to `db.update(users).set({ roleId: assignedRoleId })` —
that's a FK-invalid UUID string. The schema's
`createUserSchema.superRefine(validateCustomRolePermissions)` likely rejects
this on POST; the same refinement exists for `updateUserSchema` — confirm
that. If not, you'll get an FK violation at runtime rather than a graceful
422. Add an explicit guard near the branching for belt-and-suspenders.

---

### 🟡 4.3 — Soft-deleted user's email rewrite truncates by byte count silently 🧪 Early Stage

**File:** [app/api/dash/users/[id]/handler.ts:608-613](app/api/dash/users/%5Bid%5D/handler.ts#L608-L613)

```ts
const DELETED_SUFFIX_LEN = 46;
email: sql`LEFT(email, ${EMAIL_MAX - DELETED_SUFFIX_LEN}) || '_del_' || gen_random_uuid()`,
```

`LEFT(str, n)` in Postgres is *character*-based, not byte-based, which is what
you want. But the resulting email may no longer be a valid email *format*
(which the schema doesn't enforce except `email = LOWER(email)` —
[db/schema.ts:155](db/schema.ts#L155)). That's fine today because the email
column is just a unique index key at that point; but any downstream job that
tries to "re-notify deleted users" or that validates email format on read
will break. Worth a short comment on the sql.

---

## 5. Database Schema & Constraints

### 🟠 5.1 — No CHECK that `emailVerified` implies a working credential 🧪 Early Stage

**File:** [db/schema.ts:120](db/schema.ts#L120)

`emailVerified boolean default(false) notNull` has no relationship to
`accounts.password`. It's entirely possible (and easy with admin edits) to
have `emailVerified=true` with a user that has no credential account. Not
broken today, but worth enforcing via a trigger or a combined CHECK if
verification becomes a security gate.

---

### 🟠 5.2 — `verificationSessions.channel` is `varchar(10)` + CHECK, but not a pg enum 🧪 Early Stage

**File:** [db/schema.ts:395](db/schema.ts#L395)

Given `pageName` and `bucketType` are both proper `pgEnum`s, the inconsistency
is mild tech debt. The CHECK-based approach is fine for now because adding
channels is rare. Flag only if a future change adds `'push'` or `'whatsapp'`
and you need zero-downtime enum evolution.

---

### 🟡 5.3 — `files.contextTable` is a pg enum with only `''` as value ⚠️ Dead scaffolding

Already covered in [should-ignore.md](should-ignore.md) #4. Noting here that
the follow-up is schema-level: when you add the first real context value,
remove the `''` sentinel and make the column `NOT NULL` — otherwise you'll
carry the empty-string placeholder forever.

---

### 🟡 5.4 — `auditLogs` has no `created_at` index and the `(table_name, record_id)` index can't answer "recent activity" queries 📈 At Scale

[should-ignore.md](should-ignore.md) #38 covers the missing `created_at`
index. The bigger design point: any realistic admin UI will ask "show me
recent audit entries filtered by tableName or user", which becomes
`ORDER BY created_at DESC LIMIT 50 WHERE table_name = ?`. That's a
composite index on `(table_name, created_at DESC)`. Add it before the table
grows past a few million rows.

---

### 🟢 5.5 — `sessions.userAgent` is `varchar(2000)` — generous but unbounded history adds up 📈 At Scale

Noted only. Consider `varchar(512)` + truncation on insert; most user agents
are under 300 chars, and the only ones breaching that are either malformed
or telemetry-laden.

---

## 6. Error Handling & Response Quality

### 🟡 6.1 — `resolveUserUniqueViolation` checks a constraint name that exists, but handler fallback to generic error masks unknown unique violations 🧪 Early Stage

**File:** [utils/api-response.ts](utils/api-response.ts), used by
[app/api/dash/users/handler.ts:230-234](app/api/dash/users/handler.ts#L230-L234)

If a future unique constraint is added (say a `ux_users_phone_verified_active`
partial index) and its name isn't wired into `resolveUserUniqueViolation`,
the handler returns a generic 409 with a misleading "email exists" message.
Add a default branch that logs the unknown constraint name (so you notice)
before returning a generic message.

---

### 🟡 6.2 — `isForeignKeyViolation(error)` handler only inspects `role_id`

**Files:** [app/api/dash/users/handler.ts:235-241](app/api/dash/users/handler.ts#L235-L241), [app/api/dash/users/[id]/handler.ts:548-554](app/api/dash/users/%5Bid%5D/handler.ts#L548-L554)

Other FK edges (accounts → users, sessions → users, verification_sessions →
users, rolePermissions → roles) fall through to the generic 500 path. This is
fine because those violations are code bugs, not user input — but flag them
at the observability layer ([should-ignore.md](should-ignore.md) #48 notes
this intentionally). One recommendation: in the 500 path, emit a
`console.error({ pg_code: 'FK_VIOLATION', constraint: getConstraintName(err) })`
so the monitoring layer can alert.

---

## 7. Code Quality & Maintainability

### 🟡 7.1 — Business logic in handler files is ~300–500 lines

**File:** [app/api/dash/users/[id]/handler.ts](app/api/dash/users/%5Bid%5D/handler.ts) is the worst offender at ~650 lines.

Split `handleSelfEdit`, `handleAdminEdit`, and the custom-role reconciliation
into `lib/users/edit.ts`. The handler should orchestrate: parse → authorize →
dispatch → respond.

### 🟢 7.2 — The `validID` + `validID(session!.user.id)` double-call pattern

Search the codebase for `validID(session!.user.id)` — it's called 2–3 times in
several handlers. Extract to `currentUserId` once at the top of each handler.

### 🟢 7.3 — `comparablePermissionsJSON` and `normalizeFullPermissions` both exist — consolidate

**File:** [app/api/dash/permissions/[id]/handler.ts:50-63](app/api/dash/permissions/%5Bid%5D/handler.ts#L50-L63)

Two near-identical serialization helpers. Move one into
`lib/permissions/utils.ts` and use it from both places.

---

## 8. Production Readiness & Expert Insights

### 🟠 8.1 — Session-creation hook trusts `REQUIRE_ROLE_FOR_LOGIN` but doesn't verify `emailVerified` ⚠️ Always

Cross-cuts §1.3 and §4.1. If the product ever needs "email must be verified to
log in," the current hook doesn't enforce it. Build the `emailVerified`
assertion into [lib/auth.ts:186-195](lib/auth.ts#L186-L195) *before* shipping
any email-gated feature (password reset, account recovery, billing email).

### 🟠 8.2 — Audit log is the only tamper-evident record, and it's in the same DB

The audit log table is in the same Postgres as the data it audits. An attacker
with DB access can erase their trail. For a dashboard of this scale, consider
streaming audit entries to an external append-only store (CloudWatch Logs,
BigQuery, an S3-with-Object-Lock bucket) as a backstop. Not urgent, but flag
it as a production-maturity item.

### 🟠 8.3 — No OpenAPI / JSON schema for the public contract

The `/dash/*` endpoints are consumed by a private frontend today. The moment
you expose them to partners, service meshes, or SDK generators, you need a
stable contract. Generating one from the existing Zod schemas is a weekend
task; deferring it until "we need it" usually costs a week.

### 🟡 8.4 — `refreshUserSessions` / `refreshRoleSessions` is the load-bearing
mechanism that keeps session metadata coherent

Covered in §2.2. Worth calling out architecturally: the whole auth-cache
scheme hinges on these two functions fanning out writes correctly. Add unit
tests that verify:

- `refreshUserSessions(userId, tx)` touches only rows with
  `expires_at > NOW()` and the right userId.
- Metadata merge is a JSONB overlay, not replace (so unrelated keys survive).
- Concurrent role rename + user role change result in a consistent final
  state (property test).

---

## 9. What Was Checked and Found Good

Non-exhaustive list of things that were examined and passed muster (so you
know they were not overlooked):

- **Login brute force** — Atomic `FOR UPDATE` + argon2 + exponential lockout
  in [lib/auth/login-guard.ts](lib/auth/login-guard.ts). Timing-equalized
  failure path via `DUMMY_HASH`.
- **OTP send/verify concurrency** — Advisory lock + row-level lock + atomic
  upsert + invalidation of prior codes on resend
  ([utils/otp.ts](utils/otp.ts)).
- **Permission check** — Dual path (cache for reads, DB for writes), single-
  query join in the write path
  ([lib/permissions/checker.ts](lib/permissions/checker.ts)).
- **Delegation scope on permission grants** — `validatePermissionScope`,
  `validateRolePermissionScope` enforce "you cannot grant what you don't
  have." ([lib/permissions/utils.ts](lib/permissions/utils.ts)).
- **Data-table query parsing** — Column whitelisting, search length clamp,
  pagination ceiling ([db/queries/data-table.ts](db/queries/data-table.ts)).
- **Audit log hygiene** — Sensitive-field redaction, IP header validation,
  transactional writes ([lib/audit.ts](lib/audit.ts)).
- **Rate limiting** — Upstash Redis backend with per-endpoint overrides,
  fail-open on infrastructure errors (intentional and correct for auth rate
  limits).
- **Session creation hook** — Fail-closed on inactive users/roles and missing
  roles when `REQUIRE_ROLE_FOR_LOGIN`.
- **Better Auth path whitelist** — `ALLOWED_PATHS` in
  [lib/auth.ts:29](lib/auth.ts#L29) blocks sign-up, password-reset, and other
  Better Auth built-ins from being publicly exposed, which neatly closes a
  whole class of "I didn't know that was open" bugs.

---

## 10. Prioritized Punch List

| # | Severity | Scale | Item | Where |
|---|---|---|---|---|
| 1 | 🔴 | ⚠️ Always | Add `checkPasswordCompromise` to `POST /dash/users` | [app/api/dash/users/handler.ts:166](app/api/dash/users/handler.ts#L166) |
| 2 | 🟠 | ⚠️ Always | Exempt `isSelf` from `isProtectedSystemRole` 404 | [app/api/dash/users/[id]/handler.ts:141](app/api/dash/users/%5Bid%5D/handler.ts#L141) |
| 3 | 🟠 | ⚠️ Always | Treat admin email change as session-invalidating | [app/api/dash/users/[id]/handler.ts:441-445](app/api/dash/users/%5Bid%5D/handler.ts#L441-L445) |
| 4 | 🟠 | 📈 At Scale | Move `verifyLoginAttempt` out of the outer tx in change-email / change-password | [change-email/handler.ts:59](app/api/dash/users/me/change-email/handler.ts#L59), [change-password/handler.ts:67](app/api/dash/users/me/change-password/handler.ts#L67) |
| 5 | 🟠 | 📈 At Scale | Plan lazy session-metadata refresh (role_version) to replace in-tx fanout | [lib/permissions/utils.ts](lib/permissions/utils.ts) |
| 6 | 🟠 | 🧪 Early | Lock role row in user `DELETE` or join it with the user lookup | [app/api/dash/users/[id]/handler.ts:592](app/api/dash/users/%5Bid%5D/handler.ts#L592) |
| 7 | 🟡 | 📈 At Scale | Add `(table_name, created_at DESC)` index to `audit_logs` | [db/schema.ts:328](db/schema.ts#L328) |
| 8 | 🟡 | 🧪 Early | Size-clamp `oldData`/`newData` in audit writes | [lib/audit.ts](lib/audit.ts) |
| 9 | 🟡 | 🧪 Early | Double-guard `/api/dev/sign-up` with `ENABLE_DEV_ENDPOINTS` flag | [app/api/dev/sign-up/handler.ts](app/api/dev/sign-up/handler.ts) |
| 10 | 🟡 | 🧪 Early | Parallelize user+sessions queries in `GET /users/[id]` | [app/api/dash/users/[id]/handler.ts:108-186](app/api/dash/users/%5Bid%5D/handler.ts#L108-L186) |
| 11 | 🟡 | 🧪 Early | Add baseline security response headers | `next.config.js` |
| 12 | 🟡 | 🧪 Early | Either enforce `emailVerified` in the session hook or stop setting it on admin edits | [lib/auth.ts:186](lib/auth.ts#L186) |
| 13 | 🟢 | — | Split the ~650-line `[id]/handler.ts` into `lib/users/edit.ts` | [app/api/dash/users/[id]/handler.ts](app/api/dash/users/%5Bid%5D/handler.ts) |

---

*End of report.*
