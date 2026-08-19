# Legacy v1 results — 2026-08-18

> **Historical only. Do not use these numbers for current decisions or compare
> them with harness v2 or v3 output.** Audit found material validity defects in
> SQL shape, sweep accounting, concurrent timing/seeding, profile order, error
> handling, result metadata, and runtime verdict. See
> [FINAL-REPORT.md](FINAL-REPORT.md) for current findings and required Linux
> reruns. Current Next.js/Node deployment uses `better-sqlite3`; `bun:sqlite` is
> a future framework-migration target.

**Environment:** Windows 10, x64, 8 CPUs. `bun:sqlite` 1.3.14 (SQLite 3.53.0) vs
`better-sqlite3` 13.0.3 on Node 24.12.0 (SQLite 3.53.4). Profile `baseline`, 3
repeats per workload, median reported.

> Read the caveat at the end before acting on any absolute number here.

## 1. Driver comparison

`A` = `bun:sqlite`, `B` = `better-sqlite3`.

| Workload                       | A ops/s | B ops/s | Faster      |  A p50 |  B p50 | A max | B max |
| ------------------------------ | ------: | ------: | ----------- | -----: | -----: | ----: | ----: |
| rl_consume_hot_key             |  15,299 |  32,407 | **B 2.12×** |  0.019 |  0.027 |  20.8 |   1.2 |
| rl_consume_spread_10000        |  10,797 |  30,306 | **B 2.81×** |  0.020 |  0.025 |  49.2 |   8.3 |
| auth_get_then_set              |   8,841 |   9,855 | B 1.11×     |  0.020 |  0.022 | 173.9 | 292.0 |
| auth_atomic_consume            |  13,182 |  10,526 | A 1.25×     |  0.023 |  0.025 | 110.9 | 178.7 |
| cache_read_hit_1kb             |  14,580 |  18,227 | B 1.25×     |  0.060 |  0.052 |   2.8 |   1.0 |
| cache_read_hit_8kb             |   6,665 |   8,695 | B 1.30×     |  0.128 |  0.107 |   9.8 |   1.2 |
| cache_read_hit_8kb_noparse     |  10,753 |  12,493 | B 1.16×     |  0.081 |  0.072 |   7.5 |   2.2 |
| cache_read_hit_64kb            |   1,223 |   1,459 | B 1.19×     |  0.736 |  0.642 |   4.1 |   2.1 |
| cache_read_miss_1kb            |  28,108 |  36,258 | B 1.29×     |  0.032 |  0.026 |   1.8 |   1.2 |
| cache_write_1kb                |   4,338 |   3,685 | A 1.18×     |  0.070 |  0.062 |  58.5 | 331.3 |
| cache_write_8kb                |   2,708 |   3,266 | B 1.21×     |  0.086 |  0.083 | 957.3 |  53.4 |
| cache_write_64kb               |   1,374 |   1,409 | B 1.03×     |  0.419 |  0.399 |  62.0 |  98.4 |
| stmt_cached_reuse              |  21,322 |  24,954 | B 1.17×     |  0.043 |  0.039 |   3.4 |   1.2 |
| stmt_prepare_each_call         |  19,564 |  13,218 | **A 1.48×** |  0.049 |  0.071 |   2.8 |   9.5 |
| write_100_in_txn               |     118 |      97 | A 1.22×     |  2.205 |  1.493 |  42.0 |  40.4 |
| write_100_individually         |      35 |      32 | A 1.11×     | 35.975 | 38.020 | 117.8 | 119.6 |
| cache_sweep_20k_expired        |       2 |       1 | A 1.19×     |  209.2 |  191.9 | 443.6 | 625.3 |
| mixed_90read_5write_5ratelimit |  10,544 |  11,735 | B 1.11×     |  0.068 |  0.065 |  77.4 |  97.3 |

### What this says

**Neither driver wins outright.** better-sqlite3 leads on most read paths by
1.1–1.3×; Bun leads on statement preparation (1.48×), transaction batching and
the atomic consume.

**The one large gap is `rl_consume`, and it is a tail problem, not a speed
problem.** Bun has the _better median_ on that workload (p50 0.019 ms vs 0.027
ms) yet delivers less than half the throughput. At its own median Bun should
reach ~52,000 ops/s; it achieves 15,299 — about 29% of that. better-sqlite3
achieves 32,407 against a median implying ~37,000, about 87%. So Bun is faster
per operation and loses the throughput to periodic stalls. The `cache_write_8kb`
maximum of 957 ms against better-sqlite3's 53 ms is the same effect.

