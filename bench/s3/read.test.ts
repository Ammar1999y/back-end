/**
 * The read surface, which `lib/r2/client.ts` does not currently have.
 *
 * Nothing in this repository downloads an object from R2 — `getPublicUrl` hands
 * out a CDN URL and `getPresignedUrl` hands out a signed one, and the bytes go
 * straight from Cloudflare to the browser. So none of this is migration risk;
 * it is the other half of the decision, because a `Blob`-shaped read API and a
 * one-line `Response` redirect are capabilities the aws-sdk path does not have
 * without writing a stream adapter first.
 *
 * Kept in the suite rather than in prose because "Bun can do X" is worth exactly
 * as much as the test that ran it.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { GetObjectCommand } from '@aws-sdk/client-s3';

import {
  ASCII_KEY,
  awsClient,
  bunClient,
  CREDENTIALS,
  PUBLIC_BUCKET,
  REGION,
} from './shared/clients';
import { assertLocalOnly, startFakeS3 } from './shared/fake-s3';
import { verifyRecordedRequest } from './shared/sigv4';

const origin = await startFakeS3();
const aws = awsClient(origin);
const bun = bunClient(origin);

const PAYLOAD = '0123456789abcdef';

beforeEach(() => {
  origin.reset();
  origin.put(`${PUBLIC_BUCKET}/${ASCII_KEY}`, PAYLOAD, {
    'content-type': 'image/webp',
  });
});

afterAll(async () => {
  assertLocalOnly(origin);
  await origin.stop();
});

describe('reading an object', () => {
  test('text, bytes and arrayBuffer all reach the same bytes', async () => {
    expect(await bun.file(ASCII_KEY).text()).toBe(PAYLOAD);
    expect([...(await bun.file(ASCII_KEY).bytes())]).toEqual([
      ...new TextEncoder().encode(PAYLOAD),
    ]);
    expect((await bun.file(ASCII_KEY).arrayBuffer()).byteLength).toBe(
      PAYLOAD.length
    );
    expect(origin.of('GET')).toHaveLength(3);
    for (const request of origin.of('GET'))
      expect(
        verifyRecordedRequest(request, CREDENTIALS.secretAccessKey).valid
      ).toBe(true);
  });

  test('json parses an object written as JSON', async () => {
    await bun.write('data.json', JSON.stringify({ name: 'John', age: 30 }), {
      type: 'application/json',
    });
    expect(await bun.file('data.json').json()).toEqual({
      name: 'John',
      age: 30,
    });
  });

  test('the same read through the aws-sdk needs a stream adapter', async () => {
    const output = await aws.send(
      new GetObjectCommand({ Bucket: PUBLIC_BUCKET, Key: ASCII_KEY })
    );
    // `Body` is a stream union, not a string: `transformToString` is an
    // aws-sdk-specific helper, and the equivalent of `.json()` or `.bytes()`
    // does not exist without it. This is the ergonomic difference, measured.
    expect(typeof output.Body).toBe('object');
    expect(await output.Body?.transformToString()).toBe(PAYLOAD);
  });

  test('reading a stream yields the whole body', async () => {
    let bytes = 0;
    for await (const chunk of bun.file(ASCII_KEY).stream())
      bytes += chunk.byteLength;
    expect(bytes).toBe(PAYLOAD.length);
  });
});

describe('partial reads', () => {
  test('slice becomes a Range header, not a full download', async () => {
    expect(await bun.file(ASCII_KEY).slice(0, 4).text()).toBe('0123');
    expect(origin.one('GET').headers['range']).toBe('bytes=0-3');
  });

  test('slice().stream() sends the same Range — the Bun 1.4 fix', async () => {
    // Listed in the 1.4 notes as `slice(0, N).stream()` sending the correct
    // Range header; before, the stream path ignored the slice and downloaded
    // everything. Asserted because a silent full download of a large object is
    // exactly the kind of regression that shows up as a bandwidth bill.
    let bytes = 0;
    for await (const chunk of bun.file(ASCII_KEY).slice(0, 4).stream())
      bytes += chunk.byteLength;

    expect(bytes).toBe(4);
    expect(origin.one('GET').headers['range']).toBe('bytes=0-3');
  });

  test('an open-ended slice sends a closed range with an absurd upper bound', async () => {
    expect(await bun.file(ASCII_KEY).slice(8).text()).toBe('89abcdef');

    // Not `bytes=8-`, which is the usual spelling of "to the end", but
    // `bytes=8-4503599627370494` (2^52 − 2). S3 and R2 clamp it to the object
    // size, so the read is correct; it is recorded because a Range-validating
    // proxy in front of the bucket could reject it where `bytes=8-` would pass.
    expect(origin.one('GET').headers['range']).toBe(`bytes=8-${2 ** 52 - 2}`);
  });
});

describe('metadata without downloading', () => {
  test('stat reports size, etag, type and lastModified from a HEAD', async () => {
    const stat = await bun.stat(ASCII_KEY);

    expect(origin.one('HEAD').body.byteLength).toBe(0);
    expect(stat.size).toBe(PAYLOAD.length);
    expect(stat.type).toBe('image/webp');
    expect(stat.etag).toMatch(/^"[0-9a-f]+"$/);
    expect(stat.lastModified).toBeInstanceOf(Date);
  });

  test('but its fields are prototype getters, so it serialises as {}', async () => {
    const stat = await bun.stat(ASCII_KEY);
    // Worth knowing before someone logs one: `JSON.stringify(stat)` is `{}` and
    // `Object.keys(stat)` is empty, while every field reads fine.
    expect(Object.keys(stat)).toEqual([]);
    expect(JSON.stringify(stat)).toBe('{}');
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(stat)).sort()
    ).toEqual(['constructor', 'etag', 'lastModified', 'size', 'type']);
  });

  test('exists distinguishes present from absent, and size returns a number', async () => {
    expect(await bun.exists(ASCII_KEY)).toBe(true);
    expect(await bun.exists('temp/not-there.webp')).toBe(false);
    expect(await bun.size(ASCII_KEY)).toBe(PAYLOAD.length);
  });

  test('the deprecated synchronous size is NaN, as documented', () => {
    // `S3File.size` cannot be known without a request, so it is `NaN` rather
    // than 0 — a `if (!file.size)` guard would read the same for both.
    expect(Number.isNaN(bun.file(ASCII_KEY).size)).toBe(true);
  });
});

describe('listing a prefix', () => {
  test('returns keys under a prefix, which is what an orphan sweep needs', async () => {
    origin.put(`${PUBLIC_BUCKET}/temp/a.webp`, 'aaa');
    origin.put(`${PUBLIC_BUCKET}/temp/b.webp`, 'bbbb');
    origin.put(`${PUBLIC_BUCKET}/projects/c.webp`, 'ccccc');

    const listed = await bun.list({ prefix: 'temp/', maxKeys: 100 });
    const keys = (listed.contents ?? []).map((entry) => entry.key).sort();

    // `ASCII_KEY` is itself under `temp/` — it is what a real temporary upload
    // looks like, and the sweep would see it too.
    expect(keys).toEqual([ASCII_KEY, 'temp/a.webp', 'temp/b.webp'].sort());
    expect(listed.isTruncated).toBe(false);
    expect(origin.one('GET').query['list-type']).toBe('2');
    expect(origin.one('GET').query['prefix']).toBe('temp/');
  });

  test('sizes and etags come back per entry', async () => {
    origin.put(`${PUBLIC_BUCKET}/temp/a.webp`, 'aaa');
    const entry = (await bun.list({ prefix: 'temp/a' })).contents?.[0];

    expect(entry?.size).toBe(3);
    expect(entry?.eTag).toMatch(/^"[0-9a-f]+"$/);
    expect(entry?.storageClass).toBe('STANDARD');
  });
});

describe('handing an object to the browser without proxying it', () => {
  test('new Response(S3File) is a 302 to a presigned URL', async () => {
    const response = new Response(bun.file(ASCII_KEY));
    const location = response.headers.get('location');

    expect(response.status).toBe(302);
    expect(location).toBeTruthy();
    // The redirect target is a working presigned URL, so a route could return
    // this instead of streaming the object through the server.
    expect(new URL(location ?? '').searchParams.get('X-Amz-Signature')).toMatch(
      /^[0-9a-f]{64}$/
    );
    expect(origin.requests).toHaveLength(0);

    const followed = await fetch(location ?? '');
    expect(await followed.text()).toBe(PAYLOAD);
  });
});

describe('the s3:// protocol', () => {
  /** No space, no parenthesis — see the last test in this block for why. */
  const PLAIN_KEY = 'temp/0f1e2d3c4b5a6978_plain.webp';

  test('fetch reads an object with per-call credentials', async () => {
    origin.put(`${PUBLIC_BUCKET}/${PLAIN_KEY}`, PAYLOAD);

    const response = await fetch(`s3://${PUBLIC_BUCKET}/${PLAIN_KEY}`, {
      s3: { ...CREDENTIALS, endpoint: origin.url, region: REGION },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PAYLOAD);
  });

  test('and honours a Range header passed to fetch', async () => {
    origin.put(`${PUBLIC_BUCKET}/${PLAIN_KEY}`, PAYLOAD);

    const response = await fetch(`s3://${PUBLIC_BUCKET}/${PLAIN_KEY}`, {
      s3: { ...CREDENTIALS, endpoint: origin.url, region: REGION },
      headers: { range: 'bytes=0-3' },
    });

    expect(await response.text()).toBe('0123');
    expect(origin.one('GET').headers['range']).toBe('bytes=0-3');
  });

  test('but it double-encodes a key containing a space, so it is not interchangeable with file()', async () => {
    // `client.file(key)` and `fetch("s3://…")` are not the same addressing
    // scheme. The URL parser escapes the space to `%20` on the way in, and the
    // S3 layer escapes that again — so the request lands on `%2520` and misses
    // the object, while `file()` on the identical key finds it. Keys here can
    // contain spaces (`sanitizeFilename` keeps `\p{Zs}`), so this is reachable,
    // and it is the reason nothing in a port should reach for `s3://`.
    expect(await bun.file(ASCII_KEY).text()).toBe(PAYLOAD);

    origin.reset();
    origin.put(`${PUBLIC_BUCKET}/${ASCII_KEY}`, PAYLOAD);
    const viaProtocol = await fetch(`s3://${PUBLIC_BUCKET}/${ASCII_KEY}`, {
      s3: { ...CREDENTIALS, endpoint: origin.url, region: REGION },
    });

    expect(viaProtocol.status).toBe(404);
    expect(origin.one('GET').path).toContain('%2520');
  });
});
