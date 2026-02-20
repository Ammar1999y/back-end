import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// R2 Configuration - loaded from environment variables
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_PUBLIC_BUCKET = process.env.R2_PUBLIC_BUCKET;
const R2_PRIVATE_BUCKET = process.env.R2_PRIVATE_BUCKET;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

// Constants
const MAX_PRESIGNED_URL_EXPIRY = 604_800; // 7 days in seconds (R2 maximum)
const MIN_PRESIGNED_URL_EXPIRY = 1; // 1 second (R2 minimum)
const DEFAULT_PRESIGNED_URL_EXPIRY = 300; // 5 minutes

// Validate R2 configuration
const validateR2Config = !!(
  R2_ACCOUNT_ID &&
  R2_ACCESS_KEY_ID &&
  R2_SECRET_ACCESS_KEY
);

/**
 * Initialize S3 Client for R2
 * Best practices:
 * - region: 'auto' for R2 compatibility
 * - forcePathStyle: true for S3-compatible API
 * - endpoint: R2-specific endpoint
 */
export const r2Client = new S3Client({
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

/**
 * Upload a file to R2 with metadata
 * Best practices:
 * - Set ContentType for proper MIME type handling
 * - Set CacheControl for CDN optimization
 * - Set ContentDisposition for download behavior
 */
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
        Metadata: metadata, // Custom metadata (x-amz-meta-*)
      })
    );

    return { success: true, key };
  } catch (error) {
    throw error;
  }
}

/**
 * Delete a file from R2
 */
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

/**
 * Copy a file to a new location in R2
 * Does NOT delete the original - orphan cleanup is handled by cron job
 */
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

/**
 * Generate a presigned URL for temporary access to a file
 * Best practices:
 * - Use short expiry times for sensitive files (default: 5 minutes)
 * - Maximum expiry: 7 days (604,800 seconds)
 * - URLs are signed and cannot be tampered with
 *
 * @param expiresIn - Expiration time in seconds (default: 300 = 5 minutes)
 */
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

  // Validate expiry time
  const validExpiry = Math.max(
    MIN_PRESIGNED_URL_EXPIRY,
    Math.min(expiresIn, MAX_PRESIGNED_URL_EXPIRY)
  );

  if (validExpiry !== expiresIn) {
    console.warn(
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

/**
 * Get public URL for a file in the public bucket
 *
 * DEVELOPMENT: Returns r2.dev subdomain URL (rate limited)
 * PRODUCTION: Returns custom domain URL (no rate limits)
 *
 * To switch from development to production:
 * 1. Setup custom domain in Cloudflare Dashboard
 * 2. Update R2_PUBLIC_URL in .env (e.g., https://cdn.yoursite.com)
 * 3. Redeploy - No code changes needed!
 *
 * @param key - R2 object key (e.g., "projects/5/project/uuid.jpg")
 * @returns Public URL (e.g., "https://pub-xxxxx.r2.dev/projects/5/project/uuid.jpg")
 *
 * @throws Error if R2_PUBLIC_URL is not configured
 */
export function getPublicUrl(key: string): string {
  if (!R2_PUBLIC_URL) {
    throw new Error(
      'R2_PUBLIC_URL not configured. ' +
        'Enable public access in R2 Dashboard and add R2_PUBLIC_URL to .env'
    );
  }

  return `${R2_PUBLIC_URL}/${key}`;
}

/**
 * MIME type validation
 * Returns true if MIME type is allowed
 */
export function isAllowedMimeType(
  mimeType: string,
  allowedTypes?: string[]
): boolean {
  if (!allowedTypes || allowedTypes.length === 0) {
    return true; // Allow all if no restrictions
  }

  // Exact match
  if (allowedTypes.includes(mimeType)) {
    return true;
  }

  // Wildcard match (e.g., 'image/*')
  const wildcardMatch = allowedTypes.some((allowed) => {
    if (allowed.endsWith('/*')) {
      const prefix = allowed.slice(0, -2);
      return mimeType.startsWith(prefix + '/');
    }
    return false;
  });

  return wildcardMatch;
}

/**
 * Get recommended cache control header based on file type
 */
export function getCacheControlHeader(params: {
  mimeType: string;
  isPublic: boolean;
}): string {
  const { mimeType, isPublic } = params;

  // Private files should not be cached
  if (!isPublic) {
    return 'private, no-cache, no-store, must-revalidate';
  }

  // Public images - cache for 1 year
  if (mimeType.startsWith('image/')) {
    return 'public, max-age=31536000, immutable';
  }

  // Public documents - cache for 1 hour
  if (
    mimeType === 'application/pdf' ||
    mimeType.includes('document') ||
    mimeType.includes('word') ||
    mimeType.includes('excel')
  ) {
    return 'public, max-age=3600';
  }

  // Default for other public files - cache for 1 day
  return 'public, max-age=86400';
}

/**
 * Get content disposition header for downloads
 */
export function getContentDisposition(params: {
  filename: string;
  inline?: boolean;
}): string {
  const { filename, inline = false } = params;
  const disposition = inline ? 'inline' : 'attachment';

  const encodedFilename = encodeURIComponent(filename);

  return `${disposition}; filename="${filename}"; filename*=UTF-8''${encodedFilename}`;
}

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