The cause is not established. Candidates are WAL checkpoint handling, GC pauses,
and the Windows filesystem filter stack. **This is the single thing most worth
re-measuring on Linux**, because it is the only result that would change the
driver decision.

### Decision

Nothing here justifies adding a native dependency. The `mixed` workload — 90%
cache reads, 5% writes, 5% rate-limit consumes — runs at **10,544 ops/s on the
slower driver**, which is far beyond what a single-VPS dashboard will ask of it.
Both drivers are over-provisioned for the actual traffic, so the choice should
rest on operational properties, and there `bun:sqlite` wins: zero dependencies,
no native build, no conflict with `ignoreScripts` / `trustedDependencies`.

## 2. PRAGMA matrix

Same workload (`rl_consume_spread_10000`), one profile per row.

| Profile                     | bun:sqlite ops/s | better-sqlite3 ops/s | vs baseline            |
| --------------------------- | ---------------: | -------------------: | ---------------------- |
| **baseline** (WAL + NORMAL) |       **13,662** |           **25,594** | —                      |
| defaults (DELETE + FULL)    |               92 |                   94 | **148× / 272× slower** |
| synchronous=FULL            |              274 |                  340 | 50× / 75× slower       |
| journal_mode=DELETE         |              124 |                  125 | 110× / 205× slower     |
| synchronous=OFF             |           33,698 |               27,199 | 2.5× / 1.06× faster    |
| mmap_size=256MB             |           13,394 |               26,390 | no effect              |
| cache_size=2MB              |           13,839 |               25,107 | no effect              |
| cache_size=64MB             |           14,360 |               25,661 | no effect              |
| wal_autocheckpoint=4000     |           13,759 |               24,534 | no effect              |
| locking_mode=EXCLUSIVE      |           15,457 |               32,233 | 13% / 26% faster       |

### What this says

**Only two settings matter.** `journal_mode=WAL` and `synchronous=NORMAL` are
worth roughly 100× together, consistently on both drivers. Everything else is
noise on this workload:

- `mmap_size`, `cache_size` and `wal_autocheckpoint` produced no measurable
  change. Tuning them on a small rate-limit database is cargo cult.
- `synchronous=OFF` buys 2.5× on Bun but only 6% on better-sqlite3, and it
  trades away crash durability. Not worth it for security counters.
- **`locking_mode=EXCLUSIVE` must not be used.** V1's claimed cross-process
  divergent-view reproduction was not preserved and is not accepted evidence.
  SQLite's documented behavior is sufficient: this mode permits only one client,
  conflicting with workers, rolling deploys, and the sweep task.

## 3. Multi-process contention

4 processes, one shared database file, 6 s window, `busy_timeout=2000`.

|                | aggregate ops/s | worst worker | max latency | SQLITE_BUSY |
| -------------- | --------------: | -----------: | ----------: | ----------: |
| bun:sqlite     |          22,999 |  1 op in 6 s |    4,724 ms |           4 |
| better-sqlite3 |          24,352 | 0 ops in 6 s |    1,640 ms |           6 |

**Contention behaviour is a SQLite property, not a driver property.** Both
drivers starve a worker completely and stall for seconds, and aggregate
throughput is within 6% of each other. Changing driver will not fix this.

Two consequences:

1. `busy_timeout` alone does not deliver fairness. Under sustained multi-process
   write contention, some worker will wait pathologically long.
2. This is direct evidence for the Valkey trigger in the migration report: if
   several Bun processes end up contending on the rate-limit file in production,
   the fix is a shared server, not a driver swap or a longer timeout.

## 4. Portability finding

The shared SQL uses anonymous `?` placeholders. **better-sqlite3 rejects `?1` /
`?2` numbered placeholders** when binding positionally:

```
RangeError: Too many parameter values were provided
```

Bun accepts both styles. Writing `?1` would silently couple the application to
Bun — worth knowing given that the storage module is meant to be portable.

## Caveat

Produced on Windows 10 with an antivirus filter driver in the write path.
Deployment is Linux, where file locking, `fsync` behaviour and scheduling all
differ. The relative ordering of the PRAGMA profiles should hold. The absolute
throughput, and especially the tail-latency outliers that drive the `rl_consume`
gap, should be re-measured on the target VPS before being used to decide
anything.
