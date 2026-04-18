# API and Schema Review

## Scope

Reviewed:

- `app/api/dash/**`
- `app/api/auth/**`
- `db/schema.ts`
- `db/migrations/001_add_trgm_indexes.sql`

I also traced the shared helpers these routes depend on, especially auth, permission checks, OTP state handling, audit logging, rate limiting, and transaction wrappers.

Issues listed in `reports/should-ignore.md` were excluded from findings below.

## Executive Summary

The good news first: I did **not** find a direct SQL injection path, an obvious IDOR, or a mass-assignment bug in the reviewed handlers. The dashboard write paths are mostly better than average on concurrency: they use transactions, row locks, and DB-enforced uniqueness in the right places.

The main problems that still need attention are concentrated around the public auth/OTP surface:

1. OTP endpoints still leak account and verification state through timing and non-generic throttle/error behavior.
2. Rate limiting fails open when Redis/Upstash is unavailable, which removes a primary internet-facing abuse control exactly when infrastructure is degraded.
3. `better-auth` password verification has been globally replaced with `async () => true`; it is only safe because of a fragile path allowlist and middleware contract.

Beyond those, I did not find additional high-risk race conditions or schema flaws outside the ignore list.

## Detailed Findings

### 🟠 High — OTP endpoints still allow account-state enumeration — ⚠️ Always

**Where**

- `app/api/auth/otp/send/handler.ts:35-43`
- `app/api/auth/otp/send/handler.ts:81-107`
- `app/api/auth/otp/verify/handler.ts:34-38`
- `app/api/auth/otp/verify/handler.ts:65-118`
- `utils/otp.ts:227-236`
- `utils/otp.ts:259-266`
- `utils/otp.ts:280-283`
- `utils/otp.ts:384-395`
- `app/api/auth/otp/messages.ts:1-7`

**Why this is a problem**

The route comments and helper names show that the intent is to hide whether an email/phone exists or has a live verification flow. In practice, that protection is incomplete:

- `/api/auth/otp/send` returns a generic 200 only for "not found / already verified", but real accounts can still trigger distinct `429` responses like "wait X seconds" or "blocked for Y hours".
- `/api/auth/otp/verify` converts some failures to a generic error, but it still returns raw `429` responses when the verification-attempt limit is hit.
- The send path also has a timing side channel: the fake path sleeps to a minimum floor, while the real path performs OTP hashing plus external delivery before responding. An attacker can often distinguish "real pending account" from "no account / already verified" by latency alone.

**What could happen if ignored**

- Attackers can enumerate which emails or phone numbers belong to real accounts.
- Attackers can tell whether a target currently has a live OTP session.
- Attackers can infer whether a target account is already verified or is still in a registration / recovery flow.

That is not just cosmetic. User enumeration is useful for credential stuffing, phishing, and targeted account takeover campaigns.

**How to fix it**

Make the OTP API fully indistinguishable for all non-success states that should stay private:

- Start timing **before** the user lookup, not after it.
- Return the same body shape and status code for "unknown identifier", "already verified", "cooldown active", "blocked", "no session", and "bad code" when those states are privacy-sensitive.
- Keep the real reason only in internal logs / metrics.

Example pattern for `send`:

```ts
const startedAt = Date.now();

try {
  // normal flow
  await processOtpSend(...);
} catch (error) {
  if (
    error instanceof CustomError &&
    [400, 404, 429].includes(error.status)
  ) {
    await ensureMinDelay(Date.now() - startedAt);
    return apiSuccess({
      message: otpMsg.sendSuccess,
      data: GENERIC_SEND_DATA,
    });
  }
  throw error;
}

await ensureMinDelay(Date.now() - startedAt);
return apiSuccess({ message: otpMsg.sendSuccess, data: GENERIC_SEND_DATA });
```

For `verify`, use the same idea with one generic "invalid or expired" response for privacy-sensitive failures.

### 🟠 High — Rate limiting fails open on Redis errors — ⚠️ Always

**Where**

