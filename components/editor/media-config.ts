import { AudioLinesIcon, FileIcon, FilmIcon, ImageIcon } from 'lucide-react';

export type MediaType = 'image' | 'video' | 'audio' | 'file';

export interface MediaTypeConfig {
  enabled: boolean;
  upload: boolean;
  embed: boolean;
  label: string;
  icon: React.ElementType;
  accept: string[];
  maxSize?: number; // In MB
}

export const mediaConfig: Record<MediaType, MediaTypeConfig> = {
  image: {
    enabled: false,
    upload: false,
    embed: false,
    label: 'صورة',
    icon: ImageIcon,
    accept: ['image/*'],
    maxSize: 5,
  },
  video: {
    enabled: false,
    upload: false,
    embed: false,
    label: 'فيديو',
    icon: FilmIcon,
    accept: ['video/*'],
    maxSize: 50,
  },
  audio: {
    enabled: false,
    upload: false,
    embed: false,
    label: 'صوت',
    icon: AudioLinesIcon,
    accept: ['audio/*'],
    maxSize: 20,
  },
  file: {
    enabled: false,
    upload: false,
    embed: false,
    label: 'ملف',
    icon: FileIcon,
    accept: ['*/*'],
    maxSize: 20,
  },
};
