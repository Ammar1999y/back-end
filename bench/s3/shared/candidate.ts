/**
 * A candidate port of `lib/r2/client.ts` to Bun's S3 client.
 *
 * **Benchmark code. Nothing imports this but the tests in this directory**, and
 * it is here to answer one question with something runnable rather than with an
 * opinion: what does `lib/r2/client.ts` have to look like after the migration,
 * and what can it no longer do?
 *
 * The answer it encodes, measured by `candidate.test.ts`:
 *
 * - `deleteFromR2` and `getPresignedUrl` port to Bun outright. Same wire bytes,
 *   same URL parameters, one fewer dependency.
 * - `uploadToR2` does not. Bun's `S3Options` has no `cacheControl` and no
 *   custom-metadata field, and `write()` **silently drops** both — no throw, no
 *   header, no warning. `getCacheControlHeader` exists precisely to set
 *   `Cache-Control` on public images, and `uploadImagesToR2` sends
 *   `originalMimeType`/`originalSize` as object metadata, so dropping them is a
 *   loss of function rather than a detail. When either is asked for, this
 *   implementation signs the `PUT` itself (see `../shared/sigv4.ts`) and keeps
 *   the header.
 * - `copyFileInR2` has no Bun equivalent at all — `S3Client` exposes
 *   `delete/exists/file/list/presign/size/stat/unlink/write` and nothing else,
 *   and a copy cannot go through `presign()` because S3 rejects an `x-amz-*`
 *   header the signature does not cover. It takes the same signed path.
 *
 * So the shape of the migration is: Bun for the object verbs, a ~120-line SigV4
 * helper for the three headers Bun cannot express. Whether that trade is worth
 * making is `README.md`'s subject, not this file's.
 */
import { S3Client } from 'bun';
import type { BucketType } from '@/lib/r2/client';

import { signRequest, uriEncode } from './sigv4';

export interface CandidateConfig {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  region: string;
  publicBucket: string;
  privateBucket: string;
  /**
   * When false, `uploadToR2` never leaves Bun's client, so a test can measure
   * what a Bun-only port actually loses instead of taking this file's word.
   */
  allowSignedFallback?: boolean;
}

/** Same three bounds as `lib/r2/client.ts`, and for the same reason. */
const MAX_PRESIGNED_URL_EXPIRY = 604_800;
const MIN_PRESIGNED_URL_EXPIRY = 1;
const DEFAULT_PRESIGNED_URL_EXPIRY = 300;

/**
 * Percent-encodes a key for a URL path: every segment escaped, the separators
 * left alone. `encodeURIComponent` on the whole key would escape `/` and bury
 * the prefix structure that `temp/` keys and the retention sweep depend on.
 */
function encodeKey(key: string): string {
  return key.split('/').map(uriEncode).join('/');
}

