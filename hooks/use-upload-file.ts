import type { Options as CompressionOptions } from 'browser-image-compression';

import * as React from 'react';

import { toast } from 'sonner';

import { svgOptimizerClient } from '@/utils/images/client';
import {
  CompressionError,
  ImageCompressionService,
} from '@/utils/images/client-image-compression';
import { sanitizeSvg, validateSvgFile } from '@/utils/images/svg-optimizer';

import { mediaConfig, MediaType } from '@/components/editor/media-config';

export interface UploadedFile {
  url: string;
  name: string;
  size: number;
  type: string;
  width?: number;
  height?: number;
}

interface UseUploadFileProps {
  onUploadComplete?: (file: UploadedFile) => void;
  onUploadError?: (error: unknown) => void;
  onUploadProgress?: (progress: number) => void;
}

interface UploadOptions {
  maxSizeMB?: number;
  maxWidthOrHeight?: number;
  quality?: number;
}

export function useUploadFile({
  onUploadComplete,
  onUploadError,
}: UseUploadFileProps = {}) {
  const [uploadedFile, setUploadedFile] = React.useState<UploadedFile>();
  const [uploadingFile, setUploadingFile] = React.useState<File>();
  const [progress, setProgress] = React.useState<number>(0);
  const [isUploading, setIsUploading] = React.useState(false);
  const abortControllerRef = React.useRef<AbortController | null>(null);

  const processSvgFile = React.useCallback(
    async (file: File): Promise<File> => {
      // Validate SVG file
      const fileError = validateSvgFile(file);
      if (fileError) {
        throw new Error(fileError);
      }

      // Read and sanitize SVG content
      const content = await file.text();
      const result = sanitizeSvg(content);

      if (!result.isValid) {
        throw new Error(result.errors.join('\n'));
      }

      // Optimize SVG
      const optimizedSvg = await svgOptimizerClient({
        data: result.cleanedSvg,
      });

      // Create a new File from optimized SVG
      return new File([optimizedSvg], file.name, {
        type: 'image/svg+xml',
        lastModified: Date.now(),
      });
    },
    []
  );

  const uploadFile = React.useCallback(
    async (
      file: File,
      type: MediaType = 'file',
      options: UploadOptions = {}
    ) => {
      // Cancel previous upload if any
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;

      setIsUploading(true);
      setUploadingFile(file);
      setProgress(0);

      try {
        // Validate file type and size
        const config = mediaConfig[type];
        if (!config) throw new Error('Invalid media type');

        if (config.maxSize && file.size > config.maxSize * 1024 * 1024) {
          throw new Error(`File size exceeds ${config.maxSize}MB limit`);
        }

        let fileToUpload = file;
        let width: number | undefined;
        let height: number | undefined;

        // Optimize image if applicable
        if (type === 'image') {
          try {
            if (file.type === 'image/svg+xml' || file.name.endsWith('.svg')) {
              fileToUpload = await processSvgFile(file);
            } else {
              const compressionOptions: CompressionOptions = {
                maxSizeMB: options.maxSizeMB ?? config.maxSize,
                maxWidthOrHeight: options.maxWidthOrHeight,
                initialQuality: options.quality,
                useWebWorker: true,
                signal,
              };

              const result = await ImageCompressionService.compress(
                file,
                compressionOptions,
                true // withDimensions
              );
              fileToUpload = result.file;
              width = result.width;
              height = result.height;
            }
          } catch (e) {
            // If aborted, rethrow
            if (signal.aborted) throw e;
            if (e instanceof CompressionError && e.message.includes('إلغاء'))
              throw e;

            console.warn(
              'Image compression/optimization failed, uploading original file',
              e
            );
            // For SVGs, if optimization fails, we might not want to upload the original for security reasons
            // But for now keeping behavior consistent with previous implementation unless it's a critical error
            if (
              file.type === 'image/svg+xml' &&
              e instanceof Error &&
              !e.message.includes('optimization')
            ) {
              throw e; // Rethrow validation errors
            }
          }
        }

        if (signal.aborted) return;

        const formData = new FormData();
        formData.append('file', fileToUpload);
        formData.append('type', type);

        // Simulate progress since fetch doesn't support it natively
        const progressInterval = setInterval(() => {
          if (signal.aborted) {
            clearInterval(progressInterval);
            return;
          }
          setProgress((prev) => {
            if (prev >= 90) {
              clearInterval(progressInterval);
              return 90;
            }
            return prev + 10;
          });
        }, 200);

        try {
          const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData,
            signal,
          });

          clearInterval(progressInterval);

          if (signal.aborted) return;

          const result = await response.json();

          if (!response.ok || !result.success) {
            throw new Error(result.message || 'Upload failed');
          }

          // Merge local dimensions if available and not returned by server
          const finalData = {
            ...result.data,
            width: result.data?.width || width,
            height: result.data?.height || height,
          };

          setProgress(100);
          setUploadedFile(finalData);
          onUploadComplete?.(finalData);

          return finalData;
        } catch (fetchError) {
          clearInterval(progressInterval);
          throw fetchError;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof Error && error.name === 'AbortError') return;

        const message =
          error instanceof Error ? error.message : 'Upload failed';
        toast.error(message);
        onUploadError?.(error);
        throw error;
      } finally {
        if (!signal.aborted) {
          setIsUploading(false);
          setUploadingFile(undefined);
          // Reset progress after a delay
          setTimeout(() => setProgress(0), 1000);
        }
        abortControllerRef.current = null;
      }
    },
    [processSvgFile, onUploadComplete, onUploadError]
  );

  return {
    isUploading,
    progress,
    uploadedFile,
    uploadFile,
    uploadingFile,
  };
}
