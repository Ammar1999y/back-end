# OTP hashing — Argon2id vs a keyed MAC

Measures the cost of hashing a **six-digit, ten-minute, attempt-limited OTP**
with the password KDF profile, against the keyed MAC that replaced it.

**The decision it fed has been taken: OTP hashing moved to HMAC-SHA-256 on
2026-08-21** (`lib/auth/otp-hash.ts`, keyed from `lib/auth/otp-key.ts`). This
folder is what justified it, and is kept so the numbers stay reproducible.

## Scope: only the primitive

The bench calls `hashPassword` / `verifyPassword` from `lib/auth/password.ts` —
which is exactly what `hashOtpCode` / `verifyOtpCode` used to delegate to, with no
parameters of their own. Importing `utils/otp.ts` would pull in the database pool
and nodemailer without measuring anything more.

The `hmac` column is the construction that shipped, written out inside `run.mjs`
rather than imported. That is deliberate: the bench must keep measuring the
_proposal as proposed_ even after the application's own version drifts, so the
recorded comparison stays honest.

## Run

```sh
bun bench/otp/run.mjs              # 24 operations per concurrency level
bun bench/otp/run.mjs --count=16   # faster; what the recorded run used
bun bench/otp/run.mjs --no-json    # don't write results/latest.json
```

Needs `PASSWORD_PEPPER_ACTIVE_ID` and `PASSWORD_PEPPER_KEYRING` in the
environment — the repository `.env` supplies both. Nothing else: no database, no
network.

Correctness gates run before anything is timed, and a critical failure skips the
timings entirely. One of them reads the Argon2id parameters back out of a real
hash and compares them to what the report claims, so a change to
`lib/auth/password.ts` makes the run fail rather than silently print stale
parameters. It earned its place immediately: the first run failed it, because
`argon2@0.45` emits PHC parameters as `m,p,t` and the expected string assumed the
`m,t,p` order of the options object.

## Concurrency levels, and why those

`1, 4, 10, 32`. Not round numbers — the point of the measurement is that the
limiters bound a request **rate** and not a simultaneous working set, so the
question is what one admitted burst can reach. `PRE_AUTH_LIMIT` is 120/min per IP
per surface; 10 is `MAX_POOL_CONNECTIONS`, the process's own transaction ceiling;
32 is a burst comfortably inside a single minute's allowance.

A worker pool holds the level steady rather than `Promise.all` over everything,
which would launch N at once and tail off — reporting a peak from one instant and
a latency from a mixture.

Peak RSS is **sampled**, not differenced across the run: argon2 frees its 64 MiB
as each operation completes, so a reading taken after the last one finished
reports a number that never existed while work was in flight.

## Recorded run

`bun 1.4.0`, win32 x64, 8 cores, 8 GB, `--count=16`, default threadpool.
Full output of the persisted run in `results/latest.json`; the ranges below are
across **four** runs, because one of them turned out to matter (see the note on
event-loop lag).

### Argon2id, 64 MiB, t=3, p=4

| phase          | conc | ops/s | p50 ms  | p99 ms   | RSS Δ      |
| -------------- | ---- | ----- | ------- | -------- | ---------- |
| hash           | 1    | 11–15 | 65–93   | 83–100   | ~64 M      |
| verify (match) | 1    | 13–14 | 62–69   | 93–165   | ~64 M      |
| hash           | 4    | 16–19 | 194–215 | 244–309  | ~257 M     |
| verify (match) | 4    | 13–17 | 231–276 | 259–459  | ~257 M     |
| hash           | 10   | 12–21 | 368–409 | 377–766  | **~513 M** |
| verify (match) | 10   | 13–20 | 378–683 | 406–1177 | **~513 M** |
| hash           | 32   | 12–21 | 373–803 | 378–1366 | **~513 M** |
| verify (match) | 32   | 13–22 | 345–696 | 356–1247 | **~513 M** |

### HMAC-SHA-256, keyed

Every level: **0.02–0.2 ms**, RSS delta at or below 0.2 M. Three to four orders
of magnitude cheaper, so a per-level table adds nothing.

## What the numbers actually said

1. **The 64 MiB is per concurrent operation, as claimed.** 4 concurrent → ~257
   MiB above baseline; 10 or more → ~513 MiB. The 513 figure came back
   _identically_ in all four runs, and plateaus from concurrency 8 onward, which
   is the libuv threadpool ceiling on an 8-core host rather than any limit the
   application imposes. This is the most reproducible thing the bench measures.
2. **Throughput does not scale, so latency degrades instead.** 12–22 ops/s at
   every concurrency from 1 to 32 — raising concurrency buys nothing and simply
   queues, taking p99 to 0.8–1.4 s for hashing a six-digit code.
3. **The slow KDF was buying nothing in exchange.** Online guessing is already
   capped by the attempt budget, and against a stolen database the KEY is what
   protects the code — the same role the pepper played. With the key, 10^6
   candidates fall instantly to any primitive, and the code expires in ten
   minutes regardless.

**Event-loop lag is not evidence here, and an earlier version of this file wrongly
said it was.** One run showed 589 ms p99 at concurrency 10 and it read as decisive.
It did not reproduce: three further runs gave 6–25 ms. argon2 does its work on the
threadpool, so it should _not_ block the loop, and the typical numbers say it does
not. The 589 ms was an outlier. It is called out rather than quietly dropped
because the conclusion below deliberately does not rest on it.

**Platform caveat:** measured on Windows, 8 cores, 8 GB; the deployment target is
a Linux VPS on Coolify. The _shape_ — 64 MiB per concurrent operation, throughput
bounded by the threadpool — is architectural and will hold. The absolute
milliseconds will not. The decision rests on the memory plateau and the
three-to-four-order-of-magnitude ratio, both far too large for a factor of two
either way to change.

## What is deliberately NOT measured

Whether HMAC-SHA-256 is _secure enough_. That is not a benchmark question, and no
run here answers it — see the reasoning block at the top of
`lib/auth/otp-hash.ts`, which is where the argument lives.
