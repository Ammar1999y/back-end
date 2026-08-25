/**
 * Multipart uploads and the streaming writer.
 *
 * **Not on any current path**, and the first test says why: `MAX_IMAGE_SIZE` is
 * 1 MB and `SERVER_MAX_IMAGE_SIZE` is 0.2 MB, so nothing this application
 * uploads comes near Bun's 5 MB default `partSize`. It is here because the
 * threshold is a default rather than a policy — raising the upload cap past 5 MB
 * would switch the upload path to multipart with no code change and no sign at
 * the call site — and because two of the Bun 1.4 fixes live in this code.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { PutObjectCommand } from '@aws-sdk/client-s3';

import {
  MAX_IMAGE_SIZE,
  SERVER_MAX_IMAGE_SIZE,
} from '@/utils/validation/constants';

import { awsClient, bunClient, PUBLIC_BUCKET } from './shared/clients';
import { assertLocalOnly, startFakeS3 } from './shared/fake-s3';

const origin = await startFakeS3();
const aws = awsClient(origin);
const bun = bunClient(origin);

const MEGABYTE = 1024 * 1024;
const DEFAULT_PART_SIZE = 5 * MEGABYTE;

/** Parts of an in-flight multipart upload, identified by the query parameter. */
const partUploads = () =>
  origin.requests.filter((request) => request.query['partNumber']);
const initiate = () =>
  origin.requests.find(
    (request) => request.method === 'POST' && 'uploads' in request.query
  );
const complete = () =>
  origin.requests.find(
    (request) => request.method === 'POST' && request.query['uploadId']
  );

beforeEach(() => {
  origin.reset();
});

afterAll(async () => {
  assertLocalOnly(origin);
  await origin.stop();
});

describe('why this is out of scope today', () => {
  test('the upload cap is far below the default part size', () => {
    expect(MAX_IMAGE_SIZE * MEGABYTE).toBeLessThan(DEFAULT_PART_SIZE);
    expect(SERVER_MAX_IMAGE_SIZE * MEGABYTE).toBeLessThan(DEFAULT_PART_SIZE);
  });

  test('a body at the current cap is a single PUT, not a multipart upload', async () => {
    await bun.write(
      'at-cap.webp',
      Buffer.alloc(MAX_IMAGE_SIZE * MEGABYTE, 0x61),
      {
        type: 'image/webp',
      }
    );

    expect(origin.of('PUT')).toHaveLength(1);
    expect(initiate()).toBeUndefined();
    expect(origin.one('PUT').body.byteLength).toBe(MAX_IMAGE_SIZE * MEGABYTE);
  });
});

describe('crossing the part size', () => {
  test('write() never goes multipart, whatever the size — only writer() does', async () => {
    // Contrary to the documented "Bun automatically handles multipart uploads
    // for large files": with a body of known length, `write()` sends one PUT at
    // 6 MB, at 20 MB and at 64 MB, and `partSize` is ignored. Multipart is a
    // property of the streaming writer, not of size.
    for (const megabytes of [6, 20, 64]) {
      origin.reset();
      await bun.write(
        `big-${megabytes}.bin`,
        Buffer.alloc(megabytes * MEGABYTE, 0x62)
      );

      expect(origin.of('PUT')).toHaveLength(1);
      expect(origin.one('PUT').body.byteLength).toBe(megabytes * MEGABYTE);
      expect(initiate()).toBeUndefined();
    }

    origin.reset();
    await bun.write('explicit-part.bin', Buffer.alloc(20 * MEGABYTE, 0x62), {
      partSize: 5 * MEGABYTE,
    });
    expect(origin.of('PUT')).toHaveLength(1);
    expect(initiate()).toBeUndefined();
  }, 20_000);

  test('aws-sdk PutObject is the same single PUT, so nothing changes here', async () => {
    // `@aws-sdk/lib-storage`'s `Upload` is what does multipart in the aws-sdk,
    // and this project does not depend on it. Both sides send one request.
    const body = Buffer.alloc(DEFAULT_PART_SIZE + 1024, 0x62);
    await aws.send(
      new PutObjectCommand({
        Bucket: PUBLIC_BUCKET,
        Key: 'big-aws.bin',
        Body: body,
      })
    );

    expect(origin.of('PUT')).toHaveLength(1);
    expect(origin.one('PUT').body.byteLength).toBe(body.byteLength);
    expect(initiate()).toBeUndefined();
  });

  test('a writer-driven multipart upload reassembles to the bytes that went in', async () => {
    const part = Buffer.alloc(DEFAULT_PART_SIZE, 0x63);
    const writer = bun.file('roundtrip.bin').writer({
      partSize: DEFAULT_PART_SIZE,
    });
    writer.write(part);
    await writer.flush();
    writer.write(part);
    await writer.flush();
    writer.write(Buffer.from('tail'));
    await writer.end();

    expect(initiate()).toBeDefined();
    expect(complete()).toBeDefined();
    expect(partUploads().length).toBeGreaterThan(1);
    expect(await bun.size('roundtrip.bin')).toBe(part.byteLength * 2 + 4);
  }, 20_000);
});

