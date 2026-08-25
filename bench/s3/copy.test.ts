/**
 * `copyFileInR2` — the one operation in `lib/r2/client.ts` that Bun's S3 client
 * cannot express at all.
 *
 * It has no callers today (nothing in the application imports it), so it does
 * not block the migration in the way a missing `Cache-Control` would. It is
 * still part of the module's exported contract and it exists for a stated
 * purpose — "copy a file to a new location, orphan cleanup is handled by cron"
 * — which is the attach-an-upload-to-a-record step the retention sweep is
 * waiting for. Dropping it silently would delete a planned feature.
 *
 * So this file establishes three things: that Bun has no copy, that the obvious
 * workaround is not available either, and that a correct one exists.
 */
import { S3Client } from 'bun';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { CopyObjectCommand } from '@aws-sdk/client-s3';

import {
  awsClient,
  bunClient,
  CREDENTIALS,
  PUBLIC_BUCKET,
  REGION,
} from './shared/clients';
import { assertLocalOnly, startFakeS3 } from './shared/fake-s3';
import {
  signRequest,
  verifyPresignedUrl,
  verifyRecordedRequest,
} from './shared/sigv4';

const origin = await startFakeS3();
const aws = awsClient(origin);
const bun = bunClient(origin);

const SOURCE_KEY = 'temp/0f1e2d3c4b5a6978_source.webp';
const DESTINATION_KEY = 'projects/5/project/0f1e2d3c4b5a6978_source.webp';
/** Large enough that "did the bytes cross the process" is unambiguous. */
const SOURCE_BODY = 'x'.repeat(64 * 1024);

function seedSource(): void {
  origin.put(`${PUBLIC_BUCKET}/${SOURCE_KEY}`, SOURCE_BODY, {
    'content-type': 'image/webp',
    'cache-control': 'public, max-age=31536000, immutable',
  });
}

beforeEach(() => {
  origin.reset();
  seedSource();
});

afterAll(async () => {
  assertLocalOnly(origin);
  await origin.stop();
});

describe('the gap', () => {
  test('S3Client exposes no copy, move, or rename — on the instance or as a static', () => {
    const instanceMethods = Object.getOwnPropertyNames(S3Client.prototype);
    const statics = Object.getOwnPropertyNames(S3Client);

    // Recorded in full so a future Bun release adding one is visible as a diff
    // here rather than needing to be remembered.
    expect(instanceMethods.sort()).toEqual([
      'constructor',
      'delete',
      'exists',
      'file',
      'list',
      'presign',
      'size',
      'stat',
      'unlink',
      'write',
    ]);
    for (const name of ['copy', 'copyObject', 'move', 'rename']) {
      expect(instanceMethods).not.toContain(name);
      expect(statics).not.toContain(name);
    }
  });

  test('nor does S3File', () => {
    const file = bun.file(SOURCE_KEY);
    const members = [
      ...Object.getOwnPropertyNames(file),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(file) ?? {}),
    ];
    for (const name of ['copy', 'copyTo', 'move', 'rename']) {
      expect(members).not.toContain(name);
    }
  });
});

describe('what aws-sdk does today', () => {
  test('a server-side copy: one PUT, no body, x-amz-copy-source', async () => {
    await aws.send(
      new CopyObjectCommand({
        Bucket: PUBLIC_BUCKET,
        CopySource: `${PUBLIC_BUCKET}/${SOURCE_KEY}`,
        Key: DESTINATION_KEY,
      })
    );

    const request = origin.one('PUT');
    expect(request.body.byteLength).toBe(0);
    // No leading slash — this is the exact string `lib/r2/client.ts` builds as
    // `${bucket}/${sourceKey}`, and any replacement has to match it.
    expect(request.headers['x-amz-copy-source']).toBe(
      `${PUBLIC_BUCKET}/${SOURCE_KEY}`
    );
    expect(
      verifyRecordedRequest(request, CREDENTIALS.secretAccessKey).signedHeaders
    ).toContain('x-amz-copy-source');
    expect(
      origin.objects.get(`${PUBLIC_BUCKET}/${DESTINATION_KEY}`)?.body.byteLength
    ).toBe(SOURCE_BODY.length);
  });
});

describe('workaround A — read the object and write it back', () => {
  test('works, but moves the whole body through this process', async () => {
    const source = bun.file(SOURCE_KEY);
    const stat = await source.stat();
    await bun.write(DESTINATION_KEY, await source.bytes(), { type: stat.type });

    expect(origin.requests.map((request) => request.method)).toEqual([
      'HEAD',
      'GET',
      'PUT',
    ]);
    // Three round trips instead of one, and 64 KB in and 64 KB out per copy
    // where the server-side copy transferred nothing.
    expect(origin.one('GET').body.byteLength).toBe(0);
    expect(origin.one('PUT').body.byteLength).toBe(SOURCE_BODY.length);
    expect(
      origin.objects.get(`${PUBLIC_BUCKET}/${DESTINATION_KEY}`)?.body.byteLength
    ).toBe(SOURCE_BODY.length);
  });

  test('and loses Cache-Control, because Bun cannot set it on the way back', async () => {
    // `stat()` does not report `Cache-Control` and `write()` cannot send it, so
    // a public image copied this way stops being cacheable — the same loss as
    // `production-ops.test.ts` records for the upload path, arriving by a
    // different route.
    const stat = await bun.stat(SOURCE_KEY);
    expect(Object.keys(stat)).toEqual([]);
    expect(stat.type).toBe('image/webp');
    expect(
      (stat as unknown as Record<string, unknown>).cacheControl
    ).toBeUndefined();

    await bun.write(DESTINATION_KEY, await bun.file(SOURCE_KEY).bytes(), {
      type: stat.type,
    });
    expect(origin.one('PUT').headers['cache-control']).toBeUndefined();
  });
});

