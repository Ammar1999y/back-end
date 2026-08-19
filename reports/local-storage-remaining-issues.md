# Local SQLite storage — remaining issues and improvements

Updated: 2026-08-19

Scope: everything changed since commit `c583d82` that relates to replacing
Upstash with local SQLite — `lib/sqlite/`, `lib/cache/`, `lib/rate-limit/`,
`app/api/health/storage/`, `app/api/internal/sqlite-sweep/`,
`lib/env.server.ts`, the CI/config changes, and `bench/sqlite/`. `.md`/`.txt`
files and `scripts/` were read only where they carried a claim worth checking.

Method: every finding below was either reproduced or measured. Where a number is
quoted, the command that produced it is named. Windows host, so absolute
latencies are indicative; the orderings and the pass/fail outcomes are not
host-specific.

**Gate status at the time of writing:** `tsc --noEmit` 0 · `eslint .` 0 ·
`prettier --check .` 0 · `bun test scripts/probe/local` **60 pass / 0 fail** ·
`bench --mode=correctness` all critical checks pass on both Node and Bun stacks.

---

## 0. Standing-instruction files: no history to review

`CLAUDE.md` and `.claude/` are both in `.gitignore` (`.gitignore:50-51`), and so
is `TODO.md`. Git has never tracked them, so there is no previous version of
`CLAUDE.md` or `.claude/skills/caveman/SKILL.md` to diff against `c583d82` — the
request to check what changed in them cannot be answered from this repository.

Both files were read in full and are being followed. If their history matters —
and for files that govern how every future session behaves, it probably does —
they need to be tracked, or kept in a second location that is. That is a
decision, not a defect, so it is recorded here rather than acted on.

---

## 1. Fixed in this pass

Small, verifiable defects. Each was fixed at a shared boundary rather than at
the site where it was noticed.

| #   | Issue                                                                                                                                                                       | Fix                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Two stacked JSDoc blocks on `sweepExpired`, the first stale (it described an unbounded sweep)                                                                               | Single accurate block                                                                                                                                     |
| 2   | `tokenMatches` — a constant-time secret comparison — copy-pasted into both maintenance routes                                                                               | One [`maintenanceTokenMatches`](../lib/sqlite/maintenance-token.ts); both routes import it                                                                |
| 3   | `hasExpiredRows` had zero callers, and the sweep route's backlog probe covered `cache` but neither limiter table — so an `auth_rate_limit` backlog was the one thing hidden | Probe now covers both limiter tables via `EXISTS`, wired into the route's `hasMore`, plus 2 new tracked probe assertions                                  |
| 4   | `journal_size_limit`'s comment implied it bounds WAL growth. It does not — see §2.1                                                                                         | Comment corrected with the measurement                                                                                                                    |
| 5   | `bench/` was git-ignored, yet `lib/sqlite/database.ts` and `lib/cache/index.ts` both cite `bench/sqlite/FINAL-REPORT.md` as their justification                             | `bench/` tracked; only `node_modules/`, `.bench-data/` and `results/` ignored                                                                             |
| 6   | The benchmark measured SQL the application had stopped running — see §4                                                                                                     | Harness realigned and version-bumped to v3; refusal path and prefix invalidation gained coverage; max-aware admission gained a critical correctness check |

On #2 and #3 specifically: neither was a live bug. They are here because a
duplicated security comparison and a half-wired signal are exactly the shapes
that become live bugs on the next edit, and both were cheap to converge.

---

## 2. Open findings

### 2.1 · High · `journal_size_limit` does not bound WAL growth — peak WAL is unbounded

`lib/sqlite/database.ts` sets `journal_size_limit = 67108864` (64 MiB). That
bounds the size a WAL is **truncated to once a checkpoint completes**. It is not
a ceiling on growth, and nothing in the deployment ever forces a checkpoint.

Measured directly (Node, `better-sqlite3` 13.0.3, WAL, `synchronous = NORMAL`,
`journal_size_limit = 67108864`), with one connection holding an open read
snapshot so checkpointing could not complete:

| Writes                                                    |    `-wal` size |
| --------------------------------------------------------- | -------------: |
| 20,000                                                    |       337.2 MB |
| 40,000                                                    |       676.8 MB |
| 60,000                                                    |     1,017.0 MB |
| 80,000                                                    | **1,357.2 MB** |
| after releasing the snapshot + `wal_checkpoint(TRUNCATE)` |         0.0 MB |

