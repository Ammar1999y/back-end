# UUID v7 generation benchmark

Measures `v7` from the `uuid` package — what `lib/id.ts`'s `generateUuidV7`
currently wraps — against `Bun.randomUUIDv7()`, the candidate replacement named
in that file's own comment. **This benchmark measures and reports only; it does
not decide whether to switch.** See `lib/id.ts`'s comment and `TODO.md`'s `EM-5`
section for the decision and its stated criterion: _"a real throughput win in
the interleaved scenario (not just the tight loop) AND equal format guarantees —
same regex, same monotonicity within a millisecond."_ This directory is meant to
be re-run (not rewritten) the next time that criterion needs checking, e.g.
after a Bun upgrade.

## Layout

```text
bench/uuid/
  shared/
    generators.mjs   the two implementations under test
    stats.mjs        ops/sec + ns/op math, median/min/max across repeats
    runner.mjs       tight-loop and interleaved measurement loops
    checks.mjs       format-compatibility and monotonicity assertions
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
  app's dependencies. Here, `uuid` is already a direct dependency of the repo
  root (`package.json`: `"uuid": "^14"`) and `Bun.randomUUIDv7` needs no
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

| Flag               | Meaning                                                      | Default   |
| ------------------ | ------------------------------------------------------------ | --------- |
| `--mode`           | `all`, `throughput`, `interleaved`, `format`, `monotonicity` | `all`     |
| `--iterations=N`   | Iterations per repeat, throughput + interleaved scenarios    | `1000000` |
| `--repeat=N`       | Independent repeats per scenario (median/min/max reported)   | `5`       |
| `--burst=N`        | ids per monotonicity burst                                   | `500000`  |
| `--formatSample=N` | ids checked per implementation for format compatibility      | `50000`   |

A non-zero process exit code means a critical check (format or monotonicity)
failed — see "Monotonicity" below; that is the harness working as designed, not
a bug in it.

## Machine this run was recorded on

Windows 10 (win32/x64), Intel Core i5-1035G1, 8 logical CPUs, 8.4 GB RAM.
`bun 1.3.14 (0d9b296af)`, `uuid` package `14.0.1`. Single machine, single OS —
see "Caveats" before treating any absolute number as portable.

Reproduce with the default flags above; raw numbers are also saved to
`bench/uuid/results/latest.json` (gitignored — regenerate it, don't expect it
present in a fresh checkout).

## Results

### 1. Throughput — tight loop

1,000,000 iterations x 5 repeats per implementation, nothing else in the loop
body.

| implementation     | ops/sec (median) |       min |       max | ns/op (median) | ns/op min | ns/op max |
| ------------------ | ---------------: | --------: | --------: | -------------: | --------: | --------: |
| `uuid.v7`          |        1,312,890 | 1,296,934 | 1,405,342 |          761.7 |     711.6 |     771.0 |
| `Bun.randomUUIDv7` |        3,902,413 | 3,732,712 | 4,163,123 |          256.3 |     240.2 |     267.9 |

**Bun.randomUUIDv7 is ~2.97x faster in isolation**: +2,589,523 ops/sec
(+197.2%), saving 505.4 ns/op.

### 2. Interleaved — realistic per-row work

Same iteration/repeat counts, but each iteration builds the row object
(`{ id, createdAt: Date.now(), kind, seq }`) and runs it through
`JSON.stringify` — identical non-generation work for both implementations.

| implementation     | ops/sec (median) |       min |       max | ns/op (median) | ns/op min | ns/op max |
| ------------------ | ---------------: | --------: | --------: | -------------: | --------: | --------: |
| `uuid.v7`          |          724,444 |   701,291 |   747,048 |         1380.4 |    1338.6 |    1425.9 |
| `Bun.randomUUIDv7` |        1,379,919 | 1,254,252 | 1,423,283 |          724.7 |     702.6 |     797.3 |

**The gap shrinks by more than half once realistic per-row work is included:
~1.90x faster** (+655,475 ops/sec, +90.5%), not ~2.97x.

### id-generation share of a realistic per-row operation

| implementation     | tight-loop ns/op | interleaved ns/op | share of the realistic op |
| ------------------ | ---------------: | ----------------: | ------------------------: |
| `uuid.v7`          |            761.7 |            1380.4 |                     55.2% |
| `Bun.randomUUIDv7` |            256.3 |             724.7 |                     35.4% |

Reading this: for `uuid.v7`, id generation is 55.2% of a realistic insert-shaped
operation's cost; for `Bun.randomUUIDv7`, 35.4%. The isolated-call ratio (2.97x)
overstates what the swap is worth once the rest of the row-building work —
building the object and serializing it — is accounted for.

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

**Verdict: format-equivalent.** Every sample from both implementations passed
every check. A value from either implementation is accepted by the application's
own `validID` unchanged.

### 4. Monotonicity within one millisecond

5 independent bursts of 500,000 ids per implementation, generated back to back
as fast as the runtime allows, grouped by the 48-bit millisecond-timestamp
prefix, checked for full-string collisions and for strictly increasing string
order within each millisecond bucket (generation order already equal to sorted
order — the order a text-column index would produce).

| implementation     | collisions (5 bursts) | largest single-ms bucket seen | strictly increasing in every bucket? |
| ------------------ | --------------------: | ----------------------------: | ------------------------------------ |
| `uuid.v7`          |                     0 |                         2,200 | **yes — PASS, all 5 trials**         |
| `Bun.randomUUIDv7` |                     0 |                         6,144 | **no — FAILED, all 5 trials**        |

Per-trial detail (bucket count / largest bucket / inversions):

- `uuid.v7`: (432 / 2147 / 0), (442 / 2084 / 0), (427 / 2129 / 0), (410 / 2135 /
  0), (405 / 2200 / 0) — zero inversions in every trial.
- `Bun.randomUUIDv7`: (173 / 5950 / 40), (160 / 5890 / 43), (127 / 6144 / 61),
  (151 / 6144 / 38), (148 / 6144 / 48) — every trial had inversions once its
  largest bucket passed roughly 4096.

**Verdict: NOT monotonicity-equivalent, and this is the property that decides
whether the swap is safe for time-ordered inserts.** Neither implementation ever
produced a duplicate (0 collisions in 5,000,000 ids total, either side). But
every single one of Bun's 5 trials broke strict same-millisecond ordering,
always at exactly the same shape of failure — e.g.:

```text
prev: 01a01be7-c4d9-7fff-bd0c-cfa03fc2b816
curr: 01a01be7-c4d9-7000-bff8-a3f5ea27c5ee
                ^^^^ rand_a resets from fff (4095) back to 000 at the 4097th
                     id generated inside that same millisecond
