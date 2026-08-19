# Response to the local storage migration reviews

Date: 2026-08-18

Covers both review rounds — the original findings and the post-fix audit — as
**one current status**, not an append-only log. An earlier version of this file
kept the two rounds separately and ended up contradicting itself (it still
described a `SQL_PEEK` that had been deleted and a `U+FFFF` bound that had been
replaced). Everything below describes the code as it stands now.

Method, unchanged across both rounds: **every claim reproduced before it was
fixed, every fix re-tested after.** Nothing was fixed on assertion alone.

Headline: **both reviews were substantially correct.** Several findings were
defects of mine that would have reached production, including two I introduced
while fixing the first round, and one that corrected a factual claim I had made.

---

## 1. Current status of every finding

| ID   | Finding                                | Status                   | Note                                                            |
| ---- | -------------------------------------- | ------------------------ | --------------------------------------------------------------- |
| P-1  | Sweeper cannot ship or run             | **Fixed; model open**    | Route yields; tests tracked and run in CI; CLI-vs-HTTP is yours |
| P-3  | Production accepts ephemeral SQLite    | **Fixed; sentinel open** | Env guard done; sentinel deliberately not added (§3.3)          |
| P-4  | Readiness incomplete                   | **Partially fixed**      | Exact PRAGMA checks done; startup check pending decision 1      |
| P-5  | Schema migrations race                 | **Fixed**                | `BEGIN IMMEDIATE` + re-read under the lock                      |
| R-1  | Rejected requests write / retry race   | **Fixed**                | Max-aware admission; `SQL_PEEK` removed entirely                |
| R-2  | Unbounded sweep blocks the limiter     | **Fixed**                | Every table bounded, yields between batches, reports `hasMore`  |
| R-4  | `synchronous=NORMAL` wording too broad | **Fixed; decision open** | Named `process-crash-safe`; NORMAL vs FULL is yours             |
| R-6  | Cache prefix invalidation overmatches  | **Fixed (3rd attempt)**  | Lexicographic successor, not an appended character              |
| R-7  | Cache is scaffold with no caps         | **Accepted as scaffold** | 512 KiB value cap; pre-adoption decisions documented in-module  |
| R-8  | Stale Redis/sliding comments           | **Fixed**                | Incl. the later `scripts/` git-ignore wording in route and doc  |
| R-10 | Exact benchmark ratios are stale       | **Fixed**                | Removed from `lib/`; direction + provenance only                |
| R-11 | Failed init leaks native handles       | **Fixed**                | Open, PRAGMA, migrate AND prepare all under one cleanup guard   |
| D-1  | Coolify doc contradicts implementation | **Mostly fixed**         | Independent corrections done; sweep command awaits decision 1   |

---

## 2. Reproductions and verifications

### 2.1 Round 1 — twelve findings, twelve reproduced

| ID   | Reproduction                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------- |
| P-1  | `.gitignore:58:scripts`; `bun …sweep.ts` → `NAPI FATAL ERROR`; `node …sweep.ts` → `ERR_MODULE_NOT_FOUND` |
| P-3  | `SQLITE_DIR` defaulted to `./data` unconditionally; an empty value produced `/rate-limit.db`             |
| P-4  | `describeDatabase` had zero callers; stores open lazily on the first limited request                     |
| P-5  | 8 concurrent processes on a fresh file → `table rate_limit already exists`                               |
| R-1  | `total_changes()` grew on every denied call                                                              |
| R-2  | Single `DELETE` with no `LIMIT`, holding the sole writer lock for its whole duration                     |
| R-4  | SIGKILL proves process-crash safety only, never power-loss durability                                    |
| R-6  | `GLOB 'a*b:*'` also deleted `axb:1` and `a*bZZ`                                                          |
| R-7  | No size cap, no disk cap, no eviction                                                                    |
| R-8  | 11 present-tense references across 6 files                                                               |
| R-10 | `1.25x`, `1.6x`, `354x`, `129x`, `3.5x`, `14.5%` all traced to Windows V1 runs                           |
| R-11 | `openDatabase` had no cleanup guard between open and migrate                                             |

