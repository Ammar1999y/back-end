import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_PUBLIC_BUCKET = process.env.R2_PUBLIC_BUCKET;
const R2_PRIVATE_BUCKET = process.env.R2_PRIVATE_BUCKET;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

const MAX_PRESIGNED_URL_EXPIRY = 604_800;
const MIN_PRESIGNED_URL_EXPIRY = 1;
const DEFAULT_PRESIGNED_URL_EXPIRY = 300;

const validateR2Config = !!(
  R2_ACCOUNT_ID &&
  R2_ACCESS_KEY_ID &&
  R2_SECRET_ACCESS_KEY
);

const r2Client = new S3Client({
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID || '',
    secretAccessKey: R2_SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: true, // Required for R2 compatibility
  region: 'weur',
});

export type BucketType = 'public' | 'private';

const getBucketName = (bucketType: BucketType) =>
  bucketType === 'public' ? R2_PUBLIC_BUCKET : R2_PRIVATE_BUCKET;

export async function uploadToR2(params: {
  file: Buffer;
  key: string;
  bucketType: BucketType;
  contentType: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
}): Promise<{ success: boolean; key: string }> {
  const {
    file,
    key,
    bucketType,
    contentType,
    cacheControl,
    contentDisposition,
    metadata,
  } = params;

  if (!validateR2Config)
    throw new Error(
      'R2 is not configured. Please check environment variables.'
    );

  try {
    const bucket = getBucketName(bucketType);

    await r2Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: file,
        ContentType: contentType,
        CacheControl: cacheControl,
        ContentDisposition: contentDisposition,
        Metadata: metadata,
      })
    );

    return { success: true, key };
  } catch (error) {
    throw error;
  }
}

export async function deleteFromR2(params: {
  key: string;
  bucketType: BucketType;
}): Promise<{ success: boolean }> {
  const { key, bucketType } = params;

  try {
    const bucket = getBucketName(bucketType);

    await r2Client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );

    return { success: true };
  } catch (error) {
    throw error;
  }
}

/** @knipignore */
export async function copyFileInR2(params: {
  sourceKey: string;
  destinationKey: string;
  bucketType: BucketType;
}): Promise<{ success: boolean; newKey: string }> {
  const { sourceKey, destinationKey, bucketType } = params;

  if (!validateR2Config) {
    throw new Error(
      'R2 is not configured. Please check environment variables.'
    );
  }

  try {
    const bucket = getBucketName(bucketType);

    await r2Client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${sourceKey}`,
        Key: destinationKey,
      })
    );

    return { success: true, newKey: destinationKey };
  } catch (error) {
    throw error;
  }
}

/** @knipignore */
export async function getPresignedUrl(params: {
  key: string;
  bucketType: BucketType;
  expiresIn?: number;
  responseContentDisposition?: string;
  responseContentType?: string;
}): Promise<string> {
  const {
    key,
    bucketType,
    expiresIn = DEFAULT_PRESIGNED_URL_EXPIRY,
    responseContentDisposition,
    responseContentType,
  } = params;

  if (!validateR2Config) {
    throw new Error(
      'R2 is not configured. Please check environment variables.'
    );
  }

  const validExpiry = Math.max(
    MIN_PRESIGNED_URL_EXPIRY,
    Math.min(expiresIn, MAX_PRESIGNED_URL_EXPIRY)
  );

  if (validExpiry !== expiresIn) {
    console.error(
      `[R2] Expiry time ${expiresIn}s is out of range. Using ${validExpiry}s instead. ` +
        `Valid range: ${MIN_PRESIGNED_URL_EXPIRY}-${MAX_PRESIGNED_URL_EXPIRY} seconds`
    );
  }

  try {
    const bucket = getBucketName(bucketType);

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: responseContentDisposition,
      ResponseContentType: responseContentType,
    });

    const url = await getSignedUrl(r2Client, command, {
      expiresIn: validExpiry,
    });

    return url;
  } catch (error) {
    throw error;
  }
}

/** @knipignore */
export function getPublicUrl(key: string): string {
  if (!R2_PUBLIC_URL) {
    throw new Error(
      'R2_PUBLIC_URL not configured. ' +
        'Enable public access in R2 Dashboard and add R2_PUBLIC_URL to .env'
    );
  }

  return `${R2_PUBLIC_URL}/${key}`;
}

/** @knipignore */
export function isAllowedMimeType(
  mimeType: string,
  allowedTypes?: string[]
): boolean {
  if (!allowedTypes || allowedTypes.length === 0) {
    return true;
  }

  if (allowedTypes.includes(mimeType)) {
    return true;
  }

  const wildcardMatch = allowedTypes.some((allowed) => {
    if (allowed.endsWith('/*')) {
      const prefix = allowed.slice(0, -2);
      return mimeType.startsWith(prefix + '/');
    }
    return false;
  });

  return wildcardMatch;
}

export function getCacheControlHeader(params: {
  mimeType: string;
  isPublic: boolean;
}): string {
  const { mimeType, isPublic } = params;

  if (!isPublic) {
    return 'private, no-cache, no-store, must-revalidate';
  }

  if (mimeType.startsWith('image/')) {
    return 'public, max-age=31536000, immutable';
  }

  if (
    mimeType === 'application/pdf' ||
    mimeType.includes('document') ||
    mimeType.includes('word') ||
    mimeType.includes('excel')
  ) {
    return 'public, max-age=3600';
  }

  return 'public, max-age=86400';
}

/** RFC 5987 encoding; `encodeURIComponent` leaves `'*()` unescaped. */
const ATTR_CHARS = new Set(
  [
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$&+-.^_`|~',
  ].map((character) => character.codePointAt(0))
);

function encodeExtValue(filename: string): string {
  const bytes = new TextEncoder().encode(filename);
  let out = '';
  for (const byte of bytes)
    out += ATTR_CHARS.has(byte)
      ? String.fromCodePoint(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  return out;
}

/**
 * Keeps `filename` portable across SDK encodings; `filename*` carries the
 * original name. Controls, quotes, and backslashes are unsafe in this fallback.
 */
function asciiFallback(filename: string): string {
  let out = '';
  for (const character of filename) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x7f || code < 0x20) continue;
    if (character === '"' || character === '\\') continue;
    out += code > 0x7f ? '_' : character;
  }
  return out || 'download';
}

/** Emits an ASCII fallback and the RFC 5987 filename. */
export function getContentDisposition(params: {
  filename: string;
  inline?: boolean;
}): string {
  const { filename, inline = false } = params;
  const disposition = inline ? 'inline' : 'attachment';

  return (
    `${disposition}; filename="${asciiFallback(filename)}"; ` +
    `filename*=UTF-8''${encodeExtValue(filename)}`
  );
}
/** @knipignore */
export function getR2ConfigStatus() {
  return {
    configured: validateR2Config,
    accountId: !!R2_ACCOUNT_ID,
    accessKeyId: !!R2_ACCESS_KEY_ID,
    secretAccessKey: !!R2_SECRET_ACCESS_KEY,
    publicBucket: R2_PUBLIC_BUCKET,
    privateBucket: R2_PRIVATE_BUCKET,
    publicUrl: R2_PUBLIC_URL || null,
  };
}
