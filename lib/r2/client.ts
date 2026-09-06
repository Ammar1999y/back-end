import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { R2_PRIVATE_BUCKET, R2_PUBLIC_BUCKET } from './buckets';

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL?.trim().replace(/\/+$/, '');

const MAX_PRESIGNED_URL_EXPIRY = 604_800;
const MIN_PRESIGNED_URL_EXPIRY = 1;
const DEFAULT_PRESIGNED_URL_EXPIRY = 300;

/** `DeleteObjects` refuses more per call (measured: `MalformedXML` at 1001). */
const DELETE_OBJECTS_MAX_KEYS = 1000;

const R2_NOT_CONFIGURED =
  'R2 is not configured. Please check environment variables.';

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
  forcePathStyle: true,
  // The signing scope Cloudflare documents. `weur` (the location hint) was also
  // accepted when measured, but a hint is not a signing region.
  region: 'auto',
});

export type BucketType = 'public' | 'private';

/**
 * The visibilities this deployment can store, decided once from which bucket
 * names are configured. `lib/env.server.ts` enforces the combinations that make
 * sense; this only reports which halves exist.
 */
export const ENABLED_VISIBILITIES: ReadonlySet<BucketType> =
  new Set<BucketType>([
    ...(R2_PUBLIC_BUCKET ? (['public'] as const) : []),
    ...(R2_PRIVATE_BUCKET ? (['private'] as const) : []),
  ]);

export function isVisibilityEnabled(bucketType: BucketType): boolean {
  return ENABLED_VISIBILITIES.has(bucketType);
}

/**
 * Resolves a bucket, or refuses. `validateR2Config` does NOT cover this: it
 * checks the three credential variables only, so without this an unset bucket
 * reaches the AWS SDK as `Bucket: undefined`.
 */
const getBucketName = (bucketType: BucketType): string => {
  const bucket = bucketType === 'public' ? R2_PUBLIC_BUCKET : R2_PRIVATE_BUCKET;
  if (!bucket)
    throw new Error(
      `R2 is not configured: ${
        bucketType === 'public' ? 'R2_PUBLIC_BUCKET' : 'R2_PRIVATE_BUCKET'
      } is unset.`
    );
  return bucket;
};

/**
 * Per-segment percent-encoding, for the two places a key travels inside a URL
 * or a header rather than as a request parameter: `x-amz-copy-source` and the
 * public URL. Measured: a raw key with a space or Arabic letters in
 * `CopySource` throws `TypeError: Invalid character in header content`.
 */
function encodeObjectKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function errorField(error: unknown, field: string): unknown {
  return error && typeof error === 'object' && field in error
    ? Reflect.get(error, field)
    : undefined;
}

function httpStatusOf(error: unknown): number | undefined {
  const metadata = errorField(error, '$metadata');
  const status = errorField(metadata, 'httpStatusCode');
  return typeof status === 'number' ? status : undefined;
}

/** `HeadObject` on a missing key (`NotFound`), or `GetObject`/`CopyObject` on one (`NoSuchKey`). */
function isNotFoundError(error: unknown): boolean {
  const name = errorField(error, 'name');
  return (
    name === 'NotFound' || name === 'NoSuchKey' || httpStatusOf(error) === 404
  );
}

/** `PutObject` with `If-None-Match: *` against a key that already exists (measured: 412). */
export function isPreconditionFailedError(error: unknown): boolean {
  return (
    errorField(error, 'name') === 'PreconditionFailed' ||
    httpStatusOf(error) === 412
  );
}

