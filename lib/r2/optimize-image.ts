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
import { uploadMsg } from '@/app/api/upload/image/messages';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import {
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  SERVER_MAX_IMAGE_SIZE,
} from '@/utils/validation/constants';

const UNDECODABLE_CODES = new Set([
  'ERR_IMAGE_DECODE_FAILED',
  'ERR_IMAGE_UNKNOWN_FORMAT',
  'ERR_IMAGE_FORMAT_UNSUPPORTED',
]);

/** `Bun.Image` errors carry a `code`; nothing in the type system promises it. */
function imageErrorCode(error: unknown): string | null {
  if (!(error instanceof Error) || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function toUploadError(error: unknown): CustomError {
  if (error instanceof CustomError) return error;

  const code = imageErrorCode(error);
  if (code === 'ERR_IMAGE_TOO_MANY_PIXELS')
    return new CustomError(
      uploadMsg.tooManyPixels(Math.floor(MAX_IMAGE_PIXELS / 1_000_000)),
      HTTP_STATUS.UNPROCESSABLE
    );
  if (code !== null && UNDECODABLE_CODES.has(code))
    return new CustomError(uploadMsg.undecodable, HTTP_STATUS.UNPROCESSABLE);
  // The dimension guard below refuses this before the encoder is reached; this
  // is the backstop for a limit the guard does not yet know about. Still a
  // rejection of the input, so still 422 rather than a server fault.
  if (code === 'ERR_IMAGE_ENCODE_FAILED')
    return new CustomError(
      uploadMsg.edgeTooLong(MAX_IMAGE_EDGE),
      HTTP_STATUS.UNPROCESSABLE
    );

  return new CustomError(uploadMsg.uploadFailed, HTTP_STATUS.INTERNAL_ERROR);
}

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

/**
 * A ceiling on the ladder, independent of the option validation below. The
 * default ladder is 32 rungs; this stops a future edit to the walk itself from
 * spinning.
 */
const MAX_LADDER_RUNGS = 128;
const MAX_ENCODE_ATTEMPTS = 16;

interface Rung {
  width: number;
  quality: number;
}

/**
 * Every numeric option, checked before it can drive a loop.
 *
 * `buildLadder`'s two `while`s advance by `qualityStep` / `widthStep`. A step of
 * `0` — or negative, or `NaN` — never reaches the floor, so the loop spins
 * forever SYNCHRONOUSLY, before the first `await`, taking the event loop with
 * it. `OptimizeImageOptions` is exported, so that is reachable from a future
 * caller rather than hypothetical.
 */
function assertLadderOptions(opts: {
  startWidth: number;
  initialQuality: number;
  minQuality: number;
  qualityStep: number;
  minWidth: number;
  widthStep: number;
}): void {
  for (const [name, value] of Object.entries(opts))
    if (!Number.isFinite(value) || value <= 0)
      throw new CustomError(
        `optimizeImage: ${name} must be a positive finite number`,
        HTTP_STATUS.INTERNAL_ERROR
      );
}

function buildLadder(opts: {
  startWidth: number;
  initialQuality: number;
  minQuality: number;
  qualityStep: number;
  minWidth: number;
  widthStep: number;
}): Rung[] {
  assertLadderOptions(opts);

  const rungs: Rung[] = [];
  let quality = opts.initialQuality;
  rungs.push({ width: opts.startWidth, quality });
  while (quality > opts.minQuality && rungs.length < MAX_LADDER_RUNGS) {
    quality = Math.max(quality - opts.qualityStep, opts.minQuality);
    rungs.push({ width: opts.startWidth, quality });
  }
  let width = opts.startWidth;
  while (width > opts.minWidth && rungs.length < MAX_LADDER_RUNGS) {
    width = Math.max(width - opts.widthStep, opts.minWidth);
    rungs.push({ width, quality: opts.minQuality });
  }
  return rungs;
}

async function optimizeImageWithinSlot(
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

  try {
    const metadata = await new Bun.Image(input, {
      maxPixels: MAX_IMAGE_PIXELS,
    }).metadata();
    // From the header, before any pixel work. `MAX_IMAGE_PIXELS` bounds AREA and
    // says nothing about a single side, so an image well inside it can still be
    // one the output format cannot hold.
    if (metadata.width > MAX_IMAGE_EDGE || metadata.height > MAX_IMAGE_EDGE)
      throw new CustomError(
        uploadMsg.edgeTooLong(MAX_IMAGE_EDGE),
        HTTP_STATUS.UNPROCESSABLE
      );

    const originalWidth = metadata.width || initialWidth;
    const originalHeight = metadata.height || initialWidth;
    const longestEdgeWidth = Math.max(
      1,
      Math.floor((originalWidth * initialWidth) / originalHeight)
    );
    const startWidth = Math.min(originalWidth, initialWidth, longestEdgeWidth);

    const ladder = buildLadder({
      startWidth,
      initialQuality,
      minQuality,
      qualityStep,
      minWidth: Math.min(minWidth, startWidth),
      widthStep,
    });

    let iterations = 0;
    const measure = async (index: number) => {
      if (iterations >= MAX_ENCODE_ATTEMPTS)
        throw new CustomError(
          uploadMsg.targetUnreachable,
          HTTP_STATUS.UNPROCESSABLE
        );
      iterations++;
      const rung = ladder[index];
      if (!rung) throw new Error('ladder index out of range');
      return encodeAttempt(input, rung.width, rung.quality);
    };

    const firstAttempt = await measure(0);
    let fitting = firstAttempt.size <= targetSize ? firstAttempt : null;
    let lastMeasured = firstAttempt;

    if (!fitting) {
      let lo = 1;
      let hi = ladder.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const attempt = await measure(mid);
        lastMeasured = attempt;
        if (attempt.size <= targetSize) {
          fitting = attempt;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
    }

    if (!fitting) {
      console.warn(
        JSON.stringify({
          msg: 'image.optimize target unreachable',
          finalBytes: lastMeasured.size,
          targetBytes: targetSize,
          iterations,
        })
      );
      throw new CustomError(
        uploadMsg.targetUnreachable,
        HTTP_STATUS.UNPROCESSABLE
      );
    }

    const chosen = fitting;
    return {
      buffer: chosen.buffer,
      width: chosen.width,
      height: chosen.height,
      size: chosen.size,
      format: 'webp',
      iterations,
    };
  } catch (error) {
    if (error instanceof CustomError) throw error;
    throw toUploadError(error);
  }
}

const IMAGE_ENCODER_QUEUE_LIMIT = 4;
const encoderAdmission = {
  active: false,
  waiters: [] as Array<() => void>,
};

async function acquireEncoder(): Promise<() => void> {
  if (encoderAdmission.active) {
    if (encoderAdmission.waiters.length >= IMAGE_ENCODER_QUEUE_LIMIT)
      throw new CustomError(
        uploadMsg.processingBusy,
        HTTP_STATUS.SERVICE_UNAVAILABLE
      );
    await new Promise<void>((resolve) => {
      encoderAdmission.waiters.push(resolve);
    });
  }
  encoderAdmission.active = true;
  return () => {
    const next = encoderAdmission.waiters.shift();
    if (next) next();
    else encoderAdmission.active = false;
  };
}

export async function optimizeImage(
  input: Buffer,
  options: OptimizeImageOptions = {}
): Promise<OptimizeImageResult> {
  const release = await acquireEncoder();
  try {
    return await optimizeImageWithinSlot(input, options);
  } finally {
    release();
  }
}

export const shouldOptimizeImage = (mimeType: string) =>
  mimeType.startsWith('image/') &&
  !(mimeType === 'image/svg+xml' || mimeType === 'image/gif');
