Verified against the current dirty working tree. Do not apply [audit.md](/D:/apps/job-app/soft-house-dash-3/reports/audit.md) verbatim.

At parent-item level:

- 25 findings/test gaps confirmed.
- 19 partially confirmed or overstated.
- 3 stale, optional, or inaccurate.
- No fixes, comments, or report edits applied.

Missing coverage means “no retained test,” not necessarily broken production behavior.

## Active findings

| Item | Verdict                               | Verified result                                                                                                                                                                                                                                                                                                                                                               |
| ---- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-01 | Confirmed, Low                        | [lib/auth.ts](/D:/apps/job-app/soft-house-dash-3/lib/auth.ts:134) performs password/database work before endpoint origin validation for cookie-less sign-in. Reproduction returned `403` with `beforeRan: true`. Current password-proof work also leaves an abandoned proof until expiry. Not an authentication bypass.                                                       |
| R-02 | Partial, Low latent risk              | The report’s mechanism is wrong. [pingDatabase](/D:/apps/job-app/soft-house-dash-3/db/index.ts:81) clears single-flight when the caller race times out, while SQL continues. Repeated short calls can queue abandoned queries. Current sole caller uses the same two-second deadline, so no active production failure is proven.                                              |
| R-03 | Confirmed, Medium                     | [utils/otp.ts](/D:/apps/job-app/soft-house-dash-3/utils/otp.ts:31) has phase/inactivity timeouts, not a total delivery deadline. A Nodemailer 9.0.5 reproduction with 100 ms phase timeouts completed after 483 ms. Periodic peer activity can hold delivery indefinitely. A bare `Promise.race` or current non-pooled `transporter.close()` will not cancel the active send. |
| R-04 | Confirmed, Low; broader than reported | [coolify-deployment.md](/D:/apps/job-app/soft-house-dash-3/reports/coolify-deployment.md:404) is also stale about PostgreSQL health, SMTP occurring after commit, OTP work actually being enqueued, conditional store closure, and forced exit behavior.                                                                                                                      |
| R-05 | Partial, Low                          | Banners, history notes, restatements, measurements, and dead commented code violate policy. But comments describing security/lifecycle coupling in `lib/auth.ts`, `server.ts`, `lib/schedule.ts`, and `lib/auth/otp-hash.ts` are legitimate and should remain, perhaps shortened.                                                                                             |

