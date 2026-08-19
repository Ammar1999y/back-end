# Local storage migration review — verified current state

Updated: 2026-08-19

This report replaces the previous review in full. It verifies the implementation
and the claims in
[`local-storage-migration-review-response.md`](local-storage-migration-review-response.md)
against the current repository and production runtime.

Scope remains limited to findings retained by the project owner. Removed
findings are not reintroduced.

## Executive verdict

Core SQLite rate-limit, migration, cleanup, readiness, and bounded-sweep changes
work. The response is not fully accepted because:

- R-6 remains incorrect for keys beginning with `U+10FFFF`;
- the new SQLite probes are untracked and are not run by CI;
- saved probes bypass several production paths they claim to protect;
- P-3 and P-4 still lack retained startup/sentinel checks;
- R-8 still has stale `scripts/` wording;
- the Coolify runbook remains contradictory;
- current issues and open decisions remain in `TODO.md`.

| ID   | Current status                  | Verified result or remaining gap                                        |
| ---- | ------------------------------- | ----------------------------------------------------------------------- |
| P-1  | **Partial**                     | HTTP sweep works and yields; production integration test and CI absent  |
| P-3  | **Partial**                     | Production path guard works; retained sentinel and runbook fixes absent |
| P-4  | **Partial**                     | Exact cheap/deep readiness works; startup verification absent           |
| P-5  | **Fixed**                       | Production migration passed 24 concurrent-process starts                |
| R-1  | **Fixed**                       | Both production callers reject without writes and return correct retry  |
| R-2  | **Fixed in code; coverage gap** | All tables are bounded and yield; production regression test absent     |
| R-4  | **Fixed; decision open**        | Wording is accurate; NORMAL versus FULL remains owner choice            |
| R-6  | **Not fixed; pre-adoption**     | `prefix + U+10FFFF` is not a valid exclusive upper bound                |
| R-7  | **Accepted as scaffold**        | 512 KiB value cap works; pre-adoption requirements remain documented    |
| R-8  | **Partial**                     | Prior stale Redis text fixed; sweep route and runbook still stale       |
| R-10 | **Fixed**                       | Retained benchmark wording correction remains valid                     |
| R-11 | **Fixed**                       | Migration, PRAGMA, and prepare failures close native handles            |
| D-1  | **Not fixed**                   | Coolify instructions still contradict current implementation            |

## Remaining issues

### P-1 — High — Regression suite is not shipped or enforced

The HTTP route now runs successfully under the supported Node/Next.js runtime.
Every table uses bounded deletes, and `sweepInBatches` yields between full
batches. A production test with 20,000 expired rows in each table verified:

- 20,000 `rate_limit` rows removed;
- 20,000 `auth_rate_limit` rows removed;
- 20,000 cache rows removed;
- zero matching rows remained;
- sweep completed in 232.5 ms on this Windows host;
- concurrent cheap health request completed in 6.1 ms.

These timings prove event-loop cooperation on the tested host. They are not
Linux capacity numbers.

The retained testing requirement is still incomplete:

1. `scripts/probe/` is currently untracked by Git. It is trackable after the
   `.gitignore` change, but “trackable” is not “tracked.”
2. `.github/workflows/ci.yml` runs install, lint, format, and build only. It
   never runs `bun test` or the SQLite probes.
3. No package script exposes the intended CI test command.
4. The saved suite is SQL-semantic smoke coverage, not a production integration
   suite:
   - migration logic is copied and invoked sequentially rather than calling the
     production migration concurrently;
   - retry calculation is copied instead of calling `rateLimit` and
     `authRateLimitStorage.consume`;
   - only the rate-limit sweep SQL is checked, not auth/cache batching,
     yielding, `hasMore`, route authorization, or response shape;
   - prefix deletion supplies a hardcoded bound instead of invoking
     `cacheDeletePrefix`;
   - health, startup, and prepare-failure cleanup are not covered.

Required:

