## Verdict

I do not agree that all findings are resolved. My independent review classifies the 24 report items as:

- 11 fixed
- 8 partially fixed
- 5 unresolved

| Finding                   | Verdict                            |
| ------------------------- | ---------------------------------- |
| M5 SVG CSS                | Partial                            |
| H4 image processing       | Partial                            |
| M23 R2 configuration      | Fixed                              |
| H2 unknown auth scopes    | Fixed                              |
| M17/M18 send quotas       | Fixed                              |
| H7 OTP verification state | Unresolved                         |
| M16 failed OTP delivery   | Partial                            |
| M12 SQLite ownership      | Partial                            |
| M24/M25 smoke CI          | Fixed                              |
| M14/L27 formatting/CI     | Fixed                              |
| M24 optional token        | Fixed, stale documentation remains |
| M24 PostgreSQL readiness  | Partial                            |
| L13 permission helper     | Fixed                              |
| M4 unevaluable passwords  | Unresolved                         |
| M1 cookie cache           | Unresolved                         |
| L9 permission preflight   | Fixed                              |
| L1/L4 query validation    | Fixed                              |
| L15 cache maintenance     | Partial                            |
| M25 cron drain            | Partial                            |
| H5/M21 OpenAPI            | Partial                            |
| M9 control bytes          | Fixed                              |
| AGENTS.md comments/types  | Unresolved                         |
| M18 disabled-OTP logging  | Fixed                              |
| M25 deployment runbook    | Unresolved                         |

### 1. M5 remains bypassable

The reported escaped `@import` and `url()` inputs are now handled, but the sanitizer still recognizes only literal `url(...)` references in [config.ts](/D:/apps/job-app/soft-house-dash-3/utils/images/config.ts:84).

I reproduced two preserved external references:

```css
mask-image:image-set("https://evil.example/mask.png" 1x)
mask-image:image("https://evil.example/mask.png")
```

