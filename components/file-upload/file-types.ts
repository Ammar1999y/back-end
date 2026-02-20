import type { UploadedFile } from '@/hooks/use-upload-file';

export type FileMetadata = UploadedFile & {
  id: string;
  mimeType?: string; // UploadedFile has 'type'
};

export type FileWithPreview = {
  id: string;
  file: File | FileMetadata;
  preview?: string;
  progress?: number; // For upload progress
  error?: string;
};
