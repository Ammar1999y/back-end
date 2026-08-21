# sharp vs `Bun.Image` — scoped to this application's image pipeline

Measures `sharp@0.35` against `Bun.Image` (Bun 1.4.0) on the **three things this
codebase actually asks an image library to do**, plus the capability,
hostile-input and resource questions that decide whether replacing sharp is safe
rather than merely faster.

**The decision it fed has been taken: the pipeline moved to `Bun.Image` on
2026-08-21.** `lib/r2/optimize-image.ts` and `upload-helper.ts`'s blurhash both
run on it now; `sharp` is a devDependency kept so this comparison stays runnable.
Two capabilities `Bun.Image` lacks were closed by narrowing the contract rather
than by keeping sharp:

- **SVG** is stored sanitised and minified with **no blurhash**. It is XML,
  it arrives in a few kilobytes, and a placeholder for it bought nothing —
  rasterising SVG was the only reason this project needed a rasteriser at all.
- **Animated WebP is rejected** at `validateMagicBytes`, from the `VP8X`
  animation flag, with its own message. Animated uploads are not a feature here,
  and the previous behaviour — sharp silently keeping frame one — was worse than
  a refusal.

So the two checks that used to fail the run are now reported rather than
asserted, and a full run is green. **The engines are not interchangeable in this
harness: the `Bun.Image` column calls the application's own functions, and the
`sharp` column is the bench's copy of what production used to be.** That
direction was reversed when the migration landed — before it, both columns were
running `Bun.Image` and calling it a comparison.

## Scope: only what the route does

`app/api/upload/image/handler.ts` → `lib/r2/upload-helper.ts` →
`lib/r2/optimize-image.ts` is the whole image surface of this project. There is
no rotate, no crop, no thumbnail set, no format negotiation, so none of that is
measured — a benchmark of features nobody calls is a benchmark of nothing.

| Pipeline   | Production site                                     | What it needs                                                     |
| ---------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| `metadata` | `optimize-image.ts`, `upload-helper.ts`             | width/height without decoding pixels                              |
| `optimize` | `optimize-image.ts` — the resize/encode search loop | `resize({width, withoutEnlargement})` + WebP encode + output size |
| `blurhash` | `upload-helper.ts` + `utils/images/rgba.ts`         | **32px RGBA raw pixels** for `blurhash.encode`                    |

Constraints the harness reads from the app rather than inventing:
`MAX_IMAGE_PIXELS` (25 MP), `SERVER_MAX_IMAGE_SIZE` (the 0.2 MB target the loop
searches for), `MAX_IMAGE_SIZE` (the 1 MB per-file upload cap), and
`ALLOWED_IMAGE_TYPES` — PNG, WebP, SVG, which is why no JPEG, HEIC or AVIF
appears anywhere below.

**The `Bun.Image` side of every pipeline is the production code itself**, imported
from `@/lib/r2/optimize-image` and `@/utils/images/rgba`. The sharp side is the
bench's own copy of what production ran until 2026-08-21 (`shared/engines.mjs`),
kept because a comparison needs two implementations — and labelled, because a
benchmark whose two columns are the same library is worse than none.

## Layout

```text
bench/image/
  shared/
    corpus.mjs           deterministic inputs: realistic, hostile, and behavioural
    engines.mjs          the two implementations of the three pipelines
    quality.mjs          PSNR + SSIM, with sharp as the decode instrument
    runner.mjs           timing, event-loop-delay sampling, peak RSS
    checks.mjs           capability, parity, hostile-input and behaviour assertions
    report.mjs           tables, check printing, JSON persistence
    _startup-child.mjs   spawned: cold-start cost of each library
    _memory-child.mjs    spawned: peak RSS of one pipeline in a fresh process
  run.mjs
  results/               generated corpus + latest.json (gitignored)
```

Same conventions as `bench/sqlite` and `bench/uuid`: a `shared/` directory, a
thin entry point, `{ name, pass, detail, critical }` checks that fail the run
loudly, `median`-headline timing with min/max spread, one `results/latest.json`
per run, and `_`-prefixed spawned children.

## Running it

```bash
bun bench/image/run.mjs                    # everything, ~4 min
bun bench/image/run.mjs --mode=capability  # just the go/no-go checks, ~30 s
```

