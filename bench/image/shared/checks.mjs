// Correctness, capability and hostile-input assertions. Same contract as
// bench/sqlite's correctness.mjs and bench/uuid's checks.mjs: every check
// returns `{ name, pass, detail, critical }`, a failing critical check fails the
// run with a non-zero exit code, and a check that carries no verdict is marked
// non-critical and prints as INFO.
//
// **A failing critical check here is the answer, not a bug in the harness.**
// This benchmark exists to decide whether `sharp` can be replaced. If a
// capability the upload path depends on is missing, the run says so by failing —
// the same way bench/uuid failed while `Bun.randomUUIDv7` broke id ordering.
//
// "Fast and wrong is disqualified" applies twice as hard here, because the
// wrongness is silent: a dropped alpha channel, a flattened animation or a
// blurhash computed from the wrong pixels all produce a perfectly valid upload
// with the wrong content.

import sharp from 'sharp';

import { MAX_IMAGE_PIXELS } from '@/utils/validation/constants';

import { compareEncoded } from './quality.mjs';

function check(name, pass, detail, critical = true) {
  return { name, pass, detail, critical };
}

/** Error identity as the calling code would see it. */
function describeError(error) {
  if (!error) return 'no error';
  const code = error.code ?? error.name ?? 'Error';
  return `${code}: ${String(error.message ?? '').slice(0, 70)}`;
}

async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

// --------------------------------------------------------------- capabilities

/**
 * The three things the app asks of its image library that `Bun.Image` may not
 * be able to do at all. Measured rather than read off the type definitions,
 * because "the method is missing" and "the pipeline fails" are different claims
 * and only the second one blocks a switch.
 */
export async function capabilityChecks(engines, corpus, svgBytes) {
  const results = [];
  const photo = corpus.find((c) => c.name === 'photo-1600x1200.png');

  // 1. SVG rasterisation. **No longer required** — recorded 2026-08-21 with the
  //    switch to `Bun.Image`: an SVG is XML, it arrives in a few kilobytes and it
  //    is already sanitised and minified, so `processImage` stores it without a
  //    blurhash and never hands it to a decoder. Kept as a reported measurement
  //    rather than deleted, because it is the one capability difference between
  //    the two libraries that a future feature (server-side SVG rasterisation)
  //    would run straight back into.
  for (const engine of engines) {
    const outcome = await attempt(() => engine.blurhash(svgBytes));
    results.push(
      check(
        `${engine.name}: can rasterise SVG (not required since 2026-08-21)`,
        true,
        outcome.ok
          ? `yes — hash ${outcome.value.hash}`
          : `no — ${describeError(outcome.error)}`,
        false
      )
    );
  }

  // 2. Raw pixels for blurhash. sharp does it natively; Bun has no raw
  //    terminal, so the bench's PNG round-trip stands in. Either way the
  //    question is whether the resulting hash matches.
  const hashes = {};
  for (const engine of engines) {
    const outcome = await attempt(() => engine.blurhash(photo.bytes));
    if (outcome.ok) hashes[engine.slug] = outcome.value;
    results.push(
      check(
        `${engine.name}: 32px RGBA pixels reachable for blurhash.encode`,
        outcome.ok,
        outcome.ok
          ? `${outcome.value.pixels.width}x${outcome.value.pixels.height} RGBA` +
              (outcome.value.intermediateBytes
                ? ` via a ${outcome.value.intermediateBytes} B lossless PNG round-trip (no raw terminal exists)`
                : ' natively')
          : describeError(outcome.error)
      )
    );
  }

  if (hashes.sharp && hashes.bun) {
    const a = hashes.sharp.pixels.rgba;
    const b = hashes.bun.pixels.rgba;
    let sum = 0;
    let max = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const diff = Math.abs(a[i] - b[i]);
      sum += diff;
      if (diff > max) max = diff;
    }
    const meanDiff = sum / Math.min(a.length, b.length);
    // The hash strings are allowed to differ: two lanczos3 implementations
    // round differently, and blurhash quantises to 83 buckets per component.
    // What must hold is that the 32px inputs are the same picture — a mean
    // channel difference of a couple of levels out of 255.
    results.push(
      check(
        'blurhash inputs agree between engines (mean channel difference <= 3/255)',
        meanDiff <= 3,
        `mean ${meanDiff.toFixed(2)}, max ${max}; hashes ${
          hashes.sharp.hash === hashes.bun.hash ? 'identical' : 'differ'
        } (sharp ${hashes.sharp.hash}, bun ${hashes.bun.hash})`
      )
    );
  }

  return results;
}