describe('a ReadableStream body', () => {
  const stream = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 3; index++)
          controller.enqueue(new Uint8Array(MEGABYTE).fill(0x61));
        controller.close();
      },
    });

  test('every write entry point stringifies it, and the object is silently wrong', async () => {
    // `docs/bun-s3.md` lists `ReadableStream` in `S3File.write`'s accepted
    // union. `@types/bun@1.4.0` does not, and the runtime agrees with the types
    // in the worst available way: it stringifies rather than rejecting, so 3 MB
    // of stream becomes a 23-byte object and the call reports success.
    //
    // All three spellings, because the obvious guess is that one of them is the
    // streaming one. None is. The casts are deliberate — the declared union
    // excludes `ReadableStream`, and the point is what the runtime does anyway.
    const forms: [string, () => Promise<number>][] = [
      ['client.write', () => bun.write('rs-client.bin', stream() as never)],
      ['file.write', () => bun.file('rs-file.bin').write(stream() as never)],
      [
        'Bun.write',
        () => Bun.write(bun.file('rs-bunwrite.bin'), stream() as never),
      ],
    ];

    for (const [label, run] of forms) {
      origin.reset();
      const written = await run();
      const key = origin.one('PUT').path.split('/').pop() ?? '';

      expect(written).toBe('[object ReadableStream]'.length);
      expect(
        new TextDecoder().decode(
          origin.objects.get(`${PUBLIC_BUCKET}/${key}`)?.body
        )
      ).toBe(`[object ReadableStream]`);
      expect(label).toBeTruthy();
    }
  });

  test('a Response wrapping the stream does stream — the only supported spelling', async () => {
    await bun.write('via-response.bin', new Response(stream()));

    expect(
      origin.objects.get(`${PUBLIC_BUCKET}/via-response.bin`)?.body.byteLength
    ).toBe(3 * MEGABYTE);
  });

  test('but then write() reports 0 bytes written instead of the real count', async () => {
    // A second, smaller defect on the one path that works: the return value is
    // 0 for a streamed `Response` body, where a `Buffer` body returns its
    // length. Anything that logs or checks the byte count gets a wrong number.
    const written = await bun.write('via-response.bin', new Response(stream()));

    expect(written).toBe(0);
    expect(
      origin.objects.get(`${PUBLIC_BUCKET}/via-response.bin`)?.body.byteLength
    ).toBe(3 * MEGABYTE);
  });

  test('a Response over a known-length body reports the count correctly', async () => {
    // The contrast that makes the previous test a defect rather than a
    // convention: same `Response` wrapper, known length, correct return value.
    const body = new Uint8Array(MEGABYTE).fill(0x61);
    expect(await bun.write('known-length.bin', new Response(body))).toBe(
      MEGABYTE
    );
  });
});

