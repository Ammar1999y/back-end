/**
 * The same comparison, against the real bucket: `bun bench/s3/live-r2.ts`.
 *
 * Everything in `*.test.ts` here runs against a local origin, and a local origin
 * cannot answer the question three of the findings turn on: whether Cloudflare
 * behaves the way the fake did.
 *
 * - **Does R2 accept a signature Bun produced?** The unit suite proves the
 *   signature is correct per SigV4. Only Cloudflare can prove it is *accepted*.
 * - **Does the hand-signed copy work?** `copy.test.ts` recommends it and says
 *   plainly that it is unverified, because the fake origin does not enforce the
 *   rule that every `x-amz-*` header must be signed. This checks both halves:
 *   the signed copy should succeed and the presigned-URL variant should fail.
 * - **Are the silently-dropped headers really dropped?** A missing
 *   `Cache-Control` at a fake origin could be the fake. `HeadObject` against R2
 *   settles it.
 *
 * A plain script rather than a `bun test` file, for a reason worth knowing:
 * `bun test --env-file=…` accepts the flag and does not load the file (measured
 * on 1.4.0), so a test file would run with no credentials. Run from the
 * repository root, `bun` auto-loads `.env`, and `[test] preload` in the root
 * `bunfig.toml` does not apply outside `bun test` — so the aws-sdk here is the
 * real one. Both are checked below rather than assumed.
 *
 * **Safety.** Every object it writes lives under `bench-s3-live/<run token>/`,
 * the token is fresh per run, and cleanup deletes by that prefix only —
 * `assertOwnKey` refuses anything else. It never lists or touches the rest of the
 * bucket. Nothing is written to the private bucket.
 */
/* eslint-disable unicorn/no-process-exit -- CLI entry point: the exit code IS
   this tool's result contract, which is the case the rule excepts */
import { S3Client } from 'bun';

import {
  S3Client as AwsS3Client,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

import { startFakeS3 } from './shared/fake-s3';
import { signRequest, uriEncode } from './shared/sigv4';

// ---------------------------------------------------------------------------
// configuration and refusals
// ---------------------------------------------------------------------------

const REQUIRED = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_PUBLIC_BUCKET',
] as const;

/**
 * `--self-test` runs every check against the local origin from `*.test.ts`
 * instead of R2, with no credentials.
 *
 * It answers none of the questions this file exists for — that is the whole
 * premise — and it exists so the first execution of these checks is not also the
 * first time they touch a real bucket. The two the fake cannot answer are
 * visible in its output as the ones that report `INFO` instead of `PASS`.
 */
const SELF_TEST = Bun.argv.includes('--self-test');

const missing = SELF_TEST ? [] : REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(
    `Not run: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set.\n` +
      `\nThis probe talks to the real bucket. Provide the R2 credentials in the\n` +
      `repository root .env and run it from there:\n\n` +
      `  bun bench/s3/live-r2.ts\n\n` +
      `Read-write access to R2_PUBLIC_BUCKET is required. Objects are written\n` +
      `under bench-s3-live/<token>/ and deleted at the end of the run.`
  );
  process.exit(2);
}

if (process.env.NODE_ENV === 'production')
  throw new Error(
    'refusing to run against a production process environment: this probe ' +
      'writes and deletes objects'
  );

// The root bunfig's `[test] preload` replaces `@aws-sdk/client-s3` with a
// recording stub. It should not be in effect here, and a live comparison against
// a stub would be worse than no comparison at all.
if (
  !/PutObjectCommand/.test(PutObjectCommand.name) ||
  new PutObjectCommand({ Bucket: 'x', Key: 'y' }).input === undefined
)
  throw new Error('the aws-sdk in this process is not the real one');

const fakeOrigin = SELF_TEST ? await startFakeS3() : undefined;

const ACCESS_KEY_ID = SELF_TEST
  ? 'AKIABENCHS3EXAMPLE00'
  : (process.env['R2_ACCESS_KEY_ID'] as string);
const SECRET_ACCESS_KEY = SELF_TEST
  ? 'benchmark-secret-not-valid-anywhere-0000'
  : (process.env['R2_SECRET_ACCESS_KEY'] as string);
const BUCKET = SELF_TEST
  ? 'bench-public'
  : (process.env['R2_PUBLIC_BUCKET'] as string);
/** Matches `lib/r2/client.ts`. */
const ENDPOINT =
  fakeOrigin?.url ??
  `https://${process.env['R2_ACCOUNT_ID'] as string}.r2.cloudflarestorage.com`;

