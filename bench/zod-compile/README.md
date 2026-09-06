# `z.compile()` — Zod 4.5 AOT compilation against this repo's validation layer

Measures whether the validation layer (`utils/validation/*`, parsed by every
route handler through `schema.safeParse(body)`) should adopt `z.compile()` or the
global `import "zod/compile"` shim introduced in Zod 4.5.

**Recommendation: do not adopt, on `zod@4.5.2`.** Not because it is unsafe or
unsupported here — it is neither — but because the trade runs the wrong way for
this particular layer:

1. **The saving is invisible.** 1.55 µs off a login request that spends **93 ms**
   in `argon2.verify` — **0.0017 %**. Zod is not this application's bottleneck and
   nothing measured suggests it ever will be.
2. **The speedup is on the _accept_ path; this layer exists to _reject_.** On
   invalid input the compiled fast path runs, returns its `INVALID` sentinel, then
   the runtime **re-runs the entire parse** to build the error. Five of eight real
   schemas got measurably **slower** on rejection.
3. **`.refine()` and `z.preprocess()` execute twice on invalid input** — counted,
   1 → 2. This repo's preprocessors are sanitizers, so a rejection doubles them.
4. **The one real schema large enough to benefit demonstrates the trade exactly.**
   `deleteFilesSchema` at its 50-ID cap **saves 10.96 µs when it accepts and loses
   8.75 µs when it rejects.**

Adoption would be cheap and behaviourally safe — that part is settled below, and
is the reason this file exists rather than a one-line "no". Revisit only if a
route appears that parses a large payload per request; the targeted
`z.compile(oneSchema)` form is then preferable to the global import, because it
keeps the rejection-path regression contained to a schema you chose.

## Scope

The question is the application's own schemas under its own traffic shape, so
every "repo" row imports the real exported schema from `utils/validation/*` and
parses a payload that genuinely validates. Payloads were verified against each
schema before timing — two first drafts were silently invalid (`isActive` missing
from `createPermissionSchema`, `folderId: null` against a non-nullable
`idSchema.optional()`), which turned those rows into invalid-vs-invalid
comparisons until corrected. Any future re-run must repeat that check.

Synthetic rows exist only to locate where compilation's advantage peaks, which
turns out to be **above** anything this repo declares.

Elysia performs no validation of its own — `lib/http/adapters/elysia.ts` has no
TypeBox schema — so Zod is the only validation layer and these numbers are the
whole of it.

## Environment

`bun 1.4.0`, win32 x64, 8 cores, 8 GB. `zod@4.5.2` (Zod 4.5 shipped late August
2026; `node_modules/zod` here is dated Aug 29). Measured **2026-09-04**.

Timings use `Bun.nanoseconds()`, 20 000 warmup iterations, then at least 400 ms of
measurement per cell. Single process, no database, no network.

## What was ruled out as a blocker

Each of these was checked rather than assumed, and none of them is the reason:

| Suspected blocker           | Verdict                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unsupported schema features | **0 of 47** exported schemas refused under `compile(s, { strict: true })`                                                                                                       |
| Async refinements           | None exist — no `refine(async`, `superRefine(async`, `transform(async`, `parseAsync`, or `safeParseAsync` anywhere in `app/`, `lib/`, `utils/`                                  |
| Error / behaviour drift     | **1034 comparisons, 0 mismatches** (see below)                                                                                                                                  |
| CSP / `new Function`        | Server-side Bun on a VPS; no CSP applies to it                                                                                                                                  |
| 7 KB gzip bundle cost       | Server-side only, irrelevant                                                                                                                                                    |
| Module evaluation order     | `server.ts` deliberately dynamic-imports the app after its startup gates, so `import "zod/compile"` at its top **does** catch every schema — verified, identical 2.26 → 0.71 µs |

The last row is worth keeping: the shim's own docblock warns that "schemas
constructed in modules that evaluate before this import will not be compiled",
which is normally the hard part. This entry point already satisfies it for free.

### The compiler's actual refusal list

Read out of `node_modules/zod/v4/core/compile.js` rather than from the blog post,
which does not enumerate them. `ZodCompileUnsupportedError` is raised for:

reference cycles in the subtree · exclusive unions (`z.xor`) · discriminated
unions with `unionFallback` · discriminated-union options without static
discriminator values · `.catch()` with a callback (only a constant catch value
compiles) · `custom` schema without a predicate · custom check without a
predicate or check function · `overwrite` check without a transform · regex
format without a pattern · enum without enumerated values · `multiple_of` with a
zero divisor · comparison check with a `NaN` bound · comparison check with an
`Invalid Date` bound.

Sync `.refine()`, `.superRefine()`, `.transform()` and `z.preprocess()` are **all
supported** — only _async_ ones raise `ZodCompileAsyncError`. That is why the
repo's heavy use of `superRefine` and `preprocess` costs it nothing at compile
time, and why the "unsupported feature" theory dies immediately.

## Equivalence: compilation does not change what this layer answers