The benchmark's concurrent runs reproduce it from the other direction —
continuous writers, no long-lived reader — reaching **906 MB at two processes**
and **745 MB at four**.

The application itself never holds a read transaction open (every read is a
single statement), so the realistic trigger is sustained concurrent writes
rather than a lingering reader. That is the same condition as §2.2.

**Why it matters:** on a small VPS this is a disk-exhaustion path, and it fills
the volume the security counters live on. `data/` holding a 1 GB `-wal` is not
theoretical after a traffic spike or a deploy overlap.

**Recommended, in order:**

1. Enable Coolify's server-disk notification — the backstop that catches this
   regardless of cause. Documented in the runbook.
2. Have the hourly sweep report WAL bytes for both databases, so growth is
   visible before it is a problem rather than after.
3. Consider `PRAGMA wal_checkpoint(TRUNCATE)` at the end of the sweep. It takes
   the writer lock for its duration, so it needs its own measurement before
   being added to a scheduled task; this is why it is a recommendation and not
   already done.

Steps 2 and 3 are a small change to
[`app/api/internal/sqlite-sweep/route.ts`](../app/api/internal/sqlite-sweep/route.ts)
and are tracked in `TODO.md`.

### 2.2 · High · Multi-process write contention starves a worker, at the process count rolling updates guarantee

`bench --mode=concurrent --workload=rl_consume`, 5-second saturation window,
`baseline` profile, one shared `rate-limit.db`:

| Processes | Aggregate ops/sec | Worst worker | Worst p50 | `SQLITE_BUSY` | Peak WAL |
| --------- | ----------------: | -----------: | --------: | ------------: | -------: |
| 1         |            22,394 |            — |  0.028 ms |             0 |        — |
| 2         |            21,294 |    1,882/sec |  0.026 ms |         **1** |   906 MB |
| 4         |        **16,678** |    **0/sec** |  2,243 ms |         **6** |   745 MB |

Four processes produced **less** aggregate throughput than one, and one worker
was starved completely. This is consistent with the note already in
`lib/sqlite/database.ts` about `BUSY_TIMEOUT_MS`; what is new is that it is
reproduced at **two** processes, which a Coolify rolling update creates by
design.

**Why it matters beyond capacity.** A `SQLITE_BUSY` that outlives
`busy_timeout = 2000` reaches `rateLimit`'s catch and returns `degraded: true`.
From there the behaviour splits by call site, and both branches are bad in
different ways:

- **24 of 30** `enforceRateLimit` call sites pass `failClosed: true` — every
  OTP, auth, and mutation path. Those return **503**. Sign-in and OTP delivery
  stop.
- **6 of 30** do not: the dash read limiters in `permissions`,
  `permissions/[id]`, `roles`, `users`, `users/[id]`, and `upload/image`. Those
  **fail open** and lose their limit silently.

The Better Auth limiter is stricter still — `authRateLimitStorage.consume`
rethrows, so a store failure surfaces as an error rather than an unlimited
sign-in path. That is the right choice and should stay.

**Honest caveat.** These are saturation runs: each worker calls consume in a
tight loop with no think time, orders of magnitude above this application's real
traffic, on Windows. They establish that the write path does not scale across
processes and that the failure mode is starvation rather than graceful
degradation. They do not predict production behaviour at production load.

**Recommended:**

1. Keep **stop-first deployment** — already the runbook's default. This is now
   an evidence-backed default rather than a cautious one.
2. Keep one app process. Do not add `reusePort` workers, replicas, or a second
   container against this volume without re-measuring.
3. Re-run both concurrent workloads on the Linux VPS before any decision that
   increases the process count.
4. If sustained multi-process write contention ever becomes real, move limiter
   state to a durable shared store. **Do not raise `busy_timeout`** — it trades
   errors for longer synchronous event-loop stalls and adds no writer fairness.

### 2.3 · Medium · `secure_delete = OFF` retains deleted IP addresses, emails and phone numbers in the file

Open decision, and the default silently chooses the less private option.

