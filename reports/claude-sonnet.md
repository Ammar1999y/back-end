# Production Security & Code Review Report

**Scope:** `app/api/dash/`, `app/api/auth/otp/`, `db/schema.ts`,
`db/migrations/001_add_trgm_indexes.sql`, and all directly related library
code (`lib/`, `utils/`, `types/`)

**Date:** 2026-04-18

---

## 1. Security Vulnerabilities

---

### 🔴 Critical — `verify: async () => true` Is a Latent Authentication Bypass

**Scale:** ⚠️ Always

**File:** [`lib/auth.ts:43`](lib/auth.ts#L43)

```ts
password: {
  hash: hashPassword,
  verify: async () => true, // ← always returns true
},
```

The actual password check is performed in the `before` middleware hook via
`verifyLoginAttempt`, and Better Auth's built-in `verify` function is patched
to always return `true`. A comment explains the intent.

**Why it's a problem:**

Better Auth may ship new credential-based paths in a future update. Any
in-house addition of a feature that uses Better Auth's credential flow
(password reset with confirmation, re-authentication gate, magic link fallback,
etc.) will silently bypass the actual password check. The developer adding that
feature will not know to also add a `verifyLoginAttempt` call — there is no
compile-time or runtime signal.

The `ALLOWED_PATHS` allowlist currently blocks most paths from reaching the
`verify` hook, but the layered coupling creates a hidden trap:

- The allowlist must stay in sync with all new paths.
- The `verify: true` override is in a different file from the `before` hook.
- If any future plugin or middleware processes `/sign-in/email` after a code
  restructure, it will do so with a verification function that always passes.

**What happens if ignored:**

A future developer adds a "confirm identity before sensitive action" flow using
Better Auth's credential API. It silently passes any password, granting
unverified privilege escalation to every user.

**How to fix:**

Restore the real verify function:

```ts
password: {
  hash: hashPassword,
  verify: verifyPassword,
},
```

Then ensure the `before` hook returns early (before `verifyLoginAttempt`) when
credentials are invalid, relying on Better Auth's real `verify` as the final
gate. The current `before` hook calls `verifyLoginAttempt` and throws on
failure — it already stops the request before Better Auth ever calls `verify`.
So restoring the real function has zero behavioral impact today but removes the
hidden trap.

Alternatively, if keeping the current architecture, add a test that creates a
new mock Better Auth path, calls `verify` directly, and asserts it returns
`false` for a wrong password — failing loudly if this assumption is ever broken.

---

### 🟠 High — Rate Limiting Fails Open on Redis Unavailability

**Scale:** ⚠️ Always

**File:** [`lib/rate-limit/index.ts:64-70`](lib/rate-limit/index.ts#L64)

```ts
} catch (error) {
  console.warn('[rate-limit] check failed, allowing request:', sanitizeForLog(error));
  return { success: true, ... }; // ← all limits bypassed
}
```

When the Upstash Redis connection is unavailable, the rate limiter returns
`success: true` for every request. This applies to every rate-limited endpoint:
login (`/sign-in/email`), OTP send/verify, user creation, permission
management, etc.

**Why it's a problem:**

Fail-open is a deliberate availability trade-off (the service stays up). But
the security consequence is total: a Redis outage — intentional (DoS against
Redis) or accidental — disables brute-force protection on login and OTP
entirely. The login endpoint already calls `verifyLoginAttempt` which has its
own DB-level lock counter, so login brute force is partially protected. But OTP
verification has no DB-level equivalent: `processOtpVerify` does have
`OTP_MAX_VERIFY_ATTEMPTS` checks, but those are in-transaction per-session
counters, not per-IP. An attacker with Redis taken down could hammer OTP verify
from multiple IPs simultaneously with no rate limit.

**What happens if ignored:**

During a Redis outage, brute-force attacks on login and OTP endpoints face only
DB-level per-user counters. An attacker distributing requests across many
accounts faces no rate limit at all.

**How to fix:**

Two options:

1. **Fail-closed for sensitive paths.** Pass a `failClosed: boolean` flag to
   `enforceRateLimit`. OTP and login paths set it to `true`. On Redis error,
   throw 503 (Service Unavailable) instead of allowing the request.

2. **Circuit breaker with in-process fallback.** Keep a small in-process
   sliding-window counter as a backup when Redis is unreachable. Less accurate
   under multiple instances but provides a meaningful safety net.

At minimum, document the trade-off explicitly in a runbook so on-call engineers
know that a Redis outage degrades security posture and requires urgent
attention.

---

### 🟠 High — OTP Send Timing Guard Starts After the User Lookup

**Scale:** ⚠️ Always

**File:** [`app/api/auth/otp/send/handler.ts:81`](app/api/auth/otp/send/handler.ts#L81)
and [`app/api/auth/otp/messages.ts:3`](app/api/auth/otp/messages.ts#L3)

```ts
const [userData] = await db.select(...).where(...).limit(1); // DB query runs first
const start = Date.now();                                     // timer starts AFTER

if (!userData || ...) {
  await ensureMinDelay(Date.now() - start); // elapsed ≈ 0 → sleeps full 350ms
  return genericResponse();
}

const result = await processOtpSend({...}); // argon2 + HTTP delivery = 200–1500ms
await ensureMinDelay(Date.now() - start);   // if > 350ms → no sleep
```

`MINIMUM_RESPONSE_MS = 350`. The timer starts after the user-lookup query, so
it measures only the OTP processing phase. Total observable time for each path:

| Path | Observed response time |
|------|------------------------|
| User not found | `T_db_query + 350 ms` |
| User found, unverified | `T_db_query + max(T_processOtpSend, 350ms)` |

`processOtpSend` includes argon2 hashing (~150–500 ms depending on cost
factor) plus an external HTTP call to the SMS/email provider (latency varies
widely: 100 ms to several seconds). When OTP delivery is fast (< 350 ms) the
paths are equalized. When delivery is slow or the provider is throttling, the
found-user path takes significantly longer, leaking user existence.

**Why it's a problem:**

Cloudflare Turnstile limits automated probing, but a sophisticated attacker
using real browsers or reused captcha tokens could measure timing differences
statistically over many requests to determine whether a given email address or
phone number is registered.

**How to fix:**

Start the timer before the user lookup:

```ts
const start = Date.now(); // ← moved to top

const [userData] = await db.select(...).where(...).limit(1);

if (!userData || ...) {
  await ensureMinDelay(Date.now() - start);
  return genericResponse();
}

const result = await processOtpSend({...});
await ensureMinDelay(Date.now() - start);
```

Also raise `MINIMUM_RESPONSE_MS` to a value reliably higher than the 99th
percentile of `processOtpSend` (including the HTTP delivery call). 350 ms is
unlikely to cover slow OTP providers. A value of 1000–2000 ms with monitoring
of p99 delivery time is more appropriate.

---

### 🟡 Medium — HIBP Password Check Fails Open on API Errors

**Scale:** ⚠️ Always

**File:** [`lib/auth/check-password.ts:44-47`](lib/auth/check-password.ts#L44)

```ts
} catch (error) {
  if (error instanceof CustomError) throw error;
  console.error('HIBP check failed:', sanitizeForLog(error));
  // silently continues → compromised password is accepted
}
```

When the HaveIBeenPwned API is unreachable or returns an error, the check
passes. The same fail-open applies to admin password resets via
`handleAdminEdit` and the `POST /users/me/change-password` endpoint.

**Why it's a problem:**

HIBP API errors are most likely during periods of high traffic or rate
limiting. Attackers who know this can time their requests to coincide with HIBP
downtime and set passwords they know are in breach databases. The exploit
probability is low, but the impact (a weak password accepted into a production
system) is permanent.

**What happens if ignored:**

Users can set known-compromised passwords during HIBP outages. The broader
Better Auth `haveIBeenPwned` plugin that covers sign-up has its own fail-open
behavior.

**How to fix:**

For the `change-password` endpoint (security-sensitive, user-initiated), throw
a 503 on HIBP errors rather than silently passing:

```ts
} catch (error) {
  if (error instanceof CustomError) throw error;
  console.error('HIBP check failed:', sanitizeForLog(error));
  throw new CustomError('تعذّر التحقق من أمان كلمة المرور، أعد المحاولة لاحقاً', HTTP_STATUS.SERVICE_UNAVAILABLE);
}
```

For the admin edit path where blocking may be too disruptive, at minimum log a
metric/alert so the team is aware of outage duration.

---

### 🟢 Low — Captcha Coverage Incomplete on Better Auth Endpoints

**Scale:** ⚠️ Always

**File:** [`lib/auth.ts:270-275`](lib/auth.ts#L270)

```ts
captcha({
  provider: 'cloudflare-turnstile',
  secretKey: ...,
  endpoints: ['/sign-in/email'], // TODO: add the proper endpoints
}),
```

The captcha plugin is only configured for `/sign-in/email`. The comment
acknowledges additional endpoints are missing. Currently sign-up is blocked via
the `ALLOWED_PATHS` allowlist (only `get-session`, `sign-out`, and
`sign-in/email` are permitted), so the immediate exposure is minimal.

**Why it matters:**

If a new endpoint is added to `ALLOWED_PATHS` without adding it to the captcha
`endpoints` list, it will be unprotected. This creates a silent gap between the
allowlist and the captcha coverage.

**How to fix:**

Either: keep a single source of truth — derive the captcha `endpoints` from the
same `ALLOWED_PATHS` set that the middleware uses, so they always stay in sync.
Or: add a comment linking the two locations so any new `ALLOWED_PATHS` entry
prompts a captcha review.

---

## 2. Race Conditions & Concurrency

---

### 🟡 Medium — Advisory Lock Key Collision in `processOtpSend`

**Scale:** 📈 At Scale

**File:** [`utils/otp.ts:204-206`](utils/otp.ts#L204)

```ts
await tx.execute(
  sql`SELECT pg_advisory_xact_lock(hashtext(${userId} || ${channel}))`
);
```

`hashtext` returns `int4` — 32-bit signed, ~4.3 billion distinct values. The
key is derived from the concatenation of a UUID (36 chars) and a channel name
(3–10 chars). Two different `(userId, channel)` pairs can hash to the same
int4, causing completely unrelated OTP requests to serialize behind the same
lock.

**Why it's a problem:**

At low user counts the probability is negligible. With 10 000 active users each
sending an OTP simultaneously, the birthday collision probability against 2^32
buckets is roughly `n² / 2 × 2^32 ≈ 10^8 / 8.6×10^9 ≈ 1.2%`. At 100 000
users it rises to ~12%. Collisions cause false serialization: two users who
share the same lock key must queue, inflating OTP send latency. It is not a
security vulnerability — two colliding users each get their own correct OTP,
just slower — but it is a correctness issue in terms of expected locking
semantics.

**How to fix:**

Use `pg_advisory_xact_lock(int4, int4)`, the two-argument form, which provides
64-bit key space:

```ts
await tx.execute(
  sql`SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext(${channel}))`
);
```

This reduces collision probability to effectively zero for any realistic user
count.

---

## 3. Performance & Efficiency

No new issues found beyond what is documented in `reports/should-ignore.md`.

The concurrent `Promise.all` pattern for data + count queries, the use of
column allowlists, the precomputed `sanitizePermissions` passed to
`refreshRoleSessions`, and the single-round-trip `checkUserPermission` DB path
are all well-designed for the current scale.

---

## 4. Data Integrity & Correctness

No new issues found beyond what is documented in `reports/should-ignore.md`.

Key positives worth noting:
- Admin email change correctly sets `emailVerified: false` (`handleAdminEdit`,
  line 411).
- `createCustomRole` correctly uses `FOR UPDATE` to prevent the read-delete-insert
  race on existing custom roles.
- `processOtpSend` upserts the session atomically and resets
  `verifyAttemptNumber` on resend, preventing an attacker from resetting
  attempt counters by repeatedly requesting new codes without a timing penalty.

---

## 5. Database Schema & Constraints

No new issues found beyond what is documented in `reports/should-ignore.md`.

The trigram indexes in `001_add_trgm_indexes.sql` cover all columns used with
`ILIKE` in the data-table queries. The partial indexes (`WHERE deleted_at IS
NULL`) are appropriate and correctly aligned with the application-level
soft-delete filter.

---

## 6. Error Handling & Response Quality

The error handling architecture is solid. `handleApiError` catches `CustomError`
by status code and returns structured JSON without leaking stack traces.
Unique-constraint violations are resolved to user-friendly messages. The OTP
verify endpoint deliberately flattens `BAD_REQUEST` and `NOT_FOUND` into a
single generic error to prevent enumeration.

One subtle gap:

### 🟢 Low — `change-email` Unique Violation Handler Falls Through to Internal Error

**File:** [`app/api/dash/users/me/change-email/handler.ts:149-155`](app/api/dash/users/me/change-email/handler.ts#L149)

```ts
} catch (error) {
  if (isUniqueViolation(error)) {
    return handleApiError(
      new CustomError(resolveUserUniqueViolation(error), HTTP_STATUS.CONFLICT)
    );
  }
  return handleApiError(error, MSG_UPDATE_ERROR);
}
```

The handler checks for the unique-constraint violation as a belt-and-suspenders
fallback (in case the earlier explicit `emailExists` check races past the unique
constraint). The `resolveUserUniqueViolation` function, however, reads the
constraint name `ux_users_email` for a match. Since the check runs immediately
after the `update`, this path is reachable only if the explicit existence check
above was somehow bypassed — which cannot happen within the same transaction
with `FOR UPDATE` held. This code path is unreachable but harmless.

A minor consistency note: if `resolveUserUniqueViolation` does not match the
constraint name (e.g., future constraint rename), it returns `MSG_INTERNAL_ERROR`
(500) instead of 409. Adding `MSG_EMAIL_EXISTS` as a direct fallback instead of
`MSG_INTERNAL_ERROR` would be more defensive.

---

## 7. Code Quality & Maintainability

### 🟢 Low — `verify: async () => true` Creates Silent Coupling Across Files

Already reported under Security (section 1). From a maintainability angle: the
assumption "the before hook always runs first and covers all credential paths"
is documented only in comments. There is no automated test that would fail if
Better Auth ever calls `verify` on a path that is not guarded by the `before`
hook. As the codebase grows and Better Auth is upgraded, this becomes
progressively harder to verify manually.

**Recommendation:** Add an integration test that sends a request to
`/sign-in/email` with a correct email but wrong password, asserts a 401, and
confirms that Better Auth's `verify` was not what caught it (e.g., by
temporarily removing the `before` hook logic and verifying that the mock
`verify: async () => true` would let it through).

---

### 🟢 Low — `standardRoleFilter` Duplicated in Raw SQL Comment

**File:** [`app/api/dash/permissions/[id]/handler.ts:376`](app/api/dash/permissions/%5Bid%5D/handler.ts#L376)

```ts
// SYNC: scope condition mirrors standardRoleFilter() in lib/permissions/utils.ts
const deleted = await tx.execute(sql`
  DELETE FROM roles r
  WHERE r.id = ${roleId}
    AND r.scope = ${ROLE_SCOPE.STANDARD}
    ...
`);
```

The raw SQL intentionally re-implements the scope filter from
`standardRoleFilter()` to perform the delete atomically. The `// SYNC:` comment
signals this. This is an acceptable trade-off (the raw SQL is needed here for
the conditional delete semantics). The comment does its job.

However, the `ROLE_SCOPE.STANDARD` constant is injected via Drizzle's `${}` 
interpolation, so if the constant value changes, the raw SQL stays correct.
No action needed.

---

## 8. Production Readiness & Expert Insights

### The `verify: async () => true` Trap Is the Biggest Hidden Risk

Restoring `verify: verifyPassword` is the single highest-leverage fix in this
codebase. It costs nothing — the `before` hook runs first and throws on bad
credentials before `verify` is ever called. It removes a latent vulnerability
that could be silently introduced by an npm upgrade, a new plugin, or a
developer who does not read the comment.

### Rate Limit Fail-Open Under Redis Outage Needs a Runbook

Even if fail-open is an acceptable availability trade-off, the security
implications (login brute force goes unthrottled, OTP enumeration becomes
possible) should be written into an incident runbook. Operations teams should
know that a Redis outage is a partial security event, not just a performance
degradation.

### OTP Delivery Latency Makes the 350 ms Guard Insufficient

`MINIMUM_RESPONSE_MS = 350` assumes OTP processing completes in under 350 ms.
argon2 hashing alone may consume 200–400 ms; add network round-trips to SMS or
email providers (especially under load or in regions far from the provider's
servers) and p99 could easily be 1000–3000 ms. The guard should be set to the
p99.9 of observed OTP send time, not a fixed low value. Instrument the OTP
send path with timing metrics before finalizing this constant.

### HIBP Fail-Open Should Be an Alert, Not Just a Log

Currently `checkPasswordCompromise` logs a `console.error` on failure. In a
serverless environment this often gets aggregated away. Consider emitting a
structured metric or alerting event so the team is notified when HIBP becomes
unreachable — both because it degrades password security and because it
indicates an external service disruption.
