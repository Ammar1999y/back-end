// The two implementations under test, expressed as the THREE pipelines this
// application actually runs. Nothing else is measured: no rotate, no crop, no
// format this route cannot accept.
//
// | Pipeline   | Where it lives in the app                                     |
// | ---------- | ------------------------------------------------------------- |
// | `metadata` | `optimize-image.ts`, `upload-helper.ts`                        |
// | `optimize` | `optimize-image.ts` — the resize/encode search loop            |
// | `blurhash` | `upload-helper.ts` + `utils/images/rgba.ts` — 32px RGBA in     |
//
// **One side of every pipeline is the production code itself, and since
// 2026-08-21 that side is `Bun.Image`.** `optimize` imports the real
// `optimizeImage`; `blurhash` imports the real `imageToRgba` and repeats the
// compositing step `generateBlurhash` performs. The sharp side is now the bench's
// own copy of what production used to be — kept because a comparison needs two
// implementations, and marked so nobody reads it as shipped code.
//
// That direction was reversed when the migration landed, and it had to be: while
// `optimize` still imported the production function for the *sharp* engine, both
// columns of this benchmark were running `Bun.Image` and reporting it as a
// comparison. If the app ever moves back, move `optimizeIsProduction` with it.

import { encode as blurhashEncode } from 'blurhash';
import sharp from 'sharp';
import { optimizeImage as productionOptimizeImage } from '@/lib/r2/optimize-image';

import { imageToRgba } from '@/utils/images/rgba';
import { MAX_IMAGE_PIXELS } from '@/utils/validation/constants';

/** Mirrors `optimize-image.ts`'s defaults; both engines read the same ladder. */
export const OPTIMIZE_DEFAULTS = {
  initialQuality: 95,
  minQuality: 50,
  initialWidth: 3048,
  minWidth: 800,
  qualityStep: 5,
  widthStep: 100,
  maxIterations: 50,
};

const BLURHASH_COMPONENTS = { x: 4, y: 3 };
const BLURHASH_BACKGROUND = 0xff;

/**
 * The compositing step `upload-helper.ts`'s `generateBlurhash` performs before
 * encoding: `blurhash.encode` ignores the alpha channel, so a transparent
 * pixel's RGB would otherwise decide the placeholder — a value no viewer sees
 * and which the two decoders disagree about. Applied to both engines here, or
 * the hash comparison would be measuring that disagreement instead of the
 * resamplers.
 */
function flattenOntoWhite(rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3] ?? 0xff;
    if (alpha === 0xff) continue;
    for (let channel = 0; channel < 3; channel++) {
      const value = rgba[i + channel] ?? 0;
      rgba[i + channel] =
        (value * alpha + BLURHASH_BACKGROUND * (0xff - alpha)) / 0xff;
    }
    rgba[i + 3] = 0xff;
  }
  return rgba;
}

// ---------------------------------------------------------------- sharp engine
// The bench's copy of the pre-2026-08-21 production pipeline. NOT shipped code.

async function sharpMetadata(bytes) {
  const meta = await sharp(bytes, {
    limitInputPixels: MAX_IMAGE_PIXELS,
  }).metadata();
  return { width: meta.width, height: meta.height, format: meta.format };
}

/** `smartSubsample` and `effort` have no `Bun.Image` equivalent — see §3. */
const sharpWebpOptions = (quality) => ({
  quality,
  smartSubsample: true,
  effort: 5,
});

async function sharpEncodeOnce(bytes, { width, quality }) {
  const out = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS })
    .resize({ width, withoutEnlargement: true })
    .webp(sharpWebpOptions(quality))
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: out.data,
    size: out.info.size,
    width: out.info.width,
    height: out.info.height,
  };
}

