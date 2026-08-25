# Test Strategy — implementation brief

**Updated:** 2026-08-20 · **Toolchain measured against:** Bun `1.4.0`
(`34cbb9a40`), PostgreSQL `18.6`, `elysia@1.4.29`, `better-auth@1.7.1`,
`drizzle-orm@0.45.2`, `zod@4.4.3` · **Status:** nothing here is implemented.

**How to read this.** §1–§6 are the environment, the harness and the tooling —
build them first, in that order. §7 is the assertion catalogue: what must be
proven and why, grouped by area, one entry per property. §8–§10 are the gate,
the accepted gaps and the sequencing.

**Two standing rules for whoever implements this.** They are why several
entries below look pedantic:

- **Never assert against a hand-authored fixture where a real one is
  reachable.** A test that manufactures a driver error and then asserts the
  reader read it is circular; it passes for any invented spelling. Provoke the
  real failure.
- **A property is only proven at the layer it can fail at.** SQL-level
  behaviour needs a SQL-level assertion, transport-level behaviour needs a
  socket, signal handling needs a real process. Every entry below names its
  seam for that reason.

Every earlier revision of this document is superseded. Sections that used to
argue about drivers, stores, Neon branching, `lru-cache`, vitest and
testcontainers are gone: those questions are closed and the closures are in §1.

---

## 1. Decisions already taken

Do not re-litigate these; they are the premises the catalogue is written
against.

| Decision                                   | Choice                                                                  | Consequence for the suite                                                                                                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test runner                                | `bun test` only                                                         | No vitest, no `@vitest/coverage-v8`, no external assertion or mocking library. Coverage is built in.                                                                                  |
| Container orchestration                    | None locally                                                            | No `@testcontainers/postgresql`. It installs and constructs under Bun but `.start()` hangs past 120 s with no Docker daemon. CI's `services:` block is declarative and needs nothing. |
| PostgreSQL client                          | `bun:sql` + `drizzle-orm/bun-sql`, one pooled client in `db/index.ts`   | Session continuity exists, so `FOR UPDATE`, advisory locks and savepoints are all testable. `db/ws.ts` is deleted.                                                                    |
| Rate-limit / cache store                   | Local SQLite via `bun:sqlite`, owned fixed-window algorithm             | `now` is client-supplied, so window behaviour is drivable with `setSystemTime`. No Upstash, no Lua, no network.                                                                       |
| Contract tests between two implementations | Dropped                                                                 | One implementation, tested directly. `tests/contract/` does not exist.                                                                                                                |
| Per-process rate limiting                  | Accepted, deferred                                                      | Single-process deployment. Multi-process contention is a bench question, not a test one.                                                                                              |
| Where destructive tests run                | Developer machine and CI only                                           | §3. Production VPS gets a read-only smoke set in a separate harness and nothing else.                                                                                                 |
| Database ownership                         | Tests own the database **because it is disposable**                     | Not "granted permission on a durable one". Full ownership plus ephemeral is the norm; full ownership plus persistent-and-shared is the anti-pattern.                                  |
| Honesty about what the suite proves        | These tests prove the invariants hold **on the stack they run against** | Implementation-independence is a minimum-two-point property and is not claimed.                                                                                                       |

---

## 2. Measured facts about the toolchain

Measured on this machine today, not read from documentation. Three of these
reverse an earlier plan.

| Fact                                              | Result                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local PostgreSQL                                  | **Present** — 18.6, superuser, `rolcreatedb = true`, `max_connections = 100`. `psql`, `pg_ctl` and `docker` are all absent from `PATH`; the server is reachable only over TCP. An earlier revision concluded there was no local PostgreSQL and planned around CI only.                                              |
| `CREATE DATABASE` (empty)                         | ~616 ms                                                                                                                                                                                                                                                                                                             |
| `bun run db:migrate` into a fresh database        | ~1045 ms — both phases, 9 tables, 8 enums, `pg_trgm`, 4 GIN indexes                                                                                                                                                                                                                                                 |
| `CREATE DATABASE … TEMPLATE <migrated>`           | 455–1347 ms over six runs. An earlier revision quoted ~100 ms as typical; it was never observed.                                                                                                                                                                                                                    |
| `DROP DATABASE … WITH (FORCE)`                    | ~1.5 s alone, 16.5 s for five in a loop                                                                                                                                                                                                                                                                             |
| `TRUNCATE <9 tables> RESTART IDENTITY CASCADE`    | 190–272 ms                                                                                                                                                                                                                                                                                                          |
| `CREATE SCHEMA` / `DROP SCHEMA … CASCADE`         | 21 ms / 2 ms                                                                                                                                                                                                                                                                                                        |
| Cloning a template with any connection open to it | **Fails** — `source database "…" is being accessed by other users`                                                                                                                                                                                                                                                  |
| `bun test` and `.env`                             | **`.env` is auto-loaded.** Every test process sees the development `DATABASE_URL` unless something overrides it. `--no-env-file` suppresses it, `--env-file=<path>` replaces it, and under `NODE_ENV=test` a `.env.test` wins over `.env`.                                                                          |
| `--preload` ordering                              | Top-level `await` in a preload completes before the first test module is imported, so a preload can rewrite `process.env` and the application's module-load-time reads will see it.                                                                                                                                 |
| Worker identity                                   | `BUN_TEST_WORKER_ID` and `JEST_WORKER_ID` are set (1-based) under `--parallel` and **undefined** without it. Handle both.                                                                                                                                                                                           |
| Fake timers                                       | `jest.useFakeTimers`, `setSystemTime`, `advanceTimersByTime`, `advanceTimersToNextTimer`, `runAllTimers`, `runOnlyPendingTimers`, `getTimerCount`, `clearAllTimers`, `useRealTimers` — all present, driving both `setTimeout` and `Date`. `jest.unstable_mockModule` does **not** exist; `mock.module` is the seam. |
| `test.failing`                                    | Present and inverting: a failing body reports as a pass, a body that **starts** passing fails with `this test is marked as failing but it passed`. The right tool for a known-open gate.                                                                                                                            |
| `coverageThreshold` in `bunfig.toml`              | Honoured. **Trap:** plural keys `lines` / `functions` / `statements` gate; the singular `line` / `function` are **silently ignored** — 33 % function coverage passed `{ function = 0.99 }` with exit 0.                                                                                                             |
| File parallelism                                  | Sequential in one process by default; `--parallel=N` gives worker processes with distinct pids and overlapping execution.                                                                                                                                                                                           |

---

## 3. Where the tests run

| Environment           | Runs                        | Database it touches                                                                                    |
| --------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Developer machine** | Everything                  | Local PostgreSQL, in databases whose names end `_test` and which the harness created. **Never `app`.** |
| **GitHub Actions**    | Everything, sharded         | A `postgres:18-alpine` `services:` container, destroyed with the runner VM                             |
| **Production VPS**    | **Nothing from this suite** | Production, read-only, from a separate smoke harness                                                   |

**CI has no persistent database, which is better than having one.** The runner
VM ships with Docker, so a `services:` block starts PostgreSQL beside the job;
the job migrates it, runs the suite, and container and VM both evaporate.
Nothing persists, so a destructive suite has nothing to damage and needs no
cleanup logic. Docker is required on GitHub's machine, not on this one. Pin the
container's PostgreSQL major to the VPS's, or one fidelity gap is traded for a
smaller one rather than closed. Actions minutes are free while the repository is
public; an integration job is 2–3 minutes.

**The production VPS must not run this suite, and the guarantee has to be
structural.** The suite truncates tables, creates and drops databases, exhausts
rate-limit budgets and inserts users and sessions. The only reliable way to keep
it away from production data is for production credentials never to exist in the
environment that runs it — so there is no test database on the VPS: not a second
database on the same instance, not a second instance on the same box. Procedural
discipline fails eventually; environmental separation does not.

What does belong on the server is a **read-only** post-deploy smoke set —
health, migration version, `/openapi.json` answering 200, one known-good
login — in its own harness, kept separate for a specific reason: the day someone
adds a `DELETE` to a suite that runs against production, the separation stops
protecting everything else too.

The cost of CI-as-the-integration-environment is the feedback loop: integration
tests only run on push. `--changed` locally is the mitigation, and now that a
local PostgreSQL exists the same suite runs locally against the same harness —
only `TEST_DATABASE_URL` differs.

---

## 4. The harness

### 4.1 PostgreSQL

One file, `tests/helpers/database.ts`, imported by the integration preload and
by nothing else.

**a. The variable is `TEST_DATABASE_URL`; `DATABASE_URL` is derived from it.**
The harness reads `TEST_DATABASE_URL`, computes the per-worker database name and
writes the result into `process.env.DATABASE_URL` **inside the preload**, before
`db/index.ts` is imported. The pool is constructed at module load from
`DATABASE_URL`, so the rewrite must happen earlier than any application import,
and `--preload` is the only hook that reliably is.

**Only the rewrite belongs in the preload — not the provisioning.** A preload
runs once per worker, and once per FILE under `--isolate`, so a
`CREATE DATABASE … TEMPLATE` there is N processes racing to clone one template,
which PostgreSQL refuses outright while any connection to the template is open.
Teardown is worse: a preload's `afterAll` fires more than once per worker and not
at all when a worker is killed, so a drop registered there is both premature and
unreliable. Provisioning and dropping therefore sit in a runner **upstream** of
`bun test` — one sequential provisioner, then a `finally` around the child
process — and the workers only ever open a database that is already waiting for
them.

**b. Four guards, because `.env` auto-loads.** This is the sharpest hazard in
the plan. `bun test` reads `.env`, so the development `DATABASE_URL` — pointing
at `app`, with the developer's real data — is in every test process by default.
A harness that merely _prefers_ `TEST_DATABASE_URL` and falls back is one
missing variable away from truncating the dev database. Assert and hard-exit,
never skip:

1. `TEST_DATABASE_URL` is set. Absent is a failure, not a fallback.
2. `current_database()` ends with `_test` — asked of the server after
   connecting, not parsed out of the URL, because the URL is what would be
   wrong.
3. The resolved test URL and the `.env` `DATABASE_URL` differ in database name.
4. `NODE_ENV !== 'production'`.

Separately, run the suite with `NODE_ENV=test` so `.env.test` takes precedence
over `.env`. `.env.test` holds `TEST_DATABASE_URL` and a `DATABASE_URL` pointing
at the same test server, so even a harness bug cannot reach `app`. **Add
`.env.test` to `.gitignore`** — it currently lists `.env` and `.env.local` only,
and this file will hold a database password.

**c. One migrated template, one database per worker, `TRUNCATE` between files.**
The numbers in §2 decide this against a database per test _file_: per-file clone
is ~0.5–1.3 s to create plus ~1.5 s to drop, which across ~30 integration files
is over a minute of pure provisioning; `TRUNCATE` of all nine tables is ~200 ms
and provisions nothing.

- `app_test_template` — created once, migrated once with the real
  `scripts/migrate.ts` (~1.6 s total).
- `app_test_w<N>` — cloned from the template per worker, `N` from
  `BUN_TEST_WORKER_ID` defaulting to `0` when serial.
- Each integration file resets its own worker's database with one
  `TRUNCATE … RESTART IDENTITY CASCADE` in `beforeAll`; a file needing a clean
  slate between tests repeats it in `beforeEach`.

**d. Nothing is dropped at the end.** Drop is the expensive operation and a
crashed run has to self-heal, so the harness reconciles at **start**: reuse
`app_test_w<N>` if its recorded schema fingerprint matches, otherwise drop and
re-clone. The fingerprint is a hash of `db/drizzle/meta/_journal.json` plus every
file in `db/migrations/`, stored in a `_harness_schema` table the migrations do
not create — which doubles as the ownership marker, since a database without it
is not one the harness made and must not be touched. `bun run test:db:reset` is
the explicit teardown.

**e. Close the template pool before cloning.** Measured: PostgreSQL refuses the
clone while any connection to the template is open. Easy to get wrong because
`Bun.SQL` connects lazily — the blocking connection may have been opened by a
fingerprint read three lines earlier.

**f. The connection budget is a real ceiling.** `MAX_POOL_CONNECTIONS` is 10 per
process, so `--parallel=N` can demand 10 N backends against a local
`max_connections` of 100, before the developer's own `app` connections and a
migration run. Assert `workers × MAX_POOL_CONNECTIONS + headroom ≤
max_connections` (read from `pg_settings`) and fail with that sentence, rather
than letting it surface as Bun's 30-second `connectionTimeout`, which looks like
an unrelated hang.

**g. Session fixtures go through the real sign-in path, once per file.** An
authenticated request needs a cookie Better Auth will accept, and hand-forging
one means reimplementing its signing. Call the real sign-in endpoint through
`app.handle(...)`, keep the `Set-Cookie`, reuse it for the whole file. The
password KDF is Argon2id at 64 MiB, which is exactly why this belongs in
`beforeAll` and not `beforeEach`.

