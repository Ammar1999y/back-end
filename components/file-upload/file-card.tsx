import { memo } from 'react';

import { Download, GripVertical, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { SortableHandle } from '@/components/sortable';

import { FileWithPreview } from './file-types';
import { formatBytes, getFileIcon } from './file-utils';
import { FileZoomButton } from './file-zoom-button';

interface FileCardContentProps {
  file: FileWithPreview;
  onRemove: (id: string) => void;
  onZoom?: (file: FileWithPreview) => void;
  onDownload?: (file: FileWithPreview) => void;
  /** Whether this is rendered in drag overlay */
  isDragOverlay?: boolean;
  /** Whether to show drag handle */
  showDragHandle?: boolean;
  /** Additional className for the container */
  className?: string;
}

export const FileCardContent = memo(
  ({
    file,
    onRemove,
    onZoom,
    onDownload,
    isDragOverlay,
    showDragHandle = false,
    className,
  }: FileCardContentProps) => {
    const fileType =
      file.file instanceof File ? file.file.type : file.file.type || '';
    const fileName = file.file.name;
    const fileSize =
      file.file instanceof File ? file.file.size : file.file.size || 0;
    const isImage = fileType.startsWith('image/');
    const previewUrl =
      file.preview || (file.file instanceof File ? undefined : file.file.url);

    return (
      <div
        className={cn(
          'group relative flex h-72 max-h-full w-full flex-col overflow-hidden rounded-xl border bg-background shadow-sm transition-all hover:shadow-md',
          className
        )}
      >
        {/* Preview Area */}
        <div className='relative flex h-full w-full items-center justify-center overflow-hidden bg-muted/30'>
          {isImage && previewUrl ? (
            <img
              src={previewUrl}
              alt={fileName}
              className='h-full w-full object-cover transition-transform duration-300 group-hover:scale-105'
            />
          ) : (
            <div className='p-4'>{getFileIcon(file)}</div>
          )}

          {/* Overlay */}
          <div
            className={cn(
              'absolute inset-0 flex flex-col justify-between bg-black/60 p-3',
              !isDragOverlay &&
                'opacity-0 transition-opacity duration-200 group-focus-within:opacity-100 group-hover:opacity-100'
            )}
          >
            {/* Top Actions */}
            <div className='flex items-center justify-between'>
              {/* Drag Handle */}
              {showDragHandle && (
                <SortableHandle
                  as={Button}
                  size='icon'
                  variant='ghost'
                  className='h-8 w-8 cursor-grab rounded-full bg-white/20 text-white hover:bg-white/30 active:cursor-grabbing'
                >
                  <GripVertical className='h-4 w-4' />
                </SortableHandle>
              )}

              {/* Delete Button */}
              <Button
                variant='ghost'
                size='icon'
                onClick={() => onRemove(file.id)}
                className={cn(
                  'h-8 w-8 rounded-full bg-red-500/80 text-white hover:bg-red-600',
                  !showDragHandle && 'ms-auto'
                )}
              >
                <Trash2 className='h-4 w-4' />
              </Button>
            </div>

            {/* Center Actions */}
            <div className='flex items-center justify-center gap-2'>
              {isImage && onZoom && (
                <FileZoomButton file={file} onZoom={onZoom} />
              )}
              {onDownload && (
                <Button
                  variant='ghost'
                  size='icon'
                  onClick={() => onDownload(file)}
                  className='h-8 w-8 rounded-full bg-white/20 text-white hover:bg-white/30'
                  title='تحميل'
                >
                  <Download className='h-4 w-4' />
                </Button>
              )}
            </div>

            {/* Bottom Info */}
            <div className='w-full truncate text-right text-xs text-white/90'>
              <p className='truncate font-medium'>{fileName}</p>
              <p className='text-xs text-white/70'>{formatBytes(fileSize)}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }
);

FileCardContent.displayName = 'FileCardContent';
