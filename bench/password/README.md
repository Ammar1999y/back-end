# Password hashing — `argon2` npm vs `Bun.password`

Measures whether the credential KDF in `lib/auth/password.ts` can move from the
`argon2` npm package to the built-in `Bun.password`, on speed, on stability, and
on whether the current application can actually carry the change.

**Recommendation: do not migrate on Bun 1.4.0.** Four independent reasons, in the
order they would hurt:

1. **`Bun.password` has no pepper parameter**, and passing `secret` is _silently
   ignored_ — a swap drops the pepper with no error, no type error through a
   spread, and no failing test.
2. **It cannot read a single hash this application has already stored**, so the
   change is a full rehash of every credential, not a swap.
3. **It blocks the event loop** above the threadpool width — 10–436 ms lag p99
   against argon2's 4–21 ms, reproduced across five runs.
4. **It is 2.9× slower per hash** and no faster in aggregate. There is no
   performance case for the change at all.

The supported replacement is `node:crypto.argon2`, which does take a `secret`; it
was merged upstream two days after 1.4.0 shipped and throws
`ERR_CRYPTO_ARGON2_NOT_SUPPORTED` on this build. Re-run this bench when it lands.
Everything below is what those four rest on.

## Scope: the primitive and the migration, not the endpoints

The `npm-app` candidate calls `hashPassword` / `verifyPassword` from
`lib/auth/password.ts`, so its numbers are the application's real cost, pepper
included, rather than a reconstruction of the profile.

The `bun-peppered` candidate is a **proposal**, written out inside `run.mjs`
rather than imported, because nothing in the application implements it. Same
rationale as `bench/otp`: the bench must keep measuring the proposal as proposed
even if the application later drifts.

Needs `PASSWORD_PEPPER_ACTIVE_ID` and `PASSWORD_PEPPER_KEYRING` in the
environment — the repository `.env` supplies both. Nothing else: no database, no
network.

## Run

```sh
bun bench/password/run.mjs                          # all four candidates
bun bench/password/run.mjs --count=16               # what the recorded run used
bun bench/password/run.mjs --checks-only            # compatibility gates, ~2 s
bun bench/password/run.mjs --only=npm-app,bun-peppered
bun bench/password/run.mjs --no-json                # don't write results/latest.json
```

The compatibility and correctness gates run before anything is timed and a
critical failure skips the timings, because a latency number for a primitive that
cannot read the application's stored rows is noise. One gate reads the Argon2id
parameters back out of a real `hashPassword` call, so a change to
`lib/auth/password.ts` fails the run rather than silently printing stale
parameters.

`--soak-only=<candidate>` is the child half of the retention probe; the parent
spawns it per candidate and you do not normally call it directly.

## Candidates

| key            | construction                                                      | pepper          |
| -------------- | ----------------------------------------------------------------- | --------------- |
| `npm-app`      | `hashPassword` — argon2id, m=64 MiB, t=3, **p=4**, peppered       | argon2 `secret` |
| `bun-peppered` | `Bun.password` argon2id m=64 MiB t=3 over an HMAC-SHA-256 prehash | HMAC prehash    |
| `bun-naive`    | `Bun.password` argon2id m=64 MiB t=3, nothing else                | **none**        |
| `bun-default`  | `Bun.password.hash(pw)` — m=64 MiB, t=2, p=1                      | **none**        |

`bun-naive` is in the table because it is what a call-site swap produces, and its
row is the one that shows what that silently costs.

## The compatibility findings, which decide it

These are gates in the run, not prose. All confirmed on `bun 1.4.0`, win32 x64.