### 4.2 SQLite

`rate-limit.db` is **shared mutable state with windows up to 24 hours**. Two
files that both exhaust an OTP budget will fight, and a row left by yesterday's
run denies today's first assertion with no error — just an unexpected 429.

- `SQLITE_DIR` points at a per-worker temporary directory, never the
  repository's `data/`. The same preload that rewrites `DATABASE_URL` sets it.
- Files asserting limiter behaviour **delete the database file** in
  `beforeEach`. Sweeping is not a reset: the sweep removes only _expired_ rows,
  and a fixed-window counter inside its window is not expired.
- The multi-process assertions (§7.2a) need a directory per case — contention
  over one file is the property.
- `--isolate` is not a substitute. It resets the JavaScript global, not the
  filesystem.

### 4.3 Fakes: one egress boundary

Every outbound HTTP call is a hardcoded absolute URL —
`challenges.cloudflare.com` (Turnstile), `apis.deewan.sa` (SMS),
`services.rmz.one` (WhatsApp), `api.pwnedpasswords.com` (HIBP) — plus SMTP
through `nodemailer`. There is no injected base URL to redirect.

**Install one egress guard for the whole suite rather than per-test stubs.** A
helper replaces `globalThis.fetch` with a router keyed on hostname, returning a
scripted response per known host and **failing the test** on any unexpected
host. One mechanism, two properties: the fakes, and the assertion that a code
path makes no outbound call it should not — which is exactly the defect where an
unreachable `/api/auth/*` path would have spent Turnstile quota. Where a real
socket is wanted (timeouts, 5xx, a slow provider), point the router at a
`Bun.serve` instance instead of returning a synthetic `Response`.

**Two boundaries the `fetch` router cannot see, so it is not one guard but
three.** SMTP is not HTTP: `mock.module('nodemailer', …)` returning a transport
that records `sendMail` calls. R2 **is** HTTP and still escapes, because the AWS
SDK resolves `NodeHttpHandler` — `node:http`, not `fetch` — so an S3 call never
reaches a router installed on `globalThis.fetch`:
`mock.module('@aws-sdk/client-s3', …)` and
`mock.module('@aws-sdk/s3-request-presigner', …)` are the seams, and the test that
proves the boundary holds must assert the **absence** of `fetch` traffic to
`*.r2.cloudflarestorage.com`, not merely that the stub was called.

Both replacements are process-wide and `mock.restore()` does not undo a
`mock.module`, so install them in the shared preload rather than per file —
uniformity is what makes them safe.

**Rule on `mock.module`:** third-party modules at the process boundary only.
Mocking a first-party module means the test proves the mock. `--isolate` clears
the module registry between files so a mock cannot leak across files; it can
still leak across tests within a file, so restore in `afterEach`.
---

## 5. Layout, scripts, CI

### 5.1 Layout

```
tests/
  unit/          pure logic, no IO, milliseconds          — runs on every save
  integration/   real PostgreSQL + real handlers via app.handle + fake providers
  process/       spawned children: boot, signals, raw sockets, multi-process SQLite
  helpers/       database harness, session fixtures, egress guard, preloads
  fixtures/      _-prefixed child scripts and data (never matched by the test glob)
```

`scripts/probe/local/` becomes `tests/unit` and `tests/process`; its
`_`-prefixed children move to `tests/fixtures/`. The move is not cosmetic: it is
what lets `bunfig.toml` give the three tiers different preloads, which is the
only clean way to keep a unit test from paying for a database connection.

Two hygiene items the move must fix, both of which have already bitten:

- **The manufactured error spelling.** `auth-storage-log-boundary.test.ts:49`
  and `rate-limit-log-boundary.test.ts:42` hand-author
  `class LeakyDriverError extends Error { override name = 'SqliteError' }`.
  Measured: `bun:sqlite` throws a plain `Error` with `.name` reassigned to
  `'SQLiteError'` — different capitalisation — and `.constructor.name` of
  `'Error'`, not a subclass at all. `errorClassOf` reads only `.name`, so every
  `expect(d.errorClass).toBe('SqliteError')` passes because the fixture set that
  exact string and would pass for any invented spelling. Fix both fixtures and
  add at least one assertion per file whose error comes from a **real**
  `bun:sqlite` failure.
- **CLI-style probes.** `log-serializer`, `permission-schema` and `time-dst` were
  CLI probes without the `.test.ts` suffix and had never executed in CI. They
  are converted, not renamed — a bare rename would be worse, because an explicit
  `exit()` inside a test file ends the whole run and silently skips every file
  after it. Add the guard: every file under `tests/` either matches the test glob
  or is `_`-prefixed.

### 5.2 Scripts

| Script             | Command                                | Needs       |
| ------------------ | -------------------------------------- | ----------- |
| `test`             | `bun tests/helpers/run.ts unit`        | nothing     |
| `test:integration` | `bun tests/helpers/run.ts integration` | PostgreSQL  |
| `test:process`     | `bun tests/helpers/run.ts process`     | a free port |
| `test:all`         | the three in sequence                  | PostgreSQL  |
| `test:db:reset`    | `bun tests/helpers/reset.ts`           | PostgreSQL  |

Each tier goes through one runner rather than calling `bun test` directly, and
the reason is a trap worth knowing before writing any script here: **`bun test
<path>` treats its positional arguments as filename FILTERS, not paths.** A test
file outside the filter is skipped and the run still exits 0, which is how
`bun test scripts/probe/local` came to report success while a whole directory had
never executed. `bunfig.toml`'s `[test] root` fixes the bare `bun test` case; the
runner fixes the per-tier case, and `tests/unit/harness-layout.test.ts` asserts
from the other side that no file under `tests/` sits in no tier.

The runner also owns the two jobs a preload cannot do: provision once and
sequentially (a preload runs per worker, and per file under `--isolate`, so
`CREATE DATABASE` there is N processes racing to clone one template), and drop
once at the end whatever happened (a `finally` around the child process, since a
preload's `afterAll` fires more than once per worker and never at all when a
worker is killed).

`test` stays the cheap one deliberately: it is what `lefthook` runs pre-commit,
and a pre-commit hook that needs a database is a pre-commit hook that gets
disabled.

Do **not** use `--concurrent` or `--max-concurrency`. Tests inside one file share
a database and a rate-limit file; running them concurrently makes every counter
assertion order-dependent. Parallelism belongs at the file level, where the
harness has given each worker its own state.

### 5.3 CI

Add the `test` job to `.github/workflows/ci.yml` with a `postgres:18-alpine`
service container, `pg_isready` health options, and `TEST_DATABASE_URL` pointing
at it. Service containers are Linux-runner only; `ubuntu-24.04` qualifies.

- `bun install --frozen-lockfile` as its own first step. `package.json` was once
  edited without regenerating `bun.lock`, so every CI install would have failed
  while every local command passed — `node_modules` was already populated. No
  test that assumes an installed tree can detect this.
- `bun run db:migrate` against the container, then `bun run test:all`.
- `--shard=${{ matrix.shard }}/3` with `--timings`, uploading the timings file so
  the next run balances. Integration files are 200 ms to seconds apart, so
  file-count sharding leaves one job doing most of the work. Empty shards exit 0.
- `--reporter=junit --reporter-outfile=…` for check annotations (merges across
  `--parallel` workers) and `--coverage-reporter=text,lcov`.
- `--bail` on CI only; locally the second failure is usually the informative one.
- **Keep the existing `Boot smoke test` step exactly as it is**, including its
  `DATABASE_URL: postgres://ci:ci@db.example.com/ci`. It is the only thing
  proving the pool still connects lazily (§7.4e); giving it a real database
  silently deletes that assertion.
- Group the spawned-process tier as its own step. Those tests each own a real
  socket, a real child process or a real signal, for the same reason
  `scripts/smoke.ts` is already separate.

Once the job exists, the two items the hardening plan lists as blocked on it —
the branch-protection required-checks list and the Renovate automerge revisit —
are unblocked.

---

## 6. Bun facilities, mapped to needs

All present in the installed 1.4.0. Where a facility looks right for something
it is wrong for, that is said too.

| Need                          | Facility                                                                             | Note                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fast local loop               | `--changed[=ref]`                                                                    | Walks the import graph backward from the diff. The mitigation for integration tests being slower than unit ones.                                                                            |
| Wall-clock                    | `--parallel[=N]`                                                                     | Worker processes, implies `--isolate`. This is what makes per-worker databases the right isolation unit. Cap `N` by §4.1f, not by CPU count.                                                |
| Cross-file leakage            | `--isolate`                                                                          | Fresh `globalThis`, cleared module registry, cancelled timers, module-scope subprocesses killed between files. It is what makes `mock.module` safe to use at all.                           |
| CI fan-out                    | `--shard=M/N` + `--timings` / `--update-timings`                                     | Balances by recorded duration instead of file count.                                                                                                                                        |
| Ordering bugs                 | `--randomize` + `--seed=N`                                                           | The right tool for order dependence. `--rerun-each` catches flakiness, which is a different thing; both are useful.                                                                         |
| Genuine externality flakiness | `--retry=<N>`, `{ retry: n }`                                                        | Only where the flakiness is a property of the world. A retry on a race assertion hides the race.                                                                                            |
| Race assertions               | `{ repeats: n }`                                                                     | Runs n times, fails if any iteration fails — the inverse of `retry`, and the correct one for every concurrency invariant below.                                                             |
| Time-dependent logic          | `jest.useFakeTimers` + `setSystemTime` + `advanceTimersByTime`                       | Window rollover, the UTC-midnight OTP cap, DST, the six-hour block, cookie-cache staleness. Restore with `useRealTimers()` in `afterEach`; 1.4 also stops fake timers leaking across files. |
| Known-open gate               | `test.failing`                                                                       | Keeps CI green while a defect stands and turns red the moment it is fixed and the marker is stale. `test.skip` just goes quiet.                                                             |
| Table-driven walks            | `test.each` / `describe.each`                                                        | The manifest conformance walk and the validation matrix are both natural `each` tables.                                                                                                     |
| Platform-conditional          | `test.if` / `test.skipIf`                                                            | Only for the cases §9 names. Anything else makes coverage a function of who ran it.                                                                                                         |
| Fakes                         | `mock`, `spyOn`, `mock.module`                                                       | §4.3. `jest.unstable_mockModule` does not exist here.                                                                                                                                       |
| Fake HTTP provider            | `Bun.serve`                                                                          | Real sockets, so timeout and 5xx paths are genuinely exercised.                                                                                                                             |
| Real processes and signals    | `Bun.spawn`                                                                          | The whole process tier.                                                                                                                                                                     |
| Transport-level status        | `Bun.connect`                                                                        | The only way to observe the 413; `fetch` surfaces it as a closed socket.                                                                                                                    |
| Harness SQL                   | `Bun.SQL`                                                                            | `CREATE DATABASE`, `TEMPLATE`, `TRUNCATE`, `pg_settings`. No `pg` dependency and no `psql` binary, neither of which exists here.                                                            |
| Shape assertions              | `toMatchInlineSnapshot`                                                              | For the OpenAPI document and the error envelope, where the assertion _is_ the shape. Inline, not file-based: a snapshot the reviewer sees in the diff.                                      |
| Assertions                    | `toBeOneOf`, `toContainKey`, `toSatisfy`, `toBeWithin`, `expect.objectContaining`    | All present. Prefer them to hand-rolled booleans, which report `false !== true` and tell the reader nothing.                                                                                |
| Coverage                      | `--coverage --coverage-reporter=text,lcov`, `bunfig.toml` `[test] coverageThreshold` | §8, including the plural-key trap.                                                                                                                                                          |

---

## 7. Assertion catalogue

Every entry states what to assert, the concrete failure it catches, and the
seam. Entries marked **shipped** are defects that were live in this repository;
they are required assertions because each one already happened once.

Seams used below: **in-process** = `app.handle(new Request(...))` against the
real route table, no socket; **unit** = a direct call on an exported function;
**integration** = in-process plus a real database; **process** = a spawned child
with a real socket, signal or file lock.

### 7.1 HTTP layer

#### a. CORS preflight

**Assert.** `OPTIONS` on a registered path carrying
`Access-Control-Request-Method` and
`Access-Control-Request-Headers: X-Captcha-Response` answers with
`Access-Control-Allow-Headers` containing `X-Captcha-Response`
(case-insensitive membership in the comma-separated value), and
`Access-Control-Max-Age` equal to `600`.

**Why.** `@elysia/cors` joins `CORS_POLICY.allowedHeaders` into a fixed string
once at plugin construction and publishes it as a default header; it mirrors the
browser's own request headers back only when `allowedHeaders` is left at its
permissive `true` default, which this app does not do. So the advertised list is
exactly what `CORS_POLICY` names — and an edit that trims the array drops
browser support for that endpoint while every status check still passes, because
the preflight answers `204` either way. This already happened once: the captcha
header was missing from both `app.ts` and the Hono example. `maxAge` guards the
same drift against the plugin's own default of `5`, where losing the override
means re-preflighting nearly every cross-origin request.

