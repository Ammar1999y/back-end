# SQLite driver and configuration — audited report

**Audit date:** 2026-08-19  
**Harness:** v3 — see "Harness v3" below. v2 throughput for the limiter and
sweep workloads is superseded, because those statements changed.  
**Current runtime verdict:** `better-sqlite3` under Node/Next.js.  
**Future target:** `bun:sqlite` only after framework migration allows the server
to run under Bun.

## Decision

Driver choice is runtime compatibility, not benchmark throughput:

- Current Next.js server runs on Node, so use `better-sqlite3`.
- `bun:sqlite` is unavailable from the Node runtime.
- `better-sqlite3` cannot be treated as Bun-compatible in this project: creating
  a v13.0.3 database under Bun 1.3.14 hard-crashed in repository verification,
  despite v13 using N-API.
- Keep the adapter boundary and migration notes. Re-run v2 correctness under the
  future Bun version before swapping.

Old v1 wording that called this a Bun-only project and selected `bun:sqlite` for
current deployment was stale.

## Recommended settings

Current five-setting policy is a reasonable baseline. Only WAL and the
`NORMAL`/`FULL` tradeoff have strong performance evidence; timeout and retained
WAL size are operational policy values, not benchmark-optimal constants:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;       -- rate-limit DB
PRAGMA busy_timeout = 2000;
PRAGMA journal_size_limit = 67108864;
PRAGMA trusted_schema = OFF;
```

For the disposable cache, use the same policy with `PRAGMA synchronous = OFF`.
Do not use `OFF` for the rate-limit database.

Important precision:

- `WAL + NORMAL` protects consistency and survived deterministic application
  SIGKILL recovery in both stacks. It does **not** guarantee the newest commit
  survives an OS crash or power loss. SQLite documents that `FULL`, not
  `NORMAL`, supplies that extra WAL commit sync.
- `journal_size_limit` caps WAL/journal bytes RETAINED after a reset or a
  completed checkpoint. It is not a ceiling on live WAL growth, and the case
  that matters is not one large transaction — it is a BLOCKED checkpoint.
  Measured directly: with a single connection holding an open read snapshot, the
  WAL reached **1.36 GB against this 64 MiB setting**, then fell to 0 as soon as
  the snapshot was released and `wal_checkpoint(TRUNCATE)` could run. The
  concurrent runs below reached 745 MB (4 processes) and 906 MB (2 processes)
  for the same reason: continuous writers never leave a gap for a checkpoint to
  finish in. Peak WAL is therefore an operational concern — disk monitoring plus
  a periodic truncating checkpoint — not something this setting solves.
- The benchmark did not establish that 64 MiB is better than 32 MiB. Choose the
  exact retained size from volume budget and checkpoint/churn measurements.
- `busy_timeout=2000` requests a roughly two-second SQLite lock-wait ceiling.
  Deterministic probes returned `SQLITE_BUSY` after roughly 2.19–2.31 seconds,
  so it is not an exact wall-clock deadline. Sustained contention can still
  starve a process and a final operation can overrun the requested test window.
- `journal_mode` persists in the file. Other settings must be applied to every
  connection.
- `cache_size` and `temp_store` now remain at runtime defaults, matching app
  policy. Effective readback is recorded because defaults differ: current
  better-sqlite3 reports `-16000`, Bun reports `-2000` on this machine.

Owner must also accept `NORMAL` semantics for security counters: an application
crash is covered, while a host crash or power loss may roll back a recent
consume. Use `FULL` if preserving the newest limiter/OTP-budget commit across
that event is mandatory. V1 Windows measurements show a large write-latency
cost, but Linux must establish the actual price.

## Open security decision: deleted sensitive keys

Rate-limit/cache keys can contain raw IP addresses, email addresses, and phone
numbers. Both tested SQLite builds report `secure_delete=0` by default.

New v2 raw-file probe:

| Profile                          | Marker before checkpoint | Marker after checkpoint |
| -------------------------------- | -----------------------: | ----------------------: |
| `baseline` / `secure_delete=OFF` |                  present |             **present** |
| `secure_delete=FAST`             |                  present |                  absent |

Probe inserts a unique IP/email/phone marker, checkpoints it into the main file,
deletes it, runs a successful truncating checkpoint, closes the DB, then scans
database/WAL bytes. Both Node and Bun produce the same result.

`FAST` does not erase old data from freelist pages, but SQLite documents that it
scrubs deleted content from B-tree pages without adding I/O. `ON` additionally
scrubs freelist content at added I/O cost. WAL mode still exposes the prior main
page until deletion is checkpointed; neither setting makes deletion instant.

Targeted 5,000-row sweep runs were too noisy to quantify overhead:

| Runtime               | baseline p50 | FAST p50 |   ON p50 | repeat throughput spread |
| --------------------- | -----------: | -------: | -------: | -----------------------: |
| Node / better-sqlite3 |      68.8 ms |  50.9 ms |  52.8 ms |                 103–184% |
| Bun / bun:sqlite      |     100.8 ms |  90.9 ms | 105.6 ms |                 101–143% |

No regression is distinguishable from Windows noise. These numbers do not prove
that scrubbing is free.

**Recommendation:** add `secure_delete=FAST` to both databases unless retaining
deleted identifiers for forensic recovery is an explicit accepted policy. This
is a security/privacy choice requiring project-owner approval, followed by a
Linux sweep rerun. Current application code leaves it OFF.

Official behavior:
[SQLite `secure_delete`](https://sqlite.org/pragma.html#pragma_secure_delete).

## Correctness results

Both current stacks passed every critical check under baseline and
`secure_delete=FAST`, re-verified under harness v3:

- exact production `STRICT` schemas;
- BLOB fidelity and transaction rollback;
- cache expiry boundary and sweep semantics;
- fixed-window rollover for app and Better Auth limiter tables;
- max-aware admission on both limiter statements: exactly 4 admissions from 12
  attempts at `max=4`, no row returned on refusal, and **zero writes across 24
  refusals** — the property the clause exists for, asserted rather than assumed;
- error strings did not include the tested key;
- a held writer lock returned `SQLITE_BUSY` near the configured timeout;
- 4 processes × 500 consumes produced exactly 2,000, with zero rejected calls;
- SIGKILL inside a transaction after a 4.5 MiB uncommitted WAL spill recovered
  all 600 committed rows, rolled back every in-flight row, and passed
  `integrity_check`.

Both stacks still return an imprecise JavaScript `number` for integers above
`2^53`. Current timestamps and counters remain below that boundary. Do not store
64-bit IDs here without enabling safe-integer mode and updating every consumer
for `bigint`.

The synchronous APIs can block the event loop. The 64 MiB transaction probe
varied from roughly 0.9 to 1.9 seconds across recent runs. Keep rate-limit and
cache data in separate files and keep request-path transactions small.

## Harness v3 — realignment with the deployed SQL, and what it showed

v2 measured statements the application had stopped running. Three shapes had
changed in `lib/` without the harness following:

1. **Both consume statements became max-aware.** The deployed
   `ON CONFLICT DO UPDATE` carries a trailing
   `WHERE window_start <> excluded.window_start OR count < ?`, so a request
   already at the limit inside the current window updates nothing. v2 had no
   such clause, so every refusal wrote a row.
2. **Every sweep became bounded.** The deployed sweeper issues
   `DELETE … LIMIT ?` in 500-row batches; v2 issued one unbounded `DELETE`.
3. **Two production paths had no coverage at all** — the refusal path, and
   `cacheDeletePrefix`.

v3 fixes all three. Consequence for reading older files: **v2 throughput for
`rl_consume_*`, `auth_atomic_consume`, `cache_sweep_*` and `rate_limit_sweep_*`
is not comparable with v3.** `compare.mjs` gates on `meta.harnessVersion`.

### The refusal path is a read, and it does not contend

Windows host, `baseline`, single process, 1-minute fixed window:

| Path                        |    ops/sec |   p50 |   p95 |
| --------------------------- | ---------: | ----: | ----: |
| `rl_consume_hot_key`        |     22,394 | 0.028 | 0.084 |
| `rl_consume_denied_hot_key` | **95,296** | 0.011 | 0.018 |

Refusal is ~4.3x the throughput of admission, which is the direct measurement of
what the max-aware clause buys: sustained abuse against an exhausted key costs a
primary-key read instead of a synchronous write to the database the security
path depends on.

Four processes against one file, 5-second window:

| Workload            | aggregate ops/sec | worst worker | worst p50 | `SQLITE_BUSY` | peak WAL |
| ------------------- | ----------------: | -----------: | --------: | ------------: | -------: |
| `rl_consume`        |            16,678 |    **0/sec** |  2,243 ms |             6 |   745 MB |
| `rl_consume_denied` |           109,577 |   23,970/sec |  0.007 ms |         **0** | **0 MB** |

Read the admission row carefully. Four processes produced LESS aggregate
throughput than one (16,678 versus 22,394), one worker was starved completely,
and six operations exceeded `busy_timeout` and raised `SQLITE_BUSY`. At two
processes — the count a Coolify rolling update guarantees — one worker still
raised a `SQLITE_BUSY` and ran at roughly a tenth of its sibling's rate.

That matters beyond capacity, because `SQLITE_BUSY` surfaces in the application
as `degraded: true`: a fail-open admission for ordinary limiters and a 503 for
the `failClosed` OTP and pre-auth paths.

**Caveat, stated plainly:** these are saturation runs. Each worker calls consume
in a tight loop with zero think time, which is orders of magnitude above this
application's real traffic, and the host is Windows. They establish that the
write path does not scale across processes and that the failure mode is
starvation rather than graceful degradation. They do not predict production
behaviour at production load, and they must be repeated on the Linux VPS.

### Unbounded prefix invalidation costs tens of milliseconds

`cache_prefix_delete_5k_keys`, 5,000 keys of 1 KiB in the target namespace plus
5,000 in a neighbouring one:

| Metric |   Value |
| ------ | ------: |
| mean   | 47.4 ms |
| p50    | 47.1 ms |
| p95    | 55.7 ms |

The driver is synchronous, so that is 47 ms of event-loop blocking per
invalidation, scaling linearly with namespace size — roughly half a second for a
50,000-key namespace. `cacheDeletePrefix` is the one delete in the deployed code
that is not batched. Bound it before the first cache call site is written.

## What v1 performance results can and cannot support

`RESULTS.md` and legacy JSON preserve v1 measurements. They are historical, not
current evidence. V2 fixed material validity problems:

- Better Auth atomic workload had an artificial explicit transaction and the
  wrong table/columns.
- Cache and limiter were mixed into one file despite production using two.
- Cache sweep throughput included untimed reseeding while its latency excluded
  it.
- Unexpected SQL errors could be tolerated; exactness could pass with rejected
  consumes.
- Crash safety checked integrity but did not require committed-row recovery or
  prove rollback from an uncommitted WAL.
- Concurrent aggregate throughput divided by requested duration even when a lock
  wait ran past the deadline.
- Every worker re-seeded shared cache data.
- Matrix order was fixed, with baseline always on the coldest state.
- PRAGMA workloads overwrote one output filename and omitted enough metadata to
  reproduce comparisons.
- The secure-delete profile used an upsert workload, so it measured neither
  deletion cost nor PII remanence.

The large qualitative conclusions remain plausible: WAL is necessary for this
write/read shape, `NORMAL` is much faster than `FULL` on these Windows runs, and
transaction batching/prepared-statement reuse matter. Exact v1 multipliers and
small differences among mmap/cache/page/checkpoint profiles should not be used
until a v2 Linux matrix reproduces them.

## Locking and concurrency

Reject `locking_mode=EXCLUSIVE` for deployment. Official SQLite semantics allow
only one client; that conflicts with rolling deploys, multiple workers, health
checks, and the external sweep task. The old report's un-reproducible claim of
silent divergent views was removed. The documented single-client behavior is
already sufficient reason.

Old 4-process aggregate numbers used the wrong denominator and must be rerun. A
pair of short v2 two-process validations still showed the real risk: one worker
completed only one operation, taking 347–549 ms, while the other remained busy.
Final capacity/fairness decisions require 4-process, 6-second runs on the Linux
VPS.

If production reaches sustained multi-process write contention, move the
rate-limit state to a shared server such as Valkey. A longer busy timeout trades
errors for longer synchronous event-loop stalls; it does not add writer
fairness.

Official behavior:
[SQLite locking mode](https://sqlite.org/pragma.html#pragma_locking_mode),
[WAL concurrency](https://sqlite.org/wal.html).

## Deployment-adjacent note

An earlier revision of this report flagged a `scripts/sqlite-sweep.ts`
documented as `bun scripts/sqlite-sweep.ts` — the one runtime/driver combination
this benchmark rejects. That script no longer exists. The sweep is now
`POST /api/internal/sqlite-sweep`, which runs in the Node process Next already
provides, so the unsupported combination is unreachable.

The measurement caveat still stands: this harness times inner SQL work only.
Deployed task startup, opening and migrating two files, both limiter deletes,
the cache delete, and the backlog probes still need an end-to-end smoke test
against a running server — see `reports/coolify-deployment.md`.

## Required target reruns

```bash
cd bench/sqlite/better-sqlite3
node run.mjs --mode=correctness --profile=baseline
node run.mjs --mode=correctness --profile=secure_delete_fast
node run.mjs --mode=suite --profile=baseline --repeat=3
node run.mjs --mode=suite --profile=sync_off --only=cache_ --repeat=3
node run.mjs --mode=pragmas --workload=rl_consume --repeat=3
node run.mjs --mode=pragmas --workload=rl_consume_denied --repeat=3
node run.mjs --mode=pragmas --workload=cache_read --repeat=3
node run.mjs --mode=pragmas --workload=cache_prefix_delete --repeat=3
node run.mjs --mode=pragmas --workload=cache_sweep \
  --profiles=baseline,secure_delete_fast,secure_delete_on --repeat=3
node run.mjs --mode=concurrent --workers=4 --durationMs=6000 \
  --workload=rl_consume
node run.mjs --mode=concurrent --workers=4 --durationMs=6000 \
  --workload=rl_consume_denied
```

Capture the peak `-wal` size for each concurrent run; the harness prints it
before worker close. On this Windows host it reached 745 MB at four processes
against a 64 MiB `journal_size_limit`, so treat WAL headroom as a sizing input
rather than a bounded constant.

Run future Bun parity only when Bun becomes a deployable server runtime.

Durability reference:
[SQLite `synchronous`](https://sqlite.org/pragma.html#pragma_synchronous),
[SQLite `journal_size_limit`](https://sqlite.org/pragma.html#pragma_journal_size_limit).
