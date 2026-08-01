# Consolidated Backend API Review

## Detailed findings

### FIN-01 — `OTP_AUTO_VERIFY` creates unprotected identity and verification writers

**Severity:** High  
**Reported by:** Claude Opus, Claude Sonnet, Claude Fable  
**Locations:**

- `utils/config.ts`
- `app/api/dash/users/me/change-email/verify/handler.ts`
- `app/api/dash/users/me/change-phone/verify/handler.ts`
- `app/api/auth/otp/send/handler.ts`
- `app/api/auth/otp/verify/handler.ts`

**Problem**

With the shipped `OTP_AUTO_VERIFY = true` setting, two related protections are
removed:

1. The authenticated contact-change verify endpoints can directly commit a new
   email or phone from the request body without requiring the initiate step,
   current-password re-authentication, or a valid OTP proof.
2. Public OTP send/verify handlers can mark another account's submitted email or
   phone as verified without code or ownership proof.

The normal non-bypass flow is safer because its verification-session proof can
only be created through the gated initiate flow. The bypass branch removes that
transitive protection and replaces it with no equivalent control.

**Impact**

- A stolen, borrowed, or XSS-accessible session can change the victim's email to
  an attacker-controlled address, preserve the attacker's session, and enable
  password recovery to complete account takeover.
- An unauthenticated caller can make verification flags stop representing real
  contact ownership. This defeats future projects that enable mandatory contact
  verification without also discovering and disabling this independent flag.

**Recommended solution**

1. Default `OTP_AUTO_VERIFY` to `false`.
2. Make any bypass explicitly development-only and reject startup if it is
   enabled in production.
3. Remove auto-write behavior from public OTP handlers. They should return the
   normal privacy-preserving response without changing verification state.
4. Keep one contact-change writer. Since the initiate endpoint already commits
   in auto mode, make verify reject in that mode or accept only an idempotent
   request for the value already committed.
5. Add tests proving direct verify calls cannot change contact data without a
   valid initiate proof, and public requests cannot flip another user's
   verification flags.

### FIN-02 — A stale login proof can issue a session after credential rotation

**Severity:** High  
**Reported by:** Codex  
**Locations:**

- `lib/auth.ts`
- `lib/auth/passwordless.ts`
- `app/api/auth/forgot-password/reset/handler.ts`

**Problem**

Credential/passwordless proof acceptance and session insertion do not share one
atomic validity boundary. A request can verify the old password or consume a
passwordless proof, pause, then insert a new session after a concurrent password
reset or credential rotation has deleted all existing sessions.

This retained scope excludes the already-listed cookie-cache/deactivation gap.
The distinct issue is creation of a new database session from a proof accepted
before credential rotation.

**Impact**

Credential rotation can report success and revoke every existing session, yet a
concurrent stale authentication request can create a fresh long-lived session
after that revocation.

**Recommended solution**

Add a credential/session epoch:

1. Store an `authVersion` or credential epoch on the user.
2. Capture it when password/OTP proof succeeds.
3. Increment it in every credential, recovery-contact, and administrative
   rotation transaction.
4. Require the captured epoch to still match when the session is inserted.
5. Store the epoch in the session and reject it on later use if it no longer
   matches.

Where the auth framework permits it, session insertion and final epoch
comparison should be one transaction. Add a deterministic concurrency test for
proof accepted → rotation commits → session insert attempted.

### FIN-03 — Sign-in IP limiting is non-atomic and trusts the wrong IP source

**Severity:** High  
**Reported by:** Codex, Claude Opus  
**Locations:**

- `lib/auth.ts`
- `lib/audit.ts`
- `lib/rate-limit/auth-storage.ts`
- Better Auth rate-limiter/IP-resolution code

**Problem**

Better Auth's sign-in limiter has two independent defects:

- Admission uses separate read and later write operations. Parallel requests can
  all observe the same remaining quota and pass before increments are stored.
- Better Auth defaults to the first `x-forwarded-for` value or skips limiting
  when no IP resolves, while this application deliberately treats that header as
  client-controlled and uses trusted edge headers elsewhere.

The same untrusted value can also be written into session IP metadata.

**Impact**