47 schemas × 22 payloads = **1034 comparisons of `JSON.stringify(safeParse(x))`
between the runtime and compiled clones. Zero mismatches**, including successes,
issue codes, issue paths, and the Arabic messages.

The payload set deliberately included `undefined`, `null`, `{}`, `[]`, `0`, `''`,
`true`, two `__proto__` pollution shapes (one literal, one via `JSON.parse` so the
key is a real own property), unknown-key objects against `.strict()` schemas, a
10 000-character string, and one genuinely valid body per schema family.

**This is the finding that makes the recommendation a cost/benefit call rather
than a safety one.** If the numbers ever justify compilation, correctness is not
what stands in the way.

## Recorded run — real repo schemas

Throughput in millions of `safeParse` per second; `speedup` is compiled ÷ runtime.

| schema                          | input   | runtime | compiled | speedup   |
| ------------------------------- | ------- | ------- | -------- | --------- |
| `loginSchema`                   | valid   | 0.72M   | 2.05M    | **2.85x** |
| `loginSchema`                   | invalid | 0.20M   | 0.16M    | 0.81x     |
| `createUserSchema`              | valid   | 0.39M   | 0.75M    | **1.91x** |
| `createUserSchema`              | invalid | 0.11M   | 0.12M    | 1.06x     |
| `adminUpdateUserSchema`         | valid   | 0.42M   | 0.81M    | **1.90x** |
| `adminUpdateUserSchema`         | invalid | 0.12M   | 0.12M    | 1.00x     |
| `sendOtpSchema`                 | valid   | 1.18M   | 2.73M    | **2.31x** |
| `sendOtpSchema`                 | invalid | 0.40M   | 0.32M    | 0.80x     |
| `verifyOtpSchema` (disc. union) | valid   | 0.83M   | 1.89M    | **2.29x** |
| `verifyOtpSchema` (disc. union) | invalid | 0.25M   | 0.21M    | 0.84x     |
| `createPermissionSchema`        | valid   | 0.31M   | 0.85M    | **2.70x** |
| `createPermissionSchema`        | invalid | 0.14M   | 0.14M    | 1.01x     |
| `createFolderSchema`            | valid   | 0.96M   | 4.03M    | **4.18x** |
| `createFolderSchema`            | invalid | 0.27M   | 0.30M    | 1.13x     |
| `updateFileSchema`              | valid   | 0.74M   | 3.14M    | **4.26x** |
| `updateFileSchema`              | invalid | 0.21M   | 0.18M    | 0.84x     |

Every schema here declares 3–12 keys. That is the whole reason these land at
2–4x rather than the 8–10x the release notes advertise.

### The bulk case, isolated

`deleteFilesSchema` — `z.array(idSchema).min(1).max(IDS_ARRAY_MAX)`, and
`IDS_ARRAY_MAX` is **50**. This is the largest single Zod workload the
application actually performs, so it is the strongest case compilation has here:

| input                  | runtime  | compiled | speedup   | per-request delta |
| ---------------------- | -------- | -------- | --------- | ----------------- |
| 50 valid UUID v7       | 20.37 µs | 9.41 µs  | **2.16x** | **−10.96 µs**     |
| 49 valid + 1 malformed | 19.17 µs | 27.92 µs | **0.69x** | **+8.75 µs**      |

A bulk delete that a client got right becomes 11 µs cheaper; one that a client —
or an attacker — got wrong becomes 8.75 µs more expensive. Neither figure is
large. The point is the _sign_.

## Recorded run — synthetic, to locate the peak

| schema                          | input   | runtime | compiled | speedup    |
| ------------------------------- | ------- | ------- | -------- | ---------- |
| object, 10 keys                 | valid   | 0.61M   | 13.26M   | **21.84x** |
| object, 10 keys                 | invalid | 0.21M   | 0.27M    | 1.28x      |
| object, 20 keys                 | valid   | 0.49M   | 6.64M    | **13.55x** |
| object, 20 keys                 | invalid | 0.19M   | 0.20M    | 1.07x      |
| object, 50 keys                 | valid   | 0.10M   | 2.25M    | **21.58x** |
| object, 50 keys                 | invalid | 0.10M   | 0.10M    | 1.04x      |
| object, 100 keys                | valid   | 0.08M   | 0.55M    | 6.83x      |
| object, 100 keys                | invalid | 0.05M   | 0.04M    | 0.76x      |
| object, 200 keys                | valid   | 0.03M   | 0.09M    | 3.00x      |
| object, 200 keys                | invalid | 0.03M   | 0.03M    | 0.97x      |
| array[50] of 20-key objects     | valid   | 0.01M   | 0.19M    | **19.57x** |
| array[50] of 20-key objects     | invalid | 0.01M   | 0.01M    | 1.16x      |
| deep nested, 4 levels           | valid   | 0.11M   | 1.35M    | **12.47x** |
| deep nested, 4 levels           | invalid | 0.17M   | 0.16M    | 0.97x      |
| discriminated union ×3, 15 keys | valid   | 0.57M   | 10.37M   | **18.10x** |
| discriminated union ×3, 15 keys | invalid | 0.23M   | 0.24M    | 1.04x      |