Limiter keys embed raw identifiers — the API limiter's key ends in the
destination (email address or phone number), Better Auth's is `${ip}|${path}`.
With `secure_delete` off, deleting a row does not scrub its bytes; they persist
in the database file until those pages are reused.

The benchmark's raw-file probe (`deleted_pii_scrubbed_after_checkpoint`) inserts
a marker containing an IP address, an email address and a phone number,
checkpoints it into the main file, deletes it, runs a **successful truncating
checkpoint**, closes the database, then scans the bytes:

| Profile                | Marker after checkpoint |
| ---------------------- | ----------------------: |
| `baseline` (`OFF`)     |             **present** |
| `secure_delete = FAST` |                  absent |

Identical on both Node and Bun. This check currently reports `FAIL` on every
`baseline` correctness run — it is non-critical by design, but it is not noise.

Sweep-cost measurements at 5,000 rows were too noisy on Windows to price `FAST`
(spreads of 103–184%), so its overhead is unquantified rather than shown to be
free. SQLite documents `FAST` as scrubbing deleted content from B-tree pages
without additional I/O, and `ON` as additionally scrubbing freelist pages at a
cost.

**Recommended:** set `secure_delete = FAST` in `applyPragmas` for both
databases, then re-measure the sweep on Linux. If deleted identifiers are
deliberately retained, record that as an accepted policy instead — the point is
that it should be a decision.

### 2.4 · Medium · `cacheDeletePrefix` is the one unbounded delete left, and it blocks for tens of milliseconds

Every other delete in the codebase was converted to bounded batches with
yielding (`lib/sqlite/sweep.ts`). `SQL_DELETE_PREFIX` and `SQL_DELETE_FROM` in
`lib/cache/index.ts` were not.

`bench --only=cache_prefix_delete`, 5,000 keys of 1 KiB in the target namespace
plus 5,000 in a neighbour:

| Metric |   Value |
| ------ | ------: |
| mean   | 47.4 ms |
| p50    | 47.1 ms |
| p95    | 55.7 ms |

Both drivers are synchronous, so that is 47 ms of event-loop blocking per
invalidation, scaling roughly linearly — about half a second for a 50,000-key
namespace, during which no request is served.

**Pre-adoption, not live:** `lib/cache/` still has no call sites. Bound it
before the first one is written, using the existing `sweepInBatches` helper
rather than a second batching implementation. The bound has to preserve the
correctness the range form exists for — see `lib/cache/prefix.ts`, whose upper
bound took three attempts to get right.

### 2.5 · Medium · No startup verification, and the volume sentinel is written but never read

The stores open lazily on the first limited request. `/api/health/storage`
closes most of that gap — a container with a bad volume or schema fails its
check within one poll interval — but two things remain:

- **No single-run startup check.** Next 16.3.1 supports
  `instrumentation.register()` and skips it during `phase-production-build`, so
  there is a correct place for one. It should verify the resolved database path,
  that the driver loads, and the retained volume sentinel, and record the result
  where cheap readiness can report it.
- **The sentinel is not read by anything.** The runbook now says to retain it
  rather than delete it after the persistence test, which makes a lost mount
  detectable — but only by a human running `cat`. A startup check is what turns
  it into a signal.

Neither is a live defect; both are the difference between "detected within 30
seconds by the health check" and "refused to start". Together they are one piece
of work, which is why they are listed together.

### 2.6 · Medium · `/api/internal/*` is publicly reachable

Configuration, not code — nothing in the repository can fix it.

The sweep route is protected by `SQLITE_MAINTENANCE_TOKEN`, compared in constant
time, rejecting an unset token rather than treating it as "no auth required".
That boundary holds. But the scheduled task calls it on `127.0.0.1` from inside
the container, so the route never needs to be internet-reachable at all — and
currently it is, through the public domain like any other route.

Block or 404 `/api/internal/*` at Cloudflare or in the Traefik router so the
token is the second line of defence rather than the only one. The runbook now
carries the exact rule and a verification command. The same applies to
`/api/health/storage?deep=1`, though the cheap variant must stay reachable for
the orchestrator's health check.

### 2.7 · Low · Readiness does not cover `cache.db`

`/api/health/storage` opens and inspects `rate-limit.db` only. A broken,
unwritable, or wrongly-migrated `cache.db` passes readiness and first surfaces
as a 500 from the hourly sweep.

