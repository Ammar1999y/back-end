/**
 * WebP re-encoding, sized down until it fits a byte target.
 *
 * Runs on `Bun.Image` rather than `sharp` since 2026-08-21. The measurement
 * behind that is `bench/image/`: 1.8x-3.7x faster on this exact loop, ~65% less
 * resident memory on an ordinary upload, no native addon to load (83 ms and
 * 17 MiB per process), and output quality indistinguishable — PSNR within half a
 * decibel either way at matched settings, and a wash once the size target
 * constrains both.
 *
 * Two things the switch cost, both decided rather than discovered:
 *
 * - **`smartSubsample` and `effort` are gone**; `Bun.Image.webp()` takes only
 *   `quality` and `lossless`. So the search lands on slightly different sizes
 *   per step, which changes the iteration count, not the contract.
 * - **`Bun.Image` cannot decode SVG or animated WebP.** Neither reaches this
 *   function: `shouldOptimizeImage` excludes SVG, and `validateMagicBytes`
 *   rejects animated WebP at the door.
 */
import {
  MAX_IMAGE_PIXELS,
  SERVER_MAX_IMAGE_SIZE,
} from '@/utils/validation/constants';

export type OptimizeImageOptions = {
  /**
   * Target file size in bytes
   * Default: `SERVER_MAX_IMAGE_SIZE` MB
   */
  targetSize?: number;

  /**
   * Initial quality (1-100)
   * Default: 95
   */
  initialQuality?: number;

  /**
   * Minimum quality before reducing dimensions (1-100)
   * Default: 50
   */
  minQuality?: number;

  /**
   * Initial max width (pixels)
   * Default: 3048
   */
  initialWidth?: number;

  /**
   * Minimum width (pixels)
   * Default: 800
   */
  minWidth?: number;

  /**
   * Quality reduction step
   * Default: 5
   */
  qualityStep?: number;

  /**
   * Width reduction step (pixels)
   * Default: 100
   */
  widthStep?: number;
};

/**
 * One encode attempt. Single definition on purpose: the two call sites below
 * used to hold copies of the same option literal, and both copies contained
 * `alphaQuality: 1` — the WORST value on sharp's 0-100 alpha scale rather than
 * an "on" flag. Measured on a 1200x900 PNG carrying 167 distinct alpha levels:
 * the channel came back with 2, a pixel at alpha 127 decoded as 0, and the file
 * was LARGER for it (469,036 vs 430,484 bytes). The option does not exist on
 * `Bun.Image` at all, so the defect is gone twice over — but the shape stays,
 * because it is what stopped the two sites from drifting apart.
 */
async function encodeAttempt(input: Buffer, width: number, quality: number) {
  const image = new Bun.Image(input, { maxPixels: MAX_IMAGE_PIXELS })
    // Height omitted keeps the aspect ratio; `withoutEnlargement` is what stops
    // a 64px avatar being blown up to `initialWidth` and re-encoded.
    .resize(width, undefined, { withoutEnlargement: true })
    .webp({ quality });
  const buffer = await image.buffer();
  // `image.width`/`height` are -1 until a terminal resolves, so they are read
  // after the await, never before.
  return {
    buffer,
    size: buffer.length,
    width: image.width,
    height: image.height,
  };
}

export type OptimizeImageResult = {
  buffer: Buffer;
  width: number;
  height: number;
  size: number;
  format: 'webp';
  iterations: number;
};

export async function optimizeImage(
  input: Buffer,
  options: OptimizeImageOptions = {}
): Promise<OptimizeImageResult> {
  const {
    targetSize = SERVER_MAX_IMAGE_SIZE * 1024 * 1024,
    initialQuality = 95,
    minQuality = 50,
    initialWidth = 3048,
    minWidth = 800,
    qualityStep = 5,
    widthStep = 100,
  } = options;

  // Header-only read, so a small file declaring a huge canvas is refused before
  // any pixel buffer is allocated (`ERR_IMAGE_TOO_MANY_PIXELS`).
  const metadata = await new Bun.Image(input, {
    maxPixels: MAX_IMAGE_PIXELS,
  }).metadata();
  const originalWidth = metadata.width || initialWidth;

  let currentQuality = initialQuality;
  let currentWidth = Math.min(originalWidth, initialWidth);
  let iterations = 0;

  let attempt = await encodeAttempt(input, currentWidth, currentQuality);
  iterations++;

  // If already under target, return immediately
  if (attempt.size <= targetSize) {
    return {
      buffer: attempt.buffer,
      width: attempt.width,
      height: attempt.height,
      size: attempt.size,
      format: 'webp',
      iterations,
    };
  }

  let reduceQuality = true;

  while (attempt.size > targetSize && iterations < 50) {
    if (reduceQuality) {
      if (currentQuality > minQuality)
        currentQuality = Math.max(currentQuality - qualityStep, minQuality);
      else {
        reduceQuality = false;
        continue;
      }
    } else {
      if (currentWidth > minWidth) {
        currentWidth = Math.max(currentWidth - widthStep, minWidth);
      } else {
        console.warn(
          `[Image Optimization] Could not reach target size. Final: ${attempt.size} bytes, Target: ${targetSize} bytes`
        );
        break;
      }

      // After width reduction, try quality again
      reduceQuality = true;
    }

    attempt = await encodeAttempt(input, currentWidth, currentQuality);
    iterations++;

    if (attempt.size <= targetSize) break;
  }

  return {
    buffer: attempt.buffer,
    width: attempt.width,
    height: attempt.height,
    size: attempt.size,
    format: 'webp',
    iterations,
  };
}

export const shouldOptimizeImage = (mimeType: string) =>
  mimeType.startsWith('image/') &&
  !(mimeType === 'image/svg+xml' || mimeType === 'image/gif');