| Flag              | Meaning                                                                                           | Default |
| ----------------- | ------------------------------------------------------------------------------------------------- | ------- |
| `--mode`          | `all`, `capability`, `perf`, `quality`, `blurhash`, `concurrency`, `hostile`, `memory`, `startup` | `all`   |
| `--repeat=N`      | Timed repeats per measurement (first is discarded as warm-up when `N>1`)                          | `3`     |
| `--concurrency=N` | Pipelines in flight for the concurrency scenario                                                  | `4`     |
| `--heavy`         | Include the 12 MP / 34 MB PNG, which the 1 MB route cap makes unreachable today                   | off     |

The corpus is generated once into `results/corpus-v1/` and reused; generating it
costs ~3 s and is not part of any measurement.

## The answer, up front

| Question                                | Result                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Is `Bun.Image` faster on this workload? | **Yes — 1.8x to 4.3x** on the full optimize loop, every input measured                                  |
| Is the output quality equivalent?       | **Yes, within noise** (see §3); sizes differ ±17% in both directions                                    |
| Did it replace sharp?                   | **Yes**, 2026-08-21, after narrowing the contract on SVG and animated WebP (see above)                  |
| Is the native addon gone from requests? | Yes. `sharp` is a devDependency for this bench only — nothing on the request path `dlopen`s it any more |
| Anything sharp still does better?       | Peak memory on the extreme input: a 25 MP upload costs ~237 MiB against sharp's ~142 MiB (§4)           |

## 1. Speed

Full optimize loop — the production search, median of 3, Windows/i5-1035G1:

| input          | sharp ms | `Bun.Image` ms | Bun is    | iterations (sharp / Bun) | output size delta |
| -------------- | -------: | -------------: | --------- | ------------------------ | ----------------: |
| photo 2MP¹     |   4645.6 |         1817.5 | **2.56x** | 8 / 6                    |            +15.6% |
| webp in 2MP    |   4005.5 |         1952.2 | **2.05x** | 6 / 6                    |             +9.5% |
| screenshot 2MP |    476.5 |          189.3 | **2.52x** | 1 / 1                    |             −1.5% |
| alpha 1MP¹     |   1688.8 |          919.9 | **1.84x** | 4 / 4                    |            −17.0% |
| tiny 64px      |      5.6 |            1.3 | **4.30x** | 1 / 1                    |             −7.5% |
| 25MP at cap    |   1714.4 |          613.1 | **2.80x** | 1 / 1                    |             ±0.0% |

Output sizes are stable run to run (the encoders are deterministic); the speed
ratios move with the machine. Across three full runs the same rows landed between
**1.79x and 4.30x**, so read the range rather than any single figure — and note
that the largest ratio is the 64px avatar, where what is being measured is mostly
per-call overhead rather than pixel work.

¹ Over the 1 MB upload cap as a PNG, so unreachable through the route today —
included because the cap is a placeholder (`MAX_IMAGE_SIZE = 1; // placeholder`)
and these are what the loop would face if it moves.

One resize+encode pass (width 1600, quality 80) is 1.8x–3.4x in the same
direction, and `metadata()` is sub-millisecond on both. Iteration counts differ
because the two encoders land on different sizes at the same quality setting —
which is a behaviour difference in the search, not just a speed one: on `photo
2MP` Bun reached the target two steps earlier and therefore shipped a
_higher_-quality, larger file.

## 2. The three capability gaps, and what each one cost

### SVG has no decoder — closed by dropping the requirement

```text
sharp:     can rasterise SVG  →  yes, 240x120 in 1.0 ms
Bun.Image: no — ERR_IMAGE_UNKNOWN_FORMAT (expected JPEG, PNG, WebP, GIF, BMP, TIFF, HEIC or AVIF)
```

`Bun.Image` sniffs container formats only; there is no SVG path and no option to
add one. The requirement came from one line — `upload-helper.ts` computing a
blurhash from the sanitised SVG bytes — and that line is gone: an SVG is XML, it
is already minified by then, and `files.blurhash` is nullable. So the rasteriser
was carrying the whole `sharp` dependency for a placeholder nobody needed.

Still reported by `--mode=capability`, deliberately: it is the one capability
difference a future feature (server-side SVG rasterisation, thumbnail sheets)
would run straight back into.

### Animated WebP fails to decode — closed by rejecting the input

```text
the animated WebP fixture really is animated  →  libvips reads 3 pages, 160x360
sharp:     decodes it  →  yes, flattened to frame 1 (160x120, 134 B)
Bun.Image: no — ERR_IMAGE_DECODE_FAILED
```

