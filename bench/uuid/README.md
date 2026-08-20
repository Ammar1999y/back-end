# UUID v7 generation benchmark

Measures `v7` from the `uuid` package against `Bun.randomUUIDv7()` — the two
candidate implementations behind `lib/id.ts`'s `generateUuidV7`. **This
benchmark measures and reports only; it does not decide which one ships.** See
`lib/id.ts`'s comment and `TODO.md`'s `EM-5` section for the decision and its
stated criterion: _"a real throughput win in the interleaved scenario (not just
the tight loop) AND equal format guarantees — same regex, same monotonicity
within a millisecond."_ This directory is meant to be re-run (not rewritten) the
next time that criterion needs checking, e.g. after a Bun upgrade.

**It has been re-run once, and the answer changed.** The first run (Bun 1.3.14)
found the criterion unmet: `Bun.randomUUIDv7` broke same-millisecond ordering in
every trial. The second (Bun 1.4.0, below) finds it met, because 1.4.0 changed
what the generator does when a millisecond runs out of counter space. The
application now uses `Bun.randomUUIDv7`; `uuid` is retained as a devDependency
so this comparison stays runnable.

## Layout

```text
bench/uuid/
  shared/
    generators.mjs   the two implementations under test
    stats.mjs        ops/sec + ns/op math, median/min/max across repeats
    runner.mjs       tight-loop and interleaved measurement loops
    checks.mjs       format, monotonicity and clock-fidelity assertions
    report.mjs       console tables and JSON persistence
  run.mjs            entry point
  results/           generated JSON (gitignored — see repo root .gitignore)
```

This follows `bench/sqlite`'s conventions — a `shared/` directory, a thin entry
point, `process.hrtime.bigint()` timing, a `median`-headline / min-max-spread
repeat aggregation, a `{ name, pass, detail, critical }` check shape that fails
loudly, and one JSON file per run under `results/` — with two deliberate
adaptations:

- **One `run.mjs`, not one folder per implementation.** `bench/sqlite` splits
  `better-sqlite3`/`bun-sqlite` into separate folders because they run under
  different runtimes — no single process can load both. `uuid`'s `v7` and
  `Bun.randomUUIDv7` are both plain calls reachable from one Bun process, so
  there is no cross-runtime split to mirror, and both are measured together in
  every run for a direct, same-process comparison.
- **No per-project `package.json`.** `bench/sqlite`'s `better-sqlite3` folder
  needs its own install because that driver is a native addon separate from the
  app's dependencies. Here, `uuid` resolves from the repo root
  (`package.json`, devDependencies: `"uuid": "^14"` — kept for this benchmark
  after the application stopped importing it) and `Bun.randomUUIDv7` needs no
  package, so this directory has nothing to install.

Unlike `bench/sqlite`'s explicit "standalone, imported by nothing" design, this
benchmark **does** import from the application: `shared/checks.mjs` imports
`validID` from `@/utils` (see "Format-check note" below) — required by the task
this benchmark was built for, which is stricter here than "standalone."

## Setup

None. Run from a checkout that already has `bun install` done for the main
project; `uuid` resolves from the repo root's `node_modules`.

## Running it

```bash
# from the repo root
bun bench/uuid/run.mjs

# or from this directory
cd bench/uuid
bun run.mjs
```

Requires the **Bun** runtime — `Bun.randomUUIDv7` does not exist under Node, so
(unlike `bench/sqlite`) there is no second runtime this can also run under.

| Flag               | Meaning                                                               | Default   |
| ------------------ | --------------------------------------------------------------------- | --------- |
| `--mode`           | `all`, `throughput`, `interleaved`, `format`, `monotonicity`, `clock` | `all`     |
| `--iterations=N`   | Iterations per repeat, throughput + interleaved scenarios             | `1000000` |
| `--repeat=N`       | Independent repeats per scenario (median/min/max reported)            | `9`       |
| `--burst=N`        | ids per monotonicity burst                                            | `500000`  |
| `--formatSample=N` | ids checked per implementation for format compatibility               | `50000`   |
| `--clockSample=N`  | ids per phase of the clock-fidelity scenario (it has two)             | `3000000` |

A non-zero process exit code means a critical check failed. Entries printed
`INFO` are measurements in check shape and carry no verdict — see §4 and §5.

Two things about the harness are worth knowing before reading a number off it,
because both were changed in response to results that turned out to be
artefacts:

