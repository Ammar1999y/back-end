# Evidence relocated from code comments

Measurements and change history that used to live in source comments. The code
keeps the decision; this file keeps what was observed when it was taken, so a
reader who wants to re-check a number knows what to reproduce.

## `db/index.ts` — one `bun:sql` pool

**Decision kept in code:** one pooled client per process; every session-scoped
construct (`FOR UPDATE` across statements, `pg_advisory_xact_lock`, `SET LOCAL`)
relies on a transaction running on one backend connection.

**History.** The file previously used `drizzle-orm/neon-http`, with a second
Neon WebSocket driver in `db/ws.ts`. `neon-http` sends one HTTPS request per
query, each its own implicit transaction, so nothing session-scoped worked;
`db/ws.ts` bought that back by constructing and destroying a connection pool per
transaction.

**Measurement (Bun 1.4.0, PostgreSQL 18.6).** Every statement inside a
`db.transaction()` block ran on one backend PID, and `pg_advisory_xact_lock` was
visible in `pg_locks` for that PID.

## `db/index.ts` — the readiness probe's own pool

**Decision kept in code:** the probe has its own single-connection pool with
`statement_timeout` and `connectionTimeout` set from one constant, and the probe
is single-flight on the query itself.

**Measurement (Bun 1.4.0, deliberately hanging PostgreSQL).** Racing a
`select 1` issued through `db.execute` on the application pool against a sleep
abandoned the query without stopping it: `Query.cancel()` set `cancelled: true`
while the backend kept running, and the next two application queries waited
5.5 s for the abandoned one to finish. With `statement_timeout` on a separate
pool, the same probe errored out at 2.0 s and the application pool answered in
1 ms.

**Why the single-flight moved to the query.** Clearing the shared entry when the
caller's race settled let every poll of the public health route start a new
statement behind the abandoned one on the single connection.
`tests/process/postgres-probe.test.ts` asserts the current behaviour against a
silent peer.

## `lib/auth.ts` — where `loginSuccess` is written

**Decision kept in code:** the `session.create.after` hook is the only writer of
`loginSuccess`; `verifyLoginAttempt` writes a purpose-labelled
`passwordVerified` event instead.

**History.** `loginSuccess` used to be written by `verifyLoginAttempt` from the
`before` hook — ahead of the session-creation gates that can still reject an
inactive role, a missing required role or an unverified contact — and from three
already-authenticated re-authentication routes. A fully rejected sign-in and a
routine password re-prompt therefore produced the same audit row as a completed
login. `tests/integration/sign-in-controls.test.ts` ("what the audit trail claims
about a login") pins the split.

## `server.ts` — the post-response drain

**Decision kept in code:** `AFTER_RESPONSE_DRAIN_MS` is derived from the OTP
provider deadline plus a fixed allowance for the refund transaction.

**History.** The drain was 10 s, then 25 s: Nodemailer's four independent 5 s
phase timeouts meant a delivery could still be in flight at 10 s, and expiring
early skipped `refundFailedDelivery`, so a user whose message was never delivered
lost one of `OTP_MAX_ATTEMPTS`. The delivery now has a single wall-clock deadline
(`lib/smtp.ts`), so the drain is sized from that deadline rather than from a
sum of phase timeouts.