Acceptable while the cache has no call sites, and deliberately so: opening a
second database on every poll costs something for a store nothing reads. Revisit
when the first cache call site lands — at that point the deep check is the right
place, not the polled one.

### 2.8 · Low · Better Auth's `get`/`set` are unreachable, and `set` writes a non-window-aligned `window_start`

Verified in `node_modules/better-auth/dist/api/rate-limiter/index.mjs`:
`onRequestRateLimit` does `if (storage.consume) { … return }` before ever
reaching `legacyConsume`. Since `authRateLimitStorage` implements `consume`, its
`get` and `set` are dead in 1.6 and disappear entirely in 1.7, which drops them
from the contract.

While they are dead, one detail in `set` would be wrong if they ever became
live: it binds `value.lastRequest` into `window_start`, which is a raw
millisecond timestamp rather than a window-aligned one. A subsequent `consume`
on the same key would see a mismatched window and reset the count to 1. The
module's comment already says this path must not become primary; the specific
reason is worth having recorded.

**Recommended:** leave the code alone and delete both members at the 1.7
upgrade. Do not "fix" the alignment — that would add a behaviour to a path
nothing runs.

### 2.9 · Low · The daily OTP cap resets at UTC midnight, so a boundary burst can spend 2× in minutes

`enforceOtpGlobalSendBudget` uses `window: 86400` and `rateLimit` computes
`windowStart = now - (now % windowMs)`, so the 2,000/day budget is a fixed
window anchored to UTC midnight, not a rolling 24 hours.

Consequence, stated concretely because this one is a money cap: 2,000 sends at
23:59 UTC and 2,000 more at 00:01 UTC is 4,000 paid sends inside two minutes,
within policy.

This is an accepted trade and the fixed window is arguably the more faithful
model for a calendar-day cost cap. It is listed because the accepted-trade note
in `lib/rate-limit/index.ts` describes the general 2× boundary property without
pricing this specific case. If the burst matters, the fix is a shorter
proportional window (e.g. 250 per 3 hours) rather than a sliding algorithm.

The cutover sequence in the runbook already handles the related one-off risk:
two independent stores each granting a full daily budget.

### 2.10 · Low · Probe coverage stops at SQL semantics

`scripts/probe/local/sqlite-semantics.test.ts` is good where it reaches — it
extracts the real statements from `lib/` at run time rather than copying them,
so it cannot pass against SQL nobody runs, and it asserts the child's exit code.

What it does not reach: the routes. Authorization branches (401 with no token,
with a wrong token, 200 with the right one), the sweep's response contract,
`hasMore` under a real backlog, yielding, and the readiness route's degraded
branches are all verified manually only.

The blocker is real and worth restating: `better-sqlite3` cannot load under Bun,
which is what runs the probes, so a test that drives the real store either goes
over HTTP against a running server or waits for the `bun:sqlite` swap. Tracked
in `TODO.md`.

### 2.11 · Informational · Two known non-critical benchmark failures

Both report `FAIL` on every `baseline` run and neither is a regression:

- `large_integer_precision` — integers above 2^53 lose precision on **both**
  drivers. Documented in `lib/sqlite/driver.ts` item 9, with the reason not to
  enable `safeIntegers`. The largest value stored here is a millisecond
  timestamp (~1.7e12) against a ~9e15 ceiling.
- `deleted_pii_scrubbed_after_checkpoint` — this is §2.3, and it should stay
  failing until that decision is made. It is the honest state of the deployed
  configuration.

---

## 3. Things checked that turned out to be fine

Recorded so the next reviewer does not re-derive them.

- **`describeStoreFailure`'s scope extraction.**
  `opts.identifier.split(':', 1)[0]` is safe. `enforceRateLimit` is the **only**
  caller of `rateLimit` (verified by grep), it builds `${scope}:${identifier}`,
  and no scope contains a colon — so an IPv6 identifier like `ip:2001:db8::/64`
  cannot shift the slice. The comment's claim holds by construction.
- **Denial writes nothing.** Asserted in the tracked probe suite (zero writes
  across 10 denied calls) and re-asserted in the benchmark's new critical check
  (zero writes across 24 denials, exactly `max` admissions from 12 attempts on
  each of the two limiter statements, on both drivers).
