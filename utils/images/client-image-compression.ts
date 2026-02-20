/* eslint-disable unicorn/prefer-add-event-listener */
import type { Options as CompressionOptions } from 'browser-image-compression';

import imageCompression from 'browser-image-compression';

import { MAX_IMAGE_SIZE } from './config';

export enum ImageFormat {
  WEBP = 'image/webp',
  PNG = 'image/png',
}

export interface CompressionResult {
  file: File;
  format: ImageFormat;
  width?: number;
  height?: number;
}
export class CompressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompressionError';
  }
}

const CONSTANTS = {
  DEFAULTS: {
    maxWidthOrHeight: 2048,
    maxSizeMB: MAX_IMAGE_SIZE,
    quality: 0.95,
    useWebWorker: true,
  },
} as const;

async function getImageDimensions(
  file: File
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.width, height: img.height });
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('فشل تحميل الصورة'));
    };

    img.src = url;
  });
}

/**
 * Converts a Blob/File to a proper File with correct name and extension
 */
function toFile(
  blob: Blob | File,
  originalName: string,
  format: ImageFormat
): File {
  // Get file extension based on format
  const extension = format === ImageFormat.WEBP ? 'webp' : 'png';

  // Remove old extension and add new one
  const nameWithoutExt = originalName.replace(/\.[^.]+$/, '');
  const newFileName = `${nameWithoutExt}.${extension}`;

  // If it's already a File with correct name, return it
  if (blob instanceof File && blob.name === newFileName) {
    return blob;
  }

  // Convert to proper File object
  return new File([blob], newFileName, {
    type: format,
    lastModified: Date.now(),
  });
}

export class ImageCompressionService {
  static async compress(
    file: File,
    options: CompressionOptions = {},
    withDimensions = false
  ): Promise<CompressionResult> {
    try {
      if (!file) throw new CompressionError('لم يتم توفير ملف');

      const compressed = await this.compressWithFallback(file, {
        ...options,
        maxWidthOrHeight:
          options.maxWidthOrHeight ?? CONSTANTS.DEFAULTS.maxWidthOrHeight,
        maxSizeMB: options.maxSizeMB ?? CONSTANTS.DEFAULTS.maxSizeMB,
        useWebWorker: options.useWebWorker ?? CONSTANTS.DEFAULTS.useWebWorker,
        initialQuality: options.initialQuality ?? CONSTANTS.DEFAULTS.quality,
        signal: options.signal,
        libURL: '/js/browser-image-compression.js',
      });

      const result: CompressionResult = {
        file: compressed,
        format: compressed.type as ImageFormat,
      };

      if (withDimensions) {
        const compressedDimensions = await getImageDimensions(compressed);
        result.width = compressedDimensions.width;
        result.height = compressedDimensions.height;
      }

      return result;
    } catch (error) {
      if (error instanceof CompressionError) throw error;

      throw new CompressionError('خطأ غير متوقع في الضغط');
    }
  }

  private static async compressWithFallback(
    file: File,
    config: CompressionOptions
  ): Promise<File> {
    try {
      const compressed = await imageCompression(file, {
        ...config,
        fileType: ImageFormat.WEBP,
      });

      if (compressed.type === ImageFormat.WEBP) {
        return toFile(compressed, file.name, ImageFormat.WEBP);
      }

      throw new Error('المتصفح لا يدعم صيغة WebP');
    } catch {
      if (config.signal?.aborted)
        throw new CompressionError('تم إلغاء الضغط من قبل المستخدم');

      try {
        const compressed = await imageCompression(file, {
          ...config,
          fileType: ImageFormat.PNG,
        });

        return toFile(compressed, file.name, ImageFormat.PNG);
      } catch {
        throw new CompressionError('فشل رفع الصورة، اعد المحاوله');
      }
    }
  }
}

export default ImageCompressionService;