describe('the streaming writer', () => {
  test('partSize decides the part boundaries', async () => {
    const partSize = 5 * MEGABYTE;
    const writer = bun.file('parts.bin').writer({ partSize });

    for (let index = 0; index < 3; index++) {
      writer.write(Buffer.alloc(partSize, 0x61 + index));
      await writer.flush();
    }
    await writer.end();

    const parts = partUploads();
    expect(parts).toHaveLength(3);
    for (const part of parts) expect(part.body.byteLength).toBe(partSize);
  });

  test('queueSize caps how many parts are in flight — the Bun 1.4 fix', async () => {
    // Before 1.4 this was silently overridden to 255, which is a very different
    // memory and connection profile from what the option asks for. Measured by
    // holding every response open at the origin so overlap is observable at all.
    for (const queueSize of [1, 3]) {
      const slow = await startFakeS3({ delayMs: 30 });
      const client = bunClient(slow);
      const writer = client.file(`queue-${queueSize}.bin`).writer({
        partSize: 5 * MEGABYTE,
        queueSize,
      });

      for (let index = 0; index < 6; index++)
        writer.write(Buffer.alloc(5 * MEGABYTE, 0x61));
      await writer.end();

      expect(slow.peakConcurrency()).toBeLessThanOrEqual(queueSize);
      expect(
        slow.requests.filter((request) => request.query['partNumber'])
      ).toHaveLength(6);
      await slow.stop();
    }
  }, 20_000);

  test('writer() carries contentDisposition and contentEncoding — also new in 1.4', async () => {
    // The 1.4 notes list `write()` and `writer()` gaining both. They ride on the
    // initiate request, which is where S3 records the object's metadata.
    const writer = bun.file('typed.bin').writer({
      type: 'image/webp',
      contentDisposition: 'attachment; filename="typed.webp"',
      contentEncoding: 'gzip',
      partSize: 5 * MEGABYTE,
    });
    writer.write(Buffer.alloc(5 * MEGABYTE, 0x61));
    await writer.flush();
    writer.write(Buffer.from('tail'));
    await writer.end();

    const headers = origin.meaningfulHeaders(initiate()!);
    expect(headers['content-type']).toBe('image/webp');
    expect(headers['content-disposition']).toBe(
      'attachment; filename="typed.webp"'
    );
    expect(headers['content-encoding']).toBe('gzip');
  });
});

describe('when a part fails', () => {
  /**
   * Each case gets its own origin. A failed writer keeps working after the
   * rejection surfaces — it retries, then aborts — and those requests arrive
   * after the test that caused them has returned, which on a shared origin
   * lands them in the next test's recording.
   */
  async function failEveryPart(options?: { retry?: number }) {
    const isolated = await startFakeS3();
    const client = bunClient(isolated);
    isolated.failNext('PUT', 500, 'InternalError', 50);

    const writer = client.file('doomed.bin').writer({
      partSize: 5 * MEGABYTE,
      ...options,
    });
    // `flush()` and `end()` return `number | Promise<number>` depending on
    // whether anything is in flight, so neither can be `.catch`ed directly.
    const settle = async (result: number | Promise<number>) => {
      let rejected = false;
      try {
        await result;
      } catch {
        rejected = true;
      }
      return rejected;
    };

    writer.write(Buffer.alloc(5 * MEGABYTE, 0x61));
    const firstRejected = await settle(writer.flush());
    writer.write(Buffer.alloc(5 * MEGABYTE, 0x62));
    await settle(writer.flush());
    await settle(writer.end());
    // The abort is issued after the rejection is delivered, so it has to be
    // waited for rather than assumed present or absent.
    await Bun.sleep(300);

    return {
      isolated,
      firstRejected,
      partAttempts: isolated.requests.filter(
        (request) => request.query['partNumber']
      ).length,
      aborts: isolated.requests.filter(
        (request) => request.method === 'DELETE' && request.query['uploadId']
      ).length,
    };
  }

  test('the operation rejects', async () => {
    const { isolated, firstRejected } = await failEveryPart();
    expect(firstRejected).toBe(true);
    await isolated.stop();
  }, 20_000);

  test('the part IS retried, unlike a single-PUT write of the same failure', async () => {
    // The asymmetry worth knowing: `write()` ignores `retry` for an HTTP 5xx
    // (see `errors.test.ts`), but a multipart part upload honours it —
    // attempts = retry + 1, and the default is 3.
    for (const [retry, expected] of [
      [0, 1],
      [1, 2],
      [3, 4],
    ] as const) {
      const { isolated, partAttempts } = await failEveryPart({ retry });
      expect(partAttempts).toBe(expected);
      await isolated.stop();
    }

    const { isolated, partAttempts } = await failEveryPart();
    expect(partAttempts).toBe(4);
    await isolated.stop();
  }, 30_000);

  test('and the upload IS aborted, so no billable orphan parts are left', async () => {
    // One `DELETE ?uploadId=` per part attempt rather than one per upload —
    // redundant, but the operation is idempotent, so the outcome is the one that
    // matters: R2 is not left holding parts until a lifecycle rule reaps them.
    const { isolated, partAttempts, aborts } = await failEveryPart({
      retry: 1,
    });

    expect(aborts).toBe(partAttempts);
    expect(aborts).toBeGreaterThan(0);
    await isolated.stop();
  }, 20_000);
});