- **`retryAfter` needs no read-back.** A no-row result already proves the stored
  row matched the bound `windowStart`. The probe suite demonstrates that the
  removed read-back was racy, not merely redundant.
- **Concurrent migration.** `BEGIN IMMEDIATE` plus a re-read under the lock is
  idempotent; asserted in the probe suite and previously across 24 processes.
- **Native handle cleanup.** Open, PRAGMA, migrate and every `prepare` are
  inside one cleanup guard in both stores, and the singleton is published only
  after all statements compile.
- **Prefix upper bound.** `lib/cache/prefix.ts` computes the lexicographic
  successor, which is the only correct answer — no appended character can be,
  since the bound is exclusive and a key can always contain that character and
  continue. Covered by 24 assertions across 10 prefixes × 10 suffixes.
- **Placeholder portability.** All statements use anonymous `?`. No `?1`
  anywhere, so nothing silently couples to Bun.

---

## 4. Benchmark changes (`bench/`)

The harness had drifted from the application in a way that invalidated the
measurements it was being cited for. Three shapes had changed in `lib/` without
`bench/` following:

1. **Both consume statements became max-aware.** The deployed statements carry a
   trailing `WHERE window_start <> excluded.window_start OR count < ?`; the
   bench had no such clause, so every refusal wrote a row. The bench was
   measuring a write path production no longer has.
2. **Every sweep became bounded.** Deployed: `DELETE … LIMIT ?` in 500-row
   batches. Bench: one unbounded `DELETE`, i.e. a maintenance cost the
   application does not pay, and none of the per-commit overhead it does.
3. **Two production paths had no coverage at all** — the refusal path, and
   `cacheDeletePrefix`.

All three are fixed, and the harness version is bumped to **v3** so
`compare.mjs` rejects cross-version comparisons. v2 throughput for
`rl_consume_*`, `auth_atomic_consume`, `cache_sweep_*` and `rate_limit_sweep_*`
is superseded, and `RESULTS.md` / `FINAL-REPORT.md` now say so.

Added:

- `rl_consume_denied_hot_key` — the refusal path, single-process and
  multi-process.
- `cache_prefix_delete_5k_keys` — prices the one unbounded delete (§2.4).
- `max_aware_admission_denies_without_writing` — a **critical** correctness
  check asserting exactly `max` admissions, no row on refusal, and zero writes
  while refusing, on both limiter statements. This is a driver-portability check
  as much as a SQL one: a driver that returned an empty row object instead of no
  row would keep the counter correct while handing an attacker unlimited writes.
- A `NO_LIMIT` sentinel for the throughput and rollover cases, because with
  max-aware admission a real limit would silently turn a long run into a
  measurement of the refusal path.
- `run()` normalized to `{ changes }` in both adapters, so batched-sweep
  workloads read one shape across two drivers.

The most useful new number is the contrast the max-aware clause buys, which had
never been measured:

| Path                        |    ops/sec |      p50 |
| --------------------------- | ---------: | -------: |
| `rl_consume_hot_key`        |     22,394 | 0.028 ms |
| `rl_consume_denied_hot_key` | **95,296** | 0.011 ms |

Refusal is ~4.3× admission single-process, and at four processes it aggregates
to 109,577 ops/sec with **zero** `SQLITE_BUSY` and a **0 MB** WAL — versus
admission's starved worker in §2.2. Sustained abuse against an exhausted key
costs a primary-key read, not a write to the database the security path depends
on.

---

## 5. Suggested order of work

1. §2.1 step 1 — enable the disk notification. Minutes, and it is the backstop
   for the worst failure mode.
2. §2.3 — decide `secure_delete`. A one-line code change or a recorded policy;
   blocking nothing else but silently defaulting the wrong way.
3. §2.6 — block `/api/internal/*` at the edge. Configuration only.
4. §2.1 steps 2–3 — WAL reporting in the sweep, then a measured decision on
   `wal_checkpoint(TRUNCATE)`.
5. §2.5 — the startup check and sentinel verification, as one piece.
6. §2.10 — route-level probes over HTTP.
7. §2.4 — bound `cacheDeletePrefix`, before the first cache call site.
8. Re-run the full benchmark matrix on the Linux VPS. Everything above that
   quotes a number is Windows evidence; the orderings should hold, the
   magnitudes may not.
