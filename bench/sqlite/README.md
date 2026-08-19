# SQLite configuration benchmark

Shared harness for `better-sqlite3` under Node and `bun:sqlite` under Bun. It
answers two separate questions:

1. Does each supported runtime/driver stack preserve application contracts?
2. Which SQLite settings help this project's rate-limit and cache workloads?

It does not treat cross-runtime throughput as a pure driver comparison. Node and
Bun have different VMs, timers, SQLite builds, and defaults. Current Next.js
deployment uses `better-sqlite3` under Node. `bun:sqlite` remains a future
target after framework migration permits a Bun server runtime.

## Layout

```text
bench/sqlite/
  shared/              schema, workloads, runner, correctness, reporting
  better-sqlite3/      Node adapter and worker
  bun-sqlite/          Bun adapter and worker
  results/             generated JSON, including runtime and harness metadata
  compare.mjs          guarded side-by-side suite comparison
```

Only adapters differ. Shared code now uses the exact deployed table and SQL
shapes, including `auth_rate_limit`, `last_request`, and the single-statement
Better Auth consume.

## Setup

```bash
cd bench/sqlite/better-sqlite3
npm ci
```

`bun:sqlite` is built into Bun and needs no install.

## Run order

Run correctness before performance. A critical failure sets a non-zero process
exit code.

```bash
# Current deployment stack
cd bench/sqlite/better-sqlite3
node run.mjs --mode=correctness --profile=baseline
node run.mjs --mode=suite --profile=baseline --repeat=3

# Future Bun stack
cd ../bun-sqlite
bun run.mjs --mode=correctness --profile=baseline
bun run.mjs --mode=suite --profile=baseline --repeat=3
```

Configuration probes:

```bash
# Full write-focused PRAGMA matrix
node run.mjs --mode=pragmas --workload=rl_consume --repeat=3

# Read-focused matrix
node run.mjs --mode=pragmas --workload=cache_read --repeat=3

# PII deletion cost: targeted, balanced order
node run.mjs --mode=pragmas --workload=cache_sweep \
  --profiles=baseline,secure_delete_fast,secure_delete_on --repeat=3

# Real multi-process contention against one file
node run.mjs --mode=concurrent --workers=4 --durationMs=6000 \
  --workload=rl_consume
```

Run the same commands with `bun` inside `bun-sqlite` when validating future
runtime parity.

## Modes and flags

| Flag             | Meaning                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `--mode`         | `correctness`, `suite`, `pragmas`, or `concurrent`                    |
| `--profile`      | Profile exported by `shared/pragmas.mjs`                              |
| `--repeat=N`     | Independent repeats; aggregate uses medians and preserves worst max   |
| `--only=text`    | Suite workload-name filter                                            |
| `--iterations=N` | Default iteration override; workload-specific limits win              |
| `--profiles=a,b` | Exact profile subset for PRAGMA mode                                  |
| `--workers=N`    | Positive process count for concurrent mode                            |
| `--durationMs=N` | Requested concurrent window                                           |
| `--workload`     | Mode-specific workload key; invalid keys fail instead of falling back |
| `--tier`         | `core` or `all` (adds driver diagnostics)                             |

Result filenames include profile/workload scope. Filtered suite runs cannot
overwrite full suites; PRAGMA workloads and correctness profiles cannot
overwrite one another.

## Production-shaped workloads

Rate-limit file:

- fixed-window consume, hot key and 10,000-key spread;
- the REFUSAL path against one exhausted key (`rl_consume_denied_hot_key`);
- Better Auth 1.6 fallback `get` then `set`;
- Better Auth atomic `consume`, with exact deployed columns and no artificial
  transaction wrapper;
- bounded batched deletion across both `rate_limit` and `auth_rate_limit`.

Cache file:

- hit/miss reads with JSON decode at 1, 8, and 64 KiB;
- 1 and 8 KiB upserts;
- 95% read / 5% write traffic;
- bounded batched expiry sweep, plus a post-sweep stats query;
- unbounded prefix-range namespace invalidation (`cache_prefix_delete_5k_keys`).

Admission and refusal are separate workloads because they are separate code
paths. Since admission became max-aware, a request already at the limit inside
the current window updates nothing — so refusal is a read against the primary
key where admission is a write. The throughput workloads therefore bind an
unreachable ceiling (`NO_LIMIT`), or a long run would silently stop measuring
the write path and start measuring the refusal path instead.

