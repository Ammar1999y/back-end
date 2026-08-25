/**
 * The port, run against the original.
 *
 * `shared/candidate.ts` is `lib/r2/client.ts` rewritten onto Bun's S3 client,
 * with a hand-signed `PUT` for the three headers Bun cannot express. This file
 * runs both implementations against the same origin with the same arguments and
 * compares what R2 would end up holding — which is the only comparison that
 * settles feasibility, because every difference found elsewhere in this suite is
 * a difference in a header, and headers are what the objects are made of.
 *
 * It also pins the blast radius. Five of the nine exports in `lib/r2/client.ts`
 * never touch S3 at all, and the first block below is what makes that a measured
 * claim rather than an eyeballed one.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getCacheControlHeader, getContentDisposition } from '@/lib/r2/client';

import { createCandidateClient } from './shared/candidate';
import {
  ASCII_KEY,
  awsClient,
  CREDENTIALS,
  PRIVATE_BUCKET,
  PUBLIC_BUCKET,
  REGION,
} from './shared/clients';
import { assertLocalOnly, startFakeS3 } from './shared/fake-s3';
import { verifyPresignedUrl, verifyRecordedRequest } from './shared/sigv4';

const origin = await startFakeS3();
const aws = awsClient(origin);

const config = {
  ...CREDENTIALS,
  endpoint: origin.url,
  region: REGION,
  publicBucket: PUBLIC_BUCKET,
  privateBucket: PRIVATE_BUCKET,
};
const candidate = createCandidateClient(config);
/** The same port with the escape hatch disabled, to measure Bun alone. */
const bunOnly = createCandidateClient({
  ...config,
  allowSignedFallback: false,
});

/** Exactly what `uploadImagesToR2` passes for an optimised public image. */
const UPLOAD = {
  file: Buffer.from('webp-bytes-would-be-here'),
  key: ASCII_KEY,
  bucketType: 'public' as const,
  contentType: 'image/webp',
  cacheControl: getCacheControlHeader({
    mimeType: 'image/webp',
    isPublic: true,
  }),
  contentDisposition: getContentDisposition({
    filename: ASCII_KEY.slice(ASCII_KEY.lastIndexOf('/') + 1),
    inline: true,
  }),
  metadata: { originalMimeType: 'image/png', originalSize: '4096' },
};

/** The headers the origin ended up storing against the object. */
const storedHeaders = (bucket: string, key: string) => {
  const stored = origin.objects.get(`${bucket}/${key}`);
  if (!stored) throw new Error(`nothing stored at ${bucket}/${key}`);
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(stored.headers))
    if (
      name === 'content-type' ||
      name === 'cache-control' ||
      name === 'content-disposition' ||
      name.startsWith('x-amz-meta-')
    )
      kept[name] = value;
  return kept;
};

beforeEach(() => {
  origin.reset();
});

afterAll(async () => {
  assertLocalOnly(origin);
  await origin.stop();
});