Narrowed rather than assumed: `Bun.Image` decodes `VP8X,ALPH,VP8` (extended
container with alpha) and `VP8L` (lossless) without complaint, so the gap is
specifically `ANIM`/`ANMF` frame handling, not extended-container parsing.

`validateMagicBytes` now walks the RIFF chunks and refuses on the `VP8X`
animation flag, so the decoder never sees one. That also replaced a silent
behaviour: sharp kept frame one and returned a still image with no explanation.

### No raw-pixel terminal — closed by owning ~90 lines

Every `Bun.Image` terminal returns encoded bytes: no `raw()`, no `ensureAlpha()`.
`blurhash.encode` needs RGBA. `utils/images/rgba.ts` therefore encodes a lossless
32px PNG (`compressionLevel: 0`, ~3 KiB) and inflates it straight back — that is
production code now, not a benchmark workaround, and it is the one piece of the
migration that added surface rather than removing it.

| input          | sharp ms | Bun ms | hash               |
| -------------- | -------: | -----: | ------------------ |
| photo 2MP      |     36.1 |   53.7 | identical          |
| webp in 2MP    |     60.7 |   72.2 | differs in 2 chars |
| screenshot 2MP |      9.5 |   11.9 | differs in 2 chars |
| alpha 1MP      |     32.8 |   24.7 | differs in 2 chars |
| tiny 64px      |      4.1 |    2.5 | identical          |

Hash strings are _allowed_ to differ: two lanczos3 implementations round
differently and blurhash quantises to 83 buckets per component. The property that
matters is the decoded placeholder, and it agrees to within a mean of 0.51/255
across the corpus. The round-trip costs roughly nothing — sometimes less than
sharp's native `raw()`, because the resize itself is faster.

**One real difference surfaced here and was decided rather than inherited.**
`blurhash.encode` ignores the alpha channel, so the placeholder was being derived
from whatever RGB sits under fully transparent pixels — and the two libraries
disagree about that: sharp's resize zeroes it, `Bun.Image` keeps the source
colour. Decoded placeholders differed by up to **101/255** on a transparent PNG.
`generateBlurhash` now composites onto white first, which makes the placeholder
mean "what this image looks like on a light page" instead of depending on
invisible pixels — and drops the disagreement to 0.26/255.

## 3. Quality

At the same quality setting, encoder isolated (source downscaled once, by one
resampler, for both):

| input          | quality | sharp size / PSNR / SSIM     | Bun size / PSNR / SSIM       |
| -------------- | ------: | ---------------------------- | ---------------------------- |
| webp in 2MP    |      95 | 400.7 KiB · 44.26 dB · .9760 | 392.3 KiB · 40.06 dB · .9593 |
| webp in 2MP    |      85 | 146.7 KiB · 38.56 dB · .9053 | 167.2 KiB · 37.51 dB · .9084 |
| webp in 2MP    |      75 | 47.2 KiB · 36.53 dB · .8477  | 61.5 KiB · 36.09 dB · .8561  |
| screenshot 2MP |      95 | 79.8 KiB · 47.87 dB · .9985  | 79.8 KiB · 47.15 dB · .9988  |
| screenshot 2MP |      75 | 40.3 KiB · 40.00 dB · .9898  | 39.0 KiB · 40.01 dB · .9901  |
| alpha 1MP      |      95 | 458.1 KiB · 47.04 dB · .9884 | 420.4 KiB · 44.52 dB · .9805 |
| alpha 1MP      |      75 | 129.6 KiB · 37.82 dB · .8992 | 105.2 KiB · 37.65 dB · .8965 |

sharp is usually a fraction of a dB ahead on PSNR at the same quality number —
consistent with it passing `smartSubsample` and `effort: 5`, neither of which
`Bun.Image` exposes. SSIM lands on Bun's side about as often. Nothing here is a
visible difference; both stay in the "indistinguishable" range wherever the
target size allows it.

**What the production loop actually ships**, target-constrained (the number that
matters, since the loop searches until it fits):

| input          | sharp                               | `Bun.Image`                             |
| -------------- | ----------------------------------- | --------------------------------------- |
| webp in 2MP    | 183.3 KiB · 34.12 dB · .8123 · 6 it | 200.7 KiB · **34.54 dB** · .8379 · 6 it |
| screenshot 2MP | 100.2 KiB · 49.35 dB · .9993 · 1 it | 98.7 KiB · 48.90 dB · .9996 · 1 it      |
| alpha 1MP      | 182.3 KiB · 39.45 dB · .9322 · 4 it | **151.4 KiB** · 39.16 dB · .9278 · 4 it |

