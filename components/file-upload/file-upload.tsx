'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import {
  AnimateLayoutChanges,
  defaultAnimateLayoutChanges,
} from '@dnd-kit/sortable';
import { CloudUpload as _CloudUpload, Trash2 as _Trash2 } from 'lucide-react';
import { ErrorCode, FileRejection, useDropzone } from 'react-dropzone';
import { toast } from 'sonner';
import { ACCEPT_IMAGES_SVG_AND_PDF } from '@/lib/constants/file-types';
import { cn } from '@/lib/utils';

import { svgOptimizerClient } from '@/utils/images/client';
import { ImageCompressionService } from '@/utils/images/client-image-compression';
import { sanitizeSvg, validateSvgFile } from '@/utils/images/svg-optimizer';

import { Button } from '@/components/ui/button';
import { useZoomImageStore } from '@/components/modules/image-zoom/store';
import {
  MeasuringStrategy,
  rectSortingStrategy,
  SimpleSortableItem,
  SortableList,
  useSortableList,
} from '@/components/sortable';

import { FileCardContent } from './file-card';
import { FileWithPreview } from './file-types';
import { formatBytes } from './file-utils';

const CloudUpload = memo(_CloudUpload);
const Trash2 = memo(_Trash2);

const measuring = { droppable: { strategy: MeasuringStrategy.Always } };

/**
 * Helper function to determine supported file types from accept object
 */
const getFileTypesLabel = (accept: Record<string, string[]>): string => {
  const types: string[] = [];

  if (accept['image/*']) {
    types.push('صور');
  }

  if (accept['application/pdf']) {
    types.push('PDF');
  }

  return types.length > 0 ? types.join('، ') : 'جميع الملفات';
};

