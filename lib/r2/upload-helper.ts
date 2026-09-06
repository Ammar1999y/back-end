import { uploadMsg } from '@/app/api/upload/file/messages';
import { sanitizeForLog } from '@/utils';
import { encode } from 'blurhash';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import {
  hasRasterSignature,
  isAnimatedRaster,
  matchesMagicBytes,
} from '@/utils/images/raster-bytes';
import { imageToRgba } from '@/utils/images/rgba';
import { sanitizeSvgServer, svgOptimizerServer } from '@/utils/images/server';
import { sanitizeFilename } from '@/utils/sanitize-filename';
import { MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS } from '@/utils/validation/constants';

import { optimizeImage, shouldOptimizeImage } from './optimize-image';

/**
 * Allowed image MIME types.
 *
 * Exported so `tests/unit/upload-validation.test.ts` can walk the real list
 * instead of a copy: the property that matters is that every admitted type has a
 * magic-byte signature (or is the SVG exemption), and a hand-written list in the
 * test would keep passing for a type added here and nowhere else.
 *
 * The document types live in `lib/media/allowlist.ts`, which is also where these
 * three are listed for the upload route; this list is the IMAGE PIPELINE's own
 * statement of what it can process.
 */
export const ALLOWED_IMAGE_TYPES = [
  'image/png',
  'image/webp',
  'image/svg+xml',
] as const;

type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

export function isAllowedImageType(
  mimeType: string
): mimeType is AllowedImageType {
  return ALLOWED_IMAGE_TYPES.includes(mimeType as AllowedImageType);
}

/**
 * The stored extension, from the RESOLVED MIME type and never from `file.name`.
 *
 * Every other component of an object key is a row id; taking this one from the
 * client's string would put attacker-chosen path segments into the key.
 */
const MIME_EXTENSIONS = new Map<string, string>([
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'],
]);

/**
 * Validates file content matches its declared MIME type using magic bytes.
 * SVG is text-based and fully validated by sanitizeSvgServer.
 */
export function validateMagicBytes(
  buffer: Buffer,
  mimeType: string
): { valid: boolean; animated?: boolean } {
  // SVG validation is handled by sanitizeSvgServer
  if (mimeType === 'image/svg+xml') return { valid: true };

  if (!hasRasterSignature(mimeType)) return { valid: true };
  if (!matchesMagicBytes(buffer, mimeType)) return { valid: false };
  if (isAnimatedRaster(buffer, mimeType))
    return { valid: false, animated: true };

  return { valid: true };
}

/**
 * Blurhash from a 32px thumbnail. `imageToRgba` exists because `Bun.Image` has
 * no raw-pixel terminal and `blurhash.encode` needs RGBA — see that module.
 *
 * Raster only: an SVG never reaches here (see `processImage`).
 *
 * **Transparent pixels are composited onto white first**, and that is a decision
 * rather than a formality. `blurhash.encode` reads RGB and ignores the alpha
 * channel completely, so without this step the placeholder is computed from
 * whatever colour happens to sit underneath a fully transparent pixel — a value
 * no viewer ever sees and which the two decoders disagree about (measured:
 * sharp's resize zeroes it, `Bun.Image` keeps the source colour, and the decoded
 * placeholders differed by up to 101/255 on a transparent PNG). Compositing
 * makes the placeholder mean "what this image looks like on a light page", which
 * is where it renders, and makes it independent of the decoder.
 */
const BLURHASH_BACKGROUND = 0xff;

async function generateBlurhash(imageBuffer: Buffer): Promise<string> {
  const { width, height, rgba } = await imageToRgba(imageBuffer, 32);
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
  return encode(new Uint8ClampedArray(rgba), width, height, 4, 3);
}

/** An image after validation, optimisation and sanitisation, ready to store. */
export interface ProcessedImage {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  blurhash?: string;
  originalMimeType?: string;
  originalSize?: number;
}

export interface ValidatedSvgUpload {
  cleanedSvg: string;
  embeddedRasterMegapixels: number;
}

export interface UploadImageInput {
  file: File;
  buffer: Buffer;
  validatedSvg?: ValidatedSvgUpload;
}