`cache_prefix_delete_*` exists because `cacheDeletePrefix` is the one delete in
the deployed code that is NOT batched. Both drivers are synchronous, so its
duration is event-loop blocking, and the measurement decides whether it needs
the same bounded treatment as the sweeps before the first cache call site is
written.

Each workload opens only its production schema scope. Rate-limit and cache
traffic are not mixed into one database because deployment deliberately uses
separate files and separate writer locks.

`--tier=all` adds prepared-statement reuse and write batching diagnostics.

## Correctness coverage

The gate checks:

- `STRICT` enforcement and BLOB byte fidelity;
- transaction rollback;
- fixed-window rollover for both limiter tables;
- max-aware admission for both limiter statements: exactly `max` admissions, no
  row returned on refusal, and zero writes while refusing;
- exact `expires_at > now` reads and `expires_at <= now` sweeps;
- error-message key privacy;
- observed write-lock wait against configured `busy_timeout`;
- four-process atomic consume exactness with zero rejected operations;
- deterministic SIGKILL inside an uncommitted transaction after WAL spill,
  including integrity, committed-row recovery, and in-flight rollback;
- separate rate-limit/cache open cost and a 64 MiB event-loop stall probe;
- integer behavior past `2^53`;
- raw-file search for an IP/email/phone marker after deletion and a successful
  WAL checkpoint.

The remanence check is diagnostic, not a critical SQLite-integrity failure. With
`secure_delete=OFF`, deleted sensitive keys remain recoverable in the file. With
`secure_delete=FAST`, this probe confirms removal after checkpoint. Before
checkpoint, WAL mode still retains the old main-database page in both cases.

## Measurement rules

- Fresh database per workload and repeat.
- Workload setup and `beforeEach` replenishment excluded from operation latency
  and throughput; failed lock waits remain included.
- Any unexpected non-`SQLITE_BUSY` error aborts immediately.
- BUSY failures count as errors and their wait latency remains in percentiles;
  successful throughput never counts them as completed operations.
- Warmup BUSY events do not contaminate measured error counts.
- Repeats use median metrics and preserve raw throughput/p50 samples.
- PRAGMA repeats rotate profile order, preventing one profile from always
  running on the coldest or hottest system state.
- Matrix rows store effective PRAGMA readback, not only requested values.
- Console output labels durability/correctness-trading profiles `UNSAFE` and
  repeat spreads above 25% `NOISY`; notes print below each matrix.
- Concurrent workers seed once in the parent. Workers only prepare statements.
- Concurrent aggregate throughput divides by actual longest worker duration,
  including a final lock wait that overruns the requested window.
- Aggregate concurrent percentiles are worst-worker percentiles, useful for
  starvation detection rather than pooled request-distribution estimates.

## Runtime fairness

`baseline` matches application policy: WAL, NORMAL, 2-second busy timeout, 64
MiB retained-journal limit, and `trusted_schema=OFF`. Cache-size and temp-store
settings are intentionally left at runtime defaults. On this machine that means
`cache_size=-16000` for better-sqlite3 and `-2000` for Bun; result metadata
makes the difference visible.

Use cross-runtime results as stack comparisons only. For configuration choices,
compare profiles within one runtime on the target Linux VPS.

## Results hygiene

Harness v3 realigned every statement with the deployed SQL: both consume
statements became max-aware, all three sweeps became bounded
(`DELETE … LIMIT ?`, drained in `SWEEP_BATCH_SIZE` batches), and the refusal and
prefix-invalidation paths gained coverage. **v2 numbers for `rl_consume_*`,
`auth_atomic_consume`, `cache_sweep_*` and `rate_limit_sweep_*` are not
comparable with v3** — they measured statements the application no longer runs.
Anything quoted from a v2 run for those workloads needs a rerun before it is
cited again.

Files lacking `meta.harnessVersion` are legacy v1 results. `RESULTS.md`
preserves their historical numbers, but they are not comparable with v2: v2
corrected SQL shape, error handling, setup accounting, concurrent duration,
schema scope, profile order, and metadata. `compare.mjs` rejects known metadata
mismatches and warns on legacy files.

Generic `*-correctness.json` names are superseded historical/intermediate files.
Use profile-qualified v2 files such as `*-correctness-baseline.json` and
`*-correctness-secure_delete_fast.json`.

Linux target reruns remain required. Windows file locking, antivirus filters,
filesystem sync, and scheduling materially affect absolute and tail results.