/**
 * `weur` because that is what `lib/r2/client.ts` hard-codes, not because R2
 * documents it.
 *
 * Cloudflare documents `auto` as the SigV4 signing region for R2, and a location
 * hint (`weur`) is a different thing from a signing region — the first decides
 * where the bucket's data lives, the second only enters the credential scope.
 * Nothing here has ever run against R2, so whether Cloudflare accepts `weur` in
 * the scope at all is untested, and if it does not then the aws-sdk code in
 * production today is already broken. `R2_REGION` overrides, and the first check
 * below tries both.
 */
const REGION = process.env['R2_REGION'] ?? 'weur';

/** Fresh per run, so two runs cannot delete each other's objects. */
const RUN_TOKEN = Bun.randomUUIDv7().replaceAll('-', '').slice(0, 16);
const PREFIX = `bench-s3-live/${RUN_TOKEN}`;

/** Nothing outside the run's own prefix is ever deleted. */
function assertOwnKey(key: string): string {
  if (!key.startsWith(`${PREFIX}/`))
    throw new Error(`refusing to touch a key outside this run: ${key}`);
  return key;
}

const aws = new AwsS3Client({
  endpoint: ENDPOINT,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
  region: REGION,
});

const bun = new S3Client({
  accessKeyId: ACCESS_KEY_ID,
  secretAccessKey: SECRET_ACCESS_KEY,
  bucket: BUCKET,
  endpoint: ENDPOINT,
  region: REGION,
});

// ---------------------------------------------------------------------------
// check plumbing, same shape as bench/sqlite and bench/uuid
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  pass: boolean;
  detail: string;
  /** A failure that should fail the run rather than merely be reported. */
  critical: boolean;
}

const checks: Check[] = [];
const written = new Set<string>();

function check(name: string, pass: boolean, detail = '', critical = false) {
  checks.push({ name, pass, detail, critical });
  const status = pass ? 'PASS' : critical ? 'FAIL' : 'INFO';
  console.log(`${status.padEnd(5)} ${name.padEnd(46)} ${detail}`);
}

/** Runs a check body, turning a throw into a failed check rather than a crash. */
async function attempt(
  name: string,
  critical: boolean,
  body: () => Promise<{ pass: boolean; detail: string }>
) {
  try {
    const { pass, detail } = await body();
    check(name, pass, detail, critical);
  } catch (error) {
    const thrown = error as Error & { code?: unknown };
    check(
      name,
      false,
      `threw ${thrown.name}${thrown.code ? ` (${String(thrown.code)})` : ''}: ${thrown.message}`,
      critical
    );
  }
}

const key = (name: string) => {
  const full = `${PREFIX}/${name}`;
  written.add(full);
  return full;
};

const encodeKey = (value: string) => value.split('/').map(uriEncode).join('/');

/** `HeadObject` through the aws-sdk, which reports every stored header. */
async function head(objectKey: string) {
  return aws.send(new HeadObjectCommand({ Bucket: BUCKET, Key: objectKey }));
}

const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const DISPOSITION = 'inline; filename="live.webp"';
const BODY = 'live-probe-body-bytes';

console.log(
  SELF_TEST
    ? `\nbench/s3 live probe — SELF TEST against ${ENDPOINT}, prefix ${PREFIX}/\n` +
        `  Not R2. Only proves the checks execute; the answers mean nothing.\n` +
        `${'-'.repeat(78)}`
    : `\nbench/s3 live probe — bucket ${BUCKET}, region scope ${REGION}, prefix ${PREFIX}/\n` +
        `${'-'.repeat(78)}`
);

