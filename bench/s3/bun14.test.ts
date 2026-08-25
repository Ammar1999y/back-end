/**
 * The S3 changes in the Bun 1.4 release notes that `docs/bun-s3.md` does not
 * cover.
 *
 * The guide in `docs/` documents the API as it stands; the release post
 * (https://bun.com/blog/bun-v1.4) lists behaviour that changed on the way here.
 * Three of those items decide whether a migration is even worth planning — a
 * `queueSize` that used to be ignored, a `Range` header that used to be dropped,
 * and a `Content-Length: 0` response that used to be read as a broken
 * connection — so they are asserted rather than trusted.
 *
 * Items already covered elsewhere are named with their home rather than
 * duplicated:
 *
 * - `slice(0, N).stream()` sends the correct `Range` — `read.test.ts`.
 * - `queueSize` is respected instead of being forced to 255 — `multipart.test.ts`.
 * - `writer()` accepts `contentDisposition` and `contentEncoding` — `multipart.test.ts`.
 * - `presign()` honours `contentDisposition` and `type` — `presign.test.ts`.
 * - `Bun.s3` rejects CR/LF in `contentDisposition`, `contentEncoding`, `type` —
 *   `errors.test.ts`.
 *
 * Two are not testable from here and are recorded in `README.md` instead: the
 * fixed memory leak in `list()`, and the fixed leak when a download stream is
 * cancelled while its socket is idle.
 */
import { S3Client } from 'bun';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  bunClient,
  CREDENTIALS,
  PUBLIC_BUCKET,
  REGION,
} from './shared/clients';
import { assertLocalOnly, startFakeS3 } from './shared/fake-s3';

const origin = await startFakeS3();
const bun = bunClient(origin);

const MEGABYTE = 1024 * 1024;

beforeEach(() => {
  origin.reset();
});

afterAll(async () => {
  assertLocalOnly(origin);
  await origin.stop();
});

describe('requestPayer, for Requester Pays buckets', () => {
  const payer = () =>
    new S3Client({
      ...CREDENTIALS,
      bucket: PUBLIC_BUCKET,
      endpoint: origin.url,
      region: REGION,
      requestPayer: true,
    });

  test('set on the client, it rides on every verb', async () => {
    const client = payer();

    await client.write('rp.txt', 'x');
    expect(origin.one('PUT').headers['x-amz-request-payer']).toBe('requester');

    origin.reset();
    await client.delete('rp.txt');
    expect(origin.one('DELETE').headers['x-amz-request-payer']).toBe(
      'requester'
    );

    origin.reset();
    origin.put(`${PUBLIC_BUCKET}/rp.txt`, 'abc');
    await client.file('rp.txt').text();
    expect(origin.one('GET').headers['x-amz-request-payer']).toBe('requester');
  });

  test('or per operation', async () => {
    await bun.write('rp.txt', 'x', { requestPayer: true });
    expect(origin.one('PUT').headers['x-amz-request-payer']).toBe('requester');
  });

  test('and on every request of a multipart upload, including each part', async () => {
    // The release note is specific about this — "including each part of a
    // multipart upload" — because a header missing from one part fails the whole
    // upload on a Requester Pays bucket.
    const writer = payer()
      .file('rp-multipart.bin')
      .writer({ partSize: 5 * MEGABYTE });
    writer.write(Buffer.alloc(5 * MEGABYTE, 0x61));
    await writer.flush();
    writer.write(Buffer.from('tail'));
    await writer.end();

    expect(origin.requests.length).toBeGreaterThan(3);
    for (const request of origin.requests)
      expect(request.headers['x-amz-request-payer']).toBe('requester');
  }, 20_000);

  test('and is absent when not asked for', async () => {
    await bun.write('rp.txt', 'x');
    expect(origin.one('PUT').headers['x-amz-request-payer']).toBeUndefined();
  });
});

