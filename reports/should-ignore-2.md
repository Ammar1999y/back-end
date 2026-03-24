1. **Unauthenticated Upload** — `app/api/upload/image/route.ts:19` — No auth or
   rate limiting on upload endpoint; anyone can flood R2 storage
2. **In-Memory Rate Limiter** — `lib/auth.ts:233` — Per-process counters
   bypassed in multi-instance deployments
3. **No Rate Limiting on Admin API** — All `app/api/dash/*` routes
4. **Pool-Per-Transaction** — `db/ws.ts:7-10, 23-29` — Creates and destroys a DB
   connection pool on every write call; causes connection exhaustion under load
5. **Swallowed Pool Cleanup Errors** — `db/ws.ts:28-30`
6. **No Request Size Limit** — All POST/PUT handlers
7. **No Session, Audit Log, Delted users, Temp files Cleanup** — `db/schema.ts`
8. Soft-Deleted Users Accumulate Without Cleanup

9. **No CSRF Protection** — All POST/PUT/DELETE endpoints
10. **Email Provider Allowlist Restrictive** —
    `utils/validation/rules.ts:112-116` — Blocks corporate/custom domain emails

### 2.5 LOW: No Optimistic Locking on Updates

**Files:** All PUT endpoints

There is no `updatedAt` version check on any update operation. If two admins
edit the same role or user simultaneously, the last write silently overwrites
the first with no conflict detection.

**Fix (if needed):** Add an `updatedAt` check:

```ts
const [roleUpdated] = await tx
  .update(roles)
  .set({ ... })
  .where(
    and(
      eq(roles.id, roleId),
      eq(roles.updatedAt, body.updatedAt) // Client sends the last-known updatedAt
    )
  )
  .returning({ id: roles.id });

if (!roleUpdated)
  throw new CustomError('تم تعديل البيانات من قبل مستخدم آخر، أعد تحميل الصفحة', 409);
```

### 1.2 Account Lockout DoS — CAPTCHA Bypass

اختبره بالحقيقيه وانتاكد من ان هذا المشكلة من صدق موجودة

|                 |                                                            |
| --------------- | ---------------------------------------------------------- |
| **Severity**    | Critical                                                   |
| **Reported by** | Gemini                                                     |
| **Location**    | `lib/auth.ts:48-81` (inside `sign-in/email` `before` hook) |

**Problem.** The `before` hook runs `checkLoginLock` prior to plugin validation
(Turnstile CAPTCHA). An attacker can spam invalid login attempts for any target
email without solving the CAPTCHA. The system registers these attempts and locks
the legitimate user out — an unauthenticated Denial of Service.

**Fix.** Either:

- **Option A:** Move the lockout check to the `after` hook where it runs
  post-CAPTCHA, or restructure the hook ordering so CAPTCHA validation precedes
  lock checks.
- **Option B:** Implement IP-based rate limiting on the `/sign-in/email`
  endpoint at the infrastructure level (e.g., Cloudflare, middleware) so that
  automated attempts are blocked before email-based counters apply.

---

### F-01 🔴 Critical — Self-Edit Password/Email Change Without Current Password Verification

**Location:**
[users/\[id\]/route.ts:164-238](app/api/dash/users/[id]/route.ts#L164-L238),
[utils/validation/auth.ts:74-85](utils/validation/auth.ts#L74-L85)

**Reported by:** Gemini (🔴), Opus (🔴), Sonnet (🟠) — 3 of 4 reviewers

**Problem:** The self-edit path (`session?.user.id === targetId`) allows any
authenticated user to change their password and email without providing their
current password. `selfUpdateUserSchema` has no `currentPassword` field, and the
handler never verifies the existing credential before replacing it.

**Impact:** If an attacker obtains a valid session through any means (XSS,
physical access to an unlocked machine, shared device), they can:

1. Change the password to one they control — all other sessions are invalidated
   (lines 224-233), locking out the legitimate user
2. Change the email to one they control — future password-reset flows deliver
   the reset link to the attacker's inbox
3. Combined: **permanent, unrecoverable account takeover** from a single
   temporary session compromise

This violates OWASP ASVS 2.1.1 (require current password for password changes).

**Fix:**

Add a `currentPassword` field to `selfUpdateUserSchema` that is required when
either `password` or `email` is being changed:

```typescript
// utils/validation/auth.ts
export const selfUpdateUserSchema = userRoleSchema
  .pick({ name: true, email: true })
  .extend({
    id: idSchema,
    currentPassword: passwordSchema.optional().nullish(),
    password: z
      .preprocess(
        (e) => (typeof e === 'string' && e.trim().length ? e : null),
        passwordSchema.optional().nullish()
      )
      .optional()
      .nullish(),
  })
  .superRefine((data, ctx) => {
    if (data.password && !data.currentPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Current password is required to change password',
        path: ['currentPassword'],
      });
    }
  });
```

In the handler, verify the current password before committing changes:

```typescript
// Inside the transaction, before updating users/accounts
const emailChanged = parsed.data.email !== session?.user.email;

if (parsed.data.password || emailChanged) {
  if (!parsed.data.currentPassword)
    throw new CustomError(
      'Current password required for security-sensitive changes',
      HTTP_STATUS.BAD_REQUEST
    );

  const [account] = await tx
    .select({ password: accounts.password })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, targetId),
        eq(accounts.providerId, CREDENTIAL_PROVIDER_ID)
      )
    );

  if (!account?.password)
    throw new CustomError(userMsg.passwordUpdateFailed, HTTP_STATUS.BAD_REQUEST);

  const isValid = await verifyPassword({
    password: parsed.data.currentPassword,
    hash: account.password,
  });

  if (!isValid)
    throw new CustomError(
      'Current password is incorrect',
      HTTP_STATUS.BAD_REQUEST
    );
}
```

---

### 1.3 🟠 High | Email/Password Changes Do Not Trigger Session Refresh/Invalidation

### 🟡 Medium | 📈 At Scale — Bulk Session Operations Inside Transaction Hold Role Lock

**Location:**
[permissions/[id]/route.ts:249-258](app/api/dash/permissions/[id]/route.ts#L249-L258),
[lib/permissions/utils.ts:333-341](lib/permissions/utils.ts#L333-L341)

**Problem:** Both locations run bulk session operations (delete or update) for
all users of a role **inside** the main transaction, which also holds a
`FOR UPDATE` lock on the `roles` row:

- **Role deactivation** — deletes all sessions for users with that role
- **`refreshRoleSessions`** — updates all sessions with new permission metadata

For roles with many active users, this extends transaction duration and blocks
concurrent requests needing the same role row.

**Impact at current scale:** Negligible for a dashboard with tens of users per
role.

**Fix options (in order of complexity):**

1. **Immediate — cap and document:** Soft business rule limiting roles to ~200
   users.
2. **Short-term — post-commit operations:** Commit the role change first, then
   run the session delete/update **outside** the transaction:

```ts
// Inside transaction: only update the role
await tx
  .update(roles)
  .set({ isActive: false })
  .where(standardRoleFilter(roleId));

// After transaction: bulk session cleanup
await db
  .delete(sessions)
  .where(
    inArray(
      sessions.userId,
      db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.roleId, roleId), isNull(users.deletedAt))),
    ),
  );
```

3. **Long-term — timestamp staleness:** Track `permissions_updated_at` on the
   `roles` table. Validate in middleware and refresh only when stale —
   eliminates the bulk operation entirely.