R-01 matches Better Auth’s documented origin model; R-03 matches Nodemailer’s separate SMTP timeout semantics. Sources checked: [Better Auth security](https://better-auth.com/docs/reference/security), [Nodemailer SMTP](https://nodemailer.com/smtp), [Bun SQL](https://bun.com/docs/runtime/sql), and [Bun 1.4 notes](https://bun.com/blog/bun-v1.4).

## Missing-test verification

### HTTP and Better Auth

| Audit item                                    | Verdict                                                                                                                                                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CORS preflight headers/max-age                | Confirmed missing.                                                                                                                                                                                                    |
| OTP limiter rejection before body consumption | Confirmed missing across all five sibling handlers.                                                                                                                                                                   |
| Memoized double-read `FormData`               | Confirmed missing. JSON double-read is covered.                                                                                                                                                                       |
| Route-manifest conformance                    | Partial: reachability, universal `no-store`, and runtime equality are missing; auth-prefix GET/POST/HEAD behavior already has substantial coverage.                                                                   |
| `baseURL === PUBLIC_ORIGIN` process test      | Test missing; implementation reproduced as correct.                                                                                                                                                                   |
| Response policy                               | Partial: conflicting CSP, pipeline `500`, `Partitioned`, and immutable-header tests missing. Existing real sign-in preserves two cookies. Bun 1.4 reproduction preserved cookies through mutable and immutable paths. |
| OpenAPI negative drift/generic schema walk    | Partial: negative branches and generic walk missing; specific required-key and uniqueness assertions exist.                                                                                                           |
| Registration scanner suite                    | Confirmed missing. CI only runs the scanner against the real tree.                                                                                                                                                    |
| Full Better Auth lifecycle                    | Partial: sign-in, cookies, cached/database session reads exist; HTTP sequence, `roleName`, sign-out, and zero remaining rows are missing.                                                                             |
| Complete origin matrix                        | Confirmed missing.                                                                                                                                                                                                    |
| Origin/405 localization                       | Mixed: origin localization/status is missing. Better Auth `405` localization is stale—the application router deliberately returns `405` before Better Auth.                                                           |

Evidence anchors: [request-body-policy.test.ts](/D:/apps/job-app/soft-house-dash-3/tests/unit/request-body-policy.test.ts:41), [auth-prefix-allowlist.test.ts](/D:/apps/job-app/soft-house-dash-3/tests/integration/auth-prefix-allowlist.test.ts:136), and [openapi-contract.test.ts](/D:/apps/job-app/soft-house-dash-3/tests/unit/openapi-contract.test.ts:145).

### SQLite and PostgreSQL

| Audit item                                       | Verdict                                                                                                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite statement after close                     | Confirmed missing.                                                                                                                                  |
| Real SQLite `busy_timeout` lock ordering         | Confirmed missing; current test only reads the final pragma.                                                                                        |
| Advisory-lock mutual exclusion/release           | Confirmed missing. Existing test proves only lock visibility in one backend.                                                                        |
| Pool close/query-after-close/no-handle lifecycle | Confirmed missing.                                                                                                                                  |
| Raw/Drizzle type mapping                         | Partial. Timestamps, UUID use, and JSONB have coverage; counts, numeric, plain JSON, arrays, and complete raw-versus-Drizzle comparison do not.     |
| Migration runner                                 | Partial. Real migrations and table presence are exercised; exact inventories, ledger timestamps, second-run no-op, and clean `db:generate` are not. |

Evidence anchors: [sqlite-migration-race.test.ts](/D:/apps/job-app/soft-house-dash-3/tests/process/sqlite-migration-race.test.ts:181), [driver-contract.test.ts](/D:/apps/job-app/soft-house-dash-3/tests/integration/driver-contract.test.ts:560), and [harness.test.ts](/D:/apps/job-app/soft-house-dash-3/tests/integration/harness.test.ts:42).

### Pure logic

| Audit item                                 | Verdict                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| Full action-scope matrix                   | Partial; targeted cases and empty matrices exist.                           |
| Permission helper suite                    | Partial; most helper contracts lack direct coverage.                        |
| `preAuthScope` matrix                      | Partial; real-route collapsing exists, edge matrix does not.                |
| Rate-limit retry/degraded/failure behavior | Confirmed missing.                                                          |
| `returnNumber` / `extractIdFromUrl`        | Confirmed missing.                                                          |
| Exhaustive Zod boundaries                  | Partial; broad hostile-input coverage exists, not a complete schema matrix. |
| Data-table helper/operator matrix          | Partial.                                                                    |
| Password-pepper configuration              | Confirmed missing.                                                          |
| API error mapper/retained headers          | Partial; real database errors are covered.                                  |
| R2 helper matrix                           | Confirmed missing.                                                          |
| Hostile filename matrix                    | Partial.                                                                    |
| UUIDv7 >4,096/clock rollback               | Confirmed missing.                                                          |
| Pure route-manifest helpers                | Partial.                                                                    |

Two claimed strategy corrections are already acknowledged at the top of [test-strategy.md](/D:/apps/job-app/soft-house-dash-3/reports/test-strategy.md:20): unknown sorts are dropped, and filename sanitization does not own generated IDs or Windows-device handling. Lower stale prose still needs removal. No production behavior change is warranted.

### Integration behavior

| Audit item                                | Verdict                                                                                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent correct OTP consumption        | Confirmed missing.                                                                                                                                  |
| OTP advisory-lock mutual exclusion        | Confirmed missing.                                                                                                                                  |
| Parallel wrong-password exact increments  | Confirmed missing, including after concurrent sign-in test edits.                                                                                   |
| Inactive-role/no-role permission DB paths | Confirmed missing.                                                                                                                                  |
| Every mutating route authorization matrix | Confirmed missing.                                                                                                                                  |
| Upload alpha/SVG/blurhash properties      | Partial: real SVG upload already succeeds, indirectly proving no raster decode; alpha and persisted-null/white-composite properties remain missing. |
| `editOwn` session pagination parity       | Confirmed missing.                                                                                                                                  |
| Keyset insertion between pages            | Confirmed missing.                                                                                                                                  |

### Coverage policy

- Narrow per-module gate: real conflict between strategy and current aggregate LCOV ratchet, but this is an owner-policy decision—not a demonstrated defect.
- Retained impossible-threshold self-test: audit characterization is inaccurate. The strategy required a one-time check, not retained automation.

Recommendation: retain the aggregate denominator/rate ratchet and add narrow exhaustive tests for security-critical functions. Do not add a path-based per-module gate that cannot isolate the target symbol.

## Proposed action plan

### 1. Correct the requirements first

- Update the audit/strategy descriptions for R-02.
- Remove the unreachable Better Auth `405` requirement.
- Remove already-acknowledged sorting and filename claims.
- Narrow the response-policy cookie rationale to observed behavior.
- Record the aggregate-coverage decision.
- Split every “Partial” item so existing coverage is preserved, not duplicated.

### 2. Fix runtime behavior

1. R-03: introduce a per-send SMTP adapter that owns and can close the active connection. Add one total deadline and await cancellation cleanup.
2. R-01: invoke Better Auth’s exported `formCsrfMiddleware` before `verifyLoginAttempt()`.
3. R-02: remove the caller-controlled probe timeout, retain the underlying SQL promise as single-flight, and keep HTTP response safety separate.
4. Update the deployment runbook only after these timeout/shutdown semantics settle.

SMTP policy assumption for review: after a post-`DATA` final-reply timeout, fail closed—invalidate only the matching code, safely refund its limiter state, and allow resend. This can produce a delivered-but-invalid email, but avoids multiple valid authentication codes.

### 3. Add security and concurrency regressions

- Full origin matrix and end-to-end Better Auth lifecycle.
- Concurrent OTP exactly-once and advisory-lock release.
- Parallel wrong-password exact counter accounting.
- Inactive-role/no-role permission paths.
- Table-driven mutating-route authorization.
- Limiter-before-body checks across all OTP handlers.

Any failing regression becomes a separate production fix before continuing.

### 4. Add database contract coverage

- SQLite statement-close and real held-lock ordering tests.
- PostgreSQL pool lifecycle in a child process.
- Two-session advisory mutual exclusion and release-at-commit.
- Only the missing type mappings.
- Exact migration inventory, ledger, idempotency, and `db:generate` comparison in an isolated temporary workspace.

### 5. Consolidate HTTP contract tests

- One manifest-driven suite for reachability, `Allow`, redirects, `no-store`, auth-prefix edges, localization, and runtime equality.
- CORS preflight and PUBLIC_URL-only process checks.
- Response-policy and OpenAPI negative suites.
- Scanner fixtures and exit-code tests.

This avoids separate tests for the same routing contract.

### 6. Fill focused pure/integration gaps

Priority order:

1. Pepper, permissions, rate-limit failure modes, error mapping.
2. Zod and data-table boundaries.
3. R2, filename, UUID, route-manifest helpers.
4. Upload alpha/blurhash, session parity, and inserted-row pagination.

`returnNumber` should be exercised through its public consumer unless extraction produces a genuinely reusable boundary; do not export internals solely for testing.

### 7. Finish low-risk cleanup

- Reconcile the runbook.
- Remove objective comment violations.
- Preserve non-local security, compatibility, and shutdown invariants.
- Run full verification:
  - `bun run test:all`
  - `bun run build`
  - `bun run lint`
  - `bun run format:check`
  - `bun run find:unused-files`
  - `bun run check:coverage`
  - focused scanner, migration, and process fixtures

## Verification performed

Focused retained suites passed:

- Sign-in controls: 22/22.
- OTP send boundary: 4/4.
- Request-body policy: 15/15.
- OpenAPI contract: 50/50.
- Permission scope: 26/26.
- Input boundaries: 100/100.
- Rate-limit cost guard: 9/9.
- Shutdown lifecycle: 2/2.
- Existing coverage checker: exit 0; 116 files, 61.97% lines, 73.27% functions.

Limitations: no live Coolify/VPS exercise, no full 135-second forced-shutdown run, and no complete test-suite rerun. A scanner invocation was contaminated by a transient test fixture and was discarded as evidence.

The tree changed concurrently during verification, including sign-in and two-factor work. I re-read affected flows. No persistent change was made by me or the verification subagents.