// ------------------------------------------------------------------- pipelines

/** Metadata agreement across every corpus entry, including the PNG variants. */
export async function metadataChecks(engines, corpus) {
  const results = [];
  for (const entry of corpus) {
    const seen = [];
    for (const engine of engines) {
      const outcome = await attempt(() => engine.metadata(entry.bytes));
      seen.push({
        engine: engine.name,
        text: outcome.ok
          ? `${outcome.value.width}x${outcome.value.height} ${outcome.value.format}`
          : describeError(outcome.error),
        ok: outcome.ok,
      });
    }
    const agree = new Set(seen.map((s) => s.text)).size === 1;
    results.push(
      check(
        `metadata agrees on ${entry.label}`,
        agree,
        seen.map((s) => `${s.engine}: ${s.text}`).join(' | ')
      )
    );
  }
  return results;
}

/**
 * The invariants `processImage` depends on, asserted against the real optimize
 * pipeline output rather than against a single encode call.
 */
export async function optimizeChecks(engines, corpus, targetSize) {
  const results = [];
  for (const entry of corpus) {
    const outputs = [];
    for (const engine of engines) {
      const outcome = await attempt(() =>
        engine.optimize(entry.bytes, { targetSize })
      );
      outputs.push({ engine, outcome });
    }

    for (const { engine, outcome } of outputs) {
      if (!outcome.ok) {
        results.push(
          check(
            `${engine.name}: optimize succeeds on ${entry.label}`,
            false,
            describeError(outcome.error)
          )
        );
        continue;
      }
      const result = outcome.value;
      const source = await sharp(entry.bytes, {
        limitInputPixels: MAX_IMAGE_PIXELS,
      }).metadata();

      // Never upscale: `withoutEnlargement` is what stops a 64px avatar being
      // blown up to 3048px and re-encoded.
      results.push(
        check(
          `${engine.name}: never upscales ${entry.label}`,
          result.width <= source.width,
          `source ${source.width}px -> output ${result.width}px`
        )
      );
      // The declared output contract of `optimizeImage`.
      results.push(
        check(
          `${engine.name}: reports webp + real dimensions on ${entry.label}`,
          result.format === 'webp' &&
            Number.isInteger(result.width) &&
            result.width > 0 &&
            Number.isInteger(result.height) &&
            result.height > 0 &&
            result.size === result.buffer.length,
          `format=${result.format} ${result.width}x${result.height} size=${result.size} buffer=${result.buffer.length}`
        )
      );
    }

    // Both must land on the same decision about whether the target was
    // reachable; a difference there is a behaviour change users would see.
    if (outputs.every((o) => o.outcome.ok)) {
      const met = outputs.map((o) => o.outcome.value.size <= targetSize);
      results.push(
        check(
          `both engines agree the ${targetSize} B target is reachable for ${entry.label}`,
          new Set(met).size === 1,
          outputs
            .map(
              (o) =>
                `${o.engine.name}: ${o.outcome.value.size} B in ${o.outcome.value.iterations} it`
            )
            .join(' | ')
        )
      );
    }
  }
  return results;
}

/**
 * Alpha survival, and alpha FIDELITY — separate properties. The production call
 * passes `alphaQuality: 1`, the most aggressive setting sharp has, and
 * `Bun.Image` has no equivalent knob, so the alpha channel is the one place a
 * switch could visibly improve or degrade output without changing any code.
 */