Both survived the full sanitizer. The CSS specifications define `image()` and `image-set()` as image URL mechanisms, while `mask-image` accepts the `<image>` type. [CSS Images Level 4](https://www.w3.org/TR/css-images-4/#image-set-notation), [CSS Masking Level 1](https://www.w3.org/TR/css-masking-1/#the-mask-image).

The existing tests also do not contain direct regressions for the original escaped `@\69mport` and `u\72l` inputs.

This needs a real CSS parser/token allowlist covering every URL-bearing image form, or removal of `<style>` and `style` support.

### 2. The H4 disagreement is disproved

The WebP edge guard and numeric-option validation are valid fixes, but the rebuttal in the [response](/D:/apps/job-app/soft-house-dash-3/reports/final-audit-resolution-disagreements.md:69) is incorrect.

I reproduced three route-reachable inputs below the 1 MiB file limit:

- 127,959-byte, 5000×5000 PNG: 5,619 ms and 6 source encodes.
- 320,647-byte, 1000×15000 PNG: output remained 1000×15000.
- 759,222-byte noisy JPEG: 5 encodes and returned 282,874 bytes despite the 209,715-byte target.

The problem is not that `withoutEnlargement` enlarges small images. It is that [optimize-image.ts](/D:/apps/job-app/soft-house-dash-3/lib/r2/optimize-image.ts:215) constrains only width, accepts an edge up to 16,383 pixels, and returns an oversized final attempt instead of 422 at [line 274](/D:/apps/job-app/soft-house-dash-3/lib/r2/optimize-image.ts:274).

The Traefik ingress cap is already documented correctly. Application work still needs:

- A real longest-edge output contract.
- A 422 when the size target is unattainable.
- A hard encode-attempt ceiling independent of search assumptions.
- A VPS benchmark before selecting semaphore/queue limits.

### 3. H7 is unresolved, and the response acknowledges that

[processOtpVerify](/D:/apps/job-app/soft-house-dash-3/utils/otp.ts:937) still sums verification failures across purposes for the entire identity/contact kind.

The passing regression at [otp-verify-budget.test.ts](/D:/apps/job-app/soft-house-dash-3/tests/integration/otp-verify-budget.test.ts:302) explicitly proves that failures in other flows cause an untouched challenge to return 429 before comparing its code.

The public oracle also remains: [the handler](/D:/apps/job-app/soft-house-dash-3/app/api/auth/otp/verify/handler.ts:141) preserves 429 and `Retry-After` for a real blocked proof, while an unknown identity continues receiving generic 400 until the pre-lookup limiter fires.

Preserving the original block deadline fixed one subproblem, but the account-wide denial and enumeration primitive remain. The response itself admits this is “not a resolution” at [line 218](/D:/apps/job-app/soft-house-dash-3/reports/final-audit-resolution-disagreements.md:218).

The appropriate design remains an opaque per-initiation challenge with per-challenge attempts, fake challenge behavior, and source/IP/device/provider-spend controls outside the account-wide proof state.

### 4. M16 is only partially fixed

Authenticated contact-change routes now await the provider, so they no longer return `otpSent: true` before delivery. That part is correct.

However, delivery still occurs after committed OTP state at [utils/otp.ts](/D:/apps/job-app/soft-house-dash-3/utils/otp.ts:651). The passing test explicitly requires a failed delivery to leave both the attempt and code committed at [otp-send-boundary.test.ts](/D:/apps/job-app/soft-house-dash-3/tests/integration/otp-send-boundary.test.ts:144).

Therefore, a failed send still consumes the victim’s attempt and cooldown. There is no queued/delivered/failed/unknown state or delivery-attempt ID.

Also, `PROVIDER_TIMEOUT_MS = 5000` is not a hard end-to-end SMTP deadline. [utils/otp.ts](/D:/apps/job-app/soft-house-dash-3/utils/otp.ts:26) configures connection, greeting, and socket inactivity timeouts but not Nodemailer’s DNS timeout, which defaults to 30 seconds.

A short prepare → provider I/O → conditional finalize lifecycle is still required.

### 5. OpenAPI is protected but not strictly build-only

The important authorization behavior is correct:

- IP pre-authentication is enabled.
- A live dashboard session with an effective view grant is required.
- Responses are `no-store`.
- Upload authentication happens before resource validation.
- The build creates a server-only, production-filtered document.

But [openapi.ts](/D:/apps/job-app/soft-house-dash-3/lib/http/openapi.ts:614) still does:

```ts
prebuiltDocument() ?? generate();
```

Consequently, a production packaging error or missing artifact silently regenerates OpenAPI on the first authorized request. That contradicts “static and only change at build time.”

Production should fail closed when `build/openapi.json` is absent or invalid; runtime generation should be explicitly limited to development/test.

### 6. M1 still contradicts the selected cookie-cache contract

The response is correct that embedding `isActive` and `deletedAt` cannot detect a deleted session row. But that does not resolve the user’s explicit decision to accept a maximum five-minute stale window.

Better Auth documents that cookie caching avoids database access per request and that revoked sessions may remain active until `maxAge`; immediate revocation requires disabling/bypassing the cache or shortening it. [Better Auth session caching](https://better-auth.com/docs/concepts/session-management#session-caching).

The current cached path unconditionally calls [assertLiveSession](/D:/apps/job-app/soft-house-dash-3/lib/permissions/checker.ts:191), producing an indexed database read for every permission check. The retained tests only exercise “cookie cache missed” at [session-liveness.test.ts](/D:/apps/job-app/soft-house-dash-3/tests/integration/session-liveness.test.ts:40), so no test proves cache-hit query behavior.

A decision is still required:

- Accept the documented five-minute read staleness and preserve immediate checks for sensitive mutations; or
- Require immediate read revocation and disable/reframe cookie caching, possibly with request-scoped liveness memoization.

The model selected the second security contract without the user’s authorization.

### 7. M24 PostgreSQL readiness is improved but still incomplete

The probe now uses a separate one-connection pool with server-side `statement_timeout`, which prevents it from displacing the application pool.

However, [runPing](/D:/apps/job-app/soft-house-dash-3/db/index.ts:104) returns after the HTTP race and clears `ping.inFlight` while the underlying connection/query may still be pending.

Against a silent TCP peer, I measured:

```text
pingDatabase(100): false in 108 ms
pingDatabase(100): false in 102 ms
pingDatabase(100): false in 101 ms
open TCP sockets: 1
closeDatabase: still pending after 300 ms
```

The probe has no `connectionTimeout`, cancellation, result cache, or route metering. Bun supports both connection timeouts and query cancellation. [Bun SQL documentation](https://bun.com/docs/runtime/sql).

This is now isolated from normal traffic, so its impact is reduced, but it remains a public queue/shutdown resource issue.

### 8. M12’s code is valid; its documentation is not finished

The separate marker database in [writer-lock.ts](/D:/apps/job-app/soft-house-dash-3/lib/sqlite/writer-lock.ts:14) is a valid cooperative application-instance ownership lock. I verified:

- A second cooperating process is refused.
- A hard-killed owner releases the OS lock.
- Non-cooperating SQLite clients can still write, as documented.

The disagreement response is wrong to frame the audit as requiring impossible control over arbitrary SQLite clients; the review requested accurate operational documentation.

That documentation still conflicts with the implementation:

- The decision table still says HTTP routes and Coolify tasks at [coolify-deployment.md](/D:/apps/job-app/soft-house-dash-3/reports/coolify-deployment.md:35).
- It says a startup ownership assertion does not exist at [line 543](/D:/apps/job-app/soft-house-dash-3/reports/coolify-deployment.md:543).
- Conditional rolling deployment is still offered at [line 897](/D:/apps/job-app/soft-house-dash-3/reports/coolify-deployment.md:897), although a second new release sharing the directory will fail ownership acquisition.
- It says two replicas run competing sweeps at [line 1194](/D:/apps/job-app/soft-house-dash-3/reports/coolify-deployment.md:1194), whereas the second process should fail before scheduling.

Existing Coolify tasks are correctly instructed to be deleted later in the runbook.

### 9. Bun cron is the right choice, but shutdown remains partial

Using `Bun.cron` instead of the Elysia plugin is appropriate here. Bun provides no-overlap behavior, an explicit timezone, and a stop handle without another dependency or framework coupling. Elysia’s plugin wraps `cronner` and offers no active-callback drain advantage. [Bun cron](https://bun.com/docs/runtime/cron), [Elysia cron plugin](https://elysiajs.com/plugins/cron).

Explicit `{ tz: 'UTC' }` is necessary because Bun 1.4 changed in-process cron parsing from UTC to local time. [Bun 1.4 release notes](https://bun.com/blog/bun-v1.4).

The new active-job tracking works; my controlled active job drained successfully in approximately 82 ms. Two residual defects remain:

- [server.ts](/D:/apps/job-app/soft-house-dash-3/server.ts:293) waits up to 10 seconds before starting the 135-second forced-shutdown timer at [line 296](/D:/apps/job-app/soft-house-dash-3/server.ts:296), so it is not one common deadline.
- If `stopAndDrain` times out, the callback is not cancelled; stores are still closed underneath it.
- The process test at [shutdown-lifecycle.test.ts](/D:/apps/job-app/soft-house-dash-3/tests/process/shutdown-lifecycle.test.ts:51) does not start the production schedule with an active sweep.

### 10. M4 is still unresolved

The response correctly rejects returning a per-account 503 without a service-wide safeguard because that could become an account oracle.

Its claim that validation is “not implementable,” however, is too strong. An offline CI smoke needing lazy database startup does not prohibit a separate database-aware production deployment preflight. Such a preflight can scan credential-envelope pepper IDs and verify that every in-use generation is present before traffic is routed.

Currently, [verifyPasswordDetailed](/D:/apps/job-app/soft-house-dash-3/lib/auth/password.ts:107) converts malformed/missing-generation credentials into an ordinary bad password, and [login-guard.ts](/D:/apps/job-app/soft-house-dash-3/lib/auth/login-guard.ts:221) increments the user’s lockout state. The configuration fault therefore remains indistinguishable from a user mistake to both the affected user and HTTP monitoring.

### 11. The AGENTS.md finding was not resolved

The diff adds 1,026 comment lines. At least 125 contain change-history or measurement language such as “used to,” “before,” “measured,” or old implementation details. Examples include [password.ts](/D:/apps/job-app/soft-house-dash-3/lib/auth/password.ts:85), [auth.ts](/D:/apps/job-app/soft-house-dash-3/lib/auth.ts:357), and [db/index.ts](/D:/apps/job-app/soft-house-dash-3/db/index.ts:1).

Unearned error assertions also remain:

- [api-response.ts](/D:/apps/job-app/soft-house-dash-3/utils/api-response.ts:113) checks only that `responseHeaders` exists, then asserts it is `Record<string,string>` without validating it.
- [utils/index.ts](/D:/apps/job-app/soft-house-dash-3/utils/index.ts:512) directly casts an unknown thrown value to the invented nested database-error shape.

This does not satisfy the requested general comment/type sweep.

New comments and error typing violate standing standards

Sweep all modified and newly created code to align with `AGENTS.md` standards:

- **Comments (Baseline 4–5):**
  - **Remove noise:** Strip audit/change history, issue references, reproduction steps, and redundant code restatements.
  - **Focus on durable "why":** Document only non-obvious intent, security invariants, and subtle edge cases in the fewest lines possible.
  - **Avoid volatile details:** Remove transient configuration claims, hardcoded version references, and truncated or stale text.
- **Error Typing (Types rule):**
  - Eliminate unearned type assertions (`as`) on thrown values; treat errors as `unknown` and narrow at runtime (or import official library types).

### 12. Smaller residuals

- L15 now correctly returns `degraded` with `hasMore: true` on cache sweep failure, but there is no retained corrupt-cache regression. The runbook incorrectly says `removed.cache.error` appears in the scheduled log line at [coolify-deployment.md](/D:/apps/job-app/soft-house-dash-3/reports/coolify-deployment.md:974).
- The maintenance token no longer makes shallow readiness fail, but stale comments still claim it does in [env.server.ts](/D:/apps/job-app/soft-house-dash-3/lib/env.server.ts:195) and [maintenance-token.ts](/D:/apps/job-app/soft-house-dash-3/lib/sqlite/maintenance-token.ts:14). The route description also incorrectly says the deep probe tests the object store at [routes.ts](/D:/apps/job-app/soft-house-dash-3/routes.ts:279).
- M23 and H2 work behaviorally, but permanent regressions for independently omitted R2 buckets and many randomized unknown-auth paths are still absent.

## Verification

My independent results:

- 630 unit tests passed across all 19 unit files.
- 218 integration tests passed across 16 files.
- 24 process tests passed; 1 intentional skip.
- Current CI smoke passed all 9 checks.
- `lint`/TypeScript, formatting, Knip, `bun dedupe --check`, Actionlint, and `bun audit` passed.
- The aggregate `bun run test` did not finish within my 304-second command limit, so I executed every unit file separately instead.
- `git diff --check` passed.
- No persistent files or repository artifacts were created or changed by my review.
