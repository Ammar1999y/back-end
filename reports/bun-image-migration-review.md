# Review — `sharp` → `Bun.Image` migration

Reviewed: `lib/r2/optimize-image.ts`, `lib/r2/upload-helper.ts`, `utils/images/rgba.ts`
(plus the incidental edits to `app/api/upload/image/handler.ts`, `messages.ts`, `package.json`).
Baseline: `ccc2f8c` (the last commit still on `sharp`).
Environment: Bun 1.4.0, sharp 0.35.3 / libvips 8.18.3, win32 x64.

**Verdict: the migration is sound and I would keep it.** The engine choice, the two
contract narrowings (no SVG blurhash, animated WebP rejected) and the PNG round-trip
for raw pixels are all the right calls, and I reproduced the load-bearing claims rather
than taking them on trust. What I do not agree with is a set of _comments_: three of them
are change-history essays that CLAUDE.md rule 5 rules out, two JSDoc blocks are attached
to the wrong symbol, and two specific measured claims do not survive re-measurement.
None of that is a runtime defect. The one thing I would fix before relying on this is
where the animated-WebP gate lives, and the total absence of `bun test` coverage.

---

## 1. What I verified, and how

All ad-hoc scripts were deleted after running; nothing was left in the tree.

| Claim under test                                       | Result                                                                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `Bun.Image` cannot decode animated WebP                | **True.** `animated.webp` → `ERR_IMAGE_DECODE_FAILED: Image: decode failed`                                                                  |
| `isAnimatedWebp` catches it                            | **True.** `{"valid":false,"animated":true}`; chunk walk sees `VP8X,ANIM,ANMF,ANMF,ANMF`                                                      |
| …and does not false-positive                           | **True.** static VP8X-with-alpha → `{"valid":true}`; `VP8 ` (simple) → valid; `VP8L` (lossless) → valid                                      |
| `maxPixels` is enforced header-first                   | **True.** `overcap-6000x5000.png` (30 MP) → `ERR_IMAGE_TOO_MANY_PIXELS`; `atcap-5000x5000.png` (exactly 25 MP) passes                        |
| `Bun.inflateSync` needs `windowBits: 15` for IDAT      | **True, verbatim.** default → `invalid stored block lengths`; `windowBits: 15` → 3096 bytes out. IDAT starts `78 01` (zlib)                  |
| `imageToRgba` handles everything the app can receive   | **True on Bun 1.4.0.** All 11 decodable corpus files round-trip (greyscale, palette, 16-bit, interlaced, alpha, 25 MP, WebP source)          |
| sharp's `alphaQuality: 1` destroyed the alpha channel  | **True, exactly.** 167 source alpha levels → **2**, at 469,036 B                                                                             |
| "…and the file was LARGER for it (469,036 vs 430,484)" | **False as written** — see finding 6                                                                                                         |
| No EXIF/XMP/ICC leak into the stored object            | **True.** Spliced an `eXIf` chunk into a PNG, ran `optimizeImage`; output WebP contains only a `VP8 ` chunk, and the marker bytes are absent |
| Worst case reachable through the route                 | 25 MP inside the 1 MB cap → **586 ms, 1 iteration**. Densest 6-iteration case ≈ 1.7 s. No amplification vs sharp                             |
| `tsc --noEmit`, `eslint` on the three files            | Clean                                                                                                                                        |
| `bun bench/image/run.mjs --mode=capability`            | All critical checks passed                                                                                                                   |

---

## 2. Points I agree with

**Replacing sharp with `Bun.Image`.** The strongest argument is not speed, it is deleting
a native addon from the dependency graph of a starter kit that deploys to Coolify — no
prebuilt-binary matrix, no `ignoreScripts`/`trustedDependencies` dance at install time,
no libvips. The speed and memory numbers point the same way; I did not re-run the full
4-minute bench, so the "1.8x–3.7x / ~65% RSS" figures in the file header are the AI's,
not mine.

**Keeping `sharp` as a devDependency instead of deleting it.** The bench needs two
implementations to be a comparison, and it also needs sharp as the neutral decode
instrument for PSNR/SSIM. Right call.