export async function alphaChecks(engines, alphaEntry, targetSize) {
  const results = [];
  const reference = await sharp(alphaEntry.bytes)
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (const engine of engines) {
    const outcome = await attempt(() =>
      engine.optimize(alphaEntry.bytes, { targetSize })
    );
    if (!outcome.ok) {
      results.push(
        check(
          `${engine.name}: alpha image survives optimize`,
          false,
          describeError(outcome.error)
        )
      );
      continue;
    }
    const meta = await sharp(outcome.value.buffer).metadata();
    results.push(
      check(
        `${engine.name}: alpha channel preserved through webp encode`,
        Boolean(meta.hasAlpha),
        `channels=${meta.channels} hasAlpha=${meta.hasAlpha} ${outcome.value.size} B`
      )
    );

    if (meta.hasAlpha) {
      const out = await sharp(outcome.value.buffer)
        .resize(reference.info.width, reference.info.height)
        .ensureAlpha()
        .extractChannel(3)
        .raw()
        .toBuffer({ resolveWithObject: true });
      let sum = 0;
      let max = 0;
      for (let i = 0; i < reference.data.length; i++) {
        const diff = Math.abs(reference.data[i] - out.data[i]);
        sum += diff;
        if (diff > max) max = diff;
      }
      results.push(
        check(
          `${engine.name}: alpha fidelity (reported)`,
          true,
          `mean error ${(sum / reference.data.length).toFixed(2)}/255, max ${max}`,
          false
        )
      );
    }
  }
  return results;
}

// -------------------------------------------------------------- hostile inputs

/**
 * Every input the route can be handed that is not a well-formed raster image.
 * The assertion is not "it throws" but "it refuses cheaply and identifiably":
 * a decompression bomb that is rejected after a 100 MB allocation is a denial
 * of service that returns a 400.
 */
export async function hostileChecks(engines, inputs, targetSize) {
  const results = [];
  for (const input of inputs) {
    for (const engine of engines) {
      const rssBefore = process.memoryUsage.rss();
      const started = Bun.nanoseconds();
      const probe = await attempt(() => engine.metadata(input.bytes));
      const ms = (Bun.nanoseconds() - started) / 1e6;
      const rssDelta = process.memoryUsage.rss() - rssBefore;

      if (input.expect === 'reject') {
        // Asserted against the FULL pipeline, not the metadata probe. A
        // truncated file has an intact header, so `metadata()` legitimately
        // succeeds on it — an earlier revision of this check tested the probe
        // and reported both libraries as accepting a 512-byte fragment, which
        // was the check being wrong rather than the libraries. What must hold
        // is that nothing reaches R2.
        const pipeline = await attempt(() =>
          engine.optimize(input.bytes, { targetSize })
        );
        results.push(
          check(
            `${engine.name}: refuses ${input.label}`,
            !pipeline.ok,
            pipeline.ok
              ? `ACCEPTED — produced ${pipeline.value.size} B of webp`
              : `${describeError(pipeline.error)}` +
                  (probe.ok
                    ? ` (header alone parsed as ${probe.value.width}x${probe.value.height})`
                    : '')
          )
        );
        // A header lie must be refused FROM THE HEADER, so the cost has to stay
        // near zero rather than merely finite — this is the decompression-bomb
        // property, and it is the probe that has to be cheap.
        if (input.name === 'header-lie')
          results.push(
            check(
              `${engine.name}: refuses the 3.6-gigapixel header without allocating`,
              !probe.ok && ms < 50 && rssDelta < 32 * 1024 * 1024,
              `${describeError(probe.error)} in ${ms.toFixed(1)} ms, RSS +${(rssDelta / 1024 / 1024).toFixed(1)} MiB`
            )
          );
      } else {
        const detail = probe.ok
          ? `${probe.value.width}x${probe.value.height} ${probe.value.format} in ${ms.toFixed(1)} ms`
          : describeError(probe.error);
        results.push(
          input.expect === 'report'
            ? check(`${engine.name}: reads ${input.label}`, true, detail, false)
            : check(`${engine.name}: decodes ${input.label}`, probe.ok, detail)
        );
      }
    }
  }
  return results;
}

/**
 * The over-cap image: `MAX_IMAGE_PIXELS` is the only defence against a small
 * file that decodes to gigabytes, and it is configured through a differently
 * named option in each library (`limitInputPixels` vs `maxPixels`), so a switch
 * that forgets it looks identical until someone uploads one.
 */