export async function uploadToR2(params: {
  file: Buffer;
  key: string;
  bucketType: BucketType;
  contentType: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
  /**
   * Hex SHA-256 of `file`. Sent as the object's checksum, which R2 verifies on
   * the write and returns on a later `HeadObject` of that object (measured; a
   * copy does not inherit it).
   */
  sha256?: string;
  /**
   * Refuse to overwrite: `If-None-Match: *`. Every key this application writes
   * is derived from a fresh row id, so something at the key is either a bug or
   * this client's own retry of a write that committed and lost its response;
   * `lib/media/upload.ts` tells the two apart with a `HeadObject` rather than
   * assuming.
   */
  ifNoneMatch?: boolean;
}): Promise<{ success: boolean; key: string }> {
  const {
    file,
    key,
    bucketType,
    contentType,
    cacheControl,
    contentDisposition,
    metadata,
    sha256,
    ifNoneMatch,
  } = params;

  if (!validateR2Config) throw new Error(R2_NOT_CONFIGURED);

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
      ...(sha256 && {
        ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
      }),
      ...(ifNoneMatch && { IfNoneMatch: '*' }),
    })
  );

  return { success: true, key };
}

export async function deleteFromR2(params: {
  key: string;
  bucketType: BucketType;
}): Promise<{ success: boolean }> {
  const { key, bucketType } = params;

  if (!validateR2Config) throw new Error(R2_NOT_CONFIGURED);

  const bucket = getBucketName(bucketType);

  await r2Client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  return { success: true };
}

/**
 * Batch delete, chunked to the per-call ceiling.
 *
 * A missing key is reported by R2 as deleted (measured), so a retry of a
 * half-finished batch is clean. `failed` carries the keys R2 refused inside an
 * otherwise successful call; a call that throws as a whole propagates, because
 * then nothing about the chunk is known.
 */
export async function deleteObjectsFromR2(params: {
  keys: readonly string[];
  bucketType: BucketType;
}): Promise<{ deleted: string[]; failed: string[] }> {
  const { keys, bucketType } = params;
  if (!validateR2Config) throw new Error(R2_NOT_CONFIGURED);
  const bucket = getBucketName(bucketType);

  const deleted: string[] = [];
  const failed: string[] = [];
  for (let start = 0; start < keys.length; start += DELETE_OBJECTS_MAX_KEYS) {
    const chunk = keys.slice(start, start + DELETE_OBJECTS_MAX_KEYS);
    const result = await r2Client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      })
    );
    const refused = new Set(
      (result.Errors ?? []).flatMap((entry) =>
        typeof entry.Key === 'string' ? [entry.Key] : []
      )
    );
    for (const key of chunk) (refused.has(key) ? failed : deleted).push(key);
  }
  return { deleted, failed };
}

/**
 * Server-side copy, within a bucket or across the two.
 *
 * `replace` restates the object's headers (`MetadataDirective: REPLACE`); without
 * it R2 copies them verbatim (`COPY`, measured). A cross-bucket copy MUST
 * replace: a private object carries `Cache-Control: private, no-store`, which is
 * wrong on the public bucket, and vice versa.
 */