- **Repeats alternate between implementations and between scenarios**:
  tight(uuid), tight(bun), row(uuid), row(bun), then around again. Run-to-run
  variance on this machine is 20–30%, and running one side's repeats
  consecutively hands that drift to whichever side went first — a systematic
  bias no number of repeats removes. It was not hypothetical: consecutive
  ordering reported `uuid.v7`'s share of a realistic operation as 86% in one run
  and 58% in the next.
- **The clock scenario runs two phases** (§5). Reading the clock around every
  call is the only way to bound the behind-direction per id, but those two
  `Date.now()` calls cost more than the generation does and hold the loop below
  the rate at which drift can happen at all. A one-phase version reported "no
  drift" and would have been wrong about the only property it was added for.

`--repeat` is 9 rather than 5 for the same variance reason; the default run takes
about 55 s.

## Machine this run was recorded on

Windows 10 (win32/x64), Intel Core i5-1035G1, 8 logical CPUs, 8.4 GB RAM.
`bun 1.4.0 (34cbb9a40)`, `uuid` package `14.0.2`, harness v2. Single machine,
single OS — see "Caveats" before treating any absolute number as portable.

The previous recorded run, kept for comparison throughout: `bun 1.3.14
(0d9b296af)`, `uuid` package `14.0.1`, harness v1.

Reproduce with the default flags above; raw numbers are also saved to
`bench/uuid/results/latest.json` (gitignored — regenerate it, don't expect it
present in a fresh checkout).

## Results

Numbers below are one full default run, confirmed by a second immediately
before it (both are quoted where they differ enough to matter).

### 1. Throughput — tight loop

1,000,000 iterations x 9 repeats per implementation, nothing else in the loop
body.

| implementation     | ops/sec (median) |       min |       max | ns/op (median) | ns/op min | ns/op max |
| ------------------ | ---------------: | --------: | --------: | -------------: | --------: | --------: |
| `uuid.v7`          |        1,584,989 | 1,406,899 | 1,624,333 |          630.9 |     615.6 |     710.8 |
| `Bun.randomUUIDv7` |        4,510,110 | 3,861,019 | 5,161,900 |          221.7 |     193.7 |     259.0 |

**`Bun.randomUUIDv7` is ~2.85x faster in isolation** (+2,925,121 ops/sec, saving
409.2 ns/op). The confirming run: 1,501,150 vs 4,467,147, i.e. ~2.98x.

### 2. Interleaved — realistic per-row work

Same iteration/repeat counts, but each iteration builds the row object
(`{ id, createdAt: Date.now(), kind, seq }`) and runs it through
`JSON.stringify` — identical non-generation work for both implementations.

| implementation     | ops/sec (median) |       min |       max | ns/op (median) | ns/op min | ns/op max |
| ------------------ | ---------------: | --------: | --------: | -------------: | --------: | --------: |
| `uuid.v7`          |          970,092 |   724,589 | 1,118,152 |         1030.8 |     894.3 |    1380.1 |
| `Bun.randomUUIDv7` |        1,917,707 | 1,576,418 | 2,173,177 |          521.5 |     460.2 |     634.3 |

**The gap shrinks by roughly a third once realistic per-row work is included:
~1.98x faster**, not ~2.85x. (Confirming run: 935,065 vs 1,834,632 — ~1.96x.)
That is the same shape the 1.3.14 run found (2.97x isolated, 1.90x interleaved),
which is the useful part: the ratio between the two scenarios is stable across a
Bun major upgrade even though the absolute numbers are not.

### id-generation share of a realistic per-row operation

| implementation     | tight-loop ns/op | interleaved ns/op | share (median) | share min–max |
| ------------------ | ---------------: | ----------------: | -------------: | ------------: |
| `uuid.v7`          |            630.9 |            1030.8 |          61.4% |    45.3–71.4% |
| `Bun.randomUUIDv7` |            221.7 |             521.5 |          43.9% |    33.0–50.9% |

Reading this: for `uuid.v7`, id generation is ~61% of a realistic insert-shaped
operation's cost; for `Bun.randomUUIDv7`, ~44%. The min–max column is the spread
of the per-repeat ratios and is printed rather than hidden, because it is the
honest measure of how much of the headline is this laptop's noise. The
isolated-call ratio (2.85x) overstates what the swap is worth once the rest of
the row-building work is accounted for.

### 3. Format compatibility

50,000 freshly generated ids checked per implementation, all against the
**same** regex the application validates with (see "Format-check note" below):
app `UUID_V7_REGEX` equivalence (via the exported `validID`), exactly 36
characters, lowercase-hex-plus-hyphen layout, version nibble `7`, and RFC 9562
variant bits (`10xx`, i.e. hex digit `8`/`9`/`a`/`b`).