Attackers can bypass the intended cross-account credential-stuffing limit by
forging/rotating `x-forwarded-for`, omitting the header, or sending concurrent
requests near the limit. Per-account lockout does not stop password spraying
across many accounts.

**Recommended solution**

1. Consume an atomic Redis token before credential work using the project's
   trusted, normalized client-IP resolver.
2. Fail closed when a trusted IP is unavailable on sign-in.
3. Configure Better Auth to use the same trusted edge header for session
   metadata.
4. Disable the duplicate Better Auth sign-in quota if it cannot provide atomic
   admission; keep one authoritative limiter.
5. Test forged forwarding headers, missing trusted headers, and parallel
   requests at the quota boundary.

### FIN-04 — Credential/contact rotation does not consistently revoke pending proofs

**Severity:** High  
**Reported by:** Codex, Claude Opus, Claude Sonnet  
**Locations:**

- `app/api/dash/users/me/change-password/handler.ts`
- `app/api/dash/users/me/contact-change.ts`
- Related forgot-password, passwordless, and contact-change verification flows

**Problem**

Self-service password change revokes sessions but leaves pending
`verification_sessions`. Contact-change commits also leave sibling proofs,
unlike the forgot-password and admin-edit paths.

The strongest scenario is an unconsumed `forgot_password` or
`passwordless_login` proof surviving a victim's password change. Related
contact-change proofs also survive identity changes, even where their current
exploitability depends on the remaining session.

**Impact**

An attacker holding a previously issued proof can reset the new password or mint
a session after the victim's remedial password rotation. Lesser stale
contact-change proofs preserve authority that should have ended with the
credential/identity change.

**Recommended solution**

Delete all user verification sessions in the same transaction as password
rotation. For contact changes, consume the current proof safely, then delete all
sibling proofs before commit. Centralize this as a credential-rotation cleanup
helper so password, email, phone, recovery, and admin paths enforce one policy.

Add tests for pending forgot-password, passwordless, and sibling contact-change
proofs across every rotation path.

### FIN-05 — OTP block and success transitions retain stale counters and block state

**Severity:** High  
**Reported by:** Codex, Claude Opus  
**Location:** `utils/otp.ts`

**Problem**

Several OTP transitions preserve state that belongs to a completed cycle:

- Expired-block handling clears `isBlocked` and `blockedUntil` but not the
  per-cycle verify counter. The next request immediately creates another full
  block.
- A boundary attempt can persist a block before checking whether the submitted
  code is correct. Retained flows can succeed while leaving the row blocked.
- Successful passwordless/retained flows do not reset send-cycle state, so
  ordinary successful use eventually reaches the send cap and creates a
  six-hour block.

**Impact**

An unauthenticated caller can renew a victim's block with roughly one request per
block period. Legitimate users can also self-block through repeated successful
flows.

**Recommended solution**

Model send-cycle, verify-cycle, rolling-daily, and proof-consumption state
separately:

1. On block expiry, reset the punished per-cycle counter before admitting a new
   attempt.
2. Verify the boundary-attempt code before persisting a block, or clear the block
   atomically on success.
3. On successful retained flows, reset send and verify cycle counters plus block
   fields while preserving only the intended rolling daily abuse counter.
4. Derive returned/audited state from `UPDATE ... RETURNING`, not stale local
   values.
5. Add exact-boundary, block-expiry, correct-code-at-cap, and repeated-success
   regression tests.

### FIN-06 — Phone credential rotation does not revoke other active sessions

**Severity:** Medium  
**Reported by:** Codex  
**Locations:**

- `app/api/dash/users/me/contact-change.ts`
- `lib/auth/passwordless.ts`

**Problem**

Email change revokes every session except the current one, but phone change does
not. Phone is also a passwordless credential, so replacing it should have the
same session-security semantics.

**Impact**

A session obtained through a compromised old phone can remain valid for its full
lifetime after the owner installs and verifies a new phone.

**Recommended solution**

Pass the current session ID into `commitPhoneChange` and revoke all other
sessions inside the phone-change transaction. Reuse one identity-rotation helper
for email and phone to prevent policy drift.

### FIN-07 — OTP quotas use inconsistent purpose, channel, destination, and global scopes