**The advantage peaks around 10–50 keys and then collapses** — 21.6x at 50 keys,
6.8x at 100, 3.0x at 200. The generated function grows past the point where V8
inlines it well, so "bigger schema, bigger win" is false above ~50 keys. The
release notes' "scales with schema complexity" holds only inside that band.

The invalid column is flat across the entire size sweep, which is the same
double-work effect the repo rows show, seen at every scale.

## Why the rejection path loses

`z.compile()` returns a clone whose `_zod.run` calls a generated fast path first
and **falls back to the original runtime parser on failure** — by design, so that
error granularity, issue paths and custom messages survive exactly (and they do:
1034/1034 above). The cost of that design is that a rejection pays for both.

Counted directly, invocations per `safeParse`:

| callback         | runtime valid | compiled valid | runtime invalid | compiled invalid |
| ---------------- | ------------- | -------------- | --------------- | ---------------- |
| `.refine()`      | 1             | 1              | 1               | **2**            |
| `z.preprocess()` | 1             | 1              | 1               | **2**            |

This is not incidental. `node_modules/zod/compile.js` copies only the `run`
wrapper and comments that copying the compiled `parse`/`safeParse` closures
"would make their fallback re-enter this instance and run user callbacks a
**third** time" — so double execution is the known, accepted floor.

It matters here because this repo's preprocessors are sanitizers, not casts:
`sanitizeStrictSingleLine` on `name`, `slugPreprocess`, the whitespace/lowercase
normaliser in `emailSchema`, and `sanitizeSvg` (jsdom + DOMPurify + svgo). A
validation layer whose declared job is rejecting hostile input should not double
the cost of rejecting it.

## Cost of compiling

|                                   |                             |
| --------------------------------- | --------------------------- |
| all 47 repo schemas               | **39 ms**, heap **+639 KB** |
| average per schema                | 0.82 ms                     |
| cheapest (`updateFileSchema`)     | 0.79 ms                     |
| dearest (`adminUpdateUserSchema`) | **27.44 ms**                |
| synthetic 200-key object          | 8.63 ms                     |

`adminUpdateUserSchema` is the outlier by a factor of ~30 — it is
`.extend().strict().superRefine()` over a schema that already carries a
`z.preprocess` and a `z.union`, so the compiler walks a large tree.

Under the global shim this cost is **lazy** — paid on each schema's first parse,
not at boot — so it would not show up as a startup stall against the gates in
`server.ts`. Under explicit `z.compile()` at module scope it would be eager.

## Inconclusive / not measured

- **`SVGIconSchema` timings are not reportable.** Both intended payloads were
  rejected by `sanitizeSvg`, so the run compared invalid against invalid and the
  two rows disagreed on direction (0.55x and 1.24x). Nothing should be read from
  them. Separately: that schema **rejects a well-formed `<svg viewBox>` with a
  single `<path>`**, and it is dead code — `@knipignore`'d, referenced only from a
  comment at `tests/unit/upload-validation.test.ts:342`. Worth resolving before it
  is ever revived; out of scope for this bench.
- **Linux.** Measured on Windows; the target is a Linux VPS on Coolify. Absolute
  microseconds will not carry over. The ratios and the sign of the invalid-path
  delta are properties of the fallback design, not of the host.
- **Concurrency and event-loop lag.** `safeParse` is synchronous and
  sub-microsecond; there is no threadpool interaction to measure, unlike
  `bench/password`.
- **`assertOnly` / `z.validate()`.** Zod 4.5 also adds a boolean-only validation
  path claimed at up to 16x on invalid data. Not measured, and it is the more
  interesting lead if this is ever revisited — it targets the rejection path,
  which is the half that lost here. It would require call-site changes, since
  every handler consumes `parsed.error.issues`.
- **`z.toJSONSchema` in `lib/http/openapi.ts`.** Build-time, not request-time.

## If this is revisited

Re-run only if one of these becomes true:

1. A route appears that parses a large body per request — a bulk import, or
   `IDS_ARRAY_MAX` raised well beyond 50. Compile **that schema only**.
2. Profiling shows Zod above ~1 % of request time on any route. Nothing measured
   here comes within three orders of magnitude of that.
3. Zod ships a compiled path that does not re-run the runtime on failure, or
   `z.validate()` is adopted for routes that discard issue detail.

Do not adopt the global `import "zod/compile"` to chase item 1 — it applies the
rejection-path regression to all 47 schemas to speed up one.

## No runner

Unlike the sibling bench directories, this one has no `run.mjs`. The scripts were
scratch harnesses and were deleted; the recommendation rests on the equivalence
result and on the sign of the invalid-path delta, both of which are properties of
Zod's fallback design rather than of this host, so re-running them would not
change the answer. If one of the three triggers above fires, write a fresh runner
against the schema that triggered it — and verify every payload actually
validates before timing it.
