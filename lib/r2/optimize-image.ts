import sharp from 'sharp';

import {
  MAX_IMAGE_PIXELS,
  SERVER_MAX_IMAGE_SIZE,
} from '@/utils/validation/constants';

export type OptimizeImageOptions = {
  /**
   * Target file size in bytes
   * Default: 0.5MB (512 * 1024)
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
    targetSize = SERVER_MAX_IMAGE_SIZE * 1024 * 1024, // 0.5MB default
    initialQuality = 95,
    minQuality = 50,
    initialWidth = 3048,
    minWidth = 800,
    qualityStep = 5,
    widthStep = 100,
  } = options;

  // Get original image metadata (with pixel limit to prevent decompression bombs)
  const metadata = await sharp(input, {
    limitInputPixels: MAX_IMAGE_PIXELS,
  }).metadata();
  const originalWidth = metadata.width || initialWidth;

  let currentQuality = initialQuality;
  let currentWidth = Math.min(originalWidth, initialWidth);
  let iterations = 0;
  let result: Buffer;
  let resultSize: number;
  let resultMetadata: sharp.OutputInfo;

  const firstAttempt = await sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS })
    .resize({
      width: currentWidth,
      withoutEnlargement: true, // Don't upscale small images
    })
    .webp({
      quality: currentQuality,
      alphaQuality: 1,
      smartSubsample: true,
      effort: 5,
    })
    .toBuffer({ resolveWithObject: true });

  result = firstAttempt.data;
  resultSize = firstAttempt.info.size;
  resultMetadata = firstAttempt.info;
  iterations++;

  // If already under target, return immediately
  if (resultSize <= targetSize) {
    return {
      buffer: result,
      width: resultMetadata.width,
      height: resultMetadata.height,
      size: resultSize,
      format: 'webp',
      iterations,
    };
  }

  let reduceQuality = true;

  while (resultSize > targetSize && iterations < 50) {
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
          `[Image Optimization] Could not reach target size. Final: ${resultSize} bytes, Target: ${targetSize} bytes`
        );
        break;
      }

      // After width reduction, try quality again
      reduceQuality = true;
    }

    const attempt = await sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS })
      .resize({
        width: currentWidth,
        withoutEnlargement: true,
      })
      .webp({
        quality: currentQuality,
        alphaQuality: 1,
        smartSubsample: true,
        effort: 5,
      })
      .toBuffer({ resolveWithObject: true });

    result = attempt.data;
    resultSize = attempt.info.size;
    resultMetadata = attempt.info;
    iterations++;

    if (resultSize <= targetSize) break;
  }

  return {
    buffer: result,
    width: resultMetadata.width,
    height: resultMetadata.height,
    size: resultSize,
    format: 'webp',
    iterations,
  };
}

export const shouldOptimizeImage = (mimeType: string) =>
  mimeType.startsWith('image/') &&
  !(mimeType === 'image/svg+xml' || mimeType === 'image/gif');