### 2.2 Round 2 — seven findings, seven reproduced

| ID        | Reproduction                                                                              |
| --------- | ----------------------------------------------------------------------------------------- |
| R-1       | Concurrent rollover between denial and peek → **61 s** returned where **1 s** was correct |
| R-2 / P-1 | `SQL_SWEEP` had no `LIMIT`; `SQL_COUNT` was `COUNT(*)`/`SUM()` over the whole table       |
| P-1       | Batching frees the SQLite lock but never yields, so the sync loop owns the event loop     |
| R-6       | `U+FFFF` bound left `p:\uFFFFtail` and `p:😀tail` behind                                  |
| R-8       | `next.ts` "Upstash outage"; `store.ts` citing the deleted `scripts/sqlite-sweep.ts`       |
| R-11      | 3 prepare failures → Windows `EBUSY` on rename, proving handles stayed open               |
| P-4       | Next 16.3.1 ships `server/instrumentation/` — **my claim to the contrary was wrong**      |

### 2.3 Verification of the fixes as they now stand

| Fix                           | Verification                                        | Result                                          |
| ----------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| R-1 max-aware admission       | 15 denied calls, `total_changes()`                  | **0 writes**                                    |
| R-1 no lost admissions        | 20 calls at limit 7                                 | exactly 7 admitted, stored 7                    |
| R-1 retry time (peek removed) | two-connection rollover                             | **1 s**, correct                                |
| R-2 bounded + yielding sweep  | 60,000 expired rows, concurrent health request      | sweep 234 ms; **concurrent health 10.5 ms**     |
| R-2 backlog signal            | sweep response                                      | `{"removed":{…},"hasMore":false}`               |
| R-6 prefix range              | emoji / `U+FFFF` / metacharacter keys               | target deleted, neighbours kept                 |
| R-7 size cap                  | 600 KB value                                        | rejected, cache bytes unchanged                 |
| R-11 handle guard             | forced migration throw, then forced prepare failure | reopens and writes; no retained handle          |
| P-5 migration race            | 8 concurrent processes × 3 rounds                   | **0 failures in 24 processes**                  |
| P-3 env guard                 | production boot without `SQLITE_DIR`                | throws at module load; build fails              |
| P-4 exact PRAGMAs             | production `next start`                             | `{"busyTimeout":true,"synchronousNormal":true}` |
| P-1 / P-4 auth                | with, without and wrong token                       | 200 with; 401 otherwise                         |

**Gates:** `tsc --noEmit` 0 · `eslint . --max-warnings 0` 0 ·
`prettier --check .` 0 · **34/34 probe tests** · production build 0.

### 2.4 Tests are now tracked, which was the audit's most important point

"The per-fix tests were not saved in the repository" was correct — they lived in
throwaway routes that were deleted afterwards, so nothing in the repository
proved them and CI could not enforce them.

There is now `scripts/probe/local/sqlite-semantics.test.ts` with a Node child
runner: **8 assertions covering R-1, R-2, R-6, P-5 and the admission
invariants**, runnable in CI. Probe count went from 25 to **34**.

It deliberately does not hardcode the SQL. The parent extracts each statement
from `lib/rate-limit/store.ts` and `lib/cache/index.ts` at run time and passes
it to the child, because a copy would drift silently and keep passing against
SQL nobody runs. A failed extraction is a hard failure, not a skipped test.

The child runs under Node because `better-sqlite3` cannot load under Bun, which
is what runs the probes.

**Two fixes failed their own tests before passing**, which is the point of
writing them: the R-7 size cap was silently never applied (a replacement anchor
that had been reformatted), and the first version of the semantics child
shadowed the `path` module with itself.

---

## 3. Where I disagree, and what I deliberately did not do

### 3.1 A tracked Node CLI would need a production dependency