try {
  // -- 0. which signing regions does R2 accept? ---------------------------
  await attempt(
    `the configured region scope (${REGION}) is accepted`,
    true,
    async () => {
      // First, because everything after it is signed with this scope and a
      // rejection here would surface as twenty unrelated-looking failures.
      const objectKey = key('region-scope.txt');
      await bun.write(objectKey, 'region probe');
      return { pass: true, detail: `SigV4 credential scope .../${REGION}/s3/` };
    }
  );

  await attempt(
    'R2 accepts both `auto` and the location hint',
    false,
    async () => {
      // `lib/r2/client.ts` hard-codes `weur`; Cloudflare documents `auto`. If only
      // one of these works, that is a one-line fix in production code and the
      // migration is not what would have broken it.
      const results: string[] = [];
      for (const region of ['auto', 'weur', 'us-east-1']) {
        const client = new S3Client({
          accessKeyId: ACCESS_KEY_ID,
          secretAccessKey: SECRET_ACCESS_KEY,
          bucket: BUCKET,
          endpoint: ENDPOINT,
          region,
        });
        try {
          await client.write(key(`region-${region}.txt`), 'region probe');
          results.push(`${region}=ok`);
        } catch (error) {
          const thrown = error as Error & { code?: unknown };
          results.push(`${region}=${String(thrown.code ?? thrown.name)}`);
        }
      }
      return {
        pass: results.every((r) => r.endsWith('=ok')),
        detail: results.join(' '),
      };
    }
  );

  // -- 1. the aws-sdk baseline, on the real bucket -------------------------
  await attempt(
    'aws PutObject stores Cache-Control + metadata',
    true,
    async () => {
      const objectKey = key('aws-baseline.webp');
      await aws.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: objectKey,
          Body: BODY,
          ContentType: 'image/webp',
          CacheControl: CACHE_CONTROL,
          ContentDisposition: DISPOSITION,
          Metadata: { originalmimetype: 'image/png', originalsize: '4096' },
        })
      );
      const stored = await head(objectKey);
      const pass =
        stored.CacheControl === CACHE_CONTROL &&
        stored.Metadata?.['originalmimetype'] === 'image/png' &&
        stored.ContentType === 'image/webp';
      return {
        pass,
        detail: `cache-control=${stored.CacheControl ?? '(none)'} meta=${JSON.stringify(stored.Metadata ?? {})}`,
      };
    }
  );

  // -- 2. the gap, confirmed on R2 rather than on a fake -------------------
  await attempt(
    'bun write drops Cache-Control and metadata',
    true,
    async () => {
      const objectKey = key('bun-write.webp');
      await bun.write(objectKey, BODY, {
        type: 'image/webp',
        contentDisposition: DISPOSITION,
        // Neither is in `S3Options`; passed to see what R2 ends up holding.
        ...({ cacheControl: CACHE_CONTROL } as object),
        ...({ metadata: { originalmimetype: 'image/png' } } as object),
      });
      const stored = await head(objectKey);
      const dropped =
        !stored.CacheControl && Object.keys(stored.Metadata ?? {}).length === 0;
      return {
        pass: dropped,
        detail: dropped
          ? 'both absent on R2, as measured locally'
          : `UNEXPECTED: cache-control=${stored.CacheControl ?? '(none)'} meta=${JSON.stringify(stored.Metadata ?? {})}`,
      };
    }
  );

  await attempt(
    'bun write preserves content-type + disposition',
    true,
    async () => {
      const stored = await head(`${PREFIX}/bun-write.webp`);
      const pass =
        stored.ContentType === 'image/webp' &&
        stored.ContentDisposition === DISPOSITION;
      return {
        pass,
        detail: `type=${stored.ContentType ?? '(none)'} disposition=${stored.ContentDisposition ?? '(none)'}`,
      };
    }
  );

  // -- 3. Cloudflare accepts Bun's presigned URLs --------------------------
  await attempt('R2 accepts a Bun presigned GET', true, async () => {
    const url = bun.presign(`${PREFIX}/bun-write.webp`, { expiresIn: 300 });
    const response = await fetch(url);
    const text = response.ok ? await response.text() : '';
    return {
      pass: response.status === 200 && text === BODY,
      detail: `status=${response.status} bodyMatches=${text === BODY}`,
    };
  });

  await attempt(
    'presigned GET applies response-content overrides',
    false,
    async () => {
      const url = bun.presign(`${PREFIX}/bun-write.webp`, {
        expiresIn: 300,
        contentDisposition: 'attachment; filename="renamed.webp"',
        type: 'application/octet-stream',
      });
      const response = await fetch(url);
      const disposition = response.headers.get('content-disposition');
      const type = response.headers.get('content-type');
      return {
        pass:
          response.status === 200 &&
          disposition === 'attachment; filename="renamed.webp"' &&
          type === 'application/octet-stream',
        detail: `status=${response.status} disposition=${disposition} type=${type}`,
      };
    }
  );

  await attempt('R2 accepts a Bun presigned PUT', true, async () => {
    const objectKey = key('presigned-put.webp');
    const url = bun.presign(objectKey, { method: 'PUT', expiresIn: 300 });
    const response = await fetch(url, {
      method: 'PUT',
      body: 'uploaded-through-a-presigned-url',
    });
    const size = response.ok ? await bun.size(objectKey) : -1;
    return {
      pass: response.ok && size === 'uploaded-through-a-presigned-url'.length,
      detail: `status=${response.status} storedBytes=${size}`,
    };
  });

  await attempt(
    'a presigned URL past 7 days is rejected at use time',
    false,
    async () => {
      // Why the clamp in `lib/r2/client.ts` has to survive the migration: Bun
      // signs this happily where the aws-sdk refused to build it.
      const url = bun.presign(`${PREFIX}/bun-write.webp`, {
        expiresIn: 604_800 + 3600,
      });
      const response = await fetch(url);
      return {
        pass: !response.ok,
        detail: `status=${response.status} (a 2xx here would mean R2 tolerates it)`,
      };
    }
  );

  // -- 4. the copy workaround, which only R2 can settle -------------------
  await attempt('a hand-signed copy succeeds on R2', true, async () => {
    const destination = key('copy-signed.webp');
    const signed = signRequest({
      method: 'PUT',
      url: `${ENDPOINT}/${BUCKET}/${encodeKey(destination)}`,
      headers: { 'x-amz-copy-source': `${BUCKET}/${PREFIX}/bun-write.webp` },
      credentials: {
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
        region: REGION,
      },
    });
    const response = await fetch(signed.url, {
      method: 'PUT',
      headers: signed.headers,
    });
    const body = await response.text();
    const size = response.ok ? await bun.size(destination) : -1;
    return {
      pass: response.ok && size === BODY.length,
      detail: response.ok
        ? `status=${response.status} copiedBytes=${size}`
        : `status=${response.status} ${body.slice(0, 160)}`,
    };
  });

  await attempt(
    'a presigned PUT with an unsigned copy-source is refused',
    false,
    async () => {
      // The claim `copy.test.ts` marks as unverified. A 2xx here would mean the
      // cheaper workaround is viable after all; a 4xx confirms that the signed
      // route is the only one.
      const destination = key('copy-presigned.webp');
      const url = bun.presign(destination, { method: 'PUT', expiresIn: 300 });
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'x-amz-copy-source': `${BUCKET}/${PREFIX}/bun-write.webp` },
      });
      const body = await response.text();
      return {
        pass: !response.ok,
        detail: `status=${response.status} ${body.slice(0, 120)}`,
      };
    }
  );

  // -- 5. reads ----------------------------------------------------------
  await attempt(
    'stat reports size, etag, type, lastModified',
    false,
    async () => {
      const stat = await bun.stat(`${PREFIX}/bun-write.webp`);
      return {
        pass:
          stat.size === BODY.length &&
          typeof stat.etag === 'string' &&
          stat.lastModified instanceof Date,
        detail: `size=${stat.size} type=${stat.type} etag=${stat.etag}`,
      };
    }
  );

  await attempt('exists distinguishes present from absent', false, async () => {
    const present = await bun.exists(`${PREFIX}/bun-write.webp`);
    const absent = await bun.exists(`${PREFIX}/definitely-not-here.webp`);
    return {
      pass: present && !absent,
      detail: `present=${present} absent=${absent}`,
    };
  });

  await attempt('slice sends a Range R2 honours', false, async () => {
    const partial = await bun
      .file(`${PREFIX}/bun-write.webp`)
      .slice(0, 4)
      .text();
    return {
      pass: partial === BODY.slice(0, 4),
      detail: JSON.stringify(partial),
    };
  });

  await attempt(
    'an open-ended slice is accepted despite its absurd upper bound',
    false,
    async () => {
      // Bun sends `bytes=4-4503599627370494` rather than `bytes=4-`.
      const rest = await bun.file(`${PREFIX}/bun-write.webp`).slice(4).text();
      return {
        pass: rest === BODY.slice(4),
        detail: JSON.stringify(rest.slice(0, 24)),
      };
    }
  );

  await attempt("list returns this run's prefix only", false, async () => {
    const listed = await bun.list({ prefix: `${PREFIX}/`, maxKeys: 100 });
    const keys = (listed.contents ?? []).map((entry) => entry.key);
    const checksum = listed.contents?.[0]?.checksumAlgorithm;
    return {
      pass: keys.length > 0 && keys.every((k) => k.startsWith(`${PREFIX}/`)),
      detail: `${keys.length} keys, checksumAlgorithm=${checksum ?? '(absent on R2)'}`,
    };
  });

  await attempt(
    'the s3:// protocol double-encodes a spaced key',
    false,
    async () => {
      // Reproduced locally; this is whether R2 sees the same broken key.
      const spaced = key('a spaced name.webp');
      await bun.write(spaced, BODY, { type: 'image/webp' });
      const viaFile = await bun.file(spaced).text();
      const viaProtocol = await fetch(`s3://${BUCKET}/${spaced}`, {
        s3: {
          accessKeyId: ACCESS_KEY_ID,
          secretAccessKey: SECRET_ACCESS_KEY,
          endpoint: ENDPOINT,
          region: REGION,
        },
      });
      return {
        pass: viaFile === BODY && !viaProtocol.ok,
        detail: `file()=ok s3://=${viaProtocol.status} (a 200 would mean R2 tolerates the double encoding)`,
      };
    }
  );

  // -- 6. sizes and multipart -------------------------------------------
  await attempt('a 6 MB write is one PUT R2 accepts', false, async () => {
    const objectKey = key('six-megabytes.bin');
    const size = 6 * 1024 * 1024;
    await bun.write(objectKey, Buffer.alloc(size, 0x61));
    return {
      pass: (await bun.size(objectKey)) === size,
      detail: `${size} bytes in a single request`,
    };
  });

  await attempt(
    'a writer-driven multipart upload completes on R2',
    false,
    async () => {
      const objectKey = key('multipart.bin');
      const part = Buffer.alloc(5 * 1024 * 1024, 0x62);
      const writer = bun.file(objectKey).writer({ partSize: 5 * 1024 * 1024 });
      writer.write(part);
      await writer.flush();
      writer.write(part);
      await writer.flush();
      writer.write(Buffer.from('tail'));
      await writer.end();
      const expected = part.byteLength * 2 + 4;
      const actual = await bun.size(objectKey);
      return {
        pass: actual === expected,
        detail: `${actual} of ${expected} bytes`,
      };
    }
  );

  await attempt(
    'a ReadableStream body is stringified on R2 too',
    false,
    async () => {
      // The silent-data-loss finding, on the real bucket.
      const objectKey = key('readable-stream.bin');
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024).fill(0x61));
          controller.close();
        },
      });
      await bun.write(objectKey, stream as never);
      const stored = await bun.file(objectKey).text();
      return {
        pass: stored === '[object ReadableStream]',
        detail: `${stored.length} bytes: ${JSON.stringify(stored.slice(0, 32))}`,
      };
    }
  );

  // -- 7. delete --------------------------------------------------------
  await attempt('delete removes the object', true, async () => {
    const objectKey = key('to-delete.webp');
    await bun.write(objectKey, BODY);
    await bun.delete(objectKey);
    return {
      pass: !(await bun.exists(objectKey)),
      detail: 'gone after delete',
    };
  });
} finally {
  // -----------------------------------------------------------------------
  // cleanup: this run's prefix, and nothing else
  // -----------------------------------------------------------------------
  console.log(`${'-'.repeat(78)}\ncleanup`);
  let removed = 0;
  const failed: string[] = [];

  // Listed rather than only tracked, so an object created by a check that threw
  // halfway is still removed.
  try {
    const listed = await bun.list({ prefix: `${PREFIX}/`, maxKeys: 1000 });
    for (const entry of listed.contents ?? []) written.add(entry.key);
    if (listed.isTruncated)
      console.log('  WARNING: listing truncated; re-run cleanup');
  } catch (error) {
    console.log(
      `  list failed, falling back to tracked keys: ${(error as Error).message}`
    );
  }

  for (const objectKey of written) {
    try {
      await bun.delete(assertOwnKey(objectKey));
      removed += 1;
    } catch (error) {
      failed.push(`${objectKey} (${(error as Error).message})`);
    }
  }

  console.log(
    `  deleted ${removed} object${removed === 1 ? '' : 's'} under ${PREFIX}/`
  );
  if (failed.length > 0) {
    console.log(`  FAILED to delete ${failed.length}:`);
    for (const line of failed) console.log(`    ${line}`);
  }

  await fakeOrigin?.stop();

  const criticalFailures = checks.filter((c) => !c.pass && c.critical);
  const informational = checks.filter((c) => !c.pass && !c.critical);
  console.log(
    `${'-'.repeat(78)}\n` +
      `${checks.filter((c) => c.pass).length}/${checks.length} passed, ` +
      `${criticalFailures.length} critical failure${criticalFailures.length === 1 ? '' : 's'}, ` +
      `${informational.length} informational`
  );

  process.exit(criticalFailures.length > 0 || failed.length > 0 ? 1 : 0);
}
