# DEV ONLY — DESTRUCTIVE — DISPOSABLE SERVICES ONLY

Everything under `scripts/probe/dev-live/` connects to the **real** services in
`.env` and **writes to and deletes from them**. These are diagnostic probes for
a throwaway development database and a throwaway development Redis. They are not
tests.

**Never run these against CI, staging, production, or any environment whose data
you would miss.** They insert users and roles, spend OTP budgets, and delete
Redis keys by prefix. Nothing here isolates itself from other data in the same
service.

## Why they are not `*.test.ts`

`bun test` auto-discovers `*.test.ts` / `*.spec.ts`. These files are named
`*.dev-probe.ts` precisely so a future `bun test` in CI can never pick them up
by accident. They only run when a path is given explicitly:

```bash
bun run probe:db
```

That script passes `./scripts/probe/dev-live/database/*.dev-probe.ts` — the
leading `./` is not decoration. Without it `bun test` treats the argument as a
name FILTER, and since these files deliberately do not match the test glob it
reports "did not match any test files" and exits non-zero. A bare directory path
does not work either, with or without the `./`. Bun says so itself when it
happens: _"To treat the … filter as a path, run `bun test ./…`"_.

The script did not exist until the PostgreSQL driver swap, so the command this
README and both probe headers told you to run had never worked.

## What they do to your services

| Probe                                  | Effect                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `database/otp-verify-budget.dev-probe` | Inserts and deletes its own users/roles; writes verification rows                     |
| `database/driver-contract.dev-probe`   | Inserts and deletes its own users/roles/sessions; provokes real constraint violations |

`redis/otp-global-breaker.dev-probe` was removed with the Upstash migration. It
verified the C-02 breaker against real Redis keys, and nothing it targeted
exists any more: no Redis, no `rl:` key prefix, and the local SQLite driver
cannot even load under Bun, which is what runs these probes. The invariant
itself is still covered by `probe/local/otp-global-breaker.test.ts`, which
asserts the real call path with `rateLimit` stubbed. See TODO S-11.

## Relationship to the real test suite

These probes have known limitations that are acceptable here and unacceptable in
a real suite: shared fixtures between cases, order-dependent state, and
prefix-wide cleanup. Do not copy them into the production-grade suite described
in `reports/engineering-hardening-plan.md`. That suite should use unit tests
plus a disposable Postgres environment (e.g. Testcontainers) with equivalent
Redis isolation, so nothing depends on the developer's own services.

Pure probes with no live dependency live in `scripts/probe/local/` and are safe
to run anywhere.