**Severity:** Medium  
**Reported by:** Codex, Claude Opus  
**Locations:**

- `lib/rate-limit/api.ts`
- `db/schema.ts`
- `utils/otp.ts`
- Public OTP and forgot-password send/verify handlers

**Problem**

The current quota model creates four conflicting behaviors:

1. DB rolling verification counters are stored on purpose-specific proof rows,
   multiplying a documented user/channel daily budget across purposes.
2. A shared destination send key allows public contact-verification traffic to
   consume a victim's password-recovery delivery budget.
3. SMS and WhatsApp use independent keys/rows for the same phone destination,
   doubling delivery and block budgets by switching transport.
4. Per-IP/per-destination limits bound one victim but do not provide a global
   outbound-cost circuit breaker.

**Impact**

Attackers can multiply guesses, sustain targeted recovery denial, double paid
messages to one phone, or generate high aggregate provider spend across many
recipients.

**Recommended solution**

Use hierarchical quotas:

- Global provider/day circuit breaker with alerting.
- Aggregate delivery cap per normalized contact kind and destination; treat SMS
  and WhatsApp as one phone destination.
- Per-purpose delivery caps.
- Reserved recovery capacity that public verification traffic cannot consume.
- Shared rolling verification-failure/block counter per
  `(userId, contactKind)`, separate from purpose-bound proof rows.
- Existing per-IP controls as an additional layer, not the primary cost bound.

Keep proof rows purpose-specific for security binding; move abuse accounting out
of those rows.

### FIN-08 — Password checks and storage use different canonical forms

**Severity:** Medium  
**Reported by:** Codex  
**Locations:**

- `utils/validation/rules.ts`
- `utils/validation/auth.ts`
- `lib/auth/check-password.ts`
- `lib/auth/password.ts`
- `app/api/dash/users/me/change-password/handler.ts`

**Problem**

Password storage/verification NFKC-normalizes input, while policy validation,
same-password comparison, and HIBP screening operate on raw Unicode.

**Impact**

A compatibility-equivalent raw password can pass breached-password screening
and raw old/new comparison, then normalize into a breached or unchanged stored
credential.

**Recommended solution**

Canonicalize once at the request boundary and use that exact value for policy
validation, equality checks, HIBP lookup, hashing, and verification. Document the
canonicalization contract and add compatibility-character regression tests.

### FIN-09 — Passwordless limiter failures escape as generic 500 responses

**Severity:** Medium  
**Reported by:** Codex  
**Locations:**

- `lib/auth/passwordless.ts`
- Better Call/Better Auth error boundary

**Problem**

Project rate-limit calls execute before the `try` block that converts project
`CustomError` values into Better Auth `APIError` values. Expected 429 throttles
and 503 limiter outages therefore become generic empty 500 responses, losing
rate-limit headers.

**Impact**

The path still fails closed, but clients receive the wrong status and cannot
respect `Retry-After`; monitoring also misclassifies normal throttling as server
failure.

**Recommended solution**

Move the complete passwordless endpoint body, including both limiter calls,
inside one conversion boundary. Map status, public message, and safe response
headers into `APIError`. Add tests for identifier limit, IP limit, missing
trusted IP, and Redis failure.

### FIN-10 — Coarse shared IP buckets throttle unrelated auth traffic

**Severity:** Medium  
**Reported by:** Codex, Claude Opus  
**Locations:**

- `lib/auth.ts`
- `lib/http/adapters/next.ts`

**Problem**

Two broad buckets combine unrelated workloads:

- Better Auth's base 10/min rule applies to `/get-session`, so ordinary session
  reads from users behind one NAT compete with sign-in-sensitive traffic.
- One `dash.preauth` scope covers dashboard routes plus forgot-password and
  passwordless routes, allowing one surface to throttle another.

**Impact**

Normal office/NAT traffic can cause deterministic 429/503 responses on session
reads or recovery flows. Anonymous recovery traffic can also degrade dashboard
access from the same egress IP.

**Recommended solution**

Create explicit per-route or per-surface scopes. Exempt `/get-session` from the
mutation-grade quota or give it a high/user-aware read budget. Keep tight,
atomic, fail-closed limits for sign-in and sensitive recovery mutations without
sharing their counters with dashboard reads.

