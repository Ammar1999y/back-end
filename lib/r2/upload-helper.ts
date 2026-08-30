import type { BucketType } from './client';
import type { NewFile } from '@/db/schema';
import type { EntityID } from '@/types';

import { uploadMsg } from '@/app/api/upload/image/messages';
import { db } from '@/db';
import { files } from '@/db/schema';
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
import { generateShortId, sanitizeFilename } from '@/utils/sanitize-filename';
import {
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  SERVER_MAX_IMAGE_SIZE,
} from '@/utils/validation/constants';

import {
  deleteFromR2,
  getCacheControlHeader,
  getContentDisposition,
  uploadToR2,
} from './client';
import { optimizeImage, shouldOptimizeImage } from './optimize-image';

/**
 * Allowed image MIME types.
 *
 * Exported so `tests/unit/upload-validation.test.ts` can walk the real list
 * instead of a copy: the property that matters is that every admitted type has a
 * magic-byte signature (or is the SVG exemption), and a hand-written list in the
 * test would keep passing for a type added here and nowhere else.
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
 * Every other component of an R2 key is a random hex id or `sanitizeFilename`
 * output; taking this one from the client's string put attacker-chosen path
 * segments into the key — `file.name = "x.a/../../../../evil"` yields
 * `temp/<id>_x.a/../../../../evil`, escaping the `temp/` prefix.
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

// Generate R2 key for temporary files with sanitized name
function generateTempImageKey(originalName: string, extension: string): string {
  const safeName = sanitizeFilename(originalName);
  const shortId = generateShortId();
  return `temp/${shortId}_${safeName}.${extension}`;
}

// Processed image data ready for upload
type ProcessedImage = {
  buffer: Buffer;
  r2Key: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  blurhash?: string;
  originalMimeType?: string;
  originalSize?: number;
};

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

// Process a single image (validate, optimize, sanitize, generate blurhash)
async function processImage(
  input: UploadImageInput,
  targetSize: number
): Promise<ProcessedImage> {
  const { file } = input;
  // Validate MIME type
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

  // Handle SVG files
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
  }
  // Optimize raster images (PNG, WebP)
  else if (shouldOptimizeImage(file.type)) {
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
    r2Key: generateTempImageKey(file.name, finalExtension),
    mimeType: finalMimeType,
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

export async function uploadImagesToR2(params: {
  images: UploadImageInput[];
  targetSize?: number;
  bucketType?: BucketType;
  /**
   * Who uploaded these. Optional only because the column is nullable and
   * `onDelete: 'set null'` — every current caller passes it, and the retention
   * sweep in `db/maintenance.ts` needs it to say WHOSE abandoned upload it
   * removed. A temporary row with no owner is untraceable.
   */
  uploadedBy?: EntityID;
}): Promise<string[]> {
  const {
    images,
    bucketType = 'public',
    targetSize = SERVER_MAX_IMAGE_SIZE * 1024 * 1024,
    uploadedBy,
  } = params;

  let uploadedKeys: string[] = [];

  try {
    // Process all images (optimize, generate blurhash, etc.)
    const processedImages = await Promise.all(
      images.map((image) => processImage(image, targetSize))
    );

    // Pre-populate keys so cleanup always has the full list on partial failure
    uploadedKeys = processedImages.map((img) => img.r2Key);

    // Upload all to R2 in parallel
    await Promise.all(
      processedImages.map((img) =>
        uploadToR2({
          file: img.buffer,
          key: img.r2Key,
          bucketType,
          contentType: img.mimeType,
          cacheControl: getCacheControlHeader({
            mimeType: img.mimeType,
            isPublic: bucketType === 'public',
          }),
          contentDisposition: getContentDisposition({
            filename: img.r2Key.slice(img.r2Key.lastIndexOf('/') + 1),
            inline: true,
          }),
          metadata: {
            ...(img.originalMimeType &&
              img.originalSize !== undefined && {
                originalMimeType: img.originalMimeType,
                originalSize: img.originalSize.toString(),
              }),
          },
        })
      )
    );

    // Prepare database records
    const dbRecords: NewFile[] = processedImages.map((img) => ({
      r2Key: img.r2Key,
      bucketType: bucketType as 'public',
      contextTable: null,
      mimeType: img.mimeType,
      sizeBytes: img.sizeBytes,
      width: img.width,
      height: img.height,
      blurhash: img.blurhash,
      isTemporary: true,
      uploadedBy: uploadedBy ?? null,
    }));

    try {
      await db.insert(files).values(dbRecords);
    } catch (dbError) {
      // Best-effort cleanup: delete uploaded R2 objects to avoid orphans
      await Promise.allSettled(
        uploadedKeys.map((key) => deleteFromR2({ key, bucketType }))
      );
      uploadedKeys = []; // Prevent double cleanup
      throw dbError;
    }

    return processedImages.map((img) => img.r2Key);
  } catch (error) {
    // Best-effort cleanup on any failure (upload or processing)
    if (uploadedKeys.length > 0) {
      await Promise.allSettled(
        uploadedKeys.map((key) => deleteFromR2({ key, bucketType }))
      );
    }

    if (error instanceof CustomError) throw error;

    console.error(sanitizeForLog(error));
    throw new CustomError(uploadMsg.uploadFailed, HTTP_STATUS.INTERNAL_ERROR);
  }
}
