# Test Strategy Review — Probes, Isolation, and the VPS Target

**Date:** 2026-08-14 **Scope:** `scripts/probe/`, `db/index.ts`, `db/ws.ts`,
`lib/rate-limit/client.ts` **Question answered:** is the current "tests may
freely destroy the dev database and Redis" approach the right path to maximum
test quality, and does full isolation from the application still make sense once
the app runs on a VPS with a local Postgres and an in-memory store instead of
Redis?

---

## Short answer

The instinct is right, the mechanism is wrong, and there is a third problem
larger than both.

---

## 1. Real services are the correct call

The invariants under test **are** SQL. `processOtpVerify` relies on `FOR UPDATE`
row locks, a `SUM()` over independently-anchored daily counters, and deferred
throws so a block row still commits with the transaction. Replace Postgres with
a mock and the suite tests the mock, not the invariant.

Keep real Postgres. Do not accept repository-level mocking here.

---

## 2. "Unrestricted changes" is not isolation — it is the absence of isolation

`scripts/probe/dev-live/README.md` already documents the cost honestly: shared
fixtures, order-dependent state, and a prefix-wide `DEL rl:otp.send.*` that
removes keys the run never created.

Concrete consequences:

- Cannot run in CI, cannot run for two developers at once, cannot run in
  parallel.
- A failed run leaves poisoned state, so the next run fails for the wrong
  reason.
- `PROBE_STAMP` defaults to the hardcoded `900000001`, so collision is the
  default behaviour, not the exception.
- In `otp-verify-budget.dev-probe.ts`, the second test depends on the first
  having exhausted the phone budget. Reordering the file turns it green for the
  wrong reason.

The fix is not to restrict what tests may destroy. The fix is to make the thing
being destroyed **disposable per run**:

- Docker Postgres per run. Apply the `db/drizzle` migrations once into an
  `app_template` database, then `CREATE DATABASE t_<file> TEMPLATE app_template`
  per test file. Drop the container at the end.
- Destruction then costs nothing: no `afterAll` cleanup logic to get wrong, no
  cross-run leakage, no shared fixtures.
- Transaction-rollback isolation is **not** viable here. The application code
  opens its own transactions and takes row locks; wrapping it in an outer
  transaction changes the behaviour under test. The template-database approach
  is the correct one for this codebase.

---

## 3. The larger problem: the tests pin infrastructure that will not ship

This is what makes the current setup fundamentally flawed relative to the stated
future.

| Layer      | Tested today                                          | Planned on the VPS               |
| ---------- | ----------------------------------------------------- | -------------------------------- |
| Database   | `drizzle-orm/neon-http` + `db/ws.ts` (Neon WebSocket) | Local Postgres, different driver |
| Rate limit | Upstash Redis (`lib/rate-limit/client.ts`)            | `lru-cache` or similar           |

Both are provider-specific. Neither survives the move:

- The Neon HTTP driver cannot hold a lock across statements — each call is its
  own implicit transaction. Every transactional invariant in `utils/otp.ts` and
  `lib/auth/login-guard.ts` runs on the WebSocket path, which is equally
  Neon-specific.
- A local Postgres needs a Neon proxy for either driver to connect at all.

So the current probes certify **Neon + Upstash**. Production will be **local
Postgres + in-process cache**. A green suite would not be evidence about the
shipped product.

### Fix: contract tests

Define one interface per store, write one shared conformance suite, and run it
against every implementation:

```
tests/contract/rate-limit-store.suite.ts   // exported fn taking a store factory
tests/contract/upstash.test.ts             // runs the suite against Upstash
tests/contract/memory.test.ts              // runs the suite against lru-cache
```

Apply the same principle to the database: run the integration suite against the
driver that will actually be deployed. Perform the driver swap **before**
building the suite, otherwise the suite gets written twice.

---

## 4. Security warning — in-memory rate limiting is per-process

> This section is deliberately written without compression.