**`maxPixels` at every construction site.** All three `new Bun.Image(...)` calls
(`optimize-image.ts:80`, `:121`, `upload-helper.ts:247`) pass it, plus `rgba.ts:172` —
that is the complete set, and the semantics match sharp's `limitInputPixels` closely
enough (header-checked before pixel allocation) that the decompression-bomb guard is
unchanged. This is the security-critical invariant of the whole file and it survived
the rewrite intact.

**Extracting `encodeAttempt`.** The two call sites previously held duplicated option
literals; collapsing them is right, and reading `image.width`/`image.height` _after_
awaiting the terminal is correct — they are documented as `-1` before.

**Rejecting animated WebP at `validateMagicBytes`, with its own message.** This is the
best decision in the diff. The old behaviour (sharp silently keeping frame one) was a
user-visible surprise with no explanation; the new behaviour is a 400 with a specific
message. It also keeps the decode path narrow, which is what makes the rest of the
migration provable. The bit-1-of-`VP8X` reading is correct per the WebP container spec,
the chunk walk terminates on hostile input (`size` is unsigned, offset advances by ≥9
per iteration, so a 1 MB upload is bounded at ~116k cheap iterations), and it does not
trip on the two static-but-extended cases I was worried about (alpha and lossless).

**Widening `validateMagicBytes`' return with an optional `animated`.** Additive, so no
caller breaks — the correct shape for this, rather than throwing from a validator.

**Dropping the SVG blurhash.** Correct, and the justification is stronger than the
comment claims: `blurhash` currently has **no reader anywhere in the repo**. A grep for
`blurhash` finds the column definition (`db/schema.ts:393`, nullable), the writer, and
nothing else. Rasterising XML through a native image library to produce a placeholder
for a 3 KB file was never worth it.

**Compositing transparent pixels onto white before `blurhash.encode`.** The reasoning is
right — `encode` reads RGB and ignores alpha, so without this the placeholder is derived
from colour no viewer ever sees, and it becomes decoder-dependent. (The float result is
truncated by the `Buffer` setter, so values land ≤1 LSB low. Irrelevant at blurhash's
resolution.)

**The PNG round-trip in `utils/images/rgba.ts`, as a mechanism.** The premise checks out:
the terminals are `bytes`/`buffer`/`blob`/`toBase64`/`dataurl`/`write`/`metadata`/
`placeholder` — there is no `raw()` and no `ensureAlpha()`, and the only other encoders
are lossy or unavailable. Encoding a lossless PNG at `compressionLevel: 0` and inflating
it back is the only route to RGBA, and the ~3 KiB intermediate matches what I measured
(3164 B). `unfilter` implements PNG §9.2 correctly, including Paeth's tie-breaking order,
and the in-place unfiltering through `subarray` views is right.

---

## 3. What I would change

### 1 — The animated-WebP gate is enforced in the wrong layer _(fix this)_

`optimize-image.ts:16-18` asserts an invariant — "`validateMagicBytes` rejects animated
WebP at the door" — that is enforced only in `app/api/upload/image/handler.ts:73`, one
layer above the module that depends on it. `uploadImagesToR2` is exported, and
`processImage` already _re-checks_ `isAllowedImageType` for exactly this reason
(`upload-helper.ts:184`). So the file is internally inconsistent: one validation is
defended at the shared boundary and its sibling is not.

Today there is a single caller, so nothing is broken. But this is a starter kit; the
second caller of `uploadImagesToR2` silently loses the gate and gets
`ERR_IMAGE_DECODE_FAILED` → a 500 four layers down, which is precisely the outcome the
comment says was designed out.

Move `validateMagicBytes` into `processImage`, next to the `isAllowedImageType` check
that is already there, and let the handler keep calling it early for the cheap 400.

### 2 — Two JSDoc blocks are attached to the wrong symbol _(fix this)_

`upload-helper.ts:124-142` — the block documenting `generateBlurhash` sits above
`const BLURHASH_BACKGROUND = 0xff`, so it documents the constant. Same shape at
`upload-helper.ts:56-71`: the block describing `isAnimatedWebp`'s chunk walk is attached
to `const WEBP_ANIMATION_FLAG`. In both cases hovering the function shows nothing and
hovering the constant shows an essay about a function. Move the constants above the
comments.

### 3 — Zero `bun test` coverage for any of this _(fix this)_

`scripts/probe/local/` has eleven test files and none touch the image pipeline. The
entire migration is guarded by `bench/image/`, which is a 4-minute benchmark in a
currently-untracked directory — not something `bun test` or the lefthook `verify` gate
will ever run.