```

This matches Bun's own documentation for `Bun.randomUUIDv7()` almost exactly:
"When the timestamp changes, the counter is reset to a pseudo-random integer
**wrapped to 4096**" (`node_modules/bun-types/docs/runtime/utils.mdx`) — i.e. a
12-bit sub-millisecond counter. Once a burst generates more than 4096 ids inside
one millisecond, the counter wraps and the next id's random-looking high bits
are **not** guaranteed larger than the previous one's, breaking strict
lexicographic order for ids created in that window. `uuid.v7`'s sequence counter
spans far more bits (see `node_modules/uuid/dist-node/v7.js`,
`updateV7State`/`v7Bytes` — a 32-bit counter spread across `rand_a` and part of
`rand_b`, versus Bun's 12 bits confined to `rand_a`), so it did not wrap in any
trial here, and by construction would need roughly 2^32 ids inside one
millisecond to.

4096+ ids inside a single millisecond is a **burst-generation** result, not a
claim about normal request traffic — it takes a tight loop with no I/O to reach
generation rates this high (this same run's throughput section measured ~3.9M
ops/sec for Bun, i.e. its own tight loop regularly exceeds 4096 ids/ms). Whether
any real code path in this application can produce that many inserts in one
millisecond is outside this benchmark's scope; it only establishes that the
property does not hold unconditionally for `Bun.randomUUIDv7`, while it held in
every trial for `uuid.v7`.

### Relative to `TODO.md`'s `EM-5` criterion

Stated there, not here: _"a real throughput win in the interleaved scenario …
AND equal format guarantees — same regex, same monotonicity."_ This run measured
a real interleaved-scenario win (+90.5%) and full regex/format equivalence, but
did **not** measure equal monotonicity — `Bun.randomUUIDv7` broke strict
same-millisecond ordering in all 5 burst trials, `uuid.v7` did not in any.
Whether that gap matters enough to withhold the switch, given this application's
actual insert rates, is the decision `EM-5` reserves for a human — this
benchmark only supplies the two facts it asked for.

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
  already covered.
- `scripts/find-unused-files.ts`'s `ENTRY_DIRECTORIES` already includes
  `'bench/'`, for the same reason (see that file's comment).
- `bunx knip` and `bun scripts/find-unused-files.ts` were both run after adding
  this directory: neither lists any `bench/uuid/*` file as unreachable or
  unused.

The only file this benchmark's presence required a change to was the repo root
`.gitignore` (added `bench/uuid/results/`, matching the existing
`bench/sqlite/results/` entry and its reasoning: the harness is tracked, the
host-specific, reproducible JSON output is not).

## Caveats

- **Single machine, single OS.** Like `bench/sqlite`, absolute ops/sec numbers
  are this Windows laptop's; only the shape of the comparison (isolated vs.
  interleaved gap, format equivalence, monotonicity difference) should be
  expected to generalize without a rerun on the actual deployment target.
- **Whole-batch timing, not per-call.** `process.hrtime.bigint()` itself costs
  tens of nanoseconds — a meaningful fraction of one UUID call. Sampling every
  call (as `bench/sqlite`'s runner does, correctly, for microsecond-scale SQL
  operations) would measure the timer more than the generator here, so
  throughput and interleaved scenarios time the whole loop once instead; see
  `shared/runner.mjs`.
- **Observed variance was mostly on `Bun.randomUUIDv7`'s tight-loop throughput**
  (min 3,732,712 vs. max 4,163,123 ops/sec — about 12% spread, versus
  `uuid.v7`'s ~8%). Consistent with the median/min/max being taken over 5
  repeats rather than a single sample; not investigated further here.
- **The monotonicity burst is a stress test, not a load simulation.** It exists
  to answer a yes/no safety question (does strict ordering ever break), not to
  model realistic request concurrency.