Both reviews recommend restoring a CLI sweeper in a separate process. I have
not, and the reason is unchanged: there is still no way to _run_ it.
`bun script.ts` panics on the driver, and `node script.ts` cannot resolve the
project's TypeScript path aliases without a runner that is not a declared
dependency. Adding `tsx` or a build step to production for a maintenance job
trades a real problem for a worse one in a project whose stated posture is a
minimal dependency surface.

The event-loop objection that motivated the recommendation is now measured as
fixed: a 60,000-row sweep no longer delays a concurrent request (10.5 ms while
the sweep ran). What a separate process would still buy is removing the public
endpoint and taking the work out of the serving process entirely. That is a real
benefit, and it is decision 1 below.

### 3.2 `quick_check` and a write probe stay out of the polled path

Adopted for the deep check, rejected for the 30-second poll — which both reviews
allow. Worth restating why: a write probe takes the writer lock, so polling it
would put the health check into contention with the rate limiter, which is the
exact contention this design exists to avoid.

### 3.3 The mount sentinel

Not implemented, and the review concedes the reason: "Env validation and a
one-time sentinel existence check are not persistence proof." A sentinel written
at boot proves the path is writable, which the deep check already proves. Only
surviving a real redeploy proves persistence, and that is a runbook step. Adding
a sentinel would create the appearance of a guarantee it cannot give.

The audit's counter — that a _retained_ sentinel detects a later missing mount
at startup — is fair, and it becomes implementable alongside the startup check
in decision 1. It is recorded, not dismissed.

### 3.4 The maintenance token is not a build-time requirement

Adding it to `REQUIRED_IN_PRODUCTION` broke `next build`, which runs as
production — forcing a runtime-only secret into the build environment. Caught by
running the build after the fix.

It is enforced two other ways instead: the routes reject an unset token rather
than treating it as "no auth required", and `/api/health/storage` reports
`maintenanceTokenSet`, which fails readiness in production. Verified on a real
production server — 503 `{"maintenanceTokenSet":false}` without it, 200 with. So
a deploy that forgets it is visible at the health check rather than appearing as
a sweep that silently never runs.

`SQLITE_DIR` keeps its module-load requirement: it is not a secret, and CI gets
a placeholder like the other build vars.

### 3.5 `@upstash/redis` in `bun.lock`

The audit's observation is correct and worth stating precisely. `@upstash/redis`
is reinstalled by `bun install --frozen-lockfile` — a genuine transitive
presence, declared by drizzle-orm in `optionalPeers`. No application import
remains. `@upstash/ratelimit` and `@upstash/core-analytics` were **not**
reinstalled: those were stale on-disk directories, now removed.

---

## 4. Corrections to things I previously wrote

- **`instrumentation.ts`.** I claimed Next had no reliable single-run startup
  hook. Wrong: Next 16.3.1 supports it and skips it during
  `phase-production-build`. The startup check is not implemented yet because it
  depends on decision 1, but the reason I gave for skipping it was false.
- **"the sweep deletes in bounded batches."** False as written — only the two
  limiter tables were batched, never the cache. Now true for every table.
- **`retryAfter` via `SQL_PEEK`.** I described the follow-up read as safe
  because it takes no write lock. It was also racy, and unnecessary: a no-row
  result already proves the stored row matched the bound `windowStart`. Both
  peeks are gone.
- **P-5's failure count.** I argued the audit's "seven of eight" was overstated
  because I reproduced one. Both counts are timing-dependent; the race was real,
  which is the only part that mattered. The point was not worth making.
- **The CI test being blocked.** I said `scripts/` was git-ignored so there was
  nowhere tracked for it. That was true when written and is now resolved —
  `scripts/` is tracked and the suite exists.

---

## 5. Open decisions — implementation is paused on these

1. **Sweep execution model.** Retain the HTTP route (stall fixed, verified) or
   move to a tracked Node CLI in a separate process (removes the public endpoint
   and the work from the serving process, but needs a runnable Node entry point
   — the original P-1 blocker). **D-1, the P-4 startup check, and the retained
   sentinel in §3.3 all depend on this answer**, which is why the Coolify
   runbook has deliberately not been rewritten yet: it should not present two
   execution models as current truth.