That matters most for one specific assumption. `decodePng` accepts only 8-bit,
non-interlaced, colour type 0/2/4/6 — and the module's defence is "it only reads PNGs
this module just produced". I confirmed that holds: Bun's PNG encoder emitted
`depth=8 colourType=6 interlace=0` for every one of the 11 corpus inputs, including the
16-bit, palette and interlaced sources. But that is an undocumented implementation detail
of Bun's encoder, not an API guarantee. If a Bun upgrade changes it, every upload becomes
`rgba: unsupported colour type N` → a 500, with nothing in CI to catch it.

A small `scripts/probe/local/image-pipeline.test.ts` asserting (a) Bun's PNG output is
still 8-bit/ct-6/non-interlaced, (b) `imageToRgba` returns `w*h*4` bytes for a known
fixture, (c) `validateMagicBytes` rejects animated and accepts VP8X-with-alpha, and
(d) `optimizeImage` lands under target without upscaling, would close it in ~40 lines.

### 4 — Three comments are change-history, which CLAUDE.md rules out

Rule 4 says comment where a reader asks _why_ and the answer is not recoverable from the
code; rule 5 says use the fewest lines that carry it, with no change history.

- `optimize-image.ts:69-78` — a 10-line JSDoc on `encodeAttempt` about a defect in
  **deleted sharp code**, involving an option that does not exist on `Bun.Image`. The one
  sentence worth keeping is "single definition so the two call sites cannot drift".
- `optimize-image.ts:1-19` — the file header restates benchmark results that already live
  in `bench/image/README.md`. The migration rationale belongs in the commit message; the
  numbers belong in the bench. What earns its place here is only the second half: which
  formats cannot reach this function and who guarantees it.