/** Same search as `optimizeImage`, on sharp. */
async function sharpOptimizeImage(input, options = {}) {
  const {
    targetSize,
    initialQuality = OPTIMIZE_DEFAULTS.initialQuality,
    minQuality = OPTIMIZE_DEFAULTS.minQuality,
    initialWidth = OPTIMIZE_DEFAULTS.initialWidth,
    minWidth = OPTIMIZE_DEFAULTS.minWidth,
    qualityStep = OPTIMIZE_DEFAULTS.qualityStep,
    widthStep = OPTIMIZE_DEFAULTS.widthStep,
  } = options;

  const meta = await sharpMetadata(input);
  let quality = initialQuality;
  let width = Math.min(meta.width || initialWidth, initialWidth);
  let iterations = 0;

  let attempt = await sharpEncodeOnce(input, { width, quality });
  iterations++;
  if (attempt.size <= targetSize) return { ...toResult(attempt), iterations };

  let reduceQuality = true;
  while (
    attempt.size > targetSize &&
    iterations < OPTIMIZE_DEFAULTS.maxIterations
  ) {
    if (reduceQuality) {
      if (quality > minQuality)
        quality = Math.max(quality - qualityStep, minQuality);
      else {
        reduceQuality = false;
        continue;
      }
    } else {
      if (width > minWidth) width = Math.max(width - widthStep, minWidth);
      else break;
      reduceQuality = true;
    }
    attempt = await sharpEncodeOnce(input, { width, quality });
    iterations++;
    if (attempt.size <= targetSize) break;
  }
  return { ...toResult(attempt), iterations };
}

function toResult(attempt) {
  return {
    buffer: attempt.bytes,
    width: attempt.width,
    height: attempt.height,
    size: attempt.size,
    format: 'webp',
  };
}

async function sharpBlurhash(bytes) {
  const { data, info } = await sharp(bytes, {
    limitInputPixels: MAX_IMAGE_PIXELS,
  })
    .resize(32, 32, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = flattenOntoWhite(data);
  return {
    hash: blurhashEncode(
      new Uint8ClampedArray(rgba),
      info.width,
      info.height,
      BLURHASH_COMPONENTS.x,
      BLURHASH_COMPONENTS.y
    ),
    pixels: { width: info.width, height: info.height, rgba },
  };
}

// ------------------------------------------------------------------ bun engine
// This side IS production.

async function bunMetadata(bytes) {
  const meta = await new Bun.Image(bytes, {
    maxPixels: MAX_IMAGE_PIXELS,
  }).metadata();
  return { width: meta.width, height: meta.height, format: meta.format };
}

async function bunEncodeOnce(bytes, { width, quality }) {
  const image = new Bun.Image(bytes, { maxPixels: MAX_IMAGE_PIXELS })
    .resize(width, undefined, { withoutEnlargement: true })
    .webp({ quality });
  const out = await image.buffer();
  return {
    bytes: out,
    size: out.length,
    width: image.width,
    height: image.height,
  };
}

async function bunBlurhash(bytes) {
  const { width, height, rgba } = await imageToRgba(bytes, 32);
  const flattened = flattenOntoWhite(rgba);
  return {
    hash: blurhashEncode(
      new Uint8ClampedArray(flattened),
      width,
      height,
      BLURHASH_COMPONENTS.x,
      BLURHASH_COMPONENTS.y
    ),
    pixels: { width, height, rgba: flattened },
  };
}

export const ENGINES = [
  {
    name: 'sharp',
    slug: 'sharp',
    version: sharp.versions?.sharp ?? 'unknown',
    libvips: sharp.versions?.vips ?? 'unknown',
    metadata: sharpMetadata,
    encodeOnce: sharpEncodeOnce,
    optimize: sharpOptimizeImage,
    blurhash: sharpBlurhash,
    /** Whether this engine's `optimize` is the application's own function. */
    optimizeIsProduction: false,
  },
  {
    name: 'Bun.Image',
    slug: 'bun',
    version: Bun.version,
    libvips: `backend=${Bun.Image.backend}`,
    metadata: bunMetadata,
    encodeOnce: bunEncodeOnce,
    optimize: (input, options) => productionOptimizeImage(input, options),
    blurhash: bunBlurhash,
    optimizeIsProduction: true,
  },
];
