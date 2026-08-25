/**
 * Failure behaviour, which is where the two clients differ most and where the
 * difference is least visible from the call site.
 *
 * `uploadImagesToR2` decides whether to roll back on a rejection, and
 * `sweepTempFiles` decides whether to delete a database row on a rejection. Both
 * are `Promise.allSettled` over R2 calls, so what counts is not the error's
 * shape but *whether the call rejects at all* — and, less obviously, how many
 * times it tried before it did. The retry section is the one that changes
 * operational behaviour under a transient R2 5xx.
 */
import { S3Client } from 'bun';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getContentDisposition } from '@/lib/r2/client';

import { sanitizeFilename } from '@/utils/sanitize-filename';

import {
  ASCII_KEY,
  awsClient,
  bunClient,
  CREDENTIALS,
  PUBLIC_BUCKET,
} from './shared/clients';
import { assertLocalOnly, startFakeS3 } from './shared/fake-s3';

const origin = await startFakeS3();
const aws = awsClient(origin);
const bun = bunClient(origin);

/** Reads `code` off an unknown throwable without asserting a shape onto it. */
function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

beforeEach(() => {
  origin.reset();
});

afterAll(async () => {
  assertLocalOnly(origin);
  await origin.stop();
});

describe('the harness is isolated from ambient credentials', () => {
  test('no S3_*, AWS_* or R2_* value is visible to this process', () => {
    // `bunfig.toml` puts the working directory here so the repo root `.env` is
    // never loaded, and every client in this suite is configured explicitly. If
    // this fails, something in the environment could redirect a client at a real
    // bucket — and the missing-credentials test below would silently pass for
    // the wrong reason.
    const leaking = [
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'S3_ENDPOINT',
      'S3_BUCKET',
      'S3_REGION',
      'S3_SESSION_TOKEN',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_ENDPOINT',
      'AWS_BUCKET',
      'AWS_SESSION_TOKEN',
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
    ].filter((name) => process.env[name]);

    expect(leaking).toEqual([]);
  });
});

describe('errors the S3 service returns', () => {
  test('Bun raises an S3Error whose code is the S3 code', async () => {
    origin.failNext('PUT', 403, 'AccessDenied');

    const error = await bun.write(ASCII_KEY, 'x').then(
      () => undefined,
      (thrown: unknown) => thrown
    );

    expect((error as Error).name).toBe('S3Error');
    expect(codeOf(error)).toBe('AccessDenied');
  });

  test('a missing key on read is NoSuchKey, not a null read', async () => {
    const error = await bun
      .file('temp/absent.webp')
      .text()
      .then(
        () => undefined,
        (thrown: unknown) => thrown
      );

    expect((error as Error).name).toBe('S3Error');
    expect(codeOf(error)).toBe('NoSuchKey');
  });

  test('aws-sdk names the error after the S3 code instead', async () => {
    // Different shape, same information. Any code that matched on
    // `error.name === 'NoSuchKey'` has to move to `error.code`.
    origin.failNext('PUT', 403, 'AccessDenied');

    const error = await aws
      .send(
        new PutObjectCommand({
          Bucket: PUBLIC_BUCKET,
          Key: ASCII_KEY,
          Body: 'x',
        })
      )
      .then(
        () => undefined,
        (thrown: unknown) => thrown
      );

    expect((error as Error).name).toBe('AccessDenied');
  });

  test('neither error carries the secret key into its message or stack', async () => {
    // `lib/rate-limit/store-failure.ts` sets the rule for this repository:
    // provider-controlled error text is not logged raw. Worth confirming there
    // is nothing worse than provider text in here to begin with.
    origin.failNext('PUT', 403, 'AccessDenied');
    const fromBun = await bun.write(ASCII_KEY, 'x').then(
      () => undefined,
      (thrown: unknown) => thrown as Error
    );

    origin.failNext('PUT', 403, 'AccessDenied');
    const fromAws = await aws
      .send(
        new PutObjectCommand({
          Bucket: PUBLIC_BUCKET,
          Key: ASCII_KEY,
          Body: 'x',
        })
      )
      .then(
        () => undefined,
        (thrown: unknown) => thrown as Error
      );

    for (const error of [fromBun, fromAws]) {
      const text = `${error?.message}\n${error?.stack}`;
      expect(text).not.toContain(CREDENTIALS.secretAccessKey);
      expect(text).not.toContain(CREDENTIALS.accessKeyId);
    }
  });
});