2. **Power-loss RPO** for the daily paid-OTP counter — `synchronous = NORMAL`
   (may lose the most recent commits on host power loss) or `FULL`.
3. **WAL ceiling** — accept `journal_size_limit = 64 MiB` per database, or
   supply the disk/backup budget it should be sized against.

---

## 6. Third audit — what it found and what changed

The third audit was correct on every technical point I could reproduce.

### R-6 was still wrong, for a third distinct reason

`prefix + U+10FFFF` is an **exclusive** upper bound, so keys equal to it or
extending past it survived. Reproduced: `p:\u{10FFFF}` and `p:\u{10FFFF}tail`
were not deleted.

The root cause was that I kept reaching for a bigger character. **No appended
character can ever be correct** — whatever is appended, a key can contain it and
continue. The bound has to be the prefix's lexicographic **successor**, which is
never longer than the prefix. `lib/cache/prefix.ts` now computes it by
incrementing the last code point, carrying when it is already maximal, skipping
surrogates, and returning `null` when no successor exists (an all-maximum
prefix), in which case the range has no upper bound at all.

Verified against the audit's exact failing keys: only `q:x` survives now.

### My own test had the same blind spot the audit described

Writing the new test, my first version asserted the range in JavaScript — and it
failed. Investigating showed **the test was wrong, not the code**: SQLite
compares TEXT by UTF-8 bytes (code point order) while JS `<` compares UTF-16
code units, and they disagree for supplementary characters. Comparing U+FFFF
U+FFFF against U+10000 gives `false` in JS and `true` in SQLite.

That is precisely the failure mode the audit named — a test that constructs its
own version of the logic can only confirm itself. The test now imports the real
`prefixUpperBound` and runs the real SQL in a Node child: 24 assertions across
10 prefixes (ASCII, former GLOB/LIKE metacharacters, emoji, U+FFFF, U+10FFFF) x
10 suffixes.

### Tests are now actually enforced

All three sub-claims were true: `scripts/probe/` was untracked, CI ran no tests,
and no package script exposed them.

- `package.json` gains `"test": "bun test scripts/probe/local"`.
- `.github/workflows/ci.yml` gains a **Probe tests** step, prefixed with
  `node --version` so a runner without Node fails with an obvious message rather
  than inside a spawned child.
- `sqlite-semantics.test.ts` now asserts the child's **exit code**, not merely
  that it produced output — a child that crashed after printing would previously
  have read as a pass.

**The probe files themselves are still untracked** — that needs a commit, which
I have not made because none was requested.

### Also fixed

- **R-8** — the sweep route and the runbook both still claimed `scripts/` is
  git-ignored. It is not, since it was un-ignored. Both corrected; the real
  reason the route exists is the runtime constraint, not packaging.
- **`hasMore` contract** — documented as deliberately conservative (a final full
  batch reports `true` even if it removed the last row), and the runbook now
  says `curl -f` **cannot** see a backlog, because a backlog is a successful
  sweep returning HTTP 200. It suggests inspecting the field instead.
- **D-1** — the contradictory gate, the stale git-ignore text, the `SQLITE_DIR`
  build/runtime scope, and the false "token prevents boot" claim are all
  corrected. Only the sweep command and edge-routing sections still wait on
  decision 1.

Probe count: 34 -> **58**. Gates: `tsc` 0, `eslint` 0, `prettier` 0, build 0.

### Still not done, deliberately

- **P-4 startup check** via `instrumentation.register()`, and the **retained
  volume sentinel** (P-3). Both are genuinely useful and both are recorded. They
  are held together because a startup check that verifies the sentinel, the
  exact path and the driver is one piece of work, and its shape depends on
  whether the sweep stays in this process.
- **Edge blocking of `/api/internal/*`** — a Cloudflare/Traefik change, not a
  code change.