export async function pixelCapChecks(engines, overCapEntry, atCapEntry) {
  const results = [];
  for (const engine of engines) {
    const over = await attempt(() => engine.metadata(overCapEntry.bytes));
    results.push(
      check(
        `${engine.name}: refuses ${overCapEntry.label} (over MAX_IMAGE_PIXELS)`,
        !over.ok,
        over.ok
          ? `ACCEPTED ${over.value.width}x${over.value.height}`
          : describeError(over.error)
      )
    );
    const at = await attempt(() => engine.metadata(atCapEntry.bytes));
    results.push(
      check(
        `${engine.name}: admits ${atCapEntry.label} (exactly at the cap)`,
        at.ok,
        at.ok ? `${at.value.width}x${at.value.height}` : describeError(at.error)
      )
    );
  }
  return results;
}

/**
 * Behaviour differences that are neither a crash nor a slowdown: what comes out
 * the other side is a different file than it used to be.
 */
export async function behaviourChecks(engines, inputs, targetSize) {
  const results = [];

  const animated = inputs.find((i) => i.name === 'animated-webp');
  if (animated) {
    const pages = await sharp(animated.bytes, { animated: true }).metadata();
    results.push(
      check(
        'the animated WebP fixture really is animated',
        pages.pages > 1,
        `libvips reads ${pages.pages} pages, ${pages.width}x${pages.height}`
      )
    );
    // Reported, not asserted, since 2026-08-21: animated uploads are not a
    // feature of this application and `validateMagicBytes` now rejects them from
    // the WebP `VP8X` animation flag, before any decoder runs. So neither
    // answer here is a failure — sharp's "flattened to frame 1" was the silent
    // behaviour the rejection replaced.
    for (const engine of engines) {
      const outcome = await attempt(() =>
        engine.optimize(animated.bytes, { targetSize })
      );
      results.push(
        check(
          `${engine.name}: decodes an animated WebP (rejected upstream since 2026-08-21)`,
          true,
          outcome.ok
            ? `yes — ${outcome.value.width}x${outcome.value.height}, ${outcome.value.size} B, flattened to the first frame`
            : `no — ${describeError(outcome.error)}`,
          false
        )
      );
    }
  }

  const icc = inputs.find((i) => i.name === 'icc-p3');
  if (icc) {
    for (const engine of engines) {
      const outcome = await attempt(() =>
        engine.optimize(icc.bytes, { targetSize })
      );
      if (!outcome.ok) {
        results.push(
          check(
            `${engine.name}: processes a P3-tagged PNG`,
            false,
            describeError(outcome.error)
          )
        );
        continue;
      }
      const meta = await sharp(outcome.value.buffer).metadata();
      // Reported, not asserted: keeping the profile is arguably the better
      // behaviour (no colour shift on wide-gamut screens) and it also makes
      // every output a little larger. It is a change either way, and the sizes
      // in the perf tables include it.
      results.push(
        check(
          `${engine.name}: ICC profile handling (reported)`,
          true,
          `${meta.icc ? 'PRESERVED' : 'stripped'}, output ${outcome.value.size} B`,
          false
        )
      );
    }
  }

  return results;
}

/** Fidelity of each engine's real pipeline output against the source pixels. */
export async function pipelineFidelity(engines, entry, targetSize) {
  const rows = [];
  for (const engine of engines) {
    const outcome = await attempt(() =>
      engine.optimize(entry.bytes, { targetSize })
    );
    if (!outcome.ok) {
      rows.push({ engine: engine.name, error: describeError(outcome.error) });
      continue;
    }
    const result = outcome.value;
    // Compare in the OUTPUT geometry: the source is downscaled to the same
    // dimensions with one resampler for both, so the comparison isolates the
    // encoder. That resampler is sharp's, which is a bias worth naming — it is
    // why resampleDelta() exists as a separate, reference-free measurement.
    const reference = await sharp(entry.bytes, {
      limitInputPixels: MAX_IMAGE_PIXELS,
    })
      .resize({ width: result.width, height: result.height, fit: 'fill' })
      .png()
      .toBuffer();
    const fidelity = await compareEncoded(reference, result.buffer);
    rows.push({
      engine: engine.name,
      size: result.size,
      dims: `${result.width}x${result.height}`,
      iterations: result.iterations,
      psnr: fidelity.psnr,
      ssim: fidelity.ssim,
    });
  }
  return rows;
}