- commit the probe files;
- add a CI test step;
- add a production-entry integration test covering both databases, all three
  tables, authorization, output contract, yielding, and backlog behavior;
- make the test fail if the Node child exits unsuccessfully;
- if HTTP remains, enforce a strong maintenance-token contract and block
  `/api/internal/*` at the edge;
- make the scheduled task inspect `hasMore`; `curl -f` treats backlog responses
  as success because the route returns HTTP 200.

The HTTP-versus-CLI decision remains open. Core CI and test-quality fixes do not
need that decision.

### P-3 — High — Persistence protection remains partial

Production `SQLITE_DIR` validation is correct. Direct tests verified that:

- missing value fails module loading;
- whitespace-only value fails;
- relative path fails;
- absolute path succeeds.

Remaining gaps:

- no retained volume sentinel is checked during startup;
- the Coolify guide marks `SQLITE_DIR` runtime-only although production build
  imports the environment module and requires a build-time placeholder;
- the guide says a missing maintenance token prevents boot, but the token
  defaults to an empty string; routes fail closed and readiness returns 503;
- manual redeploy proof exists, but the sentinel is removed afterwards and
  cannot detect a later missing mount.

A retained sentinel is not persistence proof by itself. Its purpose is narrower:
detecting that a previously provisioned volume is absent or replaced during a
later startup. Real redeploy verification must remain in the runbook.

### P-4 — Medium — Startup verification is still absent

The current readiness route correctly checks exact values for:

- `journal_mode = WAL`;
- expected `user_version`;
- `busy_timeout = 2000`;
- `synchronous = NORMAL`;
- presence of the maintenance token in production.

The authorized deep route also passed `quick_check` and a real write probe.
Missing or wrong tokens returned 401; the correct token returned 200.

Still missing:

- a Node-only `instrumentation.register()` startup check;
- retained sentinel and exact production-volume validation at startup;
- recorded startup status exposed through cheap readiness;
- tracked tests for success, degraded, and unauthorized branches.

This work does not depend on HTTP versus CLI sweep execution. Only maintenance
token validation depends on retaining the HTTP maintenance routes.

### R-6 — Low · Pre-adoption — Prefix deletion still misses valid keys

`cacheDeletePrefix` executes this half-open range:

```sql
DELETE FROM cache WHERE key >= ? AND key < ?
```

Its upper value is `prefix + U+10FFFF`. Because the upper bound is exclusive,
these matching keys are not below it and survive:

- `prefix + U+10FFFF`;
- `prefix + U+10FFFF + "tail"`.

Both failures were reproduced through the production `cacheDeletePrefix`
function. The saved test passes because it tests U+FFFF and emoji, then
constructs the proposed U+10FFFF bound itself. It never invokes production
prefix-bound construction and never tests U+10FFFF keys.

Before first cache adoption, choose one correct contract:

- enforce a closed key grammar and calculate the successor within that grammar;
  or
- implement the true lexicographic successor of the prefix for SQLite BINARY
  collation.

Add production-function tests for ordinary text, U+FFFF, supplementary Unicode,
U+10FFFF, former GLOB metacharacters, neighboring namespaces, and empty prefix.

### R-8 — Low — Stale execution-model wording remains

`app/api/internal/sqlite-sweep/route.ts` still says `scripts/` is Git-ignored.
It is not. `reports/coolify-deployment.md` repeats the same claim.

Earlier stale Redis and deleted-script references in rate-limit code were fixed.
R-8 remains partial only for the current sweep-route/runbook wording.

### D-1 — High — Coolify guide is not deployment-ready

`reports/coolify-deployment.md` still contains conflicting instructions:

- production gates say no deployable sweeper exists, while the later sweep
  section says the HTTP route is ready;
- `SQLITE_DIR` is labelled runtime-only despite being needed during build;
- missing `SQLITE_MAINTENANCE_TOKEN` is described as a boot failure, but actual
  behavior is failed readiness and 401 maintenance routes;