- `lib/rate-limit/index.ts:44-71`
- `lib/rate-limit/auth-storage.ts:20-43`
- Consumed by:
  - `app/api/auth/otp/send/handler.ts:35-39`
  - `app/api/auth/otp/verify/handler.ts:34-38`
  - `lib/auth.ts:231-239`

**Why this is a problem**

Both the generic API limiter and the Better Auth limiter intentionally allow requests through when Redis/Upstash is unavailable.

That means:

- OTP send/verify IP throttling disappears during Redis outages.
- Better Auth per-IP auth throttling disappears during Redis outages.
- During an incident, the system becomes **easier** to brute-force and abuse.

For public internet auth endpoints, that is the wrong failure mode.

**What could happen if ignored**

- Password spraying and OTP abuse become much easier during Redis degradation.
- Attackers can intentionally target infra weak points and then attack when protections are down.
- Incident response gets harder because the app becomes least safe when dependencies are unstable.

**How to fix it**

Prefer fail-closed for public auth/OTP paths, or at minimum degrade to a stricter local fallback instead of "allow everything".

Safer pattern:

```ts
catch (error) {
  console.warn('[rate-limit] backend unavailable:', sanitizeForLog(error));
  throw new CustomError(
    MSG_TOO_MANY_REQUESTS,
    HTTP_STATUS.TOO_MANY_REQUESTS
  );
}
```

If you need availability over strict denial, use an in-process fallback limiter with a very small budget and short TTL. Do not silently treat a failed limiter as success for login or OTP endpoints.

### 🟡 Medium — Global password verification is effectively disabled in Better Auth — 🧪 Early Stage

**Where**

- `lib/auth.ts:25-45`
- `lib/auth.ts:49-99`

**Why this is a problem**

`better-auth` is configured with:

```ts
verify: async () => true
```

The current code is relying on a `before` hook plus a strict `ALLOWED_PATHS` allowlist to make this safe. That means the real security boundary is no longer the auth library's password verifier. It is a local convention that must remain perfectly aligned with:

- which Better Auth endpoints are enabled,
- which endpoints require password verification,
- how Better Auth internally calls `password.verify`,
- and future code changes by anyone touching auth.

**What could happen if ignored**

Today, this is mostly a latent risk. The current allowlist keeps it from being immediately exploitable.

The problem appears as soon as someone later enables another password-based Better Auth flow, upgrades the library, or adds a route assuming the library still verifies passwords. At that point, this can become an authentication bypass or a severe integrity bug.

**How to fix it**

Restore secure defaults at the auth-library boundary:

```ts
password: {
  hash: hashPassword,
  verify: async ({ password, hash }) => verifyPassword({ password, hash }),
}
```

Then keep `verifyLoginAttempt()` as an extra sign-in guard for lockout accounting, not as the only place where password verification exists.

If double verification cost is a concern, solve that explicitly in the sign-in path. Do not leave the global verifier permanently disabled.

### 🟢 Low — Missing dedicated security-event telemetry for auth and OTP flows — ⚠️ Always

**Where**

- `app/api/auth/otp/send/handler.ts`
- `app/api/auth/otp/verify/handler.ts`
- `lib/auth.ts`
- Compare with the mutation audit pattern in `lib/audit.ts:91-121`

**Why this is a problem**

Dashboard mutations are audited well, but the public auth and OTP flows do not emit dedicated security events for:

- successful / failed login attempts,
- OTP send attempts,
- OTP verification failures,
- repeated throttling,
- suspicious identifier probing.

**What could happen if ignored**

- You will have weak visibility during account-takeover investigations.
- Abuse detection will depend on infrastructure logs instead of application-level intent.
- It becomes harder to answer basic security questions like "which IPs are hammering OTP verify for this identifier?"

**How to fix it**

Add structured security-event logging with fields like:

- `event_type`
- `user_id` when known
- hashed or redacted identifier
- IP
- user agent
- outcome (`success`, `invalid`, `throttled`, `captcha_failed`)
- reason code

This should be separate from business audit logs so it can be sampled, alerted on, and retained appropriately.