1. **`Bun.password` cannot read any hash this application has stored.** It throws
   `InvalidEncoding` on 100% of them. `argon2@0.45` emits PHC parameters in
   `m,p,t` order; Bun's parser is positional and requires `m,t,p`.
   The [PHC string spec](https://github.com/C2SP/C2SP/blob/main/phc-strings.md)
   mandates `m,t,p`, so `argon2@0.45` is the non-conforming producer and Bun is
   within spec — but Bun 1.3.x accepted either order, so this is also a 1.4.0
   regression (upstream PR #32314, unmerged). Either way the consequence for us
   is the same: **cross-verification is impossible, so every row must be
   rehashed.**
2. **There is no pepper option, and passing one is silently ignored.** No
   `secret`, no `associatedData`. `Bun.password.hash(pw, { secret })` returns a
   hash that verifies _without_ the secret. Upstream #9654 has been open since
   2024-03; PR #24514, which would have added `parallelism`, was closed unmerged.
3. **`parallelism` is silently ignored too.** Request `p=4`, get `p=1`. TypeScript
   catches `secret` on an object literal (TS2353) but **not** through a spread —
   and `lib/auth/password.ts:85` uses exactly the spread form, so a swap drops
   `parallelism`, `hashLength` and `version` past both `tsc` and every test tier.
4. **A reordered peppered hash returns `false`, not an error.** Fixing the
   parameter order gets a stored hash past Bun's parser, and then the correct
   password is reported wrong with nothing raised. That is the failure mode a
   half-finished migration produces.
5. **`argon2` npm _can_ read Bun's output.** Rollback of Bun-written rows is
   possible; roll-forward of argon2-written rows is not.

### Error surface: `Bun.password.verify` throws where `argon2.verify` returns false

| stored value               | `argon2` npm | `Bun.password`               |
| -------------------------- | ------------ | ---------------------------- |
| empty string               | throw        | `false`                      |
| not a hash                 | throw        | throw `UnsupportedAlgorithm` |
| truncated PHC, −1 char     | `false`      | throw `InvalidEncoding`      |
| truncated PHC, −2 chars    | `false`      | throw `InvalidEncoding`      |
| truncated PHC, −3 chars    | `false`      | `false`                      |
| truncated PHC, −4 chars    | `false`      | throw **or** `false`         |
| app `p1:` envelope         | throw        | throw `UnsupportedAlgorithm` |
| argon2 order (`m,p,t`)     | `true`       | throw `InvalidEncoding`      |
| bcrypt hash, same password | `false`      | **`true`**                   |
| …pinned to `argon2id`      | n/a          | throw `InvalidEncoding`      |
| `hash("")`                 | accepted     | throw                        |

Four truncation lengths, not one, because Bun's throw-vs-`false` is **not a
function of the input class**. `argon2` npm returns `false` for every length on
every run. Bun throws on −1 and −2, returns `false` on −3, and **flips between the
two on −4 across runs** — three throws and one `false` in four runs of
`--checks-only`. Each run hashes a fresh random password, so the deciding factor
is the content of the stored value: base64 decoding is strict about non-canonical
trailing bits, and whether the truncated remainder has any depends on the random
bytes of the hash itself.

**Data-dependent throwing is worse than consistent throwing.** A consistent throw
gets caught the first time anyone tests a corrupt row. This one passes the test
and then throws in production.

Two rows matter more than the rest:

- **`argon2 order` → throw.** This is every login, and `lib/auth/password.ts:143`
  is _outside_ the `try` that opens at `:123` — that block only guards
  `parsePasswordHash` and `getPasswordPepper`. The throw escapes
  `verifyPasswordDetailed`, escapes the `db.transaction` in `db/index.ts:39-44`
  (rolling back the failed-attempt increment, so **lockout stops working**),
  and reaches `better-call`'s router, which answers a **bodyless, content-type-less
  500** — next to the `401` + JSON an unknown email gets. That is verbatim the
  account-existence oracle the docblock at `lib/auth/password.ts:92-113` exists to
  prevent. `lib/auth/passwordless.ts:203` reaches the same 500 on an anonymous
  endpoint through the legacy `p1:` OTP branch.
- **`bcrypt hash` → `true`.** `Bun.password.verify` infers the algorithm from the
  stored string, so a stored bcrypt cost=4 hash is honoured where the application
  expects argon2id at 64 MiB. Pinning the algorithm is the defence and it _throws_
  rather than returning false, so pinning without a try/catch trades a downgrade
  for a 500. The `$argon2id$` prefix test in `parsePasswordHash` is what closes
  this today and must survive any migration.

Any migration therefore owes a `try/catch` around every `Bun.password` call. The
`p2:` candidate in `run.mjs` has one, so the timings below measure a construction
that could actually ship.

## Recorded run

`bun 1.4.0`, win32 x64, 8 cores, 8 GB, `--count=16`, default threadpool. Full
output of the persisted run in `results/latest.json` (gitignored). The table is
that one run; the two candidates that decide the question were repeated **five**
times, and their spread is below it.

| candidate      | conc 1 p50 | conc 1 ops/s | conc 10 p50 | conc 10 ops/s | conc 32 p99 | RSS peak @10 |
| -------------- | ---------- | ------------ | ----------- | ------------- | ----------- | ------------ |
| `npm-app`      | **78 ms**  | 11.4         | 371 ms      | 21.2          | 1110 ms     | 547 M        |
| `bun-peppered` | 227 ms     | 4.4          | 452 ms      | 16.2          | 753 ms      | 548 M        |
| `bun-naive`    | 225 ms     | 4.4          | 382 ms      | 21.2          | 788 ms      | 548 M        |
| `bun-default`  | 149 ms     | 6.3          | 260 ms      | 29.6          | 539 ms      | 548 M        |

`hash` phase. `verify (match)` and `verify (miss)` are within noise of it for
every candidate — neither library gives a wrong password back cheaply, which is
the correct behaviour.

Across five runs, `hash` p50: `npm-app` **68–102 ms** at concurrency 1 and
430–974 ms at 32; `bun-peppered` **230–275 ms** at 1 and 621–898 ms at 32. The
concurrency-1 figures are tight and the ~3× separation between the two is stable;
the concurrency-32 figures move by a factor of two run to run **for both**, so
treat any single saturated number as indicative only. Nothing in the
recommendation rests on one.

### Rollout cost: one login during a `p1:` → `p2:` transition

| conc | ops/s | p50 ms   | p99 ms   |
| ---- | ----- | -------- | -------- |
| 1    | 3.1   | 312      | 355      |
| 4    | 8.6   | 464      | 509      |
| 10   | 9.8   | 787      | 1231     |
| 32   | 9.8   | **1354** | **1639** |

Verify the old hash with argon2, then write the new one with Bun. During the
transition a burst of 32 concurrent logins costs 1.3–1.6 s each — and
`reports/coolify-deployment.md:538` already records that the horizon for "every
stored hash rehashed" is **months**, with no event announcing the end.

## What the numbers actually said

1. **Bun is ~2.9× slower per hash, and it is two separate costs, not one.**
   Isolated by holding m=64 MiB and t=3 fixed and varying only `p` (medians of 5):

   | primitive      | p=1    | p=2   | p=4   | p=8   |
   | -------------- | ------ | ----- | ----- | ----- |
   | `argon2` npm   | 151 ms | 98 ms | 70 ms | 61 ms |
   | `Bun.password` | 191 ms | —     | —     | —     |

   The lanes really do run concurrently, so **losing `p=4` costs 2.2×** (151 → 70),
   and **Bun is a further 1.26× slower at identical p=1** (191 vs 151). Together
   that is the 78 → 227 ms the tables show. Only the first factor was expected.

   This is a **latency** loss, not a security one: every parameter set in the
   [OWASP cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
   is `p=1`, and its floor is 19 MiB / t=2, which m=64 MiB / t=3 clears
   comfortably. `p=4` is buying login latency here, not strength.

2. **Neither scales with concurrency, and Bun is not the faster one.** Both
   plateau in the same band from concurrency 10 up — across 5 repeats, `npm-app`
   6–22 ops/s (median ~16) and `bun-peppered` 8–14 (median ~13), overlapping
   ranges with npm-app modestly ahead. `bun-default` reaches ~30 only by dropping
   to t=2. Raising concurrency buys nothing and queues instead, exactly as
   `bench/otp` found. **Whatever else this migration is, it is not a performance
   improvement.**
3. **The 64 MiB is per concurrent operation, and the ceiling is the same for
   both.** Read the **RSS peak** column, not `RSS Δ`: peak lands at ~548 MiB at
   concurrency ≥ 10 for all four candidates, plateauing from concurrency 8 on an
   8-core host. `RSS Δ` is only meaningful for the first candidate measured
   (`npm-app`: ~257 MiB at concurrency 4, ~513 MiB at 10) — for the later ones the
   process has already grown, so the delta is measured against an inflated
   baseline and reads as low as 0.0 M. Same confound as the retention probe below;
   it is a property of the sampler, not of the library.
4. **`UV_THREADPOOL_SIZE` controls `Bun.password` throughput, and this is
   undocumented.** Eight concurrent hashes at m=64 MiB, t=3: `=2` → 1037 ms,
   `=4` → 587 ms, `=8` → 382 ms, `=16` → 425 ms — measured here. Bun's
   environment-variable documentation does not mention `Bun.password` or this
   variable at all; per Bun's source the shared pool is sized from
   `UV_THREADPOOL_SIZE`, then `GOMAXPROCS`, clamped to `[2, 1024]` (read, not
   measured — only the effect above is mine). On a small VPS this is a real tuning
   knob and a real footgun: a two-core container would roughly triple login
   latency. **Not added to `reports/coolify-deployment.md`: nothing is being
   migrated, so there is no server-side requirement yet.** It belongs there the day
   this decision is revisited.
5. **Nothing is retained, by either library.** 80 operations at concurrency 4 in a
   fresh child per candidate: baseline ~48 M, peak ~304 M (the four concurrent
   64 MiB allocations), residual after a forced GC **0.0–1.0 M** for all four,
   with one −0.1 M that is sampling noise. The in-process version of this probe
   reported _negative_ residuals throughout, because its baseline was taken while
   the allocator still held half a gigabyte from the preceding phases; that is why
   it now spawns a child.

### Stability: `Bun.password` blocks the event loop, and `argon2` does not

This is the one stability finding that separates them, and it survived five
independent runs — recorded that way because `bench/otp`'s README documents being
misled by exactly one non-reproducible lag outlier.

Event-loop lag p99, across 5 runs:

| candidate      | conc 10 (hash) | conc 10 (verify) | conc 32 (hash) | conc 32 (verify) |
| -------------- | -------------- | ---------------- | -------------- | ---------------- |
| `npm-app`      | 6–12 ms\*      | 5–31 ms          | 9–21 ms        | 4–14 ms          |
| `bun-peppered` | 10–103 ms      | 36–126 ms        | 41–239 ms      | 37–**436 ms**    |

\* one run reached 94 ms at concurrency 10; nothing else in `npm-app`'s data comes
near it, and the other four runs stayed at 6–12 ms. Called out rather than
dropped, because the conclusion should not rest on a single reading in either
direction — and here it does not: the gap is an order of magnitude and it is
present in all five runs.

Both libraries claim to hash off-thread, and at concurrency 1 and 4 both hold lag
at 1–30 ms. Above the threadpool width, `Bun.password` starts delaying unrelated
work by tens to hundreds of milliseconds while `argon2` stays flat. **A login
burst would add p99 latency to every other request in the process**, which is a
worse operational property than the slower hash itself. Finding 4 above is
probably the same effect seen from the other side: CPU-bound password jobs are
scheduled onto the shared pool with nothing reserving a core for the event loop.

Two open upstream defects are also worth recording, one confirmed here:

- **`await Bun.password.hash(undefined)` returns a real, verifiable hash of the
  literal string `"undefined"`** (upstream #33702; reproduced on this build).
  `hashSync` correctly throws `ERR_INVALID_ARG_TYPE` — only the async path is
  affected, and the async path is the one an application uses. Every writer in
  this repo validates through `passwordSchema` first, so it is not reachable from
  HTTP today; it is one deleted validation away from storing a universally-known
  password.
- **Out-of-range cost parameters wrap silently** (#33865): `memoryCost: 2**32+64`
  becomes `m=64`.
- An abort on an unallocatable `memoryCost` is reported upstream (#39021) but
  **did not reproduce here**: a stored PHC declaring `m=2 TiB` throws
  `WeakParameters`. What does happen is that `m=4 GiB` is accepted and _allocated_
  — `Bun.password.verify` sizes its allocation from the stored string, not from
  application config. This is not a Bun-specific flaw: `argon2` npm parses `m`
  from the stored string too, and the app's `parsePasswordHash` validates the
  envelope and the `$argon2id$` prefix but never the parameters. Not a
  differentiator, and out of scope here.

## Can the current application carry the change?

Mechanically yes; safely, not without work. `db/schema.ts:334` is `varchar(255)`
and a `p2:` envelope is 154 characters worst case (Bun uses a 32-byte salt against
npm's 16, so its PHC is 117 characters against 96) — **no schema change**. The
`chk_password_hash_length >= 50` check passes. The lazy-rehash vehicle exists:
`needsRehash` in `verifyPasswordDetailed`, then `upgradePasswordHash` with a
compare-and-swap in `lib/auth/login-guard.ts:449-494`.

Four things block a safe swap, and the last is the real one:

1. **`needsRehash` is pepper-generation-only** (`lib/auth/password.ts:151`). A
   `p1:` row under the current generation reports `false`, so as written the
   vehicle would migrate **zero rows** on an envelope change.
2. **The vehicle only runs on `/sign-in/email`.** `lib/auth/login-guard.ts:391`
   suppresses the upgrade when a caller passes `tx`, and `returnPasswordProof:
true` skips it earlier — so the four re-auth call sites migrate nothing.
3. **`p1:` is hardcoded in three places in `lib/auth/otp-hash.ts`** (`:23`, `:56`,
   `:102`), and `canEvaluateOtp` returns `true` unconditionally for that prefix.
4. **Every failure mode is silent.** `tsc` accepts the spread that drops
   `parallelism`. `tests/helpers/session.ts:194` reseeds fixtures with whatever
   `hashPassword` writes, so the whole integration tier stays green on unpeppered
   hashes. The `PEPPERED_HASH` regex at
   `tests/integration/self-service-credentials.test.ts:124` is
   `/^p\d+:[^:]+:\$argon2id\$/` — it accepts `p2:` and it accepts an unpeppered
   Bun hash, despite a docblock saying it exists to catch a silently dropped
   pepper. And `scripts/check-password-peppers.ts:18`, the documented pre-traffic
   gate, calls `assertPasswordHashEvaluable`, which never verifies anything — it
   would clear a database the new primitive cannot read.

There is also no behavioural test anywhere in `tests/` for the rehash-on-login
path, the compare-and-swap, or the unevaluatable-hash conversion at
`lib/auth/password.ts:129-141`. The migration vehicle is untested.

The one genuine upside: `reports/coolify-deployment.md:1140-1144` records `argon2`
as the **only remaining native addon on the request path**, and it is the sole
entry in `trustedDependencies`. Dropping it would simplify the container build.
That is a build-hygiene win, and it is not worth an unpeppered credential store.

## If this is revisited

`node:crypto.argon2` — merged upstream 2026-08-22, two days after 1.4.0 — takes
`secret`, `associatedData`, `parallelism` and `tagLength`, which is everything
missing above. `crypto.argon2Sync(...)` throws
`ERR_CRYPTO_ARGON2_NOT_SUPPORTED` on this build; confirmed, not assumed. It
returns a raw tag rather than a PHC string, so the envelope and parameter storage
would become ours to own — which the `p1:`/`p2:` envelope already does.

Re-run this bench on the first Bun release that ships it. The `p2:` prehash then
stops being necessary, and the question narrows to one migration instead of a
migration plus a new cryptographic construction.

## What is deliberately NOT measured

- **Whether the HMAC prehash in `p2:` is sound.** It is a construction this bench
  invented to work around a missing parameter, and no benchmark can tell you
  whether it is safe to hold a credential. That argument would have to be made
  before any of this shipped, and the recommendation above is not to.
- **`hashSync` / `verifySync`.** Blocking the event loop for 78–227 ms per login
  is not a candidate.
- **bcrypt.** `Bun.password` offers it; it is a downgrade from argon2id and is
  only present in the error-surface table, where it verifies when it should not.
- **Linux.** See below.

## Platform caveat

Measured on Windows, 8 cores, 8 GB; the deployment target is a Linux VPS on
Coolify. The absolute milliseconds will not carry over. The findings the
recommendation rests on are not timings at all — the missing pepper parameter, the
silently-ignored options, the PHC order incompatibility and the throw-vs-false
error surface are all properties of the library, and the 2.9× `p=4` gap is
architectural. One upstream report of a Windows-specific hang after
`Bun.password` (#39046) was closed 17 minutes after filing with no root cause; it
is unresolved rather than refuted, and it is a Windows-only concern that would not
follow us to the VPS.