- `upload-helper.ts:124-138` — 15 lines where ~3 carry the decision ("`blurhash.encode`
  ignores alpha, so composite onto white or the placeholder is derived from invisible
  colour and becomes decoder-dependent"). The measurement narrative is commit-message
  material.

The counter-example, and the standard the rest should be held to, is
`rgba.ts:115-118` (`windowBits: 15`). It states a non-obvious fact, gives the exact error
you get without it, and names the version it was measured on. I reproduced it verbatim.
Keep that one exactly as it is.

### 5 — `rgba.ts:40-42` states something that is false as configured

> "All five have to be handled: the encoder picks per row, and Bun's does use more than one."

Measured on the same 32px thumbnail:

| `compressionLevel`            | PNG size | filter types emitted |
| ----------------------------- | -------- | -------------------- |
| 0 (**what this module uses**) | 3164 B   | `{0}`                |
| 6                             | 1368 B   | `{1, 4}`             |
| 9                             | 1341 B   | `{1, 4}`             |

At level 0 Bun emits filter `None` for every row. So `unfilter` cases 1–4 never execute,
and neither does any branch of `CHANNELS_BY_COLOUR_TYPE`/`toRgba` other than
`channels === 4`. Roughly half of `rgba.ts` is unreachable as wired.

I would keep the code — it is cheap insurance against exactly the Bun-encoder change that
finding 3 is about, and it is correct — but the comment must stop claiming it is
exercised. "Bun emits only filter 0 at `compressionLevel: 0`; the other four are handled
so a change of level or encoder version does not silently corrupt output" is both shorter
and true.

### 6 — One measured claim is misattributed _(the only substantively wrong statement)_

`optimize-image.ts:74-76` says `alphaQuality: 1` destroyed the alpha channel "and the file
was LARGER for it (469,036 vs 430,484 bytes)".

The first half reproduces exactly — 167 distinct alpha levels in the source collapse to
**2**, at 469,036 B. The second half does not. At matched sharp settings:

| Encode                                                           | Size          | Alpha levels |
| ---------------------------------------------------------------- | ------------- | ------------ |
| sharp, `quality: 95, alphaQuality: 1, smartSubsample, effort: 5` | 469,036 B     | 2            |
| sharp, same minus `alphaQuality` (default 100)                   | 469,**112** B | 167          |
| **`Bun.Image`, `quality: 95`**                                   | **430,484 B** | —            |

So 430,484 is `Bun.Image`'s output, not sharp's. The sentence presents a cross-engine size
difference as evidence about a sharp option; at matched settings `alphaQuality: 1` made
the file 76 bytes _smaller_ while destroying the channel. The conclusion (the option was
wrong, and it is moot now) stands — the number supporting it does not.

The same confusion is baked into the bench. `bench/image/shared/checks.mjs:231-232` says
"The production call passes `alphaQuality: 1`", but `shared/engines.mjs:77-81` omits it.
That is why the harness reports `sharp: alpha fidelity mean error 0.00/255, max 0` — the
sharp column is a sharp _without_ the defect the comment is about. It makes the quality
comparison conservative rather than flattering, which is fine, but the harness does not
reproduce the claim, and the two files contradict each other. Fix `checks.mjs`'s comment
or add the option back to the sharp engine.

### 7 — Worth reconsidering: is `rgba.ts` needed at all?

`Bun.Image` ships `.placeholder()`, which returns a ThumbHash-rendered LQIP as a
`data:image/png;base64,…` URL — same job as blurhash, ~400–700 bytes, no client-side
decoder. Adopting it would delete `utils/images/rgba.ts` entirely (~180 lines of
hand-rolled PNG decoding), the `blurhash` dependency, the alpha-compositing decision, and
finding 5 along with them.

The cost is a schema change: `files.blurhash` is `varchar(100)` and a data URL will not
fit, so it needs a `text` column and probably a rename. Normally that would kill the idea
— but there is no production data, and as noted above **nothing in this repo reads
`blurhash` yet**. There will never be a cheaper moment. Your call, not a defect; I flag it
because the review of `rgba.ts` is otherwise "this is well-built", and the better question
is whether it should exist.

---

## 4. Checked and cleared

- **EXIF/GPS retention.** sharp strips metadata by default; I could not assume `Bun.Image`
  does. Tested directly (spliced `eXIf` chunk → `optimizeImage` → output has only a
  `VP8 ` chunk, marker bytes absent). No privacy regression.
- **ICC profiles.** The Bun docs state the source ICC profile _is_ preserved through
  re-encode, where sharp strips it. I did not test this — I had no ICC-bearing fixture and
  building a valid `iCCP` chunk by hand was not worth it. Effect would be marginally larger
  objects and, if anything, better colour. **Flagging as unverified.**
- **EXIF auto-orientation.** `Bun.Image` defaults `autoOrient: true`; sharp does not
  auto-orient without `.rotate()`. Moot here — `ALLOWED_IMAGE_TYPES` is PNG/WebP/SVG, and
  neither raster format carries JPEG orientation.
- **CPU cost as a DoS surface.** The search loop still re-decodes the source on every
  iteration (up to 50), unchanged from the sharp version. Bounded in practice by the 1 MB
  per-file cap and `MAX_FILES_PER_REQUEST = 1`: the pathological input (25 MP in 82 KB)
  finishes in one iteration at 586 ms, and the densest multi-iteration case measured 1.7 s
  over 6 iterations. Not a regression, and not worth restructuring on current evidence.
- **Hostile-input loop termination** in both `isAnimatedWebp` and `decodePng`'s chunk walk:
  offsets advance monotonically, sizes are unsigned, oversized lengths exit the loop rather
  than spin. `Buffer.subarray` clamps, and the `raw.length < (stride + 1) * height` guard
  catches the resulting short read.
- **`decodePng` memory safety.** Width/height come from a PNG this module just produced at
  ≤32 px, so `Buffer.alloc(stride * height)` is bounded regardless of the original upload.
- **Reference sweep.** `optimizeImage`, `imageToRgba`, `validateMagicBytes`,
  `isAllowedImageType` and `uploadImagesToR2` have exactly the callers listed above; no
  `sharp` import survives outside `bench/`. (`server.ts:91` matches a grep for "sharp" only
  because of the word "sharper" in prose.)
- **`package.json`.** Moving `sharp` to `devDependencies` while leaving it in
  `trustedDependencies` is right for the bench. The pre-existing contradiction — `sharp`
  appears in both `ignoreScripts` and `trustedDependencies` — predates this change.

## 5. Unrelated change in the same working tree

`.gitignore` replaced `TODO.md` + `/TODO.md` with `TODO*.md`. Harmless and arguably
better, but it has nothing to do with the image pipeline and should not ride along in this
commit.