- health documentation omits exact PRAGMA checks now returned by the route;
- scheduled-task success example does not match the current nested response;
- scheduled task uses `curl`, while prerequisites accept `curl` or `wget`;
- target application container is not explicit;
- the task does not parse or alert on `hasMore`;
- stale “scripts are ignored” text remains.

Most corrections are independent of the HTTP-versus-CLI choice and should be
made now. Only the sweep command, maintenance-token, and edge-routing sections
must wait for that decision.

### Tracking correction — current issues do not belong in `TODO.md`

Per project-owner instruction, current defects belong in this review. `TODO.md`
is for future, pre-adoption, or post-deployment reminders.

Move these current items out of `TODO.md`:

- S-9: missing CI sweep test;
- S-12: public maintenance-route exposure;
- S-8 and S-10 while they remain unanswered owner decisions.

The future Bun runtime migration, pre-adoption cache work, target-Linux
benchmarks, and post-deployment monitoring remain valid TODO material.

## Verified fixes

### P-5 — Production migration serialization

The real production store was started through eight concurrent Node processes
against a fresh database, repeated for three rounds. All 24 processes succeeded.
Each database ended with `user_version = 1` and exactly one copy of both tables.

### R-1 — Atomic admission, zero denial writes, correct retry time

Production callers, not copied SQL, were tested:

- API limiter: 7 admitted and 13 denied at limit 7;
- Better Auth limiter: 5 admitted and 9 denied at limit 5;
- denied calls added zero SQLite changes;
- both denial paths returned `retryAfter = 1` at the tested boundary;
- four concurrent processes admitted exactly 123 API calls at limit 123;
- four concurrent processes admitted exactly 77 auth calls at limit 77;
- stored counts matched admitted counts.

`SQL_PEEK` is gone from both production paths. R-1 is fixed.

### R-2 — Bounded cooperative cleanup

All three sweep statements are bounded. Shared helper yields to the event loop
between full batches. Production-server test proved health requests run during a
60,000-row sweep.

`hasMore` is conservative: exactly 100,000 deletions returns `true` even if the
last deleted row was the final expired row. This false positive is safe, but the
contract and runbook should describe it accurately.

### R-7 — Cache scaffold and value cap

Small value stored successfully. A 600 KiB value was rejected, with cache cap
reported as 524,288 bytes. Module remains clearly labelled as unused scaffold.

### R-11 — Native-handle cleanup

Malformed current-version databases forced statement-prepare failure three times
for both stores. Both database files were renamed while the process was still
alive. No native handle remained open. R-11 is fixed.

### R-4 and R-10 — Wording corrections

Durability wording now distinguishes process-crash safety from power-loss RPO.
Retained benchmark wording correction remains valid.

## Verification performed

- `bun test scripts/probe/local`: **34 passed, 0 failed**;
- `bun run lint`: passed;
- `bun run format:check`: passed;
- `git diff --check`: passed, with line-ending warnings only;
- production `next build`: passed;
- production `next start`: passed;
- cheap health: 200;
- deep health without/wrong token: 401;
- deep health with correct token: 200;
- sweep without/wrong token: 401;
- sweep with correct token: 200;
- 60,000-row production sweep: all rows removed, concurrent health 6.1 ms;
- production admission tests: exact limits, zero denial writes, correct retry;
- four-process admission tests: exact stored counts;
- 24-process production migration test: zero failures;
- prepare-failure handle test: passed;
- production `SQLITE_DIR` guard: passed;
- production cache-value cap: passed;
- production Unicode prefix deletion: failed for U+10FFFF boundary as described.

## Open decisions requiring owner input

1. **Sweep execution model:** retain HTTP route or create a tracked Node CLI.
2. **Power-loss RPO:** retain `synchronous = NORMAL` or require `FULL` for the
   paid daily OTP counter.
3. **WAL ceiling:** accept 64 MiB per database or provide the disk/backup budget
   used to select another value.

Do not start choice-dependent implementation until these are answered.
Independent R-6, CI, stale-comment, startup/sentinel, runbook, and tracking
fixes do not need those decisions.