Resampler difference, engine vs engine, lossless, no reference image (so neither
side's kernel is treated as "correct"):

| input          | at 800px wide | PSNR     | SSIM  |
| -------------- | ------------- | -------- | ----- |
| webp in 2MP    | 800x600       | 41.66 dB | .9645 |
| screenshot 2MP | 800x450       | 55.52 dB | .9999 |
| alpha 1MP      | 800x600       | 48.16 dB | .9953 |

## 4. Resources — where sharp wins one

Peak RSS, one fresh process per measurement (`--mode=memory`), because
scenario-shared processes only report what earlier scenarios allocated:

| input       | engine      | pipeline cost | note                                               |
| ----------- | ----------- | ------------: | -------------------------------------------------- |
| 25MP at cap | sharp       |     142.0 MiB | libvips streams tiles                              |
| 25MP at cap | `Bun.Image` |     237.2 MiB | **+67%** — a full 25 MP RGBA buffer, it looks like |
| webp in 2MP | sharp       |      70.7 MiB |                                                    |
| webp in 2MP | `Bun.Image` |      24.6 MiB | **−65%**                                           |

The in-process `RSS delta` column of the perf table agrees on both directions
(25 MP: 139.8 MiB sharp vs 228.3 MiB Bun; 2 MP webp: 39.3 vs 16.4), which is
what makes the child-process figures worth trusting rather than an artefact of
one measurement method.

Read together: Bun is lighter on ordinary images and heavier on the extreme the
pixel cap still permits. `MAX_IMAGE_PIXELS` is 25 MP and a 25 MP PNG can be
82 KB on the wire, so a single request under the 1 MB cap costs ~240 MB of RSS
under Bun against ~140 MB under sharp — on an endpoint that is unauthenticated
with a 20/minute IP limit. That is a capacity question for the VPS, and it is
recorded in `TODO.md` rather than settled here.

Cold start, fresh process:

| engine      | module load | first op | RSS after load |
| ----------- | ----------: | -------: | -------------: |
| sharp       |    86.33 ms |   6.4 ms |      48.95 MiB |
| `Bun.Image` |     0.15 ms |   1.9 ms |      32.02 MiB |

sharp's 83 ms is paid once per process, so it matters for a cold container and
for nothing else. The 17 MiB of resident memory is permanent, though, and a
process that never receives an upload still pays it.

Event-loop delay, sampled every 5 ms while the pipelines run (idle baseline on
this machine: 2.0 ms max, 0.2 ms median):

| engine      | in flight | wall ms | ms/image | loop lag max | lag median |
| ----------- | --------: | ------: | -------: | -----------: | ---------: |
| sharp       |         1 |  3738.9 |   3738.9 |       9.3 ms |     0.6 ms |
| `Bun.Image` |         1 |  2035.3 |   2035.3 |       2.0 ms |     0.6 ms |
| sharp       |         4 |  4113.3 |   1028.3 |       2.0 ms |     0.4 ms |
| `Bun.Image` |         4 |  2364.4 |    591.1 |       1.8 ms |     0.2 ms |

Neither library blocks the JavaScript thread in a way that would matter: median
delay is indistinguishable from idle for both. sharp's _worst_ sample is
consistently the larger one (9.3 ms here, 41.3 ms in another run against a 60 ms
idle outlier in that same run) — consistent with the JS-side buffer allocation
`toBuffer()` does, and small enough that it is a curiosity rather than a finding.
This deployment runs a single process (`reusePort: false`), so it was worth
checking rather than assuming.

Both scale to 4 concurrent pipelines at roughly the cost of one — libvips and
Bun each use their own thread pool, and this machine has 8 logical CPUs. That
also means the per-image figures in §1 are not what a busy server sees; four at
once cost 4x less per image on both.

## 5. Hostile input — parity, with better error identity on Bun

| input                         | sharp                                   | `Bun.Image`                           |
| ----------------------------- | --------------------------------------- | ------------------------------------- |
| truncated PNG (512 B)         | refused at decode (`libpng read error`) | refused (`ERR_IMAGE_DECODE_FAILED`)   |
| zero bytes                    | refused                                 | refused (`ERR_IMAGE_UNKNOWN_FORMAT`)  |
| 4 KiB of random bytes         | refused                                 | refused (`ERR_IMAGE_UNKNOWN_FORMAT`)  |
| header claiming 60000×60000   | refused in 0.4 ms, +0.0 MiB             | refused in 0.0 ms, +0.0 MiB           |
| 30 MP over `MAX_IMAGE_PIXELS` | refused                                 | refused (`ERR_IMAGE_TOO_MANY_PIXELS`) |
| 25 MP exactly at the cap      | admitted                                | admitted                              |

Both refuse the 3.6-gigapixel header lie from the header, before allocating —
the decompression-bomb property, and the one that matters most. `Bun.Image`'s
`error.code` values are documented and stable; sharp's are message strings, which
is why `optimize-image.ts` cannot branch on them today.

Note on the truncated case: `metadata()` succeeds on it in **both** libraries —
the header is intact, only the pixel data is missing. The assertion is therefore
made against the full pipeline. An earlier revision of this check tested the
metadata probe and reported both libraries as "accepting" a 512-byte
fragment — the check was wrong, not the libraries.

One behaviour difference that is neither crash nor slowdown:

```text
sharp:     ICC profile handling → stripped,   output 102648 B
Bun.Image: ICC profile handling → PRESERVED,  output 100462 B
```

sharp drops the input's colour profile (it keeps metadata only with
`withMetadata()`, which this code does not call); `Bun.Image` carries it through
to the WebP. Preserving it is arguably the better behaviour — a Display P3 source
will not colour-shift on a wide-gamut screen — but it is a change in what gets
stored, and it puts a few hundred bytes to a few KB into every output.