| check                         | `uuid.v7`        | `Bun.randomUUIDv7` |
| ----------------------------- | ---------------- | ------------------ |
| matches app `UUID_V7_REGEX`   | 50000/50000 PASS | 50000/50000 PASS   |
| exactly 36 characters         | 50000/50000 PASS | 50000/50000 PASS   |
| lowercase hex + hyphen layout | 50000/50000 PASS | 50000/50000 PASS   |
| version nibble is 7           | 50000/50000 PASS | 50000/50000 PASS   |
| variant bits RFC 9562 (10xx)  | 50000/50000 PASS | 50000/50000 PASS   |

**Verdict: format-equivalent**, unchanged from the 1.3.14 run. A value from
either implementation is accepted by the application's own `validID` unchanged.

### 4. Monotonicity — the check that reversed

9 independent bursts of 500,000 ids per implementation, generated back to back
as fast as the runtime allows. Three properties per implementation: no
full-string collisions; strictly increasing string order **within** each
48-bit-timestamp millisecond bucket; and strictly increasing **across the whole
burst**, which also covers ordering between buckets.

| implementation     | collisions (4.5M ids) | strict order within every ms | strict order across the burst | largest ms bucket | median ms bucket |
| ------------------ | --------------------: | ---------------------------- | ----------------------------- | ----------------: | ---------------: |
| `uuid.v7`          |                     0 | **PASS**                     | **PASS**                      |             2,293 |            1,376 |
| `Bun.randomUUIDv7` |                     0 | **PASS**                     | **PASS**                      |             4,095 |            3,056 |

**This is the reversal.** On Bun 1.3.14 the same scenario failed for
`Bun.randomUUIDv7` in all 5 trials, always the same way: its 12-bit
sub-millisecond counter wrapped at the 4097th id inside one millisecond and the
next id sorted below its predecessor.

```text
1.3.14, every trial:
prev: 01a01be7-c4d9-7fff-bd0c-cfa03fc2b816
curr: 01a01be7-c4d9-7000-bff8-a3f5ea27c5ee
                ^^^^ rand_a resets from fff (4095) to 000 at the 4097th id
```

1.4.0 does not wrap. Probed directly: the counter starts at a pseudo-random
value, increments to 4095, and when it is exhausted the generator **advances the
timestamp embedded in the id** instead of reusing the millisecond. That is why
the largest bucket here is 4,095–4,096 exactly, in every run, rather than the
6,144 the wrapping version reached — and why the ordering holds at a rate that
used to break it. `uuid.v7` never got near its own limit: its sequence counter
spans 32 bits across `rand_a` and part of `rand_b`
(`node_modules/uuid/dist-node/v7.js`, `updateV7State`/`v7Bytes`), so it would
need roughly 2^32 ids in one millisecond to wrap.

The bucket-size columns are reported for a reason: "monotonic" means little if
the implementation was never asked to fill a millisecond. Bun's median bucket is
~3,000 ids and its largest is the counter's exact ceiling, so exhaustion
genuinely happened here. Note the trade-off it implies — per-millisecond
capacity is `4096 − random start`, so it is ~2,048 on average, not 4,096.

4096+ ids inside a single millisecond is a **burst-generation** result, not a
claim about normal request traffic; it takes a tight loop with no I/O to get
there. What changed is that the property now holds unconditionally rather than
only below a threshold.

### 5. Clock fidelity — the cost 1.4.0 moved, and where it landed

New scenario, added because §4's fix has to be paid for somewhere: if a
generator advances the embedded timestamp to avoid reusing a millisecond, the
timestamp inside the id can run **ahead of the wall clock**. Nothing was
measuring that. Two phases per implementation, 3,000,000 ids each — see the
"Running it" note on why one phase is not enough.

| implementation     | max ms behind | paired max ms ahead | burst ms borrowed (sampled peak) | still ahead after 50 ms idle |
| ------------------ | ------------: | ------------------: | -------------------------------: | ---------------------------: |
| `uuid.v7`          |             1 |                   0 |                            0 (0) |                            0 |
| `Bun.randomUUIDv7` |             1 |                   1 |                        333 (327) |                          282 |

- **Behind the clock is the assertion, and both pass.** An id whose timestamp
  predates a row inserted before it would sort ahead of that row, which is the
  guarantee these ids exist for. Tolerance is 1 ms because the comparison is two
  separate clock reads, not one.