**Seam.** In-process. The plugin answers `OPTIONS` from its own `onRequest`
hook.

#### b. Admission precedes body parsing — four properties, three seams

**b1. Oversized body rejected before buffering.** A JSON POST and a multipart
POST past `MAX_REQUEST_BODY_BYTES` (8 MiB, exported from `app.ts`) both return
`413`. The limit is `maxRequestBodySize`, a `Bun.serve` socket option, and its
purpose is to stop Bun's 128 MiB default from buffering an oversized body before
any per-route logic runs. Proving "before buffering" needs the client to still
be sending when the rejection lands: pace the write (chunked body, or a raw
socket with a delay between chunks) and assert the rejection arrives mid-write.
Measured: the reply arrives after roughly 64 KiB of a declared 12 MiB body, so
the rejection genuinely precedes buffering.

**The 413 is a bare transport reply** — `HTTP/1.1 413 Request Entity Too Large`,
no body, no security headers, no API envelope, no access-log line — and Bun's own
`fetch` surfaces it as a closed socket rather than as a status. A `fetch`-based
`status === 413` assertion **cannot** pass. **Seam: process, with `Bun.connect`.**
`app.handle()` cannot observe this at all: the `Request` it receives is already
materialised with no socket underneath.

**b2. A JSON-policy route sent `multipart/form-data` parses nothing.** For a
route declared `body: 'json'`, a POST with `Content-Type: multipart/form-data`
and a real multipart body yields `await ctx.readJson() === null` **and**
`await ctx.readFormData() === null`, with the multipart parser never running.
Each reader in `withBodyPolicy` is gated on `policy === … && essence === …` and a
forbidden reader is `() => Promise.resolve(null)`, which never touches the
stream. Before the reordering the client's own `Content-Type` picked the parser —
a JSON-only dashboard route parsing attacker-chosen multipart data. **Seam:**
unit on `withBodyPolicy`, or in-process; both are valid, unit is cheaper.

**b3. Nothing is parsed before the handler runs.** This is what distinguishes the
current design from the first fix, which only reordered the adapter's own
admission check. Both readers are lazy and `withBodyPolicy` is synchronous, so a
route whose only admission check is inside its handler — the OTP endpoints,
`preAuth: 'none'`, with their own per-identifier budgets — also rejects before a
byte is parsed. Assert it where it is observable: a `POST /api/auth/otp/send`
that the handler's own limiter rejects must not have consumed the body. **Seam:**
an instrumented `Request` whose `text()` records that it was called, driven
through `app.handle`. Asserting only against `withBodyPolicy` proves the reader
is lazy, not that the handler ordered its checks correctly — assert both.

**b4. Both readers are memoised.** `readFormData` twice on a multipart route and
`readJson` twice on a JSON route return the same result both times (same
`FormData`, same parsed value, or both `null` for a malformed body) rather than
throwing `Body has already been used` on the second call. The guard is
`memoise`'s `pending ??= read()`. **Seam:** unit, with a real `Request`.

#### c. Route-table conformance — table-driven over `ROUTE_MANIFEST`

`ROUTE_MANIFEST` is exported from `app.ts` for exactly this. Four assertions per
entry, plus five that the manifest walk cannot reach on its own.

**Reachable.** A request satisfying the route's own `body`/`preAuth` policy
reaches the handler — the response is neither `404` nor `405`. "Reachable" means
the router dispatched to the intended handler, not that the handler succeeded.
This replaces hand-verifying that every `routes.ts` entry is wired into `app.ts`'s
registration loop.

**Wrong method → `405` with a correct `Allow`.** `Allow` matches `allowHeader()`'s
computed set (`GET` implies `HEAD`, `OPTIONS` always included). Elysia reports
"no such path" and "wrong method on a real path" as the same `NOT_FOUND`
(measured), so nothing but the manifest can tell them apart.

**Trailing slash → `308`.** With `Location` pointing at the canonical path.
`strictPath: true` makes the two URLs different resources; wrong canonicalisation
splits a cache key and a security-rule match across two URLs for one resource.

**`Cache-Control: no-store`** on every answer, including the `404`, `405` and
`308` paths — these fall out of the walk for free.

Then, the five hand-written cases:

- **`/api/auth/*` wrong method.** `ROUTE_MANIFEST` is `toManifest(ROUTES)` and
  does not include `ROUTE_PREFIXES`, even though `createRouteLookup` folds
  prefixes in at runtime. Only `GET`/`POST` are registered, so `PUT`/`DELETE`
  must `405` — one assertion against `ROUTE_PREFIXES`, not derivable from
  iterating the manifest.
- **`Allow` must never name a method the path answers 404 for** (shipped).
  Generic assertion: for every manifest path, each method in `Allow` returns
  something other than 404. The specific case it was written for is `HEAD` —
  Elysia derives it from a `GET` route in the table but **not** from the Better
  Auth wildcard, so `Allow: GET, POST, HEAD, OPTIONS` on `/api/auth/*` named a
  method answering 404. `Allow` for those paths is now `GET, POST, OPTIONS`.
- **The 405 boundary must not claim paths that do not exist** (shipped).
  `ROUTE_PREFIXES` matched the whole `/api/auth` prefix, so
  `PUT /api/auth/does-not-exist` answered `405 Allow: GET, POST` while `GET` on
  the same path answered `404`. For a path outside `BETTER_AUTH_ALLOWED_PATHS`:
  every method must be `404`, and `OPTIONS` must not be `204`.
- **One URL shape, one answer, on every method** (shipped). For a real path,
  every method on the trailing-slash form returns `308` with the same
  `Location` — **including `OPTIONS`**, which answered `404` while every other
  method redirected, because the route-aware OPTIONS gate runs before the router
  and did not canonicalise. For an unknown path, every method on the slash form
  returns `404` and none returns `308`, so the redirect never becomes a path
  oracle.
- **Every route must be IN the route table** (shipped). `/openapi.json` was
  registered directly on the framework instance, so it silently had no 405
  boundary, no trailing-slash redirect and no route-aware `OPTIONS` — the
  manifest could not see it. Assert that the set of paths the server answers
  equals the set the manifest declares.

**Manifest completeness.** Every `handler.ts` under `app/api/**` is imported by
`routes.ts` — `scripts/find-unused-files.ts`'s `assertHandlersRegistered`
already performs this check, but folding it into a suite that `bun run test`
executes is what makes it enforced rather than hand-invoked. Also assert every
`ROUTES` entry declares both `preAuth` and `body`; stated honestly, both are
required fields on `RouteDefinition` so omitting either is already a compile
error — this is cheap insurance against a future optional field or an
`as RouteDefinition` cast, not something reachable today.

**Seam.** In-process throughout, which is the reason `app.ts` was split from
`server.ts`.

#### d. Better Auth path allowlist — a security fix, not tidiness

**Assert.** `POST /api/auth/zz/sign-in/email/zz` — an arbitrary nonexistent path
that merely _contains_ `sign-in/email` — answers `404` with this API's envelope
and makes **no outbound call**. Assert the second half with the egress guard
(§4.3), not by reading the response.

**Why** (shipped). Better Auth runs plugin `onRequest` handlers ahead of its own
hooks, and the captcha plugin matches its endpoint list with
`pathname.includes(...)`. Measured before the fix: that path answered
`400 Missing CAPTCHA response`, and with an `x-captcha-response` header it would
have performed an outbound Turnstile siteverify for a path this server does not
serve — unauthenticated, attacker-triggerable spend against the Turnstile quota
from any URL shaped that way. `app.ts` now checks
`BETTER_AUTH_ALLOWED_PATHS` before calling `auth.handler`.

**Also assert** `auth.options.baseURL === PUBLIC_ORIGIN` (shipped) under an
environment that sets **only** `PUBLIC_URL`. The canonical-origin parse was added
to `lib/env.js` and `lib/auth.ts` was not switched over, so Better Auth kept
reading `process.env.NEXT_PUBLIC_URL`; once CI moved to the new name, `baseURL`
was `undefined` — and session cookies are signed against that value. Asserting
under an environment that sets both names hides exactly this bug.

#### e. Response policy and cookies

**A route's own conflicting header loses.** A handler returning a native
`Response` carrying its own `Content-Security-Policy` still shows the
application's CSP on the wire. Measured on `elysia@1.4.29`: a header on a native
`Response` a route returns wins over the same key set into `set.headers`, so a
route's own CSP silently replaced the global one before `mapResponse` existed to
overwrite it back.

_A wrinkle:_ no handler under `app/api/**` currently sets a custom CSP or any
`HandlerOutput.headers`, so no existing route exercises this end to end. A unit
call on `applyResponsePolicy` proves the function's overwrite logic but says
nothing about whether `app.ts`'s hook registration order still puts `mapResponse`
where it needs to be. **Do not add a throwaway route to the shared `app`
singleton** — files run sequentially in one process by default, so the route
leaks into every other file's `app.handle()` calls for the rest of the run. Build
a second minimal Elysia instance in the test file with the same hook chain
(`onRequest` → `cors` → `mapResponse` → `onError`) and one throwaway route on
that.

**`Cache-Control: no-store` on a genuine 500.** Compose
`toWebResponse(handleApiError(new Error(...)))` through `applyResponsePolicy` —
the exact pipeline `app.ts` runs for an application-level throw. No need to
provoke Elysia's framework-level `onError`, which `handleApiError` intercepts
almost everything before by design.

**Cookies survive intact and distinct.** A `HandlerOutput` with two or more
cookies, at least one carrying `extraFlags: ['Partitioned']`, survives
`toWebResponse` → `applyResponsePolicy` with `response.headers.getSetCookie()`
returning N separate values — not one comma-joined line — and `Partitioned`
still present on the value that carried it. Two independent places can merge
them: `serializeSetCookie` is the only place a `HandlerCookie` is rendered
(including attributes neither Next's nor Elysia's cookie API models), and
`applyResponsePolicy`'s fallback path rebuilds the `Headers` object when
`headers.set(...)` throws on an immutable bag, re-appending every `Set-Cookie`
via `getSetCookie()` precisely because `new Headers(headers)` folds repeats into
one comma-joined line that browsers reject.

**Two seams for two properties.** `serializeSetCookie` is the unit — feed it a
cookie with `extraFlags`/`extra` set and assert the rendered string. The
comma-join property needs a real `Response` to call `getSetCookie()` on. The
immutable-headers fallback has no caller in this codebase that constructs an
immutable-header `Response` (`app.ts`'s redirect deliberately avoids
`Response.redirect()` for this reason), so exercise it with a unit call on
`applyResponsePolicy` fed a `Response.redirect(...)`.

#### f. The access log's own claim

**Assert.** It is **not** one line per request: `OPTIONS` produces none, because
both OPTIONS answers short-circuit in an `onRequest` hook (the CORS plugin's 204
and the route-aware 404) and `onAfterResponse` never fires for them. 404s, 405s
and 308s **do** appear. Assert exactly that set rather than the slogan, so a
future change that starts or stops logging preflights is visible.

#### g. OpenAPI document

**A. The consistency check must fire on every drift shape.**
`openApiConsistencyProblems(manifest)` is exported for this. Assert it returns
empty for the real table and non-empty for each of: a route declaring
`body: 'json'` with no `REQUEST_BODIES` entry; a `REQUEST_BODIES` key matching no
route; a `CREATED_ROUTES` key matching no route; a route that keeps its schema
after its body policy drops to `none`. Assert **separately** that
`openApiDocument` _throws_ on each — the CI gate is the 500 that produces, since
`scripts/smoke.ts` asserts `GET /openapi.json` is 200. Without the throw the
check is decorative. Two routes shipped with no request body before it existed;
adding the two schemas fixed the instances and nothing else.

**B. Documented `required` must match runtime optionality** (shipped). For every
request body in the document, a body omitting each listed-required key is
**rejected** by the corresponding Zod schema, and a body omitting each
not-required key is not rejected for that reason. This catches the converter
defect directly: `z.toJSONSchema(schema, { io: 'input' })` reports
`required: []` for `createUserSchema` because `emailSchema` and `passwordSchema`
are `z.preprocess`, while the runtime rejects `{}` with a 422 — so
`POST /api/dash/users` advertised seven optional properties, all required.
`io: 'output'` is **not** the fix and must not be substituted: it marks defaulted
keys (`isActive`, `phoneNumber`) required in a request where they are optional.
Cover a discriminated union too (`sendOtpSchema`), where every branch listed only
`channel`.

**C. Statuses the server actually produces must be documented** (shipped). `400`
and `422` appear on the operations that can return them. Both are derivable from
the manifest — `400` from a non-`none` body policy via `requireJsonBody`, `422`
from that or from a path parameter, since every `:id` route validates it — and
both were absent while `422` is the standard validation failure of every JSON
route. `401`, `403` and `409` are **not** derivable from the manifest today; if
they should be documented that needs a new manifest field, which is a design
change rather than a test.