## 6. What this benchmark found in the application itself

**`alphaQuality: 1` was destroying the alpha channel.** `optimize-image.ts`
passed it to both of its `.webp()` calls. sharp's alpha scale is 0–100 with a
default of 100, so `1` was the worst setting available, not an "on" flag.
Measured on the 1200×900 corpus entry, which carries 167 distinct alpha levels:

| encode                             | distinct alpha levels |   bytes |
| ---------------------------------- | --------------------: | ------: |
| source PNG                         |                   167 |       — |
| sharp, `alphaQuality: 1` (shipped) |                 **2** | 469,036 |
| sharp, default alpha               |                   167 | 430,484 |
| `Bun.Image`                        |                   167 | 430,484 |

A pixel at alpha 127 decoded as 0. Soft shadows and anti-aliased logo edges
became a hard 1-bit mask — **and the file was bigger for it**. Fixed on the day it
was found, first by deleting the option and collapsing the two duplicated literals
into one (the defect existed twice because the literal did), and then by the
migration, which removed the option's existence: `Bun.Image.webp()` takes
`quality` and `lossless`, nothing else. Every sharp number in this README is
post-fix, and the single-definition shape survives in `encodeAttempt`.

The same section of code also carried two stale comments claiming a 0.5 MB
default target when `SERVER_MAX_IMAGE_SIZE` makes it 0.2 MB; both corrected.

## Caveats

- **One machine, one OS.** Windows 10, i5-1035G1, 8 logical CPUs. Absolute
  numbers are this laptop's. The ratios should travel; the RSS figures and the
  concurrency scaling should be re-measured on the VPS before capacity planning
  on them (`TODO.md` EM-1 already owes a measurement on that box).
- **Windows uses the same `Bun.Image` geometry backend as Linux** (Highway SIMD;
  only macOS substitutes Accelerate/vImage for `lanczos3`), and JPEG/PNG/WebP go
  through the same statically-linked codecs on every platform. So of the two
  platforms available, this is the one whose _output_ should match the VPS. It
  was not verified byte-for-byte against Linux.
- **Synthetic corpus.** Deterministic noise, gradients and screenshot-shaped
  blocks rather than photographs. A flat-colour corpus makes the two encoders
  look byte-identical (measured, on the first spike), which is why the content
  is structured — but real photographs would still shift the size numbers.
- **SSIM here is an 8×8 box-window approximation**, not the reference
  Gaussian-weighted implementation. Comparable between the two engines in this
  run; not comparable to published figures.
- **The animated-WebP fixture is hand-assembled** (sharp cannot author one in
  this tree — measured). libvips reads it back as 3 pages, which is the evidence
  that the container is valid rather than merely tolerated.
- **`--heavy` inputs cannot reach the route today.** They are measured for
  scaling, not for capacity planning against the current cap.