export async function copyFileInR2(params: {
  sourceKey: string;
  destinationKey: string;
  bucketType: BucketType;
  /** Defaults to `bucketType`: a copy within one bucket. */
  sourceBucketType?: BucketType;
  replace?: {
    contentType: string;
    cacheControl: string;
    contentDisposition?: string;
    metadata?: Record<string, string>;
  };
}): Promise<{ success: boolean; newKey: string }> {
  const { sourceKey, destinationKey, bucketType, replace } = params;

  if (!validateR2Config) throw new Error(R2_NOT_CONFIGURED);

  const bucket = getBucketName(bucketType);
  const sourceBucket = getBucketName(params.sourceBucketType ?? bucketType);

  await r2Client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${sourceBucket}/${encodeObjectKey(sourceKey)}`,
      Key: destinationKey,
      ...(replace && {
        MetadataDirective: 'REPLACE',
        ContentType: replace.contentType,
        CacheControl: replace.cacheControl,
        ContentDisposition: replace.contentDisposition,
        Metadata: replace.metadata,
      }),
    })
  );

  return { success: true, newKey: destinationKey };
}

export interface ObjectHead {
  contentLength: number | null;
  contentType: string | null;
  /** Quoted, as R2 returns it. The content MD5 for a single-part object (measured). */
  etag: string | null;
  /** Base64, present only for an object written with `sha256` (measured: not carried by a copy). */
  checksumSha256: string | null;
}

/** `null` when the key does not exist; every other failure propagates. */
export async function headObjectInR2(params: {
  key: string;
  bucketType: BucketType;
}): Promise<ObjectHead | null> {
  if (!validateR2Config) throw new Error(R2_NOT_CONFIGURED);
  const bucket = getBucketName(params.bucketType);
  try {
    const head = await r2Client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: params.key,
        ChecksumMode: 'ENABLED',
      })
    );
    return {
      contentLength:
        typeof head.ContentLength === 'number' ? head.ContentLength : null,
      contentType: head.ContentType ?? null,
      etag: head.ETag ?? null,
      checksumSha256: head.ChecksumSHA256 ?? null,
    };
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export interface ListedObject {
  key: string;
  size: number;
}

/**
 * One page of keys under a prefix. R2 caps a page at 1000 whatever `maxKeys`
 * asks for (measured), so callers loop on `nextContinuationToken`.
 */
export async function listObjectsInR2(params: {
  bucketType: BucketType;
  prefix: string;
  continuationToken?: string;
}): Promise<{ objects: ListedObject[]; nextContinuationToken: string | null }> {
  if (!validateR2Config) throw new Error(R2_NOT_CONFIGURED);
  const bucket = getBucketName(params.bucketType);
  const page = await r2Client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: params.prefix,
      MaxKeys: 1000,
      ContinuationToken: params.continuationToken,
    })
  );
  return {
    objects: (page.Contents ?? []).flatMap((entry) =>
      typeof entry.Key === 'string'
        ? [{ key: entry.Key, size: entry.Size ?? 0 }]
        : []
    ),
    nextContinuationToken: page.IsTruncated
      ? (page.NextContinuationToken ?? null)
      : null,
  };
}

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

  if (!validateR2Config) throw new Error(R2_NOT_CONFIGURED);

  const validExpiry = Math.max(
    MIN_PRESIGNED_URL_EXPIRY,
    Math.min(expiresIn, MAX_PRESIGNED_URL_EXPIRY)
  );

  if (validExpiry !== expiresIn) {
    // One JSON object with a dotted `msg`, like every other log call here —
    // `lib/http/after-response.ts` defines the shape. `warn`, not `error`: the
    // value was successfully clamped and the request proceeds.
    console.warn(
      JSON.stringify({
        msg: 'r2.presign expiry clamped',
        requested: expiresIn,
        used: validExpiry,
        min: MIN_PRESIGNED_URL_EXPIRY,
        max: MAX_PRESIGNED_URL_EXPIRY,
      })
    );
  }

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
}

/**
 * Whether public objects can be addressed without signing. Absent in
 * development is supported (`lib/env.server.ts`); the URL builders then fall
 * back to a presigned GET on the public bucket, which works but expires.
 */
export function hasPublicUrl(): boolean {
  return Boolean(R2_PUBLIC_URL);
}

export function getPublicUrl(key: string): string {
  if (!R2_PUBLIC_URL) {
    throw new Error(
      'R2_PUBLIC_URL not configured. ' +
        'Attach a custom domain to the public bucket and add R2_PUBLIC_URL to .env'
    );
  }

  return `${R2_PUBLIC_URL}/${encodeObjectKey(key)}`;
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
    mimeType.includes('excel') ||
    mimeType.includes('spreadsheet')
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

/**
 * PRESENCE only, for every field.
 *
 * `app/api/health/storage/handler.ts` states the rule for this codebase one
 * directory away: _"The body reports status only: no paths, schema contents, or
 * row counts."_ A status function that is safe only because nothing calls it is
 * one route away from not being safe.
 *
 * @knipignore
 */
export function getR2ConfigStatus() {
  return {
    configured: validateR2Config,
    accountId: !!R2_ACCOUNT_ID,
    accessKeyId: !!R2_ACCESS_KEY_ID,
    secretAccessKey: !!R2_SECRET_ACCESS_KEY,
    publicBucket: !!R2_PUBLIC_BUCKET,
    privateBucket: !!R2_PRIVATE_BUCKET,
    publicUrl: !!R2_PUBLIC_URL,
  };
}