describe('what the migration does not touch', () => {
  test('the two header builders the upload path uses are pure, and port unchanged', () => {
    // Called against the real module, not a copy, because their return values
    // are what the rest of this suite asserts on the wire.
    expect(
      getCacheControlHeader({ mimeType: 'image/webp', isPublic: true })
    ).toBe('public, max-age=31536000, immutable');
    expect(
      getCacheControlHeader({ mimeType: 'image/webp', isPublic: false })
    ).toBe('private, no-cache, no-store, must-revalidate');
    expect(
      getCacheControlHeader({ mimeType: 'application/pdf', isPublic: true })
    ).toBe('public, max-age=3600');
    expect(
      getCacheControlHeader({ mimeType: 'application/zip', isPublic: true })
    ).toBe('public, max-age=86400');

    expect(getContentDisposition({ filename: 'a b.webp' })).toBe(
      'attachment; filename="a b.webp"; filename*=UTF-8\'\'a%20b.webp'
    );
    expect(
      getContentDisposition({ filename: 'a.webp', inline: true })
    ).toContain('inline;');
  });

  test('the S3 client is reached from exactly four places in the module', async () => {
    // The blast radius, counted rather than described: three `r2Client.send`
    // calls (`uploadToR2`, `deleteFromR2`, `copyFileInR2`) and one
    // `getSignedUrl` (`getPresignedUrl`). The remaining five exports —
    // `getPublicUrl`, `isAllowedMimeType`, `getCacheControlHeader`,
    // `getContentDisposition`, `getR2ConfigStatus` — are string and environment
    // functions the migration cannot affect.
    //
    // Read from source rather than called, deliberately: importing
    // `getPublicUrl` or `isAllowedMimeType` here would give them an importer
    // and silence knip's report that the APPLICATION has no caller for them.
    const source = Bun.file(
      path.join(import.meta.dir, '..', '..', 'lib', 'r2', 'client.ts')
    );
    const text = await source.text();

    expect(text.match(/r2Client\.send\(/g)).toHaveLength(3);
    expect(text.match(/getSignedUrl\(/g)).toHaveLength(1);
    for (const name of [
      'getPublicUrl',
      'isAllowedMimeType',
      'getCacheControlHeader',
      'getContentDisposition',
      'getR2ConfigStatus',
    ]) {
      const body = text.slice(text.indexOf(`export function ${name}`));
      const end = body.indexOf('\n}\n');
      expect(body.slice(0, end)).not.toContain('r2Client');
    }
  });
});

describe('uploadToR2', () => {
  test('a Bun-only port loses Cache-Control and the object metadata', async () => {
    await bunOnly.uploadToR2(UPLOAD);

    expect(storedHeaders(PUBLIC_BUCKET, UPLOAD.key)).toEqual({
      'content-type': 'image/webp',
      'content-disposition': UPLOAD.contentDisposition,
    });
    // The two the pipeline actually sets, gone, with nothing raised.
    expect(
      storedHeaders(PUBLIC_BUCKET, UPLOAD.key)['cache-control']
    ).toBeUndefined();
  });

  test('with the signed fallback, the stored headers match aws-sdk exactly', async () => {
    await aws.send(
      new PutObjectCommand({
        Bucket: PUBLIC_BUCKET,
        Key: UPLOAD.key,
        Body: UPLOAD.file,
        ContentType: UPLOAD.contentType,
        CacheControl: UPLOAD.cacheControl,
        ContentDisposition: UPLOAD.contentDisposition,
        Metadata: UPLOAD.metadata,
      })
    );
    const fromAws = storedHeaders(PUBLIC_BUCKET, UPLOAD.key);

    origin.reset();
    await candidate.uploadToR2(UPLOAD);
    const fromCandidate = storedHeaders(PUBLIC_BUCKET, UPLOAD.key);

    expect(fromCandidate).toEqual(fromAws);
  });

  test('and its signature covers the body, which the aws-sdk path also did', async () => {
    await candidate.uploadToR2(UPLOAD);

    const verification = verifyRecordedRequest(
      origin.one('PUT'),
      CREDENTIALS.secretAccessKey
    );
    expect(verification.valid).toBe(true);
    // Not `UNSIGNED-PAYLOAD`: the signed path restores the payload binding that
    // Bun's own `write()` gives up (see `production-ops.test.ts`).
    expect(verification.payloadMatchesBody).toBe(true);
    expect(verification.signedHeaders).toContain('cache-control');
    expect(verification.signedHeaders).toContain('x-amz-meta-originalmimetype');
  });

  test("an empty metadata object stays on Bun's own path", async () => {
    // What `uploadImagesToR2` passes for an image that was not converted — the
    // spread produces `{}`, and aws-sdk sends no `x-amz-meta-*` for it. It must
    // not be what forces the signed path.
    await candidate.uploadToR2({
      ...UPLOAD,
      cacheControl: undefined,
      metadata: {},
    });

    const verification = verifyRecordedRequest(
      origin.one('PUT'),
      CREDENTIALS.secretAccessKey
    );
    // Bun's own path, identified by what it does not sign: the signed fallback
    // always covers `cache-control` or an `x-amz-meta-*`, and Bun cannot send
    // either. (It does sign `content-disposition`, which it can send — hence
    // testing for absence rather than for a fixed list.)
    expect(verification.signedHeaders).not.toContain('cache-control');
    expect(
      verification.signedHeaders.filter((name) =>
        name.startsWith('x-amz-meta-')
      )
    ).toEqual([]);
    expect(verification.payloadMatchesBody).toBeUndefined();
  });

  test('returns the same shape the current implementation returns', async () => {
    expect(await candidate.uploadToR2(UPLOAD)).toEqual({
      success: true,
      key: UPLOAD.key,
    });
  });

  test('writes to the private bucket when asked', async () => {
    await candidate.uploadToR2({ ...UPLOAD, bucketType: 'private' });
    expect(origin.one('PUT').path.startsWith(`/${PRIVATE_BUCKET}/`)).toBe(true);
  });

  test('rejects on an S3 failure, which is what the rollback path needs', async () => {
    // `uploadImagesToR2` deletes already-uploaded keys when a later upload
    // fails. That branch is unreachable unless the failure propagates.
    origin.failNext('PUT', 403, 'AccessDenied', 1);
    await expect(candidate.uploadToR2(UPLOAD)).rejects.toThrow();

    origin.reset();
    origin.failNext('PUT', 403, 'AccessDenied', 1);
    await expect(
      bunOnly.uploadToR2({ ...UPLOAD, cacheControl: undefined, metadata: {} })
    ).rejects.toThrow();
  });
});

describe('deleteFromR2', () => {
  test('same path and empty body as aws-sdk, and the same return shape', async () => {
    await aws.send(
      new DeleteObjectCommand({ Bucket: PUBLIC_BUCKET, Key: ASCII_KEY })
    );
    const fromAws = origin.one('DELETE');

    origin.reset();
    const result = await candidate.deleteFromR2({
      key: ASCII_KEY,
      bucketType: 'public',
    });
    const fromCandidate = origin.one('DELETE');

    expect(result).toEqual({ success: true });
    expect(fromCandidate.path).toBe(fromAws.path);
    expect(fromCandidate.body.byteLength).toBe(0);
  });

  test('rejects on failure, which is what sweepTempFiles counts', async () => {
    origin.failNext('DELETE', 500, 'InternalError', 1);
    await expect(
      candidate.deleteFromR2({ key: ASCII_KEY, bucketType: 'public' })
    ).rejects.toThrow();
  });
});

describe('copyFileInR2', () => {
  test('same request as aws-sdk: one PUT, no body, identical copy-source', async () => {
    const source = 'temp/0f1e2d3c4b5a6978_source.webp';
    const destination = 'projects/5/project/0f1e2d3c4b5a6978_source.webp';
    origin.put(`${PUBLIC_BUCKET}/${source}`, 'x'.repeat(2048));

    await aws.send(
      new CopyObjectCommand({
        Bucket: PUBLIC_BUCKET,
        CopySource: `${PUBLIC_BUCKET}/${source}`,
        Key: destination,
      })
    );
    const fromAws = origin.one('PUT');

    origin.reset();
    origin.put(`${PUBLIC_BUCKET}/${source}`, 'x'.repeat(2048));
    const result = await candidate.copyFileInR2({
      sourceKey: source,
      destinationKey: destination,
      bucketType: 'public',
    });
    const fromCandidate = origin.one('PUT');

    expect(result).toEqual({ success: true, newKey: destination });
    expect(fromCandidate.path).toBe(fromAws.path);
    expect(fromCandidate.headers['x-amz-copy-source']).toBe(
      fromAws.headers['x-amz-copy-source']
    );
    expect(fromCandidate.body.byteLength).toBe(0);
    expect(
      origin.objects.get(`${PUBLIC_BUCKET}/${destination}`)?.body.byteLength
    ).toBe(2048);
  });

  test('a key with a space copies to the same path both ways', async () => {
    const source = ASCII_KEY;
    const destination = 'projects/5/project/photo name (1).webp';
    origin.put(`${PUBLIC_BUCKET}/${source}`, 'abc');

    await aws.send(
      new CopyObjectCommand({
        Bucket: PUBLIC_BUCKET,
        CopySource: `${PUBLIC_BUCKET}/${source}`,
        Key: destination,
      })
    );
    const fromAws = origin.one('PUT').path;

    origin.reset();
    origin.put(`${PUBLIC_BUCKET}/${source}`, 'abc');
    await candidate.copyFileInR2({
      sourceKey: source,
      destinationKey: destination,
      bucketType: 'public',
    });

    expect(origin.one('PUT').path).toBe(fromAws);
  });

  test('rejects when the source is missing', async () => {
    await expect(
      candidate.copyFileInR2({
        sourceKey: 'temp/gone.webp',
        destinationKey: 'projects/5/gone.webp',
        bucketType: 'public',
      })
    ).rejects.toThrow(/NoSuchKey/);
  });
});

describe('getPresignedUrl', () => {
  test('same path and response-content parameters as the aws-sdk version', async () => {
    const disposition = getContentDisposition({
      filename: 'report.webp',
      inline: false,
    });

    const fromAws = new URL(
      await getSignedUrl(
        aws,
        new GetObjectCommand({
          Bucket: PRIVATE_BUCKET,
          Key: ASCII_KEY,
          ResponseContentDisposition: disposition,
          ResponseContentType: 'image/webp',
        }),
        { expiresIn: 300 }
      )
    );
    const fromCandidate = new URL(
      await candidate.getPresignedUrl({
        key: ASCII_KEY,
        bucketType: 'private',
        expiresIn: 300,
        responseContentDisposition: disposition,
        responseContentType: 'image/webp',
      })
    );

    expect(fromCandidate.pathname).toBe(fromAws.pathname);
    for (const name of [
      'response-content-disposition',
      'response-content-type',
      'X-Amz-Expires',
      'X-Amz-Credential',
    ])
      expect(fromCandidate.searchParams.get(name)).toBe(
        fromAws.searchParams.get(name)
      );
    expect(
      verifyPresignedUrl(fromCandidate.href, CREDENTIALS.secretAccessKey).valid
    ).toBe(true);
  });

  test('defaults to five minutes, as the current implementation does', async () => {
    const url = new URL(
      await candidate.getPresignedUrl({ key: ASCII_KEY, bucketType: 'private' })
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  test('clamps below 1 second, which is now the difference between a URL and a throw', async () => {
    const url = new URL(
      await candidate.getPresignedUrl({
        key: ASCII_KEY,
        bucketType: 'private',
        expiresIn: 0,
      })
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('1');
  });

  test('clamps above seven days, which is now the difference between a URL and a 403', async () => {
    const url = new URL(
      await candidate.getPresignedUrl({
        key: ASCII_KEY,
        bucketType: 'private',
        expiresIn: 30 * 24 * 60 * 60,
      })
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('604800');
    expect(
      verifyPresignedUrl(url.href, CREDENTIALS.secretAccessKey).valid
    ).toBe(true);
  });

  test('makes no request, so nothing is charged for a URL nobody uses', async () => {
    await candidate.getPresignedUrl({ key: ASCII_KEY, bucketType: 'private' });
    expect(origin.requests).toHaveLength(0);
  });
});

describe("end to end, the upload pipeline's exact call", () => {
  test('an object written by the port is readable and carries every header', async () => {
    await candidate.uploadToR2(UPLOAD);

    // Read it back through Bun, which is what a later feature would do.
    const url = await candidate.getPresignedUrl({
      key: UPLOAD.key,
      bucketType: 'public',
      expiresIn: 60,
    });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(UPLOAD.file.toString());
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toBe(UPLOAD.cacheControl);
  });

  test('and the rollback path still deletes what it uploaded', async () => {
    // The shape of `uploadImagesToR2`'s cleanup: upload two, fail the database
    // write, delete both with `Promise.allSettled`.
    const keys = [
      'temp/0f1e2d3c4b5a6978_a.webp',
      'temp/0f1e2d3c4b5a6978_b.webp',
    ];
    await Promise.all(
      keys.map((key) => candidate.uploadToR2({ ...UPLOAD, key }))
    );
    expect(origin.objects.has(`${PUBLIC_BUCKET}/${keys[0]}`)).toBe(true);

    const outcomes = await Promise.allSettled(
      keys.map((key) => candidate.deleteFromR2({ key, bucketType: 'public' }))
    );

    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(
      true
    );
    for (const key of keys)
      expect(origin.objects.has(`${PUBLIC_BUCKET}/${key}`)).toBe(false);
  });
});