export function validateSvgUpload(
  buffer: Buffer,
  fileName: string
): ValidatedSvgUpload {
  const result = sanitizeSvgServer(buffer.toString('utf8'));
  if (result.isValid)
    return {
      cleanedSvg: result.cleanedSvg,
      embeddedRasterMegapixels: result.embeddedRasterMegapixels,
    };

  console.error('SVG sanitization failed:', sanitizeForLog(result.errors));
  throw new CustomError(
    result.reason === 'animated'
      ? uploadMsg.animatedNotAllowed(sanitizeFilename(fileName))
      : result.reason === 'too-many-pixels'
        ? uploadMsg.tooManyPixels(Math.floor(MAX_IMAGE_PIXELS / 1_000_000))
        : result.reason === 'edge-too-long'
          ? uploadMsg.edgeTooLong(MAX_IMAGE_EDGE)
          : uploadMsg.invalidSvg,
    result.reason === 'too-many-pixels' || result.reason === 'edge-too-long'
      ? HTTP_STATUS.UNPROCESSABLE
      : HTTP_STATUS.BAD_REQUEST
  );
}

/**
 * Validate, optimise, sanitise and fingerprint one image.
 *
 * Pure with respect to storage: it neither writes an object nor a row. The
 * store-and-record half lives in `lib/media/upload.ts`, which is what both
 * upload routes call, so the two never diverge on what an image becomes before
 * it is kept.
 */
export async function processImage(
  input: UploadImageInput,
  targetSize: number
): Promise<ProcessedImage> {
  const { file } = input;
  if (!isAllowedImageType(file.type)) {
    throw new CustomError(
      uploadMsg.invalidMimeType(file.type),
      HTTP_STATUS.BAD_REQUEST
    );
  }

  let buffer = input.buffer;
  let finalMimeType = file.type;
  let finalSize = file.size;
  let width: number | undefined;
  let height: number | undefined;
  let blurhash: string | undefined;
  let finalExtension: string;

  if (file.type === 'image/svg+xml') {
    const sanitizeResult =
      input.validatedSvg ?? validateSvgUpload(buffer, file.name);

    const optimizedSvg = svgOptimizerServer({
      data: sanitizeResult.cleanedSvg,
    });
    buffer = Buffer.from(optimizedSvg, 'utf8');
    finalSize = buffer.length;
    finalExtension = 'svg';
    // No blurhash for SVG, deliberately. It used to be produced by rasterising
    // the markup through sharp, which was the only reason this project needed a
    // rasteriser at all. An SVG is XML: it is small, it is already sanitised and
    // minified above, and a placeholder for a file that arrives in a few
    // kilobytes buys nothing. `files.blurhash` is nullable, so consumers must
    // already tolerate its absence.
  } else if (shouldOptimizeImage(file.type)) {
    const optimized = await optimizeImage(buffer, { targetSize });

    // `optimized.buffer` is the result object's Buffer field, not a view's
    // `.buffer`, so `Buffer.from` here was a redundant copy — not the unsafe
    // conversion `unicorn/no-unsafe-buffer-conversion` reports.
    buffer = optimized.buffer;
    finalMimeType = 'image/webp';
    finalSize = optimized.size;
    width = optimized.width;
    height = optimized.height;
    blurhash = await generateBlurhash(buffer);
    finalExtension = 'webp';
  } else {
    // Image doesn't need optimization. Unreachable with the current
    // `ALLOWED_IMAGE_TYPES` — `shouldOptimizeImage` is true for every raster
    // type on the list — and kept because the list is what would change.
    blurhash = await generateBlurhash(buffer);
    const metadata = await new Bun.Image(buffer, {
      maxPixels: MAX_IMAGE_PIXELS,
    }).metadata();
    width = metadata.width;
    height = metadata.height;
    finalExtension = MIME_EXTENSIONS.get(finalMimeType) ?? 'webp';
  }

  return {
    buffer,
    mimeType: finalMimeType,
    extension: finalExtension,
    sizeBytes: finalSize,
    width,
    height,
    blurhash,
    ...(finalMimeType === 'image/webp' && {
      originalMimeType: file.type,
      originalSize: file.size,
    }),
  };
}