describe('workaround B — a presigned PUT carrying x-amz-copy-source', () => {
  test('cannot work: presign signs only `host`, and S3 refuses unsigned x-amz-* headers', () => {
    const url = bun.presign(DESTINATION_KEY, {
      method: 'PUT',
      expiresIn: 60,
    });
    const verification = verifyPresignedUrl(
      url,
      CREDENTIALS.secretAccessKey,
      'PUT'
    );

    expect(verification.valid).toBe(true);
    // This is the disqualifying fact, and it is a property of Bun's presigner
    // rather than of any particular server: there is no way to get
    // `x-amz-copy-source` into the signature, and S3 rejects a request that
    // presents an `x-amz-*` header the signature does not cover.
    expect(verification.signedHeaders).toEqual(['host']);
  });

  test("this benchmark's origin accepts it anyway, which is why it is not the answer", async () => {
    // Stated explicitly so nobody reads a green test as "verified against R2".
    // The fake origin does not enforce the signed-header rule, so the copy
    // succeeds here and would fail against Cloudflare. Untested against real R2.
    const url = bun.presign(DESTINATION_KEY, { method: 'PUT', expiresIn: 60 });
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'x-amz-copy-source': `${PUBLIC_BUCKET}/${SOURCE_KEY}` },
    });

    expect(response.status).toBe(200);
    expect(
      verifyRecordedRequest(origin.one('PUT'), CREDENTIALS.secretAccessKey)
        .presented
    ).toBe('');
  });
});

describe('workaround C — sign the copy request directly', () => {
  test('one PUT, no body, valid signature covering x-amz-copy-source', async () => {
    const signed = signRequest({
      method: 'PUT',
      url: `${origin.url}/${PUBLIC_BUCKET}/${DESTINATION_KEY.split('/')
        .map(encodeURIComponent)
        .join('/')}`,
      headers: { 'x-amz-copy-source': `${PUBLIC_BUCKET}/${SOURCE_KEY}` },
      credentials: { ...CREDENTIALS, region: REGION },
    });
    const response = await fetch(signed.url, {
      method: 'PUT',
      headers: signed.headers,
    });

    expect(response.status).toBe(200);
    const request = origin.one('PUT');
    const verification = verifyRecordedRequest(
      request,
      CREDENTIALS.secretAccessKey
    );
    expect(verification.valid).toBe(true);
    expect(verification.signedHeaders).toContain('x-amz-copy-source');
    // Same wire shape as aws-sdk's: nothing crosses the process.
    expect(request.body.byteLength).toBe(0);
    expect(
      origin.objects.get(`${PUBLIC_BUCKET}/${DESTINATION_KEY}`)?.body.byteLength
    ).toBe(SOURCE_BODY.length);
  });

  test('the copy-source string is byte-identical to what aws-sdk sends', async () => {
    await aws.send(
      new CopyObjectCommand({
        Bucket: PUBLIC_BUCKET,
        CopySource: `${PUBLIC_BUCKET}/${SOURCE_KEY}`,
        Key: DESTINATION_KEY,
      })
    );
    const fromAws = origin.one('PUT');

    origin.reset();
    seedSource();
    const signed = signRequest({
      method: 'PUT',
      url: `${origin.url}${fromAws.path}`,
      headers: { 'x-amz-copy-source': `${PUBLIC_BUCKET}/${SOURCE_KEY}` },
      credentials: { ...CREDENTIALS, region: REGION },
    });
    await fetch(signed.url, { method: 'PUT', headers: signed.headers });
    const fromSigned = origin.one('PUT');

    expect(fromSigned.headers['x-amz-copy-source']).toBe(
      fromAws.headers['x-amz-copy-source']
    );
    expect(fromSigned.path).toBe(fromAws.path);
  });

  test('a missing source fails on both paths, with S3 error semantics intact', async () => {
    origin.reset(); // no source seeded

    await expect(
      aws.send(
        new CopyObjectCommand({
          Bucket: PUBLIC_BUCKET,
          CopySource: `${PUBLIC_BUCKET}/gone.webp`,
          Key: DESTINATION_KEY,
        })
      )
    ).rejects.toThrow();

    const signed = signRequest({
      method: 'PUT',
      url: `${origin.url}/${PUBLIC_BUCKET}/${DESTINATION_KEY}`,
      headers: { 'x-amz-copy-source': `${PUBLIC_BUCKET}/gone.webp` },
      credentials: { ...CREDENTIALS, region: REGION },
    });
    const response = await fetch(signed.url, {
      method: 'PUT',
      headers: signed.headers,
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('NoSuchKey');
  });
});