interface FileUploadProps {
  maxFiles?: number;
  maxSizeMB?: number;
  accept?: Record<string, string[]>;
  initialFiles?: FileWithPreview[];
  onFilesChange?: (files: FileWithPreview[]) => void;
  className?: string;
  /** Custom text before "اضغط للاستعراض" */
  dropzoneText?: string;
  /** Custom className for dropzone text */
  dropzoneTextClassName?: string;
  /** Custom helper text (replaces default size/count/format info) */
  dropzoneHelperText?: string;
  inputID?: string;
}
// const modifiers = [restrictToWindowEdges, restrictToFirstScrollableAncestor];
const modifiers = [];
export const FileUpload = memo(
  ({
    maxFiles = 10,
    maxSizeMB = 1,
    accept = ACCEPT_IMAGES_SVG_AND_PDF,
    initialFiles = [],
    onFilesChange,
    className,
    dropzoneText = 'اسحب وأفلت الملفات هنا، أو',
    dropzoneTextClassName,
    dropzoneHelperText,
    inputID,
  }: FileUploadProps) => {
    const [files, setFiles] = useState<FileWithPreview[]>(initialFiles);

    const {
      activeItem,
      sensors,
      handleDragStart,
      handleDragEnd,
      handleDragCancel,
      removeItem,
    } = useSortableList<FileWithPreview>({
      items: files,
      onItemsChange: setFiles,
      getId: (file) => file.id,
    });

    const itemIds = useMemo(() => files.map((f) => f.id), [files]);

    useEffect(() => {
      onFilesChange?.(files);
    }, [files, onFilesChange]);

    const handleRemove = useCallback(
      (id: string) => {
        removeItem(id);
      },
      [removeItem]
    );

    const handleClearAll = useCallback(() => {
      setFiles([]);
    }, []);

    const handleZoom = useCallback((file: FileWithPreview) => {
      useZoomImageStore.getState().setZoomFile(file);
      useZoomImageStore.getState().setActiveId(file.id);
    }, []);

    const handleDownload = useCallback((file: FileWithPreview) => {
      const url =
        file.preview ||
        (file.file instanceof File ? URL.createObjectURL(file.file) : '');
      if (!url) return;

      const a = document.createElement('a');
      a.href = url;
      a.download = file.file.name;
      document.body.append(a);
      a.click();
      a.remove();
    }, []);

    const processSvgFile = useCallback(async (file: File): Promise<File> => {
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
    }, []);

    const onDropRejected = useCallback(
      (fileRejections: FileRejection[]) => {
        for (const rejection of fileRejections) {
          const { file, errors } = rejection;

          for (const error of errors) {
            switch (error.code) {
              case ErrorCode.FileTooLarge:
                toast.error(
                  `الملف "${file.name}" كبير جداً (الحد الأقصى: ${maxSizeMB} MB)`
                );
                break;
              case ErrorCode.FileInvalidType:
                toast.error(`الملف "${file.name}" نوعه غير مدعوم`);
                break;
              case ErrorCode.TooManyFiles:
                toast.error(`يمكنك رفع بحد أقصى ${maxFiles} ملفات فقط`);
                break;
              default:
                toast.error(`خطأ في الملف "${file.name}": ${error.message}`);
            }
          }
        }
      },
      [maxFiles, maxSizeMB]
    );

    const onDrop = useCallback(
      async (acceptedFiles: File[]) => {
        if (files.length + acceptedFiles.length > maxFiles) {
          toast.error(`يمكنك رفع بحد أقصى ${maxFiles} ملفات فقط`);
          return;
        }

        const newFiles: FileWithPreview[] = [];

        for (const file of acceptedFiles) {
          if (file.size > maxSizeMB * 1024 * 1024) {
            toast.error(
              `الملف ${file.name} يتجاوز الحجم المسموح به (${maxSizeMB} MB)`
            );
            continue;
          }
          let processedFile = file;
          // Process images
          if (file.type.startsWith('image/')) {
            try {
              if (file.type === 'image/svg+xml' || file.name.endsWith('.svg')) {
                processedFile = await processSvgFile(file);
              } else {
                const compressed = await ImageCompressionService.compress(
                  file,
                  {
                    maxSizeMB,
                    useWebWorker: true,
                  }
                );
                processedFile = compressed.file;
              }
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : 'فشلت معالجة الصورة';
              toast.error(`${file.name}: ${errorMessage}`);
              console.error('Processing failed', error);
              continue;
            }
          }

          newFiles.push({
            id: Math.random().toString(36).slice(0, 7),
            file: processedFile,
            preview: URL.createObjectURL(processedFile),
          });
        }

        setFiles((prev) => [...prev, ...newFiles]);
      },
      [files.length, maxFiles, maxSizeMB, processSvgFile]
    );

    const { getRootProps, getInputProps, isDragActive } = useDropzone({
      onDrop,
      onDropRejected,
      accept,
      maxFiles,
      maxSize: maxSizeMB * 1024 * 1024,
      disabled: files.length >= maxFiles && maxFiles === 1,
    });

    const totalSize = files.reduce(
      (acc, curr) =>
        acc +
        (curr.file instanceof File ? curr.file.size : curr.file.size || 0),
      0
    );
    const animateLayoutChanges = useMemo<AnimateLayoutChanges>(
      () => (args) =>
        defaultAnimateLayoutChanges({ ...args, wasDragging: true }),
      []
    );
    const isSingleMode = maxFiles === 1;
    const showDropzone = !isSingleMode || files.length === 0;

    return (
      <div className={cn('w-full space-y-4', className)}>
        {/* Header (Multi-file mode only) */}

        {/* Dropzone */}
        {showDropzone && (
          <button
            {...getRootProps()}
            type='button'
            className={cn(
              'relative flex w-full flex-col items-center justify-center gap-4 rounded-2xl border border-dashed bg-muted/30 px-4 py-8 text-center transition-all duration-300 hover:border-primary hover:bg-primary/5',
              isDragActive && 'border-primary bg-primary/10'
            )}
          >
            <input {...getInputProps()} id={inputID} />
            <div className='rounded-full bg-primary/10 p-4'>
              <CloudUpload className='size-8 text-primary/60' />
            </div>
            <div className='space-y-2'>
              <p
                className={cn(
                  'font-medium text-muted-foreground',
                  dropzoneTextClassName
                )}
              >
                {dropzoneText}{' '}
                <span className='text-primary hover:underline'>
                  اضغط للاستعراض
                </span>
              </p>
              <p className='text-xs text-muted-foreground'>
                {dropzoneHelperText ||
                  `أقصى حجم: ${maxSizeMB} MB • أقصى عدد: ${maxFiles} • الصيغ المدعومة: ${getFileTypesLabel(accept)}`}
              </p>
            </div>
          </button>
        )}

        {!isSingleMode && files.length > 0 && (
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <h3 className='text-sm font-medium'>الملفات ({files.length})</h3>
              <span className='text-xs text-muted-foreground'>
                {formatBytes(totalSize)}
              </span>
            </div>
            <Button
              variant='ghost'
              size='sm'
              onClick={handleClearAll}
              className='h-8 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive'
            >
              <Trash2 className='ml-2 h-4 w-4' />
              حذف الكل
            </Button>
          </div>
        )}

        {/* Single File Preview (Replaces Dropzone) */}
        {isSingleMode && files.length > 0 && (
          <FileCardContent
            file={files[0]}
            onRemove={handleRemove}
            onZoom={handleZoom}
            onDownload={handleDownload}
          />
        )}

        {/* File List (Multi-file mode) */}
        {!isSingleMode && files.length > 0 && (
          <SortableList
            items={itemIds}
            sensors={sensors}
            measuring={measuring}
            modifiers={modifiers}
            strategy={rectSortingStrategy}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
            overlay={
              activeItem ? (
                <FileCardContent
                  file={activeItem}
                  onRemove={handleRemove}
                  isDragOverlay
                  showDragHandle
                />
              ) : null
            }
          >
            <div className='grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'>
              {files.map((file) => (
                <SimpleSortableItem
                  animateLayoutChanges={animateLayoutChanges}
                  key={file.id}
                  id={file.id}
                  useHandle
                >
                  <FileCardContent
                    file={file}
                    onRemove={handleRemove}
                    onZoom={handleZoom}
                    onDownload={handleDownload}
                    showDragHandle
                  />
                </SimpleSortableItem>
              ))}
            </div>
          </SortableList>
        )}
      </div>
    );
  }
);

FileUpload.displayName = 'FileUpload';
