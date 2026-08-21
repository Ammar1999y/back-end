// Fidelity measurement. "Smaller file" is only a win if the pixels survived, so
// every size number in this benchmark is paired with one of these.
//
// **sharp is the instrument, not a participant, in this file.** Both engines'
// encoded output has to be turned back into pixels to be compared, and sharp is
// the only decoder in the tree that can hand back raw RGB. That is safe in a way
// the reverse would not be: a decoder cannot flatter the encoder that produced
// its input — it decodes WebP bytes to pixels, and libwebp is the same library
// underneath both engines' encoders. Where a sharp-shaped bias IS possible, the
// scenario says so at the call site (see `resampleDelta`).

import sharp from 'sharp';

/**
 * Raw greyscale plane at native size — the comparison space for both metrics.
 *
 * Composited onto a fixed mid-grey first, and that step is load-bearing rather
 * than cosmetic. In a fully transparent region the RGB values are undefined:
 * sharp's resize premultiplies and leaves them near zero, Bun's keeps the
 * source colour. Both render identically, but comparing the raw planes scored
 * the difference at 12.5 dB — an artefact of invisible pixels, on an image that
 * looked the same. Flattening compares what a viewer would see; for an opaque
 * input it is a no-op.
 */
async function greyPlane(bytes) {
  const { data, info } = await sharp(bytes)
    .flatten({ background: '#808080' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/**
 * Peak signal-to-noise ratio in dB. Above ~40 dB is generally
 * indistinguishable; below ~30 dB is visible. `Infinity` means bit-identical.
 */
export function psnr(a, b) {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error(
      `psnr: size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`
    );
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) {
    const diff = a.data[i] - b.data[i];
    sum += diff * diff;
  }
  const mse = sum / a.data.length;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

/**
 * Mean SSIM over non-overlapping 8x8 windows, on the greyscale plane.
 *
 * Stated plainly because it matters when comparing against published figures:
 * this is NOT the reference implementation. Wang et al. use an 11x11 Gaussian
 * window with per-pixel stride; this uses a box window with stride 8, which is
 * the standard cheap approximation and is consistent between the two engines —
 * so differences between them are meaningful, while the absolute value is not
 * comparable to a paper's.
 */
export function ssim(a, b) {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error('ssim: size mismatch');
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const win = 8;
  let total = 0;
  let windows = 0;

  for (let wy = 0; wy + win <= a.height; wy += win) {
    for (let wx = 0; wx + win <= a.width; wx += win) {
      let sumA = 0;
      let sumB = 0;
      let sumAA = 0;
      let sumBB = 0;
      let sumAB = 0;
      for (let y = 0; y < win; y++) {
        for (let x = 0; x < win; x++) {
          const i = (wy + y) * a.width + wx + x;
          const va = a.data[i];
          const vb = b.data[i];
          sumA += va;
          sumB += vb;
          sumAA += va * va;
          sumBB += vb * vb;
          sumAB += va * vb;
        }
      }
      const n = win * win;
      const meanA = sumA / n;
      const meanB = sumB / n;
      const varA = sumAA / n - meanA * meanA;
      const varB = sumBB / n - meanB * meanB;
      const covAB = sumAB / n - meanA * meanB;
      total +=
        ((2 * meanA * meanB + C1) * (2 * covAB + C2)) /
        ((meanA * meanA + meanB * meanB + C1) * (varA + varB + C2));
      windows++;
    }
  }
  return windows === 0 ? Number.NaN : total / windows;
}

/**
 * Fidelity of `encoded` against `reference`, both as encoded byte buffers of
 * the same dimensions.
 */
export async function compareEncoded(referenceBytes, encodedBytes) {
  const [reference, encoded] = await Promise.all([
    greyPlane(referenceBytes),
    greyPlane(encodedBytes),
  ]);
  return { psnr: psnr(reference, encoded), ssim: ssim(reference, encoded) };
}

/**
 * How far apart the two RESAMPLERS are, with no encoder in the way: each engine
 * downscales the same source to the same width and writes it losslessly, then
 * the two results are compared to each other.
 *
 * There is no reference image here on purpose. Producing one would mean picking
 * somebody's lanczos3 as "correct" — and since the only raw-pixel resizer
 * available in this tree is sharp's, that choice would hand sharp a perfect
 * score by construction. Engine-against-engine has no such asymmetry: it says
 * how much visible difference a switch introduces, without ruling on which side
 * is nearer the ideal kernel.
 */
export async function resampleDelta(sourceBytes, width, engines) {
  const outputs = [];
  for (const engine of engines) {
    // Lossless PNG, so the delta is resampling only.
    if (engine.slug === 'sharp')
      outputs.push(await sharp(sourceBytes).resize({ width }).png().toBuffer());
    else
      outputs.push(
        await new Bun.Image(sourceBytes).resize(width).png().bytes()
      );
  }
  const planes = await Promise.all(outputs.map((bytes) => greyPlane(bytes)));
  return {
    psnr: psnr(planes[0], planes[1]),
    ssim: ssim(planes[0], planes[1]),
    dims: `${planes[0].width}x${planes[0].height}`,
  };
}
