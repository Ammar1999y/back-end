/**
 * The two operations this application actually performs against R2 today:
 * `uploadToR2` (a `PutObject`) and `deleteFromR2` (a `DeleteObject`). Everything
 * reachable from an HTTP request goes through one of them —
 * `uploadImagesToR2` for the upload route, `sweepTempFiles` for the retention
 * cron — so this file is the one that decides whether the migration is possible
 * at all. The rest of the suite is about surface that is exported but not yet
 * called.
 *
 * Both clients are pointed at the same recording origin and the requests are
 * diffed. What matters is not that each library "works" but that R2 receives the
 * same bytes and the same headers afterwards, because the headers are the part
 * that has no test today and no visible failure mode: a dropped `Cache-Control`
 * costs CDN caching on every public image and nothing anywhere reports it.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';

import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getCacheControlHeader, getContentDisposition } from '@/lib/r2/client';

import {
  ASCII_KEY,
  awsClient,
  bunClient,
  codeUnits,
  CREDENTIALS,
  PUBLIC_BUCKET,
  REALISTIC_KEY,
  REGION,
} from './shared/clients';
import { assertLocalOnly, startFakeS3 } from './shared/fake-s3';
import { verifyRecordedRequest } from './shared/sigv4';

const origin = await startFakeS3();
const aws = awsClient(origin);
const bun = bunClient(origin);

/** The exact options `uploadImagesToR2` passes for an optimised public image. */
const UPLOAD = {
  body: Buffer.from('webp-bytes-would-be-here'),
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

beforeEach(() => {
  origin.reset();
});

afterAll(async () => {
  assertLocalOnly(origin);
  await origin.stop();
});

describe('the configuration this benchmark reproduces', () => {
  test('lib/r2/client.ts still asks for path style and the weur region', async () => {
    // `shared/clients.ts` restates the aws-sdk constructor because the real
    // module hard-codes its endpoint from an env var and cannot be redirected.
    // A restatement that drifts would quietly compare the wrong two clients.
    const source = await Bun.file(
      path.join(import.meta.dir, '..', '..', 'lib', 'r2', 'client.ts')
    ).text();

    expect(source).toContain('forcePathStyle: true');
    expect(source).toContain(`region: '${REGION}'`);
  });
});

describe('uploadToR2 — PutObject on the wire', () => {
  test('aws-sdk sends every header the upload pipeline asks for', async () => {
    await aws.send(
      new PutObjectCommand({
        Bucket: PUBLIC_BUCKET,
        Key: REALISTIC_KEY,
        Body: UPLOAD.body,
        ContentType: UPLOAD.contentType,
        CacheControl: UPLOAD.cacheControl,
        ContentDisposition: UPLOAD.contentDisposition,
        Metadata: UPLOAD.metadata,
      })
    );

    const headers = origin.meaningfulHeaders(origin.one('PUT'));
    expect(headers['content-type']).toBe('image/webp');
    expect(headers['cache-control']).toBe(
      'public, max-age=31536000, immutable'
    );
    expect(headers['content-disposition']).toBe(UPLOAD.contentDisposition);
    // Metadata keys arrive lowercased; S3 stores and returns them that way.
    expect(headers['x-amz-meta-originalmimetype']).toBe('image/png');
    expect(headers['x-amz-meta-originalsize']).toBe('4096');
  });

  test('Bun keeps content-type and content-disposition', async () => {
    await bun.write(REALISTIC_KEY, UPLOAD.body, {
      type: UPLOAD.contentType,
      contentDisposition: UPLOAD.contentDisposition,
    });

    const headers = origin.meaningfulHeaders(origin.one('PUT'));
    expect(headers['content-type']).toBe('image/webp');
    expect(headers['content-disposition']).toBe(UPLOAD.contentDisposition);
  });

  test('Bun has no field for Cache-Control and drops it in silence', async () => {
    // Passed through an `as` because `S3Options` has no such key — the point is
    // what the runtime does with an option a future reader might assume works.
    await bun.write(REALISTIC_KEY, UPLOAD.body, {
      type: UPLOAD.contentType,
      ...({ cacheControl: UPLOAD.cacheControl } as object),
    });

    const headers = origin.meaningfulHeaders(origin.one('PUT'));
    expect(headers['cache-control']).toBeUndefined();
    // No throw, no warning: the object simply arrives uncacheable. This is the
    // finding that decides the migration, so it is asserted rather than noted.
    expect(headers['content-type']).toBe('image/webp');
  });

  test('Bun has no field for object metadata and drops it in silence', async () => {
    await bun.write(REALISTIC_KEY, UPLOAD.body, {
      type: UPLOAD.contentType,
      ...({ metadata: UPLOAD.metadata } as object),
    });

    const sent = Object.keys(origin.meaningfulHeaders(origin.one('PUT')));
    expect(sent.filter((name) => name.startsWith('x-amz-meta-'))).toEqual([]);
  });

  test('body bytes and object path are identical between the two', async () => {
    await aws.send(
      new PutObjectCommand({
        Bucket: PUBLIC_BUCKET,
        Key: REALISTIC_KEY,
        Body: UPLOAD.body,
        ContentType: UPLOAD.contentType,
      })
    );
    const fromAws = origin.one('PUT');

    origin.reset();
    await bun.write(REALISTIC_KEY, UPLOAD.body, { type: UPLOAD.contentType });
    const fromBun = origin.one('PUT');

    expect(fromBun.path).toBe(fromAws.path);
    expect(fromBun.host).toBe(fromAws.host);
    expect([...fromBun.body]).toEqual([...fromAws.body]);
    // Path style: the bucket is the first path segment, not a host label.
    expect(fromBun.path.startsWith(`/${PUBLIC_BUCKET}/`)).toBe(true);
    expect(fromBun.host.startsWith('127.0.0.1')).toBe(true);
  });

  test('keys survive identically, including the spaces sanitizeFilename allows', async () => {
    // `sanitizeFilename` keeps `\p{L}\p{N}\p{Zs}_-()`, so a space, a non-ASCII
    // letter and a parenthesis are all reachable from a real upload. A
    // percent-encoding difference here would write to a different object.
    const keys = [
      'temp/0f1e2d3c4b5a6978_plain.webp',
      'temp/0f1e2d3c4b5a6978_two words.webp',
      'temp/0f1e2d3c4b5a6978_Ünïcode nàme.webp',
      'temp/0f1e2d3c4b5a6978_paren (1).webp',
      'temp/0f1e2d3c4b5a6978_plus+sign.webp',
      'temp/0f1e2d3c4b5a6978_dash-under_score.webp',
    ];

    for (const key of keys) {
      origin.reset();
      await aws.send(
        new PutObjectCommand({ Bucket: PUBLIC_BUCKET, Key: key, Body: 'k' })
      );
      const fromAws = origin.one('PUT').path;

      origin.reset();
      await bun.write(key, 'k');
      const fromBun = origin.one('PUT').path;

      expect(fromBun).toBe(fromAws);
    }
  });

  test('write() returns the byte count, which the aws-sdk call did not', async () => {
    const written = await bun.write(REALISTIC_KEY, UPLOAD.body, {
      type: UPLOAD.contentType,
    });
    expect(written).toBe(UPLOAD.body.byteLength);
  });
});

describe('content-type fidelity', () => {
  test('the three MIME types this application uploads pass through unchanged', async () => {
    // `ALLOWED_IMAGE_TYPES` in `lib/r2/upload-helper.ts`, plus `image/webp`,
    // which is what optimisation converts everything to.
    for (const type of ['image/png', 'image/webp', 'image/svg+xml']) {
      origin.reset();
      await bun.write('ct.bin', 'x', { type });
      expect(origin.one('PUT').headers['content-type']).toBe(type);
    }
  });

  test('Bun appends charset=utf-8 to text-ish types, where aws-sdk does not', async () => {
    // Not on any current path — nothing here uploads JSON or text — but it is a
    // real divergence, and the first non-image upload would meet it. Recorded so
    // that is a decision rather than a surprise.
    for (const type of ['text/plain', 'application/json']) {
      origin.reset();
      await bun.write('ct.bin', 'x', { type });
      const fromBun = origin.one('PUT').headers['content-type'];

      origin.reset();
      await aws.send(
        new PutObjectCommand({
          Bucket: PUBLIC_BUCKET,
          Key: 'ct.bin',
          Body: 'x',
          ContentType: type,
        })
      );
      const fromAws = origin.one('PUT').headers['content-type'];

      expect(fromAws).toBe(type);
      expect(fromBun).toBe(`${type};charset=utf-8`);
    }
  });

  test('omitting the type yields application/octet-stream, not an empty header', async () => {
    await bun.write('no-type.bin', Buffer.from('x'));
    expect(origin.one('PUT').headers['content-type']).toBe(
      'application/octet-stream'
    );
  });
});

describe('a non-ASCII filename in Content-Disposition', () => {
  /**
   * This block used to record a divergence: the two clients put different bytes
   * on the wire for the same header, because `getContentDisposition`
   * interpolated the raw name into `filename="…"` and a header value travels as
   * Latin-1. `@aws-sdk/client-s3` substituted `U+FFFD` per code point, Bun sent
   * the UTF-8 bytes, and neither stored the name.
   *
   * `getContentDisposition` now emits an ASCII-only `filename` and puts the real
   * name in `filename*` (see `tests/unit/content-disposition.test.ts`). So this
   * block asserts the *absence* of the divergence — which is the property that
   * makes the migration header-neutral, and which would silently come back if
   * that function were ever changed to interpolate again.
   *
   * Reachable from a real upload: `sanitizeFilename` keeps `\p{L}`, so
   * `Ünïcode.png` survives into the R2 key and `uploadImagesToR2` feeds that key
   * straight to `getContentDisposition`.
   */
  const disposition = getContentDisposition({
    filename: 'Ünïcode nàme.webp',
    inline: true,
  });

  test('the header the application builds is pure ASCII', () => {
    expect(disposition).not.toMatch(/[^ -~]/);
    expect(disposition).toContain('filename="_n_code n_me.webp"');
    expect(disposition).toContain(
      "filename*=UTF-8''%C3%9Cn%C3%AFcode%20n%C3%A0me.webp"
    );
  });

  test('so both clients transmit it byte-identically', async () => {
    await bun.write(ASCII_KEY, 'x', { contentDisposition: disposition });
    const fromBun = origin.one('PUT').headers['content-disposition'] ?? '';

    origin.reset();
    await aws.send(
      new PutObjectCommand({
        Bucket: PUBLIC_BUCKET,
        Key: ASCII_KEY,
        Body: 'x',
        ContentType: 'image/webp',
        ContentDisposition: disposition,
      })
    );
    const fromAws = origin.one('PUT').headers['content-disposition'] ?? '';

    expect(fromBun).toBe(fromAws);
    expect(fromBun).toBe(disposition);
    // No `U+FFFD` (ef bf bd) from the aws-sdk and no raw UTF-8 (c3 9c) from Bun:
    // the two failure modes this used to record are both gone.
    expect(codeUnits(fromAws)).not.toContain('ef bf bd');
    expect(codeUnits(fromBun)).not.toContain('c3 9c');
  });

  test('and the real name is still recoverable from the wire', async () => {
    await bun.write(ASCII_KEY, 'x', { contentDisposition: disposition });
    const received = origin.one('PUT').headers['content-disposition'] ?? '';
    const extValue = /filename\*=UTF-8''(.*)$/.exec(received)?.[1] ?? '';

    expect(decodeURIComponent(extValue)).toBe('Ünïcode nàme.webp');
  });
});

describe('request signing', () => {
  test("both clients' PutObject signatures verify against SigV4", async () => {
    await aws.send(
      new PutObjectCommand({
        Bucket: PUBLIC_BUCKET,
        Key: REALISTIC_KEY,
        Body: UPLOAD.body,
        ContentType: UPLOAD.contentType,
        CacheControl: UPLOAD.cacheControl,
        Metadata: UPLOAD.metadata,
      })
    );
    const awsCheck = verifyRecordedRequest(
      origin.one('PUT'),
      CREDENTIALS.secretAccessKey
    );
    expect(awsCheck.valid).toBe(true);
    expect(awsCheck.scope.region).toBe(REGION);
    expect(awsCheck.scope.service).toBe('s3');

    origin.reset();
    await bun.write(REALISTIC_KEY, UPLOAD.body, { type: UPLOAD.contentType });
    const bunCheck = verifyRecordedRequest(
      origin.one('PUT'),
      CREDENTIALS.secretAccessKey
    );
    expect(bunCheck.valid).toBe(true);
    expect(bunCheck.scope.region).toBe(REGION);
    expect(bunCheck.scope.service).toBe('s3');
  });

  test('aws-sdk signs the body; Bun signs UNSIGNED-PAYLOAD and adds no checksum', async () => {
    await aws.send(
      new PutObjectCommand({
        Bucket: PUBLIC_BUCKET,
        Key: REALISTIC_KEY,
        Body: UPLOAD.body,
        ContentType: UPLOAD.contentType,
      })
    );
    const fromAws = origin.one('PUT');
    const awsCheck = verifyRecordedRequest(
      fromAws,
      CREDENTIALS.secretAccessKey
    );
    // A real hash, and it matches the bytes that arrived.
    expect(awsCheck.payloadMatchesBody).toBe(true);
    expect(fromAws.headers['x-amz-checksum-crc32']).toBeDefined();
    expect(awsCheck.signedHeaders).toContain('content-type');
    expect(awsCheck.signedHeaders).toContain('content-length');

    origin.reset();
    await bun.write(REALISTIC_KEY, UPLOAD.body, { type: UPLOAD.contentType });
    const fromBun = origin.one('PUT');
    const bunCheck = verifyRecordedRequest(
      fromBun,
      CREDENTIALS.secretAccessKey
    );

    // Bun declares the payload unsigned, so the signature covers no body bytes
    // and there is no `x-amz-checksum-*` either. Over TLS to R2 that is a
    // defence-in-depth difference rather than an exposure, but it IS a
    // difference: aws-sdk detects a corrupted upload, Bun accepts it.
    expect(fromBun.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
    expect(bunCheck.payloadMatchesBody).toBeUndefined();
    expect(fromBun.headers['x-amz-checksum-crc32']).toBeUndefined();
    expect(bunCheck.signedHeaders).toEqual([
      'host',
      'x-amz-content-sha256',
      'x-amz-date',
    ]);
  });
});

describe('deleteFromR2 — DeleteObject on the wire', () => {
  test('same method, path and empty body from both clients', async () => {
    await aws.send(
      new DeleteObjectCommand({ Bucket: PUBLIC_BUCKET, Key: REALISTIC_KEY })
    );
    const fromAws = origin.one('DELETE');

    origin.reset();
    await bun.delete(REALISTIC_KEY);
    const fromBun = origin.one('DELETE');

    expect(fromBun.path).toBe(fromAws.path);
    expect(fromBun.body.byteLength).toBe(0);
    expect(fromAws.body.byteLength).toBe(0);
    expect(
      verifyRecordedRequest(fromBun, CREDENTIALS.secretAccessKey).valid
    ).toBe(true);
  });

  test('unlink is delete, so either name ports', async () => {
    await bun.unlink(REALISTIC_KEY);
    expect(origin.one('DELETE').path).toContain('/temp/');
  });

  test('delete resolves to true, though @types/bun 1.4.0 declares Promise<void>', async () => {
    // Harmless here — `deleteFromR2` ignores the result and returns its own
    // `{ success: true }` — but it is a types-versus-runtime mismatch, and code
    // written against the declaration would be wrong about what it got.
    const result: unknown = await bun.delete('temp/some.webp');
    expect(result).toBe(true);
    expect(await (bun.unlink('temp/some.webp') as unknown)).toBe(true);
  });

  test('deleting a key that does not exist resolves, as it does today', async () => {
    // S3 answers 204 for a missing key, so `sweepTempFiles` must not treat an
    // already-gone object as a failure. Both clients agree.
    await expect(bun.delete('temp/never-existed.webp')).resolves.toBeDefined();
    origin.reset();
    await expect(
      aws.send(
        new DeleteObjectCommand({
          Bucket: PUBLIC_BUCKET,
          Key: 'temp/never-existed.webp',
        })
      )
    ).resolves.toBeDefined();
  });

  test('a rejecting delete still rejects, which is what the sweep counts', async () => {
    // `sweepTempFiles` uses `Promise.allSettled` and deletes the database rows
    // only for the fulfilled half. A Bun client that resolved on failure would
    // silently orphan objects while reporting a clean sweep.
    const keys = ['temp/a.webp', 'temp/b.webp', 'temp/c.webp'];
    origin.failNext('DELETE', 500, 'InternalError', 1);

    const outcomes = await Promise.allSettled(
      keys.map((key) => bun.delete(key))
    );
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2);
    expect(origin.of('DELETE')).toHaveLength(3);
  });
});