describe('errors Bun raises before a request leaves', () => {
  test('no credentials is ERR_S3_MISSING_CREDENTIALS', async () => {
    const error = await new S3Client({ bucket: 'b', endpoint: origin.url })
      .file('k')
      .text()
      .then(
        () => undefined,
        (thrown: unknown) => thrown
      );

    expect(codeOf(error)).toBe('ERR_S3_MISSING_CREDENTIALS');
    expect(origin.requests).toHaveLength(0);
  });

  test('no bucket is ERR_S3_INVALID_PATH', async () => {
    // Relevant because `getBucketName` returns `undefined` when
    // `R2_PUBLIC_BUCKET` is unset, and today that produces a request to a bucket
    // literally named "undefined". Bun refuses instead.
    const error = await new S3Client({ ...CREDENTIALS, endpoint: origin.url })
      .write('k', 'x')
      .then(
        () => undefined,
        (thrown: unknown) => thrown
      );

    expect(codeOf(error)).toBe('ERR_S3_INVALID_PATH');
    expect(origin.requests).toHaveLength(0);
  });

  test('an unsupported presign method is ERR_S3_INVALID_METHOD', () => {
    let thrown: unknown;
    try {
      bun.presign(ASCII_KEY, { method: 'PATCH' as 'PUT' });
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('ERR_S3_INVALID_METHOD');
  });
});

describe('header injection', () => {
  const INJECTED = 'inline\r\nx-injected: 1';

  test('Bun rejects CR/LF in contentDisposition, contentEncoding and type', async () => {
    // Listed in the Bun 1.4 notes under Injection: "Bun.s3 rejects CR/LF in
    // contentDisposition, contentEncoding, and type". Load-bearing here because
    // `getContentDisposition` builds its value from a filename.
    for (const field of [
      'contentDisposition',
      'contentEncoding',
      'type',
    ] as const) {
      let thrown: unknown;
      try {
        // Synchronously, not as a rejected promise — `write` throws before it
        // returns one, so `await write(...).catch(…)` never sees this.
        void bun.write(ASCII_KEY, 'x', { [field]: INJECTED });
      } catch (error) {
        thrown = error;
      }

      expect((thrown as Error | undefined)?.message).toContain(
        'must not contain newline characters'
      );
      expect(codeOf(thrown)).toBe('ERR_INVALID_ARG_TYPE');
    }
    expect(origin.requests).toHaveLength(0);
  });

  test('aws-sdk also refuses, with a different error', async () => {
    // Both fail closed, so this is not a regression either way — only the
    // message and the type change.
    const error = await aws
      .send(
        new PutObjectCommand({
          Bucket: PUBLIC_BUCKET,
          Key: ASCII_KEY,
          Body: 'x',
          ContentDisposition: INJECTED,
        })
      )
      .then(
        () => undefined,
        (thrown: unknown) => thrown as Error
      );

    expect(error?.message).toContain('Invalid character in header content');
  });

  test('and the application cannot reach either, because sanitizeFilename drops CR/LF', () => {
    // The value that actually flows is `getContentDisposition({ filename })`
    // where the filename came through `sanitizeFilename`, whose allow-list is
    // `\p{L}\p{N}\p{Zs}_-()` — CR and LF are not in it. Asserted so a future
    // widening of that allow-list fails here.
    const hostile = 'photo\r\nx-injected: 1.png';
    const sanitized = sanitizeFilename(hostile);

    expect(sanitized).not.toContain('\r');
    expect(sanitized).not.toContain('\n');
    expect(
      getContentDisposition({ filename: sanitized, inline: true })
    ).not.toMatch(/[\r\n]/);
  });
});

describe('retries — the difference that shows up under load, not in a test', () => {
  test('aws-sdk retries a 5xx three times by default', async () => {
    origin.failNext('PUT', 500, 'InternalError', 20);

    await expect(
      aws.send(
        new PutObjectCommand({
          Bucket: PUBLIC_BUCKET,
          Key: ASCII_KEY,
          Body: 'x',
        })
      )
    ).rejects.toThrow();
    expect(origin.of('PUT')).toHaveLength(3);
  });

  test('and therefore rides out a single transient 503', async () => {
    origin.failNext('PUT', 503, 'SlowDown', 1);

    await expect(
      aws.send(
        new PutObjectCommand({
          Bucket: PUBLIC_BUCKET,
          Key: ASCII_KEY,
          Body: 'x',
        })
      )
    ).resolves.toBeDefined();
    expect(origin.of('PUT')).toHaveLength(2);
  });

  test('Bun does not retry a 5xx, with retry: 3 or without it', async () => {
    // `retry` covers network errors, not HTTP error statuses — so the option
    // that looks like the aws-sdk equivalent is not one. This is the finding:
    // after the migration a single transient R2 5xx fails the upload, where
    // today it is invisible.
    for (const retry of [0, 3]) {
      origin.reset();
      origin.failNext('PUT', 500, 'InternalError', 20);

      await expect(bun.write(ASCII_KEY, 'x', { retry })).rejects.toThrow();
      expect(origin.of('PUT')).toHaveLength(1);
    }
  });

  test('so the same transient 503 fails the operation', async () => {
    origin.failNext('PUT', 503, 'SlowDown', 1);

    await expect(bun.write(ASCII_KEY, 'x', { retry: 3 })).rejects.toThrow();
    expect(origin.of('PUT')).toHaveLength(1);
  });

  test('an application-level retry restores the behaviour', async () => {
    // What a port has to add. Three attempts, same as the aws-sdk default.
    const withRetry = async (attempts: number) => {
      let lastError: unknown;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          return await bun.write(ASCII_KEY, 'x', { type: 'image/webp' });
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    };

    origin.failNext('PUT', 503, 'SlowDown', 1);
    await expect(withRetry(3)).resolves.toBe(1);
    expect(origin.of('PUT')).toHaveLength(2);
  });
});