**D. `operationId` unique across the whole document** (shipped). Four Better Auth
operations shared one object between `get` and `post`, invalid per OpenAPI 3.1
§4.8.10 and breaking generators. A one-line uniqueness assertion over every
operation catches the class.

**E. Every route declaring a body policy appears with a matching request body**
(shipped) — a cross-check between `ROUTE_MANIFEST` and `openApiDocument(...)`,
not an inspection of the document alone.

#### h. The registration scanner must fail on each hole that was open

Four cases, each verified to exit non-zero: a `handler: NS.METHOD` reference
present in `routes.ts` but **outside** the `ROUTES` array (a dead const satisfied
the gate, because the regex ran over the whole file); an unrouted
`export function POST`; an unrouted `export { x as POST }`. Plus one case that
must exit **zero**: `export { GET as legacyGet }` alongside a routed `GET`, since
the exported name is not a method and a false positive here trains someone to
disable the gate. **Assert the exit codes, not the message text.**

### 7.2 SQLite storage

Seam for all of this: spawned children against the real `bun:sqlite` driver —
same shape as the existing `_sqlite-semantics-child.cjs` (a separate process so a
failed case cannot leak an open file handle), extended to genuinely concurrent
spawns for (a).

**a. Migration concurrency — the existing test is not concurrent and does not
call the production code.** `_sqlite-semantics-child.cjs`'s
`[runMigration(), runMigration(), runMigration()]` are three synchronous calls
evaluated in array-literal order, in one process, one after another. It also
builds its own `Database`, its own PRAGMA sequence and its own `user_version`
dance inline rather than calling `openDatabase` with a real migration list — so a
regression in `migrate()`'s `BEGIN IMMEDIATE` locking strategy would not be
caught, because the test never calls that function.

**What a genuine version needs:** real OS processes. Spawn 3–8 separate `bun`
children via `Bun.spawn`, each pointed at the same file path through env (mirror
the existing temp-directory pattern), each calling the production path —
`getRateLimitStore()`, which calls `openDatabase` with the real `MIGRATIONS` —
started via `Promise.all` over the spawns rather than awaited one at a time, so
process starts and connection opens genuinely race. Assert every child exits `0`
(the historically reproduced failure was a loser throwing
`table rate_limit already exists`) and that a fresh connection afterwards reads
`user_version === RATE_LIMIT_SCHEMA_VERSION` with the schema applied exactly
once.

**b. Better Auth's own statements are never exercised.** The child receives
`SQL_CONSUME`, `SQL_SWEEP_RATE_LIMIT` and `SQL_ANY_EXPIRED` but never
`SQL_AUTH_CONSUME`, `SQL_AUTH_GET` or `SQL_AUTH_SET` — the statements behind the
login limiter's storage contract, against the separate `auth_rate_limit` table.
Assert `SQL_AUTH_CONSUME` is max-aware the same way `SQL_CONSUME` is already
proven to be (admits exactly the limit, zero writes on denial, correct window
rollover), `SQL_AUTH_GET` excludes expired rows (`expires_at > ?`), and
`SQL_AUTH_SET` overwrites on conflict — count, window_start, last_request and
expires_at all replaced — rather than accumulating.

**Blocked on a decision:** `authGet`/`authSet` in `lib/rate-limit/store.ts` now
have **no caller**, because `better-auth@1.7.1` dropped `get`/`set` from
`BetterAuthRateLimitStorage` and made `consume` the sole member. Either write
these tests and keep the statements as a tested seam, or delete both statements
and drop this half of the entry. Tracked as `TODO.md` PG-3. Do not leave them as
untested dead code.

**c. The log-boundary test tests the boundary function, not the storage.**
`auth-storage-log-boundary.test.ts` asserts `describeAuthStoreFailure` in
isolation because, when it was written, importing the real
`authRateLimitStorage` under Bun hard-panicked (`better-sqlite3`). That blocker
is gone. Force a real failure out of the real storage — an unwritable
`SQLITE_DIR` is the cheapest reliable way — and prove the same containment
property (no IP, no key, no path) through the actual
`catch → sanitizeForLog → console.error` wiring, not just the extracted
function.

**d. Statement finalisation.** `openConnection` tracks every statement it
prepares in a `live` set and finalises all of them on `close()` before
`db.close(true)`. Two assertions: a connection with statements prepared through
it (never explicitly finalised) closes without throwing; and a statement handle
obtained **before** `close()` genuinely stops working afterwards —
`.get()`/`.run()` throws rather than silently returning rows. The second is the
regression proof: before this fix a statement prepared from a connection then
`db.close(false)`'d still returned rows afterwards, with its file lock and memory
still held. A test that only checks `close()` doesn't throw would not catch that
coming back; it has to reuse the pre-close handle.

**e. `busy_timeout` before `journal_mode = WAL`.** `applyPragmas` sets
`busy_timeout` first because a fresh `bun:sqlite` connection reads back
`busy_timeout = 0` and `journal_mode = WAL` is itself lock-taking. Two separate
assertions, not one. The read-back value
(`describeDatabase(db).busyTimeout === BUSY_TIMEOUT_MS` on a fresh connection via
the real `openDatabase`) proves the final state and says nothing about the order.
Proving the order needs a real lock: hold a write lock on the same file from a
second connection (an uncommitted `BEGIN IMMEDIATE` via `openConnection`
directly, bypassing migrations), then open a fresh connection against that file
through `openDatabase` and assert it **waits** rather than failing `SQLITE_BUSY`
immediately — that wait is only possible if `busy_timeout` was already non-zero
when the lock-taking WAL pragma ran. Two connections to one file within one Bun
process should reproduce SQLite's file-level locking correctly, but confirm that
rather than assuming it.

**f. Route-level SQLite behaviour still uncovered.** `scripts/smoke.ts` covers
readiness-ok, the 404 envelope, the security headers and the sweep's
unauthorized branch. Still uncovered: the readiness route's **degraded**
branches (each of `journalModeWal`, `schemaVersion`, `busyTimeout`,
`synchronousNormal`, `maintenanceTokenSet` failing individually → 503 with the
failing field visible in `checks`), the sweep's `hasMore` under a real backlog,
and the maintenance-token authorization matrix (absent token → 401, wrong token
→ 401, correct token → 200, constant-time comparison).

### 7.3 Boot, shutdown, process lifecycle

#### a. Startup rejection and production posture

`server.ts` validates the runtime **before** importing the application, so none
of this is reachable by a test that imports `lib/env.server.ts` directly (which
is all `env-secret.test.ts` does). Spawn the real `bun run start`.

**Assert non-zero exit and a `startup rejected` line for:** `NODE_ENV` absent;
`NODE_ENV=prodution` (misspelt); `PORT` not a decimal integer in `1..65535`; a
weak or absent `BETTER_AUTH_SECRET`; a relative `SQLITE_DIR` under
`NODE_ENV=production`. The misspelling case is the sharpest —
`lib/env.server.ts` only ever compares `NODE_ENV === 'production'`, so a
misspelt value was silently treated as not-production and disabled all four
production guards at once while the server still booted and served traffic
(reproduced).