If Next.js runs on the VPS under PM2 cluster mode, systemd with multiple
workers, or more than one container, an `lru-cache` store gives every worker its
own counters. The application-wide OTP breaker (`otp.send.global`, 2000/day per
contact kind) then becomes 2000 × N. The login guard and the per-destination
caps fragment in exactly the same way.

That is a regression of a security invariant, not a performance detail. Per
`CLAUDE.md`, security invariants do not depend on traffic volume.

Options, in order of preference for this codebase:

1. **Postgres-backed counters.** The database is already local on the VPS,
   latency is sub-millisecond, and the OTP daily budget is already enforced
   transactionally in SQL. This removes an entire store from the stack.
2. **Local Redis or Valkey on the VPS.** Cheap, keeps the existing key space and
   the existing `lib/rate-limit` semantics unchanged.
3. **Genuinely single-process deployment** with `lru-cache`, enforced at boot by
   asserting the worker count rather than assuming it.

Whichever is chosen, the contract suite from §3 must include a
**concurrent-access** case. Without it, the swap looks correct in tests and
fails in production.

---

## 5. "Isolated from the application?" — isolate the environment, never the code path

- **Environment:** separate database, separate store, fake providers, its own
  env file. Total isolation. Yes.
- **Code path:** tests must enter through the same door a request does. The
  front-end has been removed, so the API surface _is_ the product. The
  highest-value tests call the route handlers through
  `lib/http/adapters/next.ts` with a real `Request`, asserting status, body
  shape and headers — not only internal functions.

The `mock.module('@/lib/rate-limit/index', …)` probes under
`scripts/probe/local/` are sound as unit probes, but they carry the drift risk:
they assert which identifiers were _consumed_, which stays green even if the
real store stops enforcing them. Keep them; they cannot be the only coverage of
that path.

---

## 6. Target layout

```
tests/unit/          pure, no IO, milliseconds        — run on every save
tests/contract/      store conformance                — every implementation
tests/integration/   docker Postgres + real handlers + fake providers
scripts/probe/       retire once the above exists
```

---

## 7. Bun tooling worth using

| Tool                                    | Use here                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `bunfig.toml` `[test] preload`          | Container boot, migrations, global teardown. Replaces per-file setup.                                            |
| `setSystemTime` from `bun:test`         | Directly applicable to the 24h budget anchoring and the DST cases, which are untestable without it.              |
| `Bun.sql`                               | Built-in Postgres client, zero dependencies, for `CREATE`/`DROP DATABASE` orchestration outside Drizzle.         |
| `Bun.$`                                 | Docker lifecycle in preload; avoids a Testcontainers dependency.                                                 |
| `Bun.serve`                             | Fake SMS/email provider as a real HTTP server. Better than mocking nodemailer — exercises timeout and 5xx paths. |
| `test.each` / `describe.each`           | The contract suite parameterized over implementations.                                                           |
| `bun test --rerun-each=20`              | Flake and order-dependence detection.                                                                            |
| `--coverage`, `--bail`, `expect.extend` | Coverage gates, fast failure, domain-specific matchers.                                                          |
| `bun test --env-file=.env.test`         | Prevents `.env` leaking into a suite that drops databases.                                                       |

---

## 8. Stated uncertainties

- I am not certain whether Bun 1.3.14 runs test **files** in parallel or
  sequentially within a single process. This affects template-database isolation
  and preload assumptions, and should be verified before the design depends on
  it.
- Testcontainers-node compatibility under Bun is unverified. `Bun.$` plus
  `docker run` avoids the question entirely.
- The cost of `CREATE DATABASE … TEMPLATE` on this schema has not been measured.
  The ~100ms figure is typical, not observed here.

---

## 9. Recommended order

1. Decide the production store now — single-process + `lru-cache`, local
   Redis/Valkey, or Postgres-backed counters. Everything downstream depends on
   this choice.
2. Swap the database driver to the one the VPS will run.
3. Build the disposable-Postgres harness in `preload`.
4. Port the two `dev-live` probes onto it. They become real tests, unchanged in
   intent.
5. Add the contract suite for the store, then the handler-level integration
   tests.
