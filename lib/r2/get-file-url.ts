import { getPublicUrl } from './client';

export function getFileUrl(file: {
  r2Key: string;
  bucketType: 'public' | 'private';
}): string | null {
  if (file.bucketType === 'private') return null;

  return getPublicUrl(file.r2Key);
}