**Assert the Bun version guard still bites.** A minor-version mismatch exits
non-zero; a patch difference logs `bun patch version drift` and continues.
`Bun.version` cannot be stubbed in a spawned real binary, so split it: assert the
comparison as a **unit**, and assert the real guard does **not** reject at the
pinned version by booting the real binary. Say which of the two any given
assertion proves. The pin is not cosmetic: through Bun 1.3.x a simple-protocol
query running concurrently with a not-yet-prepared parameterized query on the
same connection could deliver one query's rows to the other, and the `BEGIN`,
`COMMIT` and `ROLLBACK` that `db.transaction()` issues **are** simple-protocol
queries (Bun #32772, fixed in 1.4.0). Below the pin every transaction in the
application is exposed to it.

**Assert the production posture, positively.** CI's boot smoke step sets
`NODE_ENV: development` explicitly, so nothing exercises production today. With
throwaway production-shaped values (mirror `_env-secret-child.ts`'s `REQUIRED`
map plus `NODE_ENV=production`): `Strict-Transport-Security` is present on a real
response, and `/api/health/storage` reports `maintenanceTokenSet: true` when a
real `SQLITE_MAINTENANCE_TOKEN` is configured — proving the production config
actually wired a token, which a missing-token 401 cannot distinguish from a
route that is simply guarded.

**Cross-reference, not a duplicate:** `env-secret.test.ts` already covers
exhaustively what makes a `BETTER_AUTH_SECRET` valid (length floor, whitespace,
the library default, the `AUTH_SECRET`/`BETTER_AUTH_SECRETS` aliases) via
subprocess against `lib/env.server.ts`. This item's job is narrower: the same
floor still holds when reached through the real boot sequence. One weak-secret
case is enough.

**Seam.** A sibling of `scripts/smoke.ts` — spawn, poll, assert, kill — wired as
a second CI step. The negative cases invert the existing suite's pass condition:
success means the process exits non-zero and a health fetch never succeeds. Flag
that polarity so it is not copied from `scripts/smoke.ts` unchanged.

#### b. Graceful shutdown

**Assert.** A request already in flight when `SIGTERM` arrives completes
normally — its `fetch()` resolves with the real response, not a connection reset —
and the process exits within the bounded window. `SIGTERM` twice in quick
succession, or `SIGTERM` then `SIGINT`, runs the sequence exactly once: one
`server stopping` and one `server stopped` line, no duplicate close attempt on
the rate-limit or cache store.

**Why.** The previous wiring was `process.on('beforeExit')`, not a signal
handler, so it never fired on Coolify's stop-first `SIGTERM` at all and in-flight
mutations, uploads and external calls were simply terminated. The idempotency
guard exists because a grace period is not a promise that exactly one signal
arrives.

**Record and assert the real `app.stop()` semantics** (shipped as four wrong
comments, and the wrong version argued for a different fix). Measured on
`elysia@1.4.29`: `stop()` **does** close the listener — a new connection is
refused as soon as it resolves — and what survives is an already-established
keep-alive connection, on which a further request is still served. Assert both
halves.

**The forced-shutdown bound is derived; assert the invariant, not the number.**
It is `max(IDLE_TIMEOUT_SECONDS, MAX_ROUTE_TIMEOUT_SECONDS) + 15` in
milliseconds — 135 s with the current table. A flat 15 s bound would have aborted
at 15 s exactly the 120 s upload the per-route ceiling exists to permit. The
one-term form (`MAX_ROUTE_TIMEOUT_SECONDS` alone) is also wrong and would have
passed while the two-term invariant was violated: `reports/coolify-deployment.md`
§12.2 tells the operator to lower the upload ceiling to 30 s for a shorter deploy
window, which under the one-term form leaves a 45 s bound against a global
ceiling that still permits 60 s requests. **Assert the two-term form against a
route table where the global ceiling is the larger term**, or the test proves
nothing the one-term version did not.

**Forced shutdown must actually fire when the drain hangs** (shipped). The timer
was `unref`'d, so in the one shape it exists for — `app.stop()` resolved,
listener closed, nothing after it settling, no other ref'd handle — the process
exited **0** with no `forced shutdown` line and the store closes never ran.
Assert a non-zero exit and the log line for a hung drain. This needs a hang
_after_ `stop()` resolves, not during it: a hang during `stop()` leaves a ref'd
handle and masks the defect.

**A gap worth naming.** No current route has a deliberate, controllable delay, so
catching a request reliably in flight at the moment the signal is sent is a real
scheduling problem. The robust shape: fire a burst of concurrent requests against
an already-registered lightweight route, send the signal shortly after the burst
starts, and assert none of the in-flight ones error — rather than timing one
request precisely against the signal.

**Seam.** Process only, and **Linux only** — see §9.

### 7.4 PostgreSQL driver

Everything here was verified by hand against a real local PostgreSQL 18.6 on Bun
1.4.0 while making the Neon → `bun:sql` change, by a throwaway suite that was
then deleted. That deletion is the gap this section closes. Each item either
shipped broken or was one edit away from it.

**Partly closed already, 2026-08-20 — check before treating an item as
outstanding.** A review pass made the point that a check run once is not a check
that stays, so two of these are now implemented rather than merely specified:

- `scripts/probe/local/log-serializer.test.ts` gained six assertions covering
  **b**: the SQLSTATE in `errno` kept, the constraint name beside it, an
  OTP-shaped `errno` still redacted, a numeric Node `errno` kept, and the
  SQLSTATE surviving the query-error reduction while the bound parameter does
  not. They use Bun's own `SQL.PostgresError` constructor instead of
  `Object.assign` on an `Error`, so the fixture cannot drift from the shape the
  driver throws — and they need no database, so they run in CI today under
  `bun run test`.
- `scripts/probe/dev-live/database/driver-contract.dev-probe.ts` (new) covers the
  live half — **a**, **b**'s real-error cases, **c**, **d** and **g** — against a
  real server. 8 assertions, all passing, run with `bun run probe:db`.

**That is not a gate, and the distinction matters.** `bun run test` runs
`scripts/probe/local` only and CI has no PostgreSQL service, so the live probe
runs on demand. Putting it under `local/` would break CI on the first push. §3's
service-container decision is still what turns these into gates.

Still specification-only: **e** (the pool and lazy connect), **f** (type
mapping), **h** (the migration runner, which needs a scratch database) and the
version guard, which belongs with §7.3's production-launch smoke.

**a. The SQLSTATE moved, and three functions read it** (shipped). `Bun.SQL`'s
`PostgresError` puts its own identifier in `code` —
`'ERR_POSTGRES_SERVER_ERROR'` for every constraint violation — and the
five-character SQLSTATE in **`errno`**, as a string. Measured across unique,
not-null, check, FK, undefined-table, undefined-column, syntax, bad-cast,
divide-by-zero, lock-not-available and `RAISE … USING errcode` failures: `errno`
held the SQLSTATE in all eleven, letters intact (`42P01`, `23P01`), never a
number. `neon-http` put it in `code`, so `isUniqueViolation`,
`isForeignKeyViolation` and every caller went silently false the moment the
driver changed — duplicate-email handling would have returned a generic 500
instead of a 409.

**Assert against errors thrown by the real driver, never a fixture.** A fixture
setting `.errno = '23505'` proves only that the reader reads `errno`. Provoke
each: `isUniqueViolation` true for a real duplicate insert through Drizzle, with
`getConstraintName` returning the actual index name (`ux_users_email`) rather
than the empty string; `isForeignKeyViolation` true for a real orphan `role_id`;
`handleUserUniqueViolation` mapping a real `users` unique violation to **409**
(the assertion that catches this at the contract level rather than the helper
level); and both helpers **false** for an unrelated failure such as an undefined
table, so the test cannot pass by matching everything. Also assert the wrapping:
Drizzle rethrows inside a `DrizzleQueryError` whose `cause` is the driver error,
so the fields sit one level down — `hasSqlState` checks both levels and both key
spellings, and a test that only ever sees a top-level error proves half of it.

**b. The log serializer allowlists field names, so it lost the SQLSTATE too**
(shipped). `serializeQueryError` reduces a parameter-bearing query error to
hard-allowlisted fields, and the allowlist named `code` and `constraint`. With
this driver `code` is `ERR_POSTGRES_SERVER_ERROR`, which fails the
five-character shape gate and is dropped — so every driver-error log line carried
a constraint name and no code at all. `errno` is now in both
`QUERY_ERROR_SAFE_FIELDS` and `ERROR_DETAIL_KEYS`. Assert both directions on a
**real** error: `sanitizeForLog` of a real `42P01` contains `42P01`;
`sanitizeForLog` of a real `22P02` (uuid cast of a non-uuid, which PostgreSQL
echoes the offending value into) contains `22P02` and does **not** contain the
offending value. Both halves, because widening the allowlist to fix the first is
exactly how the second gets broken. And a six-digit OTP in a `code` field is
still redacted — `errno` joining the shape-checked set must not have widened what
a plain `code` may carry.

**c. `db.execute()` returns rows, not a result object.** `neon-http` returned
`{ rows: [...] }`; `bun-sql` returns the array. Three call sites read `.rows`:
the role `DELETE … RETURNING`, the CTE `UPDATE … RETURNING`, and the
`SELECT … FOR UPDATE OF u FOR SHARE OF r`. The compiler caught all three, which
is the only reason this was not a runtime outage — `deleted.rows.length === 0` on
an array is `undefined === 0`, i.e. false, so the role-delete guard would have
**silently stopped rejecting deletes of roles that still have users**. Two of the
three sites are security-relevant and a future `execute` written from memory gets
no type error if it never touches `.rows`. Assert per site, through the real
statement, inside a real transaction: the `DELETE … RETURNING` returns one row
for a deletable role and zero for one already gone; the CTE `UPDATE … RETURNING`
returns the previous name and a `Date` for `updated_at`; the locking `SELECT`
returns the locked row.

**d. Session continuity — the property the old two-driver split existed to
buy.** Losing it would break `processOtpSend`'s advisory lock and every
`FOR UPDATE` in the codebase with no error at all. Assert: two
`pg_backend_pid()` reads inside one `withTransaction` return the same PID; after
`pg_advisory_xact_lock(...)` inside a transaction, `pg_locks` shows exactly one
advisory lock for that backend — using `utils/otp.ts`'s real statement, not a
stand-in; a throw inside `withTransaction` rolls the writes back and the row
count is unchanged; and a nested `tx.transaction()` becomes a SAVEPOINT, so an
inner throw rolls back only the inner write while the outer transaction still
commits. The last is a real behaviour change from a driver that could not nest
at all.

**e. The pool, and the one property CI silently depends on.** **Lazy connect is
load-bearing.** CI's boot smoke step runs with
`DATABASE_URL: postgres://ci:ci@db.example.com/ci` and asserts that no
PostgreSQL or network access is required. That was free with a `fetch`-based
driver; it is now true only because `new SQL(...)` does not connect until the
first query — measured: construction against an unreachable host takes about
1 ms, and `close()` on a never-connected pool resolves in under 1 ms.
**Assert it**, or the next person to add an eager connection or a startup ping
breaks CI's whole smoke job and the failure will look like a network problem.

Also assert: `MAX_POOL_CONNECTIONS` is a real ceiling — 12 concurrent queries
open exactly 10 backends in `pg_stat_activity` for the current database;
`closeDatabase()` on a live, actively-used pool resolves, and a query after it
fails rather than silently reconnecting; and the process exits without a hanging
handle after `closeDatabase()`, since a pooled connection holding the event loop
open would turn every deploy into a forced shutdown.

**f. Type mapping, where a wrong assumption is a wrong number.** Unchanged from
`neon-http` in every case measured, which is the point — assert it so a driver or
Bun upgrade cannot move it quietly. `count()` from Drizzle is a JS `number` (it
carries `mapWith(Number)`), and so is the hand-written `usersCount` subquery in
`app/api/dash/permissions/handler.ts`. **A raw `count(*)` without `mapWith` is a
`string`** — PostgreSQL `bigint` maps to string by default and `bigint: false` is
Bun's default. Assert the string case as well as the number case, so the reason
`mapWith` is required is recorded where whoever writes the next aggregate will
see it. Also: `numeric` is a `string` (precision preserved), `timestamptz` and
`timestamp` are `Date`, `jsonb`/`json` are parsed objects, `uuid` is a `string`,
integer and text arrays are JS arrays. And a guard rather than a fix:
`'infinity'::timestamp` decodes to the **number** `Infinity`, not a `Date` (Bun
#35121, changed in 1.4) — nothing in this schema writes it, so assert it only if
a nullable timestamp ever gains an `infinity` sentinel, and know that `Date`
methods on it will throw.

**g. `jsonb` was double-encoded — the sharpest defect in the swap** (shipped,
live, silent, and it reached the permission system).

_Mechanism._ Drizzle's built-in `jsonb` returns `JSON.stringify(value)` from
`mapToDriverValue`, because most PostgreSQL drivers want JSON _text_ for a jsonb
parameter. `bun:sql` instead JSON-encodes whatever JS value it is handed for a
jsonb parameter, so the already-serialised string was encoded a second time and
the column stored a jsonb **string scalar** rather than an object. Measured on
Bun 1.4.0: a string parameter into a jsonb column stores `"{\"a\":1}"`
(`jsonb_typeof` = `string`); the same statement with the object stores `{"a":1}`
(`jsonb_typeof` = `object`).

_Why nothing noticed._ `mapFromDriverValue` JSON-parses a string, so the double
encode round-tripped invisibly through the ORM — write twice, read twice, same
object back. Every read through `db.select()` looked correct. What did **not** go
through that mapper was every SQL-level jsonb operation.

_What actually broke._ `refreshRoleSessions` and `refreshUserSessions` merge
session metadata with `metadata || $1::jsonb`, and `||` on two jsonb **strings**
concatenates into an array instead of merging objects. Reproduced:
`sessions.metadata` became `["{\"keepMe\":…}","{\"roleName\":…}"]` and the
permission patch was lost — a role's permission change did not reach the sessions
it was supposed to refresh.

_Two fix sites, because there are two ways a jsonb value reaches the driver_, and
a test covering one proves nothing about the other. Column writes: `db/schema.ts`
defines a local `jsonb` via `customType` with `toDriver: (v) => v`, deliberately
shadowing the drizzle export, covering `sessions.metadata`,
`role_permissions.permissions` and `audit_logs`' `old_data` / `new_data` /
`changed_fields`. Raw parameters: the two `tx.execute(sql\`… || ${patch}::jsonb\`)`sites bypass the column mapper entirely and now bind the **object** instead of`JSON.stringify` of it.

_Assert at the SQL level — not through the ORM read path, which is what hid
this._ For every jsonb column, after a write through Drizzle,
`jsonb_typeof(column) = 'object'` — the whole defect in one assertion, and the
one a `select` through Drizzle cannot make. `refreshUserSessions` and
`refreshRoleSessions` **merge**: an unrelated pre-existing key survives and the
patched keys are overwritten; both halves, because a replace passes the second
and fails the first while a broken merge fails both. The raw merge statement, run
directly, produces `jsonb_typeof = 'object'` and not an array.

_Fixture rule:_ **reset the row between cases.** Once a row holds an array,
`array || object` appends and every later assertion in the same test reads
contaminated state. This happened while writing the check and made a working fix
look broken.

_Also worth a guard:_ the bug is only reachable with `prepare: true` (the
default). Without a prepared statement Bun does not learn the parameter is jsonb
and sends it as text, which PostgreSQL parses correctly — so the same code is
correct under `prepare: false` and wrong under `prepare: true`. Any future move
to `prepare: false` (which the runbook prescribes if a transaction pooler is ever
introduced) must not be read as making the helper unnecessary.

**Corrections to this section, from porting it (2026-08-21).** Each was found by
writing the assertions against the real driver, and each is a place the entry as
written would have accepted a weaker test:

- **`changed_fields` must be `'array'`, not `'object'`.** §7.4g prescribes
  `jsonb_typeof = 'object'` "for every jsonb column" and notes a few lines earlier
  that `changed_fields` stores an array — it contradicts itself. The invariant that
  generalises is: **`jsonb_typeof` matches the kind of the JS value written, and is
  never `'string'`.** `'string'` is what the double encode produced, so that is the
  half worth asserting explicitly.
- **The `cause` branch is not "half" — it is all of it.** For anything thrown
  through Drizzle the TOP level carries neither `errno` nor `constraint`. So every
  real-error path depends on the `cause` branch, and the top-level spellings are
  defensive only: `Bun.SQL` is module-private in `db/index.ts`, so no reachable
  code can produce a bare driver error. Say that, rather than implying the two are
  comparable.
- **The advisory-lock assertion asks for the wrong property.** Visibility in
  `pg_locks` would also be satisfied by a lock leaked to another session or by a
  key derivation that collided. What `processOtpSend` needs is **mutual
  exclusion**: two overlapping transactions on the same key, the second blocked
  until the first commits. Release-at-commit is likewise unasked, and the `xact`
  in `pg_advisory_xact_lock` is a promise about exactly that. Both are still
  unproven — `pg_locks` is cluster-wide, so an unscoped post-commit count is flaky
  when several harness runs share the server.
- **"The row count is unchanged" is satisfiable by an insert that never ran.** The
  rollback case needs a read INSIDE the transaction before the throw.
- **The zero-row cases are the security-relevant ones.** §7.4c names only the
  positive counts, but the role `DELETE … RETURNING` returning **0** is what
  raises the 400 that keeps a role with users undeletable, and the locking
  `SELECT` returning **0** is what raises the 404 protecting a system role. Those
  are precisely the branches `deleted.rows.length === 0` (`undefined === 0`,
  false) silently disabled.
- **There is a fixture rule but no statement rule.** "Never a hand-authored error"
  is repeated per item; nothing forbids a hand-copied SQL string, which is the
  obvious way to satisfy §7.4c and produces a test that passes forever against a
  statement nobody runs. Extract the statement from the source at run time and
  fail hard when the extraction misses.
- **`sanitizeForLog` has two branches keyed on `NODE_ENV`, and this section does
  not say which one it means.** The database tiers must run
  `NODE_ENV=development` (for `/api/dev/sign-up`), so every live-database
  assertion lands on the development path. The PRODUCTION branch paired with a
  real driver error is currently uncovered by anything —
  `tests/unit/log-serializer.test.ts` covers it with a constructed error.
- **Eight assertions was the wrong size.** The probe had no cross-check that the
  predicates can return false, no in-transaction read before the rollback, no
  proof the compared PID was not a constant, no completeness check on the jsonb
  column inventory, and it read the merge result back through the ORM — whose
  `fromDriver` is a pass-through, so that read was one refactor away from being
  unable to see the defect it existed for. Twenty tests is the honest size of
  a/b/c/d/g.

**h. The migration runner.** `bun run db:migrate` is `scripts/migrate.ts` and
applies both phases: `db/drizzle/` through the ORM's own migrator, then the
idempotent hand-written SQL in `db/migrations/`. `drizzle-kit migrate` cannot run
here at all — it supports four drivers and this project deliberately has none of
them. Assert against a scratch database, never the dev one:

- A fresh database ends with the 9 tables, the 8 enum types, `pg_trgm`, and all
  four trigram GIN indexes.
- The ledger is `drizzle.__drizzle_migrations` with one row per journal entry and
  `created_at` equal to the journal's `when` — this is what makes the script
  interchangeable with `drizzle-kit migrate`, and it is the claim the script's
  header makes. A test is what keeps it true across a drizzle upgrade.
- Running it twice is a no-op: no new ledger rows, no error from the
  `IF NOT EXISTS` files.
- Phase order asserted **by consequence**, not by reading the code: on a fresh
  database the trigram indexes exist, which is only possible if the tables they
  index were created first.
- `bun run db:generate` reports "No schema changes" against `db/schema.ts` — the
  migrations on disk really are the schema. Cheap, and it is the check that
  answers "are the pending migrations applied, or just rewritten". It is also the
  guard that the `customType` jsonb fix keeps emitting `jsonb` rather than
  silently becoming a migration.

### 7.5 Pure logic — the untested majority of the codebase

Everything in this subsection is unit tier: no IO, no database, milliseconds. It
is where the highest value per line is, and none of it is blocked on anything.

**`lib/permissions/checker.ts` — `resolveActionScope`.** Highest value in the
repository: a bug here is an authorization bypass and the function is pure.

**It is not exported.** Verified at `HEAD`: `lib/permissions/checker.ts:41` reads
`function resolveActionScope(`, and an import fails with
`Export named 'resolveActionScope' not found`. Its own doc comment claims the
opposite ("the function is exported to every future call site"), which is how the
discrepancy went unnoticed. Export it before writing the matrix below — it is a
pure function guarding authorization and the case for testing it directly is the
strongest in this document. Expect `knip` to report the new export as unused,
since a test will be its only consumer; that is the expected cost, not a reason
to revert it. The alternative — leaving it private and reaching it through
`checkUserPermission` — pays a session and a database round trip per case and
belongs to §7.6 instead.

Assert the full matrix over `DASHBOARD_PAGES × PERMISSION_ACTIONS` with
`test.each` — an empty matrix denies; the exact grant allows with `scope: 'all'`;
the `Own` variant alone allows with `scope: 'own'`. Plus the two cases the
function's own comment records as previously wrong: holding `edit` while asking
for `editOwn` must be `allowed: true, scope: 'all'` (it was denied outright), and
holding only `editOwn` while asking for `editOwn` must report `scope: 'own'` (it
reported `'all'` — an own-scoped grant reported as unrestricted). No route asks
for an own variant today, which is exactly how a latent trap becomes a live one.
Also assert an unknown resource, a `null` matrix, and prototype-polluted keys
(`__proto__`, `constructor`) all deny — the function indexes a plain object with a
caller-supplied key.

**`lib/permissions/utils.ts` — `sanitizePermissions`, `normalizeFullPermissions`,
`permissionsEqual`, `diffPermissionMatrices`, `validatePermissionScope`.**
`sanitizePermissions` is the boundary between a `jsonb` column and the
authorization matrix, so assert it against hostile column content: an unknown
page name, an unknown action, a non-boolean truthy value (`1`, `"true"`), a
nested object, `null`, an array where an object is expected. Each must be dropped
rather than passed through — a `"false"` string surviving as truthy is a grant.
`validatePermissionScope` is the "cannot grant what you do not hold" rule: an
actor holding a strict subset cannot grant a superset, per page and per action,
and equality is permitted.

**`lib/rate-limit/api.ts` — `ipBucket`, via `ipIdentifier`.** Hand-rolled IPv6
parsing, which is where this class of bug lives. Assert: full IPv4 unchanged;
IPv4-mapped IPv6 (`::ffff:1.2.3.4`) unchanged; an uncompressed IPv6 collapses to
its first four hextets; **the same address written compressed collapses to the
same bucket as its expanded form** — two spellings of one address must not be two
budgets; `::1`; `::`; a `::` mid-string; an address with a zone index. Assert the
invariant rather than the strings: any two addresses in one /64 map to one key,
any two in different /64s do not. Also assert `ipIdentifier` throws **503** when
no trusted header is present in production and resolves the loopback fallback
under `NODE_ENV=development` — the fail-closed direction is the security
property, and 400 would let a privacy-collapsing OTP catch mistake it for a
client error and return a fake success.

**`lib/rate-limit/api.ts` — the quota keys.** Assert the recovery surface uses a
**different** key from the shared destination budget
(`otp.send.dest.recovery.*` vs `otp.send.dest.*`): reserved capacity only counts
as reserved if nothing else can spend it, and a refactor collapsing the two keys
silently reintroduces a targeted account-recovery denial while every count
assertion still passes. Assert `otpContactKind` maps both `sms` and `whatsapp` to
`phone`, since keying on the channel is what let a caller double a paid budget by
switching transport.

**`lib/http/pre-auth.ts` — `preAuthScope`.** Assert `/api/dash/users/<uuid>` and
`/api/dash/users/<other-uuid>` produce the **same** scope (ids must not explode
the keyspace) while `/api/auth/forgot-password/send` and `/api/dash/users`
produce **different** ones (one surface must not throttle another — the defect the
function exists for, where anonymous recovery traffic and authenticated dashboard
traffic from one office NAT drew on a single counter). Also the 40-character
segment truncation, `/api` alone yielding `preauth.root`, and a path with empty
`//` segments.

**`lib/rate-limit/index.ts` — `rateLimit`'s arithmetic.** `windowStart` is
`now - (now % windowMs)`, so this is the natural home for `setSystemTime`: the
counter resets exactly at the boundary; `retryAfter` is floored to 1 s rather
than 0 immediately before a rollover (the hot-loop case); a denial reports
`remaining: 0` **without a follow-up read** — reading it back was a race where a
concurrent process rolling the row into the next window overstated `retryAfter` by
a whole window (measured 61 s where 1 s was correct). Then assert the degraded
path returns `success: true, degraded: true`, and that `enforceRateLimit`
converts exactly that into a **503 with `Retry-After`** when `failClosed` and
into nothing when not. That pairing is the fail-closed contract of every OTP and
auth path.

**`utils/time.ts`.** Partly covered already. Extend to: the Riyadh default (a
zone with no DST) and a DST zone across both transitions;
`zonedDayStart`/`zonedNextDayStart` on the skipped and the repeated hour;
`calendarDayInZone` immediately either side of midnight. Drive with
`setSystemTime`, not hand-built dates, so the assertion is about the function
rather than the fixture.

**`utils/index.ts` — `sanitizeForLog` / `serializeForLog`.** The SQLSTATE cases
are in §7.4b. Add the general containment property: a deeply nested object, a
cyclic object, a `Headers`, an `Error` with a `cause` chain and a `Buffer` all
serialize without throwing and without emitting a value from any redacted key.
Assert the key-**fragment** rule with `test.each` over `password`, `newPassword`,
`currentPassword`, `token`, `secret`, `otp`, `code` — fragments rather than exact
names is what the redactor learned the hard way, since an exact set let
`newPassword` and `currentPassword` through.

**`utils/index.ts` — `validID`, `returnNumber`, `positiveInt`,
`normalizeArabicDigits`, `extractIdFromUrl`.** `validID` gates every id that
reaches SQL: assert it rejects a v4 UUID, a non-UUID of exactly 36 characters, an
uppercase variant and one with surrounding whitespace. `normalizeArabicDigits`
runs before numeric validation: assert Arabic-Indic and Extended Arabic-Indic
digits both normalize and that a mixed-script string does not silently
half-convert.

**`utils/validation/*` — the Zod schemas.** The largest untested surface, and
pure. Per schema, with `test.each`: the minimal valid input parses; each required
field's absence is rejected; each length bound rejects at `max + 1` and accepts at
`max`; and the `z.preprocess` layers (`emailSchema`, `passwordSchema`,
`phoneSchema`, `otpCodeSchema`, `slugPreprocess`, `datePreprocess`) **normalize**
rather than merely validate — trimming, case-folding, Arabic-digit conversion.
Then two properties that are not per-schema: **`.strict()` schemas reject unknown
keys** (mass assignment is the failure mode), and the documented-required
cross-check of §7.1g-B, which is the same assertion from the OpenAPI side and
must agree with this one. `sanitizeStrict` / `safeStringRegex` get their own
hostile-input table: control characters, RTL overrides, zero-width joiners,
`<script>`, a null byte.

**`lib/data-table/filter-columns.ts` — `escapeLike`, `filterColumns`,
`getColumn`.** These build SQL from query parameters. Assert `escapeLike`
neutralizes `%`, `_` and the escape character itself, and that a value of `100%`
matches literally rather than as a wildcard. Assert `getColumn` rejects a column
not in the spec (an allowlist, not a filter) and `operatorAllowedForType` rejects
an operator the column's type does not support. Assert `filterColumns` **throws**
`MSG_INVALID_FILTER` on a malformed filter rather than producing a query — the
failure to prevent is a silently-empty `where`, which reads as "no filter" and
returns everything.

**`lib/data-table/parsers.ts`.** Assert `MIN_SEARCH_LENGTH`, `MAX_SEARCH_LENGTH`,
`MAX_PAGE` and `MAX_PER_PAGE` are enforced (an unbounded `perPage` is a denial
vector), a non-numeric `page` falls back rather than producing `NaN` in SQL, and
`parseSortingState` rejects a column outside the allowlist.

**`lib/cache/prefix.ts` — `prefixUpperBound`.** Assert directly rather than only
through `cacheDeletePrefix`: the empty prefix, a prefix ending in `0xFF`, and a
prefix containing `%`, `_`, `*`, `?` and `[` — the closed key grammar `TODO.md`
requires before the first cache call site exists.

**`lib/auth/password-pepper.ts` — `validatePasswordPepperConfiguration`.** A
keyring missing the active id is rejected at load; a secret below the length
floor is rejected; malformed JSON is rejected; and a keyring still containing a
**retired** generation is accepted — removing one while codes hashed under it are
inside their expiry is the HTTP 500 `TODO.md` describes. Configuration parse
only; no hashing needed.

**`utils/api-response.ts` — `handleApiError` and the violation mappers.** A
`CustomError` keeps its status, message and `responseHeaders`; an ordinary
`Error` becomes a fixed generic 500 with no dependency message reaching the
client; a `ZodError` becomes 422 with field-level detail;
`handleUserUniqueViolation` maps a **real** driver error to 409 (§7.4a — never a
fixture). Assert `getErrorHeaders` preserves `Retry-After` and `X-RateLimit-*`:
the limiter's contract is in the headers, not the body.

**`utils/svg/*` and `utils/images/*` — `sanitizeSvg`, `validateSvgFile`,
`isDangerousValue`, `safeDecodeURI`.** Security-relevant and pure. One table of
hostile SVGs, all neutralized: inline `<script>`, `onload`, a `javascript:` href,
a `data:text/html` href, `<foreignObject>`, an external `xlink:href`, a CSS
`@import`, a percent-encoded `javascript:` (which is what `safeDecodeURI` exists
for), an entity-expansion payload, and a document past `SVG_MAX_ELEMENTS`.
`validateSvgFile` rejects a non-SVG with an `.svg` name. **Run the same table
against both copies**: `utils/svg/server.ts` and `utils/images/server.ts` are
divergent duplicates of security code (`TODO.md` EM-11), and running one table
against both is what makes the divergence visible instead of theoretical.

**`lib/r2/upload-helper.ts` — `validateMagicBytes`, `isAllowedImageType`.** Each
allowed type's real magic bytes pass; a PNG header under a `.jpg` name is judged
by bytes not name; a polyglot (valid GIF header followed by `<script>`) is
rejected; a truncated header is rejected rather than throwing; an empty buffer is
rejected.

**`lib/r2/client.ts` — `getCacheControlHeader`, `getContentDisposition`,
`getPublicUrl`, `isAllowedMimeType`, `getR2ConfigStatus`.** Pure.
`getContentDisposition` decides whether a browser renders or downloads
attacker-supplied content, so assert quoting and that a filename containing a
quote, a newline or a non-ASCII character cannot break out of the header value.

**`utils/sanitize-filename.ts`.** Path traversal (`../`, `..\`), an absolute
path, a Windows device name (`CON`, `NUL`), a trailing dot or space, a null byte,
an over-long name, and a name that sanitizes to **empty** — which must produce a
generated id rather than an empty string.

**`lib/id.ts` — `generateUuidV7`.** Format against the application's own
`UUID_V7_REGEX`, the version nibble, the RFC 9562 variant bits, and strict
monotonicity across a burst. Load-bearing: these are time-ordered primary keys
and the session list pages on a `(createdAt, id)` keyset cursor.

The implementation is now `Bun.randomUUIDv7` (`TODO.md` EM-5, switched
2026-08-20; `uuid` had been kept because 1.3.x wrapped a 12-bit counter and
inverted at index 4096 of a millisecond bucket, which 1.4.0 fixed by advancing
the embedded timestamp instead). Two consequences for what must be asserted, and
both are cheap:

- **The burst has to be big enough to exhaust the counter** — over 4,096 ids
  inside one millisecond — or the assertion passes without testing the case that
  used to fail. Assert the bucket size it actually reached, not only the absence
  of inversions.
- **Assert the embedded timestamp is never behind `Date.now()`**, and do not
  assert it is never ahead: counter exhaustion deliberately borrows future
  milliseconds (measured 333 ms ahead in a 3M-id tight loop). Behind is the
  ordering defect; ahead is the accepted cost. `bench/uuid/` covers both against
  the two implementations; the suite's job is the narrower one of keeping the
  property true for the one that ships.

**`lib/http/security-headers.ts`.** HSTS present under `NODE_ENV=production` and
absent otherwise; CSP, frame and referrer headers on every response including
error paths (the wire half is §7.1e).

**`lib/http/route-manifest.ts` — `toManifest`, `createRouteLookup`,
`allowHeader`.** The pure half of §7.1c: `GET` implies `HEAD`, `OPTIONS` always
included, prefix folding, and the ordering that makes `/api/dash/users/me/...`
win over `/api/dash/users/:id`.

### 7.6 Integration behaviour

Seam: in-process handlers plus a real database, per §4.

**`utils/otp.ts` — `processOtpSend` / `processOtpVerify`.** The most
concurrency-sensitive code in the repository, and local sub-millisecond latency
will expose races Neon's tens-of-milliseconds RTT masked. Race windows scale with
RTT, so a TOCTOU the old stack hid can surface here — and lock contention that
only appears at local speed never appeared on Neon. Use `{ repeats: n }` so a
single lucky ordering does not read as a proof.

- `OTP_MAX_ATTEMPTS`, `OTP_MAX_VERIFY_ATTEMPTS`,
  `OTP_MAX_DAILY_VERIFY_ATTEMPTS` and the six-hour block each admit exactly their
  limit and deny the next — checked by **row state**, not only by response
  status.
- Concurrent verifies of the same code consume it **once**: two parallel requests
  with the correct code produce one success and one failure, not two successes.
  This is what `pg_advisory_xact_lock` and `FOR UPDATE` are for, and §7.4d proves
  the driver can now hold them.
- The advisory lock in `processOtpSend` is actually taken — asserted via
  `pg_locks` for the transaction's backend PID, using the production statement.
- Delivery-failure accounting: a provider that throws leaves the row in the state
  the code claims, and the global breaker is charged at the **delivery boundary**
  and not by the pre-lookup chain. `otp-global-breaker.test.ts` asserts this with
  `rateLimit` stubbed; the integration version asserts it against the real store.
- Anchored-window honesty, with `setSystemTime`: 2000 sends at 23:59 UTC **plus**
  2000 at 00:01 UTC both succeed. That is the accepted behaviour `TODO.md`
  records; asserting it keeps it a decision rather than a surprise.
- `verification_sessions.verify_attempt_daily` is summed across matching
  `(userId, contactKind)` rows, each with its own anchored 24-hour window, and
  successful verification, credential rotation and cleanup can delete rows and
  therefore forgive their failed attempts. Assert the behaviour as an **anchored
  fixed window**, never as a rolling one — the wording rule in `TODO.md` applies
  to test names too.

**`lib/auth/login-guard.ts` — `verifyLoginAttempt`.** The lock counter increments
per failure; the lock engages at the threshold and releases at `locked_until`
(drive expiry with `setSystemTime`); a correct password mid-lock is still
refused; a successful login resets the counter. Then the concurrency case: N
parallel wrong passwords produce exactly N increments, not fewer — a lost update
here is a brute-force window.

**`lib/permissions/checker.ts` — the DB path.** A deleted session row denies a
**write** even while the cookie cache would still serve the session; a
deactivated user denies; an inactive role denies; a user with no role gets 403
rather than 401. And assert the boundary this deliberately does **not** cross: a
**read** still succeeds from cache for the cache window, because that is the
accepted trade — a test that "fixes" it would be asserting a decision nobody
made. `assertLiveSession` is a pre-transaction check: it proves the row existed
when it ran, not that it still exists when the mutation commits. Do not write a
test name or comment claiming it closes the rotation race.

**`lib/permissions/utils.ts` — `refreshRoleSessions` / `refreshUserSessions`.**
§7.4g, and it is the sharpest item there: assert the merge at the **SQL** level.

**`lib/auth/rotation.ts` — `revokeOtherSessions`, `revokePendingProofs`.** A
password change deletes every other session and leaves the current one; pending
proofs for the rotated contact are gone; and the audit row is written in the same
transaction — a rotation that commits without its audit entry is the one case the
audit log cannot reconstruct.

**`lib/audit.ts` — `auditLog`.** Against a real insert: `old_data`/`new_data`
containing `newPassword` stores the key with no value; `jsonb_typeof` is `object`
(§7.4g — audit's three jsonb columns are in the same class); `apiPath` and
`userAgent` truncate at their constants rather than erroring.

**The insert must be against a REAL database, and the payload must come from
`stripSensitive` rather than be a hand-written literal.** That is the whole
assertion, and it is the only shape that catches what shipped. `redactValue`
builds its result with `Object.create(null)`, and Drizzle's `is()` — run on every
value handed to `.values()` — reads
`Object.getPrototypeOf(value).constructor`, which throws `null is not an object`
for a prototype-free object. Every audited write was a `TypeError`, including the
one on the login-success path, and `bun run test` was 150/150 green throughout,
because no test ever put a `stripSensitive` result into a real insert. A test
that calls `stripSensitive` and inspects the returned object proves the redaction
and cannot see this at all.

**Nesting is NOT what makes the test work** — worth stating, because the obvious
guess is that it is. A flat prototype-free object throws exactly the same way:
`is()` reads only the top-level prototype. So one level is enough to catch the
regression. Include a nested object anyway, for a different assertion: it pins
that the fix preserves structure rather than flattening it.

**Also assert `changed_fields` survives as an ARRAY.** `clampJson` is the shared
choke point for all three jsonb columns, and `changedFields` is a `string[]`. The
fix re-parses the JSON string it already builds; the tempting cheaper fix, a
spread, would have turned that column into `{ 0: '…', 1: '…' }`. Assert
`jsonb_typeof(changed_fields) = 'array'` after an UPDATE audit, so a future
"simplification" back to a spread fails here instead of silently changing the
column's shape.

**Per-route enforcement, table-driven.** §7.1c proves each route is _reachable_;
this proves each one _enforces_. For every mutating route in `ROUTES`:
unauthenticated is 401; authenticated-but-unauthorized is 403; a malformed body
is 422; a valid request produces the documented status **and** an `audit_logs`
row; the response envelope matches the contract. Routes with
`preAuth: 'ip-limit'` additionally answer **503** when the limiter store is
broken — fail-closed is the entire purpose of `enforcePreAuthIpLimit`, and a
passing 429 test does not prove it.

**`app/api/upload/image/handler.ts`.** The per-file byte ceiling, the magic-byte
rejection, and the authorization gate. **Corrected 2026-08-21: this entry used to
say the route is "still **unauthenticated** (`TODO.md` item 1)" and that was
wrong on both halves.** `app/api/upload/image/handler.ts` calls
`requireAnyPermission(ctx, { resource, actions: ['create', 'edit'] })`, and
`TODO.md` item 1 is the stale-login-proof race — nothing in `TODO.md` records this
route as unauthenticated. So the gate is the contract: anonymous is 401, a session
holding every OTHER action on the same page is 403, and a grant on one dashboard
resource does not authorise another.

Two properties worth naming because a status code cannot show either. **The
`resource` query parameter is validated before the multipart body is parsed** —
every rejection is a 400 or a 401 whether the body was buffered first or not, so
the assertion has to observe the body accessors rather than the response.
**And an `editOwn`-only grant is currently admitted**: `resolveActionScope`
answers `allowed: true, scope: 'own'`, `requireAnyPermission` reads the boolean
and drops the scope, and a temporary upload has no record to scope against. Pin it
as current behaviour rather than as an endorsement — it is written down nowhere
else, and if `create`/`edit` were meant as strictly unrestricted here it is a gap.

**The documented enumeration oracle is real:** an anonymous caller gets 400 for an
unknown `resource` and 401 for a known one, so valid page names are
distinguishable without a session. The handler accepts this because
`DASHBOARD_PAGE_NAMES` is already published in `/openapi.json` — which means the
safety of this route depends on that document staying public, and nothing links
them but a comment. Assert it in both directions, so hardening it fails loudly as
a deliberate change.

**The upload pipeline runs on `Bun.Image`, not `sharp`** (as of 2026-08-21 —
`bench/image/` holds the measurement). Four assertions follow from that change,
and the first is a shipped-defect regression test.

**a. The alpha channel survives** (shipped). Encode a PNG carrying soft
transparency through the real `optimizeImage`, decode the result, and assert the
alpha channel still has **more than two distinct levels**. That is the
assertion — not a byte or size comparison — and the reason is what it caught: the
two `.webp()` calls passed `alphaQuality: 1`, the WORST value on sharp's 0-100
scale rather than an "on" flag. Measured: 167 distinct alpha levels became 2, a
pixel at alpha 127 decoded as 0, anti-aliased edges became a 1-bit mask, and the
file was 9% LARGER for it. Nothing failed and every upload looked successful. The
option does not exist on `Bun.Image`, so the specific defect cannot return — but
the property is what matters, and it holds the new encoder to it too.

**b. Animated WebP is REJECTED, with its own message.** `image/webp` is in
`ALLOWED_IMAGE_TYPES` and the magic-byte check only proves `RIFF`/`WEBP`, so an
animated file is a well-formed upload of an unwanted kind. `validateMagicBytes`
now walks the RIFF chunks and refuses when `VP8X` carries the animation flag,
returning `{ valid: false, animated: true }` so the handler can say "animated
images are not supported" instead of "content does not match its type". Assert
three things, because two of them are the ways this breaks: an animated WebP is
refused with `animated: true`; a still WebP is **still accepted** (a chunk walk
that over-matches would reject every WebP); and a PNG declared as `image/webp` is
still refused with `animated` absent, so the two rejection reasons cannot be
confused. Before this, sharp silently kept the first frame and the user got back
a still image with no explanation. Authoring the fixture needs hand-assembled
RIFF chunks — `sharp` cannot write one in this tree (measured) — and
`bench/image/shared/corpus.mjs` has a working builder to lift.

**c. An SVG upload stores no blurhash, and never reaches a raster decoder.**
`Bun.Image` cannot decode SVG at all, which is fine because the rasterisation
only ever existed to produce a placeholder for a file that arrives in a few
kilobytes already sanitised and minified. Assert that an SVG upload succeeds with
`blurhash` null and that `files.blurhash` stays nullable — the column, not just
the code, is what a future consumer will trust.

**d. The blurhash is computed on a white composite.** `blurhash.encode` ignores
the alpha channel, so without compositing the placeholder is derived from
whatever RGB sits under fully transparent pixels — a value no viewer sees, and
one the two decoders disagree about (measured: decoded placeholders differed by
up to 101/255 on a transparent PNG). Assert the property rather than a hash
string: for an image with transparency, the decoded placeholder must be close to
what "flatten onto white, then encode" produces — hash strings legitimately
differ because two lanczos3 implementations round differently and blurhash
quantises to 83 buckets per component. Comparing hashes for equality is the wrong
assertion at this layer and will fail for reasons that do not matter.

**`app/api/dash/users/[id]/handler.ts` and `.../sessions/handler.ts`.** The
`editOwn` gate: an actor with `editOwn` viewing a user they did not create is
refused, and the sessions subresource refuses for the same reason on page one as
on page two. Session metadata (IP, user-agent) must be gated by the same role
authority the `/sessions` subresource requires, which needs `createdBy` and
`roleId` from the user row plus an `actorCoversTargetRole` check — when sessions
were fetched in parallel with the user query, page one arrived through this
endpoint while only page two was refused by the child route. Assert both, or the
fix is only a comment.

**Keyset pagination — `app/api/dash/users/[id]/sessions/pagination.ts` and
`db/queries/*`.** The cursor is stable across a page boundary when a row is
inserted between requests, and a forged or garbage cursor is rejected rather than
scanning from the start.

**Property test worth having, from `TODO.md`:** a concurrent role rename plus a
user role change (the same user moving off the role as it is renamed) converges
to a consistent final state — no orphan sessions, no stale `roleName` in
`session.metadata`.

**Which clock a boundary is on, before reaching for `setSystemTime`.** Added
2026-08-21, and it corrects guidance this document and the harness brief both got
wrong. `verification_sessions` carries BOTH kinds on one row, so the question is
per-column, not per-module:

- **Process clock — `setSystemTime` works.** Code expiry
  (`gt(expiresAt, new Date().toISOString())` builds the cutoff in JS and binds
  it), block expiry on the verify path (`new Date(session.blockedUntil) > new
Date()`), block stamping (`Date.now() + OTP_BLOCK_DURATION_HOURS`), and the
  send path's resend wait.
- **Server clock — `setSystemTime` is a silent NO-OP.** The 24-hour verify-failure
  window in all three places it appears (the `NOW() - verify_attempt_window_start
  > INTERVAL '24 hours'`predicate, the`SUM(CASE WHEN …)`read over it, and the
re-anchor write),`verified_at`/`consumed_at`, every `db/maintenance.ts`
cutoff (`now() - $1::interval`), and **every column default in this schema** —
  `defaultNow()` and `$onUpdate(() => sql\`now()\`)` never reach the JS clock.

The textual discriminator: `NOW()` or `sql\`now()\``**in the predicate** means
server clock;`new Date()`or`Date.now()` **at the call site** means process
clock. Drive a server-clock boundary by writing the row's timestamp
(`now() - <n> * interval '1 hour'`), never by moving the process clock.

**Why getting this wrong looks like a pass rather than a failure.**
`setSystemTime(+25h)` against the OTP budget expires the seeded CODE in JS terms,
so the verify returns `400 no-code` **without charging** — and an assertion of
"not 429" then reads as "the window reopened" when nothing of the sort happened.
A test written that way passes for the wrong reason forever.

Note also that §7.6's "anchored-window honesty, with `setSystemTime`: 2000 sends
at 23:59 plus 2000 at 00:01" bullet is about the SQLite global send breaker, a
different store with a different clock. The phrase "anchored fixed window"
describing two clocks is how this guidance came to be wrong in the first place.

**`db/maintenance.ts` — the retention sweep behind `/api/internal/db-sweep`.**
Added 2026-08-21. This document had no entry for it at all — `grep -c retention`
returned 0 — while eleven assertions for it already existed in
`scripts/probe/dev-live/database/retention-sweep.dev-probe.ts`. That probe is the
specification; this entry exists so the port has somewhere to land instead of
being deleted as uncatalogued.

**Every assertion is PAIRED: one row that must go, and one adjacent row that must
stay.** That is the whole discipline of the entry. A sweep is only correct if it
is also narrow, and a `WHERE` clause that deletes too much passes any test that
only checks the target vanished — which is the shape of a data-loss incident that
looks like a passing suite.

The pairs:

- an expired session past the grace window is removed; one inside the window stays
- a consumed proof row is removed, and its live code goes with it by cascade
- a proof row past its TTL is removed; a fresh unconsumed one stays
- an expired code is removed **without** taking its still-live session
- a recent temporary file is untouched, and a non-temporary file is untouched
  however old
- a temporary file's row **survives** a FAILED R2 delete, so the object is never
  orphaned — the one case where not deleting is the correct behaviour

_Seam:_ integration, and it is the entry that most needs the disposable database.
The sweep deletes every qualifying row in the database rather than only the rows
the test seeded, which is why it could never be asserted against the developer's
`.env` database and why it is safe to assert now. `hasMore` under a real backlog
(§7.2f) belongs with it.

### 7.7 The Better Auth sign-in contract

Added 2026-08-21 from `reports/better-auth-1.7-upgrade-review.md`. The framing
that earns this its own subsection: **a complete authentication outage passed
`tsc --noEmit` AND 150/150 probes.** Better Auth 1.7 changed the credential
lookup from `providerId === 'credential'` to a three-part match on
`(providerId, issuer, accountId)`; `accounts` had no `issuer` column, so every
password login answered a well-formed `401` with correct credentials. Nothing in
either gate could see it, because the project's own type-checking never meets the
library's account-model requirement and no test signed anybody in.

§7.1d already covers the Better Auth **path allowlist** — which paths are
reachable. This is a different axis: whether a request that reaches the handler
with valid credentials actually authenticates.

**a. Sign-in succeeds.** `POST /api/auth/sign-in/email` with a correct password
for a seeded user returns **200** and sets a `session_token` cookie. Assert both.
"Not a 500" is not the assertion — the defect's signature was a clean, correctly
shaped 401, so only the positive case detects it. This single assertion is the
highest-value test in this document: it is the one that would have caught the
outage.

**b. The account row satisfies the library's own predicate.** After creating a
user through the real path (`POST /api/dev/sign-up`, or the dashboard's user
create), assert the `accounts` row has `issuer = 'local:credential'`
(`CREDENTIAL_ISSUER`) and `account_id = user.id`. A row-level guard that fails at
the cause rather than four layers downstream at the response — worth having
alongside (a), because (a) tells you login broke and this tells you why.

**c. The check constraint holds.** An insert with any other `issuer` for a
`credential` row is rejected by `chk_credential_issuer`. Cheap, and it is what
stops a future third insert site from writing a value that reads as "wrong
password" forever.

**d. The whole allowed-path surface, in sequence.** Table-driven over
`BETTER_AUTH_ALLOWED_PATHS`: sign-in → `get-session` (from the cookie cache) →
`get-session?disableCookieCache=true` (from the database) → `sign-out`, asserting
`session.metadata.roleName` survives both read paths and that the `sessions` row
count drops to zero after sign-out. This exercises session create, read and
delete through `drizzle-orm/bun-sql` — a driver-and-adapter pairing nothing else
in this document covers, and the path 1.7's new affected-row validation runs on.

**e. Captcha fires on the configured endpoint, and only on it.** `400
MISSING_RESPONSE` for `/sign-in/email` with no `x-captcha-response`, and **404 —
not 400** — for `/api/auth/zz/sign-in/email/zz`. The second assertion is the
load-bearing one: it pins the matching semantics in both directions. 1.6.26
matched by substring and answered 400 there; 1.7 matches exactly and answers 404.
Either behaviour changing again is a security-relevant change to what triggers an
outbound Turnstile call, and only this assertion notices.

**f. Origin behaviour is pinned.** With valid credentials: same-origin → 200;
untrusted `Origin` → 403; `Sec-Fetch-*` present with no `Origin` → 403; and **no
`Origin` and no `Sec-Fetch-*` → 200**. Write the last one down explicitly — it
records that the protection is browser-only, which is easy to mistake for a gap
and is the reason API clients are unaffected. Note these run BEFORE any
per-account lockout matters: re-seed between cases, or a rejected attempt's
`failed_login_attempts` increment masks the next one.

**g. Every reachable `BASE_ERROR_CODES` key has an Arabic mapping.** Derivable
rather than a hand-kept list: iterate the codes the library exports, filter to
those reachable from the four allowed paths, and assert each is present in
`lib/auth/code-errors.ts`. Unmapped codes fall through `lib/auth.ts`'s `after`
hook and reach an Arabic-only UI as raw English — which is how
`INVALID_ORIGIN`, `MISSING_OR_NULL_ORIGIN`,
`CROSS_SITE_NAVIGATION_LOGIN_BLOCKED` and
`METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED` all shipped unmapped. Assert the
status is PRESERVED through that hook too (403 stays 403, 405 stays 405); it
re-throws with `failure.status`, and a regression there would turn a security
rejection into a 400.

**Seam.** All of (a)–(g) are in-process via `app.handle(new Request(...))` against
the real route table, plus direct SQL for the row-level assertions in (b) and (c).
No socket, no subprocess. Seeding needs three things the reproduction got wrong
first, so they are recorded here rather than rediscovered: ids must be **UUID v7**
(`validID` rejects v4, and the failure is a 401 from the session-create hook that
looks exactly like the defect in (a)); the email domain must be one
`emailSchema` allows (gmail/outlook/hotmail/live/yahoo, else a 422 before Better
Auth is reached); and the request needs `cf-connecting-ip` (the per-IP limiter
fails closed without a trusted header) and `x-captcha-response` (any value passes
against the development Turnstile test secret).

---

## 8. Coverage gating, scoped

Report coverage everywhere; gate almost nowhere. A repository-wide threshold
would be theatre twice over: most of the codebase has no tests even after this
pass, so a repo-wide number is either meaninglessly low or an immediate expected
failure — and coverage instrumentation only sees code executed **inside** the
`bun test` process, so every spawned-process tier (§7.1b1, §7.2, §7.3) reports as
uncovered no matter how thoroughly it is exercised, penalising exactly the code
this plan tests most rigorously.

Gate only where the suite is exhaustive by construction:
`lib/http/route-manifest.ts`, `lib/http/request.ts`,
`lib/http/response-policy.ts`, `lib/http/contract.ts`, `lib/http/pre-auth.ts`,
`resolveActionScope` in `lib/permissions/checker.ts`, `lib/rate-limit/api.ts`,
`lib/cache/prefix.ts`, `utils/time.ts`, `utils/sanitize-filename.ts`. A drop
there means a branch of the dispatch, admission or authorization logic escaped
the table-driven walk.

Use `coveragePathIgnorePatterns` to exclude everything else while the gate is
narrow, and **verify the gate fails before trusting it** — set the threshold
absurdly high once and confirm a non-zero exit. The singular-key trap in §2
means a misconfigured threshold is indistinguishable from a passing one.

---

## 9. Out of scope, deliberately

- **R2 network calls, SMTP delivery, Deewan, WhatsApp, HIBP, Turnstile
  siteverify.** Faked at the egress boundary (§4.3). Their real behaviour is a
  deployment check.
- **Better Auth internals.** Assert the configuration this project owns —
  `baseURL`, the allowed-path list, the limiter rules — not the library's session
  machinery.
- **Argon2 parameters.** Assert the profile constants; benchmarking belongs in
  `bench/`.
- **`sharp` output pixels.** Assert the decision (`shouldOptimizeImage`, the size
  and pixel ceilings), not the bytes.
- **Anything needing Linux.** The SIGTERM ordering in §7.3b and §7.4e cannot be
  tested on this machine: Windows `TerminateProcess` is not interceptable, so a
  spawned server killed with `SIGTERM` exits 143 with no handler output. Mark
  those `test.skipIf(process.platform === 'win32')` so CI runs them and the local
  run says so out loud rather than reporting a false pass.
- **`lib/http/adapters/hono.ts.disabled`.** Unverifiable by construction: it
  matches no tsconfig include, no lint glob and no test, and it drifted anyway —
  it called `attachBody`, deleted three changes ago, and nothing caught it. Its
  CORS policy was extracted into `CORS_POLICY` specifically so it could not
  drift, and the body contract — the security-relevant half — drifted regardless.
  Either give it a check that can fail (a static rule asserting every identifier
  it imports from `lib/http/*` still exists, which is cheap) or accept that it is
  prose and stop describing it as "the working adapter". Decision, not a test —
  `TODO.md` EM-17.

**One known-open gate, and it must be visible rather than absent.**
`utils/config.ts` sets `OTP_AUTO_VERIFY = true`, which is gate 1 of the
deployment runbook. Write the assertion that it is `false` as `test.failing`: the
suite stays green while the flag stands, and turns red the moment the flag is
fixed and the marker is stale. `test.skip` would go quiet, and a plain `test`
would make CI red forever and get deleted.

---

## 10. Order of work

1. **`tests/unit/` and the layout move.** No infrastructure decision, and it
   holds the highest-value target in the repository (`resolveActionScope`).
   Retire `scripts/probe/local` into it, fixing the fixture spelling and the
   CLI-style-probe trap (§5.1) on the way.
2. **`tests/helpers/database.ts` with all four guards — before a single
   integration test.** The guards are what stands between a destructive suite and
   the developer's `app` database, and `.env` auto-loading means the default is
   unsafe. Add `.env.test` to `.gitignore` in the same change.
3. **The CI `test` job** with the service container (§5.3). Unblocks branch
   protection and Renovate automerge.
4. **`tests/integration/`** — the §7.1c conformance walk first, since it is
   table-driven over the manifest and immediately covers every route's routing
   contract; then §7.4 (the driver assertions, which are the ones currently
   protected by nothing at all), then the OTP and login-guard concurrency work.
5. **`tests/process/`** — §7.1b1, §7.2, §7.3. Slowest, and the tier most likely
   to need Linux.
6. **The coverage gate**, last, when the numbers mean something.

**Critical path: 1 → 2 → 3 → 4.** Step 2 is the only one with a safety
consequence if it is done late.