### FIN-11 — Custom permission changes lack complete before/after audit records

**Severity:** Medium  
**Reported by:** Codex  
**Locations:**

- `lib/permissions/utils.ts`
- `app/api/dash/users/handler.ts`
- `app/api/dash/users/[id]/handler.ts`

**Problem**

Custom-role creation and in-place permission changes mutate `roles` and
`role_permissions`, but the associated user audit can omit the permission
matrix and show no meaningful role-ID change.

**Impact**

Investigators cannot reconstruct who granted or removed a sensitive permission,
such as `users.delete`, from the existing event alone.

**Recommended solution**

Write a dedicated custom-role/permission audit event in the same transaction.
Store role ID plus normalized old/new permission matrices and changed
permissions. Reuse the standard-role audit format so both role types have one
forensic contract.

### FIN-12 — Data-table filters do not bind columns to valid operators, types, or cost limits

**Severity:** Medium  
**Reported by:** Codex, Claude Opus, Claude Sonnet  
**Locations:**

- `lib/data-table/parsers.ts`
- `lib/data-table/filter-columns.ts`
- `db/queries/data-table.ts`
- Dashboard list handlers

**Problem**

Column names, variants, and operators are validated independently, not as valid
combinations. A text operator can reach a boolean/timestamp column and produce
invalid PostgreSQL casts or operators. Separately, text filters do not enforce
the three-character floor used by quick search, allowing short `ILIKE` filters
and scan-only `NOT ILIKE` predicates.

**Impact**

Authorized callers can cause deterministic 500 responses and repeated broad
table/count scans. Up to 20 predicates can amplify query cost.

**Recommended solution**

Define server-owned descriptors for every filterable column:

- Actual DB type and coercion rules.
- Allowed variants and operators.
- Null/empty semantics.
- Minimum input length for text-search operators.
- Whether an operator is scan-only and therefore disallowed or separately
  budgeted.

Reject invalid combinations with 422 before query construction. Do not silently
drop invalid filters because that can unexpectedly broaden results.

### FIN-13 — Date filters shift calendar boundaries across client/server timezones

**Severity:** Medium  
**Reported by:** Codex  
**Locations:**

- `components/ui/data-table/filters/filter-inputs.tsx`
- `lib/data-table/filter-columns.ts`

**Problem**

The browser sends a timestamp representing local midnight. The server then
reinterprets that instant and applies start/end-of-day operations in its own
timezone.

**Impact**

When client and server timezones differ, a selected calendar date or range can
query the previous/next day and return incorrect records.

**Recommended solution**

Choose one explicit contract:

- Send `YYYY-MM-DD` plus an authoritative business timezone and derive UTC
  boundaries server-side; or
- Send already computed inclusive/exclusive UTC boundaries from the client.

Prefer half-open ranges (`>= start`, `< nextDay`) to avoid end-of-day precision
problems. Add cross-timezone and daylight-saving tests.

### FIN-14 — Production log sanitization destroys structured diagnostic context

**Severity:** Medium  
**Reported by:** Codex, Claude Fable  
**Locations:**

- `utils/index.ts`
- Security/auth/rate-limit callers of `sanitizeForLog`

**Problem**

Production sanitization applies `String()` to plain diagnostic objects. These
become `"[object Object]"`, discarding event names, identifiers, attempts, and
nested error messages.

**Impact**

OTP delivery failures, rate-limit-store outages, race diagnostics, and unknown
constraint errors become indistinguishable precisely when incident response
needs them.

**Recommended solution**

Implement bounded structured serialization with:

- An allowlist of safe fields.
- Recursive redaction of passwords, OTPs, tokens, cookies, secrets, and provider
  bodies.
- Explicit nested `Error` conversion to safe name/message fields.
- CR/LF and Unicode line-separator removal.
- Depth, collection-size, and total-length limits.

Avoid unrestricted `JSON.stringify(input)`, which can restore context but leak
sensitive fields.

### FIN-15 — Expired login-lock audits use stale pre-reset state

**Severity:** Low  
**Reported by:** Codex  
**Location:** `lib/auth/login-guard.ts`

