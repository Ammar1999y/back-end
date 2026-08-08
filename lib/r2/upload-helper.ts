import type { BucketType } from './client';
import type { NewFile } from '@/db/schema';

import { uploadMsg } from '@/app/api/upload/image/messages';
import { db } from '@/db';
import { files } from '@/db/schema';
import { sanitizeForLog } from '@/utils';
import { encode } from 'blurhash';
import sharp from 'sharp';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import { generateShortId, sanitizeFilename } from '@/utils/sanitize-filename';
import { sanitizeSvgServer, svgOptimizerServer } from '@/utils/svg/server';
import {
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

// Allowed image MIME types
const ALLOWED_IMAGE_TYPES = [
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

// Magic bytes signatures for file type validation
const MAGIC_BYTES = {
  'image/png': {
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    offset: 0,
  },
  'image/webp': {
    bytes: [0x52, 0x49, 0x46, 0x46],
    offset: 0,
    secondary: { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  },
} as const;

/**
 * Validates file content matches its declared MIME type using magic bytes.
 * SVG is text-based and fully validated by sanitizeSvgServer.
 */
export function validateMagicBytes(
  buffer: Buffer,
  mimeType: string
): { valid: boolean } {
  // SVG validation is handled by sanitizeSvgServer
  if (mimeType === 'image/svg+xml') return { valid: true };

  const signature = MAGIC_BYTES[mimeType as keyof typeof MAGIC_BYTES];
  if (!signature) return { valid: true };

  // Check primary signature
  const primaryMatch = signature.bytes.every(
    (byte, i) => buffer[signature.offset + i] === byte
  );
  if (!primaryMatch) return { valid: false };

  // Check secondary signature if exists (WebP needs RIFF + WEBP)
  const secondary = 'secondary' in signature ? signature.secondary : undefined;
  if (secondary) {
    const secondaryMatch = secondary.bytes.every(
      (byte, i) => buffer[secondary.offset + i] === byte
    );
    if (!secondaryMatch) return { valid: false };
  }

  return { valid: true };
}

// Generate blurhash from image buffer
async function generateBlurhash(imageBuffer: Buffer): Promise<string> {
  const { data, info } = await sharp(imageBuffer, {
    limitInputPixels: MAX_IMAGE_PIXELS,
  })
    .resize(32, 32, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return encode(new Uint8ClampedArray(data), info.width, info.height, 4, 3);
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

// Process a single image (validate, optimize, sanitize, generate blurhash)
async function processImage(
  file: File,
  targetSize: number,
  preBuffer?: Buffer
): Promise<ProcessedImage> {
  // Validate MIME type
  if (!isAllowedImageType(file.type)) {
    throw new CustomError(
      uploadMsg.invalidMimeType(file.type),
      HTTP_STATUS.BAD_REQUEST
    );
  }

  const arrayBuffer = preBuffer ?? Buffer.from(await file.arrayBuffer());
  let buffer: Buffer = Buffer.isBuffer(arrayBuffer)
    ? arrayBuffer
    : Buffer.from(arrayBuffer);
  let finalMimeType = file.type;
  let finalSize = file.size;
  let width: number | undefined;
  let height: number | undefined;
  let blurhash: string | undefined;
  let finalExtension: string;

  // Handle SVG files
  if (file.type === 'image/svg+xml') {
    const svgContent = buffer.toString('utf8');
    const sanitizeResult = sanitizeSvgServer(svgContent);

    if (!sanitizeResult.isValid) {
      console.error(
        'SVG sanitization failed:',
        sanitizeForLog(sanitizeResult.errors)
      );
      throw new CustomError(uploadMsg.invalidSvg, HTTP_STATUS.BAD_REQUEST);
    }

    const optimizedSvg = svgOptimizerServer({
      data: sanitizeResult.cleanedSvg,
    });
    buffer = Buffer.from(optimizedSvg, 'utf8');
    finalSize = buffer.length;
    finalExtension = 'svg';
    blurhash = await generateBlurhash(buffer);
  }
  // Optimize raster images (PNG, WebP)
  else if (shouldOptimizeImage(file.type)) {
    const optimized = await optimizeImage(buffer, { targetSize });

    buffer = Buffer.from(optimized.buffer);
    finalMimeType = 'image/webp';
    finalSize = optimized.size;
    width = optimized.width;
    height = optimized.height;
    blurhash = await generateBlurhash(buffer);
    finalExtension = 'webp';
  } else {
    // Image doesn't need optimization
    blurhash = await generateBlurhash(buffer);
    const metadata = await sharp(buffer, {
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata();
    width = metadata.width;
    height = metadata.height;
    finalExtension = file.name.split('.').pop()?.toLowerCase() || 'webp';
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
  files: File[];
  preBuffers?: Buffer[];
  targetSize?: number;
  bucketType?: BucketType;
}): Promise<string[]> {
  const {
    files: imageFiles,
    preBuffers,
    bucketType = 'public',
    targetSize = SERVER_MAX_IMAGE_SIZE * 1024 * 1024,
  } = params;

  let uploadedKeys: string[] = [];

  try {
    // Process all images (optimize, generate blurhash, etc.)
    const processedImages = await Promise.all(
      imageFiles.map((file, i) =>
        processImage(file, targetSize, preBuffers?.[i])
      )
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