export function createCandidateClient(config: CandidateConfig) {
  const {
    accessKeyId,
    secretAccessKey,
    endpoint,
    region,
    publicBucket,
    privateBucket,
    allowSignedFallback = true,
  } = config;

  const bucketOf = (bucketType: BucketType) =>
    bucketType === 'public' ? publicBucket : privateBucket;

  const client = (bucketType: BucketType) =>
    new S3Client({
      accessKeyId,
      secretAccessKey,
      bucket: bucketOf(bucketType),
      endpoint,
      region,
    });

  /**
   * The escape hatch: a `PUT` signed here so it can carry headers `S3Options`
   * has no field for.
   *
   * It also signs the real body hash rather than `UNSIGNED-PAYLOAD`, which is
   * what Bun sends — so on this path the signature covers the bytes, as
   * `@aws-sdk/client-s3` does today.
   */
  async function signedPut(params: {
    bucketType: BucketType;
    key: string;
    body: Uint8Array<ArrayBuffer>;
    headers: Record<string, string>;
  }): Promise<void> {
    const bucket = bucketOf(params.bucketType);
    const signed = signRequest({
      method: 'PUT',
      url: `${endpoint}/${bucket}/${encodeKey(params.key)}`,
      headers: params.headers,
      credentials: { accessKeyId, secretAccessKey, region },
      payloadSha256: new Bun.CryptoHasher('sha256')
        .update(params.body)
        .digest('hex'),
    });

    const response = await fetch(signed.url, {
      method: 'PUT',
      headers: signed.headers,
      body: params.body,
    });
    if (!response.ok)
      throw new Error(
        `signed PUT failed: ${response.status} ${await response.text()}`
      );
  }

  return {
    async uploadToR2(params: {
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

      // An empty metadata object is what `uploadImagesToR2` passes for a
      // non-optimised image, and aws-sdk sends no `x-amz-meta-*` for it — so it
      // must not be what pushes this off Bun's own path.
      const metadataEntries = Object.entries(metadata ?? {});
      const needsUnsupportedHeaders =
        Boolean(cacheControl) || metadataEntries.length > 0;

      if (needsUnsupportedHeaders && allowSignedFallback) {
        await signedPut({
          bucketType,
          // Copied into an `ArrayBuffer`-backed view: `Buffer` is
          // `Uint8Array<ArrayBufferLike>`, which `fetch`'s `BodyInit` rejects.
          key,
          body: new Uint8Array(file),
          headers: {
            'content-type': contentType,
            ...(cacheControl && { 'cache-control': cacheControl }),
            ...(contentDisposition && {
              'content-disposition': contentDisposition,
            }),
            ...Object.fromEntries(
              metadataEntries.map(([name, value]) => [
                `x-amz-meta-${name.toLowerCase()}`,
                value,
              ])
            ),
          },
        });
        return { success: true, key };
      }

      await client(bucketType).write(key, file, {
        type: contentType,
        ...(contentDisposition && { contentDisposition }),
      });
      return { success: true, key };
    },

    async deleteFromR2(params: {
      key: string;
      bucketType: BucketType;
    }): Promise<{ success: boolean }> {
      await client(params.bucketType).delete(params.key);
      return { success: true };
    },

    /**
     * Server-side copy, which Bun cannot express. Same `x-amz-copy-source` form
     * `@aws-sdk/client-s3` sends today — `bucket/key`, no leading slash — so the
     * request R2 receives is unchanged.
     */
    async copyFileInR2(params: {
      sourceKey: string;
      destinationKey: string;
      bucketType: BucketType;
    }): Promise<{ success: boolean; newKey: string }> {
      const { sourceKey, destinationKey, bucketType } = params;
      const bucket = bucketOf(bucketType);
      await signedPut({
        bucketType,
        key: destinationKey,
        body: new Uint8Array(0),
        headers: { 'x-amz-copy-source': `${bucket}/${sourceKey}` },
      });
      return { success: true, newKey: destinationKey };
    },

    /**
     * `Promise<string>` although `presign` is synchronous: the exported contract
     * is already a promise and narrowing it is a separate breaking change.
     *
     * The clamp is not cosmetic after the migration — it is load-bearing in both
     * directions. Bun throws `ERR_INVALID_ARG_TYPE` on `expiresIn <= 0`, where
     * aws-sdk signed it happily; and Bun signs an expiry beyond seven days
     * without complaint, where aws-sdk threw. Removing the clamp swaps a caught
     * mistake for a URL R2 rejects at use time.
     */
    async getPresignedUrl(params: {
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

      const validExpiry = Math.max(
        MIN_PRESIGNED_URL_EXPIRY,
        Math.min(expiresIn, MAX_PRESIGNED_URL_EXPIRY)
      );
      if (validExpiry !== expiresIn)
        console.error(
          `[R2] Expiry time ${expiresIn}s is out of range. Using ${validExpiry}s instead. ` +
            `Valid range: ${MIN_PRESIGNED_URL_EXPIRY}-${MAX_PRESIGNED_URL_EXPIRY} seconds`
        );

      return client(bucketType).presign(key, {
        expiresIn: validExpiry,
        method: 'GET',
        ...(responseContentDisposition && {
          contentDisposition: responseContentDisposition,
        }),
        ...(responseContentType && { type: responseContentType }),
      });
    },
  };
}

export type CandidateClient = ReturnType<typeof createCandidateClient>;