**Problem**

After an expired lock is reset in the database, local user values still contain
the old failure count. The next failure is correctly stored as attempt one, but
the audit can record attempt six and `accountLocked: true`.

**Impact**

Authentication behavior remains correct, but security telemetry misstates the
account state and can trigger false incident conclusions.

**Recommended solution**

Use `UPDATE ... RETURNING` as the authoritative post-state for auditing, or
reset local counter/lock variables immediately after the database reset.

### FIN-16 — Session management hides active sessions beyond the newest 50

**Severity:** Low  
**Reported by:** Codex  
**Locations:**

- `app/api/dash/users/[id]/handler.ts`
- `app/api/dash/users/[id]/sessions/handler.ts`

**Problem**

The session list is capped at the newest 50 without a cursor, while selective
revocation requires explicit session IDs.

**Impact**

An older compromised session cannot be discovered and selectively revoked while
preserving all newer legitimate sessions.

**Recommended solution**

Cursor-paginate sessions using `(createdAt, id)`. Also provide a transactional
“revoke all except current” operation as a safe emergency path.

### FIN-17 — Admin phone-change audits omit the previous value

**Severity:** Low  
**Reported by:** Codex  
**Location:** `app/api/dash/users/[id]/handler.ts`

**Problem**

Admin phone-change audit data includes the new phone but omits the prior phone
and related verification state, despite both being available from the locked
user row.

**Impact**

The event cannot independently reconstruct the identity change.

**Recommended solution**

When `phoneChanged` is true, include old/new phone numbers and old/new verified
flags in the same transactional audit event.

### FIN-18 — Unknown unique constraints are misreported as HTTP 409

**Severity:** Low  
**Reported by:** Claude Opus  
**Locations:**

- `utils/api-response.ts`
- Dashboard user create/update handlers

**Problem**

The unique-violation resolver returns an internal-error message for an unknown
constraint, but callers still wrap it in HTTP 409.

**Impact**

A code/schema mismatch appears to be a client conflict and bypasses 5xx
monitoring.

**Recommended solution**

Return `null` or a typed “unrecognized constraint” result. Map only known
user-correctable constraints to 409; let unknown constraints reach the standard
500 handler.

### FIN-19 — Raw-body presence detection can turn invalid admin updates into silent no-ops

**Severity:** Low  
**Reported by:** Claude Opus, Claude Sonnet  
**Locations:**

- `utils/validation/auth.ts`
- `app/api/dash/users/[id]/handler.ts`

**Problem**

Several schemas strip unknown keys, and `handleAdminEdit` determines phone-field
presence from the raw body instead of parsed data. A typo such as
`phone_number` can be stripped, interpreted as “phone not supplied,” and return
200 without performing the intended update.

The broader proposal to make every schema strict is not retained: source reports
also document deliberate, tested unknown-key stripping for some collection
contracts. The retained defect is the concrete raw/parsed-body mismatch and
misleading success.

**Impact**

Client integration bugs can silently fail while appearing successful.

**Recommended solution**

Represent `phoneNumber` as genuinely optional in the parsed schema and derive
presence only from parsed output. Make this admin-update schema strict if its API
contract does not intentionally allow unknown keys. Return 422 for an update
that contains no recognized mutable fields.

### FIN-20 — OTPs reuse the password KDF profile and password pepper lifecycle

**Severity:** Low  
**Reported by:** Claude Opus  
**Locations:**

- `utils/otp.ts`
- `lib/auth/password.ts`
- Password pepper/keyring utilities

**Problem**

Six-digit, short-lived, attempt-limited OTPs use the same high-memory Argon2id
profile and pepper keyring as passwords.

**Impact**

- OTP verify traffic creates avoidable memory pressure.
- Retiring a password pepper generation can make outstanding OTP verification
  fail with server errors until those codes expire.

**Recommended solution**

Use a dedicated OTP key lifecycle. HMAC-SHA-256 with a dedicated versioned
server secret is suitable for short-lived, single-use, strictly attempt-limited
codes; compare MACs in constant time. Keep previous OTP keys only for the short
code-expiry grace period. Do not store fast unkeyed hashes of six-digit codes.