describe('write() accepts contentEncoding', () => {
  test('for pre-compressed bodies', async () => {
    // Newly typed too: the notes list `S3Options.contentEncoding` among the
    // `@types/bun` additions, so before this it worked only with a cast.
    await bun.write('compressed.json', Buffer.from('gzipped-bytes'), {
      type: 'application/json',
      contentEncoding: 'gzip',
    });

    const headers = origin.meaningfulHeaders(origin.one('PUT'));
    expect(headers['content-encoding']).toBe('gzip');
    expect(headers['content-type']).toBe('application/json;charset=utf-8');
  });
});

describe('list() entry checksum fields', () => {
  test('checksumAlgorithm is present and enumerable', async () => {
    origin.put(`${PUBLIC_BUCKET}/temp/a.webp`, 'aaa');
    const entry = (await bun.list({ prefix: 'temp/' })).contents?.[0];

    expect(entry?.checksumAlgorithm).toBe('CRC32');
    expect(Object.keys(entry ?? {})).toContain('checksumAlgorithm');
  });

  test('the misspelled checksumAlgorithme still reads but no longer enumerates', async () => {
    // Kept for compatibility, made non-enumerable — so it is gone from
    // `Object.keys()` and from `JSON.stringify()` while still resolving.
    origin.put(`${PUBLIC_BUCKET}/temp/a.webp`, 'aaa');
    const entry = (await bun.list({ prefix: 'temp/' })).contents?.[0] as
      Record<string, unknown> | undefined;

    expect(entry?.['checksumAlgorithme']).toBe('CRC32');
    expect(Object.keys(entry ?? {})).not.toContain('checksumAlgorithme');
    expect(JSON.stringify(entry)).not.toContain('checksumAlgorithme');
  });
});

describe('close-delimited PUT and DELETE responses', () => {
  test('a Content-Length: 0 + Connection: close reply is not read as a broken connection', async () => {
    // The shape of every S3 PUT and DELETE. Before the fix this surfaced as
    // `ConnectionClosed` and drove retries through connection-recycling proxies
    // — which for a DELETE means deleting twice and for a PUT means uploading
    // twice. One request each is the assertion.
    const closing = await startFakeS3({ closeDelimited: true });
    const client = bunClient(closing);

    await client.write('close.txt', 'x', { retry: 3 });
    await client.delete('close.txt');

    expect(closing.of('PUT')).toHaveLength(1);
    expect(closing.of('DELETE')).toHaveLength(1);
    expect(closing.requests).toHaveLength(2);
    assertLocalOnly(closing);
    await closing.stop();
  });

  test('and several in a row still take one request each', async () => {
    // Connection reuse is where the old bug showed up, so more than one
    // sequential request is the case that matters.
    const closing = await startFakeS3({ closeDelimited: true });
    const client = bunClient(closing);

    for (let index = 0; index < 5; index++)
      await client.write(`close-${index}.txt`, 'x');
    for (let index = 0; index < 5; index++)
      await client.delete(`close-${index}.txt`);

    expect(closing.of('PUT')).toHaveLength(5);
    expect(closing.of('DELETE')).toHaveLength(5);
    await closing.stop();
  });
});

describe('async stack traces from native I/O', () => {
  test('an S3 error points back at the await in application code', async () => {
    // Before this, errors thrown from native async APIs had empty stacks: there
    // was no JavaScript on the call stack when the error was created. It matters
    // for this codebase specifically because `sanitizeForLog(error)` is what the
    // upload path logs, and an error with no stack gives nothing to locate.
    async function readMissingObject() {
      return await bun.file('temp/definitely-absent.webp').text();
    }

    const error = await readMissingObject().then(
      () => undefined,
      (thrown: unknown) => thrown as Error
    );

    expect(error?.name).toBe('S3Error');
    expect(error?.stack).toContain('readMissingObject');
    expect(error?.stack).toContain('bun14.test.ts');
  });
});