## 1. Security Vulnerabilities

### Confirmed issues

- OTP enumeration via timing and differentiated throttle/error behavior.
- Fail-open rate limiting on internet-facing auth/OTP endpoints.
- Global Better Auth password verification disabled, relying on fragile surrounding controls.

### What I did not find

- No direct SQL injection path in the reviewed endpoints.
- No obvious mass-assignment issue; handlers explicitly map allowed fields into inserts/updates.
- No clear IDOR in the dashboard mutations I reviewed; user/role-sensitive actions generally re-check ownership/scope inside transactions.

## 2. Race Conditions and Concurrency

No additional high-risk race condition stood out beyond the ignore list.

The code actually does several things correctly:

- login verification uses one transaction plus `FOR UPDATE` and atomic counter updates in `lib/auth/login-guard.ts`.
- OTP send uses a transaction, row locks, and an advisory lock to serialize first-send races.
- admin role/user mutations are wrapped in transactions and use row locks before destructive changes.

I would not block deployment on a new concurrency finding from this review alone.

## 3. Performance and Efficiency

No additional performance issue rose above the ignore list.

Notable strengths:

- Searchable list endpoints are wired to trigram indexes via `db/migrations/001_add_trgm_indexes.sql`.
- The main list endpoints avoid N+1 query loops.
- Permission/session refreshes are done with set-based SQL updates rather than per-row application loops.

The biggest remaining auth-path cost is OTP delivery latency, but that specific issue is already on the ignore list.

## 4. Data Integrity and Correctness

No new medium-or-higher correctness issue was identified outside the ignore list.

What looks good:

- uniqueness for user email/phone is DB-enforced,
- OTP counters and bounds are backed by DB checks,
- dashboard write paths generally use transactions so partial multi-step failures roll back.

## 5. Database Schema and Constraints

I did not find an additional schema flaw that I would escalate beyond the ignore list.

The OTP tables are reasonably well-defended for the current use case:

- `verification_sessions` has a FK to `users`, a uniqueness guarantee on `(user_id, channel)`, and bounds checks on attempt counters in `db/schema.ts:388-444`.
- `verification_codes` has a FK to `verification_sessions` and a uniqueness guarantee per session in `db/schema.ts:450-470`.
- user identifiers are protected by unique partial indexes in the `users` table.

## 6. Error Handling and Response Quality

Strengths:

- `handleApiError()` consistently prevents stack traces from leaking to clients.
- status codes for validation, auth, conflict, and not-found cases are generally sensible.

Issue to address:

- OTP handlers break their own "generic response" privacy goal by surfacing private throttling states.

## 7. Code Quality and Maintainability

The biggest maintainability risk is security behavior depending on comments and conventions instead of safe defaults.

The clearest example is `lib/auth.ts:25-45`: future developers can easily assume Better Auth still verifies passwords, while the real behavior has been replaced with a custom hook contract. That is the kind of hidden coupling that produces severe regressions later.

## 8. Production Readiness and Expert Insights

Before calling this auth surface production-ready on the public internet, I would require:

1. fully genericized OTP failure behavior,
2. fail-closed or safe-fallback throttling,
3. secure-default password verification in the auth library boundary,
4. security-event telemetry for login and OTP abuse.

### Assumption to verify

I am assuming your deployment platform overwrites and protects `cf-connecting-ip`, `x-vercel-forwarded-for`, and `x-forwarded-for`.

If that assumption is false, then IP-based throttling can be bypassed by spoofed headers because `getClientIp()` trusts those headers directly in `lib/audit.ts:21-29`, and `ipIdentifier()` uses that value for OTP throttling.

## Final Assessment

If I were signing off this review for production, I would treat the dashboard CRUD surface as broadly acceptable after the ignore-list exclusions, but I would **not** sign off the public auth/OTP surface until the two high-severity items are fixed:

- OTP enumeration/privacy leakage
- fail-open rate limiting

The medium-severity auth-verifier issue should be corrected in the same hardening pass because it is exactly the kind of "safe until someone changes one thing" design that turns into a real incident later.
