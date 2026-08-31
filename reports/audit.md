# Remaining and Partially Resolved Issues

## 1. Active and partially resolved findings

### R-01 — First-login origin rejection can occur after credential work

**Status:** Partial — low-severity resource ordering

For a first-login request without cookies, Better Auth's router-wide origin
middleware can defer validation. The custom `hooks.before` handler at
`lib/auth.ts:95-160` may execute `verifyLoginAttempt()` before endpoint-level
form-CSRF middleware forces origin validation.

CAPTCHA runs before this work, so this is not an authentication bypass. A
request with a valid CAPTCHA can still cause password and database work before
its untrusted origin is rejected.

Completion requirement:

- Reject untrusted first-login origins before `verifyLoginAttempt()`; and
- retain a test proving an untrusted-origin request never reaches credential or
  database verification.

### R-02 — Readiness timeout contract can abandon future probes

**Status:** Partial — contract hardening

The readiness pool has fixed two-second connection and database-side deadlines,
but exported `pingDatabase(timeoutMs)` at `db/index.ts:98-121` accepts any
caller-supplied timeout. A future caller can pass a smaller value, return before
the database operation ends, and leave the single-flight probe occupied until
the fixed pool deadline.

Completion requirement:

- Derive the HTTP and database deadlines from one invariant, or make the probe
  deadline internal and non-configurable; and
- retain a silent-peer regression test covering response latency, repeated
  probes, pool occupancy, and shutdown.

### R-03 — SMTP has stage timeouts but no total delivery deadline

**Status:** Partial — availability

`utils/otp.ts:31-48` configures independent five-second DNS, connection,
greeting, and socket timeouts. These stages can accumulate; they do not enforce
a five-second wall-clock boundary around `sendMail()`.

An authenticated request and shutdown drain can remain occupied longer than the
nominal provider timeout.

Completion requirement:

- Add one total delivery deadline with explicit cancellation/cleanup behavior;
- test a provider that stalls in each SMTP phase; and
- verify refund, cooldown, and matching-code deletion behavior after timeout.

### R-04 — Deployment runbook contradicts current runtime behavior

**Status:** Open — operational correctness

`reports/coolify-deployment.md` contains these stale statements:

- Lines 404-409 say the health check reads SQLite only and cannot detect an
  unreachable PostgreSQL database; the shallow health route now checks
  PostgreSQL and reports it as `checks.postgres`.
- Line 835 says post-response drain is ten seconds; code uses 25 seconds.
- Lines 855-859 say drain timeout exits zero and no real work is enqueued.
- Lines 879-880 say the forced timer closes stores; current code deliberately
  leaves them open when work has not quiesced and exits non-zero.

Completion requirement:

- Reconcile the runbook with the current health route and `server.ts`; and
- add a documentation check or review gate for duplicated operational constants
  and shutdown semantics.

### R-05 — Comment policy cleanup remains incomplete

**Status:** Open — maintainability

The codebase still contains comments prohibited by the standing engineering
standard: change history, section banners, restated behavior, embedded version
measurements, and long explanations that belong in reports. Examples begin at
`db/index.ts:1`, `lib/auth.ts:72`, and several schema section banners.

Completion requirement:

- Sweep the repository by comment class;
- retain only non-local invariants and external constraints; and
- move historical evidence and measurements into reports.

## 3. Missing test-strategy requirements

The following items from `reports/test-strategy.md` are not fully implemented.

### 3.1 HTTP layer

- CORS preflight headers and max-age.
- OTP limiter rejection proving the request body was not consumed.
- Memoized double-read behavior for `FormData`.
- Complete table-driven route-manifest conformance:
  - every route is reachable;
  - `no-store` is preserved;
  - auth-prefix edges are covered; and
  - runtime and manifest route sets are equal.
- Process test proving Better Auth `baseURL === PUBLIC_ORIGIN` when only
  `PUBLIC_URL` is set.
- Response-policy regressions for conflicting CSP, genuine pipeline `500`,
  multiple `Set-Cookie` values including `Partitioned`, and immutable headers.
- OpenAPI negative drift tests and a generic required-versus-runtime-optional
  walk.
- Scanner regression suite for all negative cases, one positive case, and
  process exit codes.

### 3.2 SQLite

- Statement-handle behavior after database close.
- Lock-order test proving `busy_timeout` controls real wait behavior.

### 3.3 PostgreSQL

- Advisory-lock mutual exclusion and release at transaction commit.
- Pool lifecycle contract:
  - closing a live pool;
  - query-after-close failure; and
  - no hanging process handle.
- Complete raw/Drizzle mapping for counts, numeric, JSON/JSONB, arrays, and UUID.
- Migration-runner verification:
  - exact table, enum, extension, and index inventory;
  - migration ledger rows and timestamps;
  - second-run no-op; and
  - clean `db:generate` gate.

### 3.4 Pure logic

- Full `DASHBOARD_PAGES x PERMISSION_ACTIONS` action-scope matrix.
- Complete permission sanitization, normalization, equality, diff, and scope
  validation suites.
- Complete `preAuthScope` edge matrix.
- Exact rate-limit retry-after, degraded-mode, fail-open, and fail-closed
  behavior.
- Direct `returnNumber` and `extractIdFromUrl` tests.
- Exhaustive Zod boundary, strictness, preprocessing, and hostile sanitizer
  coverage.
- Data-table tests for `escapeLike`, `getColumn`, and operator/type combinations.
- Password-pepper configuration unit matrix.
- API error/validation mapper matrix, including retained headers.
- R2 cache-control, public URL, MIME allowlist, and configuration-status tests.
- Complete hostile filename sanitization matrix.
- UUIDv7 generation beyond 4,096 IDs in one millisecond and under clock rollback.
- Pure route-manifest lookup, `Allow`, prefix, and static-ordering tests.

Strategy text requiring correction:

- It expects unknown sorting columns to be rejected; the current contract drops
  them.
- It assigns generated-ID and Windows-device-name behavior to filename
  sanitization, while current ID generation occurs at another layer.

### 3.5 Integration behavior

- Concurrent correct OTP consumption proving exactly one success.
- OTP advisory-lock mutual exclusion.
- Parallel wrong-password attempts with exact counter increments.
- Permission database-path cases for inactive-role and no-role users.
- Table-driven authorization enforcement for every mutating route.
- Upload properties for retained alpha, SVG exclusion from raster/blurhash work,
  and white-composited blurhash generation.
- `editOwn` session parity on both pagination pages.
- Keyset pagination with a row inserted between pages.

### 3.6 Better Auth contract

- Full sign-in, cookie-cache session, database session, and sign-out sequence,
  including metadata and zero remaining session rows.
- Complete origin behavior matrix.
- Reachable origin and `405` error-code localization with status preservation.

### 3.7 Coverage policy

- The strategy's narrow exhaustive per-module coverage gate is not implemented;
  the repository uses an aggregate integration-LCOV ratchet.
- No retained self-test proves the coverage checker fails under an impossible
  threshold.
