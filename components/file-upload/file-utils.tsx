import { memo } from 'react';

import {
  FileArchive,
  FileAudio,
  FileIcon,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Image as ImageIcon,
} from 'lucide-react';

import { FileWithPreview } from './file-types';

// Memoize icons for performance
const FileTextIcon = memo(FileText);
FileTextIcon.displayName = 'FileTextIcon';

const FileArchiveIcon = memo(FileArchive);
FileArchiveIcon.displayName = 'FileArchiveIcon';

const FileSpreadsheetIcon = memo(FileSpreadsheet);
FileSpreadsheetIcon.displayName = 'FileSpreadsheetIcon';

const VideoIcon = memo(FileVideo);
VideoIcon.displayName = 'VideoIcon';

const HeadphonesIcon = memo(FileAudio);
HeadphonesIcon.displayName = 'HeadphonesIcon';

const ImageIconComponent = memo(ImageIcon);
ImageIconComponent.displayName = 'ImageIconComponent';

const DefaultFileIcon = memo(FileIcon);
DefaultFileIcon.displayName = 'DefaultFileIcon';

export const formatBytes = (bytes: number, decimals = 2): string => {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = Math.max(0, decimals);
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return (
    Number.parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
  );
};
const iconProps = { className: 'size-8 opacity-60' };

export const getFileIcon = (file: FileWithPreview) => {
  const fileType =
    file.file instanceof File ? file.file.type : file.file.type || '';
  const fileName = file.file.name;

  if (
    fileType.includes('pdf') ||
    fileName.endsWith('.pdf') ||
    fileName.endsWith('.doc') ||
    fileName.endsWith('.docx')
  ) {
    return <FileTextIcon {...iconProps} />;
  }
  if (
    fileType.includes('zip') ||
    fileType.includes('archive') ||
    fileName.endsWith('.zip') ||
    fileName.endsWith('.rar')
  ) {
    return <FileArchiveIcon {...iconProps} />;
  }
  if (
    fileType.includes('excel') ||
    fileName.endsWith('.xls') ||
    fileName.endsWith('.xlsx')
  ) {
    return <FileSpreadsheetIcon {...iconProps} />;
  }
  if (fileType.includes('video/')) {
    return <VideoIcon {...iconProps} />;
  }
  if (fileType.includes('audio/')) {
    return <HeadphonesIcon {...iconProps} />;
  }
  if (fileType?.startsWith('image/')) {
    return <ImageIconComponent {...iconProps} />;
  }

  return <DefaultFileIcon {...iconProps} />;
};