- **Ahead of the clock is reported, not asserted.** `Bun.randomUUIDv7` borrowed
  333 ms of future timestamps over a 3,000,000-id burst and was still 282 ms
  ahead after 50 ms of idle time — the debt is only repaid as real time passes.
  It is bimodal across runs (1 ms in some, 100–330 ms in others) for a
  straightforward reason: drift happens only while generation sustains more than
  ~4,096 ids/ms, which is almost exactly this machine's top speed for the call.
  A 3,000,000-id tight loop sits right at that boundary; a request handler is
  three orders of magnitude below it.

Why it is reported rather than gated: nothing in this application decodes the
timestamp out of an id — callers treat it as an opaque sortable string, and the
session keyset cursor sorts `(createdAt, id)` with `createdAt` supplying the
time. The measurement is here so that stops being an accident. `lib/id.ts`
carries the same warning at the seam.

### Relative to `TODO.md`'s `EM-5` criterion

Stated there, not here: _"a real throughput win in the interleaved scenario …
AND equal format guarantees — same regex, same monotonicity."_ On Bun 1.4.0 all
three hold: +98% interleaved, full format equivalence, and monotonicity that now
survives counter exhaustion in both the per-millisecond and whole-burst forms.
The one measured difference that remains is §5's forward drift, which is not a
guarantee `EM-5` asked about and does not touch anything this codebase reads.

## Format-check note: `UUID_V7_REGEX` is not exported

`utils/index.ts` defines `UUID_V7_REGEX` as a module-private `const` — only the
`validID` function that wraps it (`UUID_V7_REGEX.test(trimmed) ? trimmed : ''`)
is exported. This benchmark must not edit application code, so it cannot add an
`export` to reach the regex directly. Instead, `shared/checks.mjs` imports
`validID` and asserts `validID(id) === id`, which for a whitespace-free string
is exactly "id matches `UUID_V7_REGEX`" — the same equivalence the task asked
for, without a hand-copied pattern that could drift from the real one. Length,
lowercase-hex-layout, version-nibble, and variant-bits checks are independent,
additional assertions written for this benchmark (not copies of the app's regex,
which is case-insensitive and would not by itself catch an uppercase-hex
regression).

## Tooling declarations (knip / find-unused-files)

No change was needed, verified by actually running both:

- `knip.jsonc`'s `entry` array declares `bench/**/*.mjs` (and `bench/**/*.ts`) —
  a directory-wide glob, not per-subdirectory paths — so `bench/uuid/**` is
  already covered. This is also what keeps `uuid` a declared-and-used
  devDependency now that the application no longer imports it.
- `scripts/find-unused-files.ts`'s `ENTRY_DIRECTORIES` already includes
  `'bench/'`, for the same reason (see that file's comment).
- `bunx knip` and `bun scripts/find-unused-files.ts` were both run after the
  harness v2 changes: neither lists any `bench/uuid/*` file as unreachable or
  unused, and neither reports `uuid` as an unused dependency.

The only file this benchmark's presence required a change to was the repo root
`.gitignore` (added `bench/uuid/results/`, matching the existing
`bench/sqlite/results/` entry and its reasoning: the harness is tracked, the
host-specific, reproducible JSON output is not).

## Caveats

- **Single machine, single OS.** Like `bench/sqlite`, absolute ops/sec numbers
  are this Windows laptop's; only the shape of the comparison (isolated vs.
  interleaved gap, format equivalence, monotonicity, drift behaviour) should be
  expected to generalize without a rerun on the actual deployment target.
- **Whole-batch timing, not per-call.** `process.hrtime.bigint()` itself costs
  tens of nanoseconds — a meaningful fraction of one UUID call. Sampling every
  call (as `bench/sqlite`'s runner does, correctly, for microsecond-scale SQL
  operations) would measure the timer more than the generator here, so
  throughput and interleaved scenarios time the whole loop once instead; see
  `shared/runner.mjs`.
- **`uuid.v7`'s own variance is the wider of the two** on this machine (tight
  loop 1.41–1.62M ops/sec within a single run, and medians 1.50M/1.58M between
  two consecutive runs). `Bun.randomUUIDv7` was steadier. The alternating repeat
  order stops that from biasing the comparison but does not remove it from the
  min/max columns.
- **The monotonicity burst is a stress test, not a load simulation.** It exists
  to answer a yes/no safety question (does strict ordering ever break), not to
  model realistic request concurrency. The same applies to §5's second phase:
  the drift it measures needs a rate no real handler reaches.
- **§5's sampled peak understates, never overstates.** The burst phase reads the
  clock once every 65,536 ids, so a peak between two samples is missed; the
  "borrowed" column is exact by construction (embedded-timestamp span minus
  elapsed wall time) and is the one to read.
