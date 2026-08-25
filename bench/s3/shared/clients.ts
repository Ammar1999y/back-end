/**
 * The two clients under test, configured to be the same client twice.
 *
 * The aws-sdk half is not imported from `lib/r2/client.ts`, and that is the one
 * seam in this benchmark. That module builds its `S3Client` at load time from
 * `R2_ACCOUNT_ID` into `https://<id>.r2.cloudflarestorage.com`, with no way to
 * redirect it — so pointing the real module at a loopback origin is impossible
 * without editing it. What is reproduced here instead is its constructor
 * arguments, verbatim (`forcePathStyle: true`, `region: 'weur'`), and
 * `awsConfigMatchesProduction` in `production-ops.test.ts` fails if that copy
 * ever stops matching the source.
 *
 * Everything else the application decides — cache-control values, content
 * disposition, MIME policy — is imported from the real module rather than
 * restated, so the header values under assertion are production's own.
 */
import { S3Client } from 'bun';
import type { FakeS3 } from './fake-s3';

import { S3Client as AwsS3Client } from '@aws-sdk/client-s3';

/**
 * Credentials shaped like R2's but valid nowhere. Deliberately not read from the
 * environment: a test that can only reach a fake origin cannot leak, and
 * `bunfig.toml` places the working directory where no `.env` is loaded.
 */
export const CREDENTIALS = {
  accessKeyId: 'AKIABENCHS3EXAMPLE00',
  secretAccessKey: 'benchmark-secret-not-valid-anywhere-0000',
} as const;

/** Matches `lib/r2/client.ts`: `region: 'weur'` for R2. */
export const REGION = 'weur';

export const PUBLIC_BUCKET = 'bench-public';
export const PRIVATE_BUCKET = 'bench-private';

/**
 * A key in the shape `generateTempImageKey` produces: `temp/<16 hex>_<sanitized
 * name>.<ext>`. `sanitizeFilename` permits `\p{L}\p{N}\p{Zs}_-()`, so a space
 * and a non-ASCII letter are both reachable from a real upload — which is why
 * this fixture contains them rather than a tidy ASCII name.
 */
export const REALISTIC_KEY = 'temp/0f1e2d3c4b5a6978_Ünïcode name (1).webp';

/**
 * The same shape with an ASCII name. Header-equality assertions use this one:
 * a non-ASCII `Content-Disposition` is mangled on the wire — differently by each
 * client — which is its own finding rather than something to fold into every
 * other test. See `production-ops.test.ts`.
 */
export const ASCII_KEY = 'temp/0f1e2d3c4b5a6978_photo name (1).webp';

/** Code units of a header value as received, for a byte-level comparison. */
export function codeUnits(value: string): string {
  return [...value]
    .map((character) =>
      (character.codePointAt(0) ?? 0).toString(16).padStart(2, '0')
    )
    .join(' ');
}

/** The aws-sdk client, configured exactly as `lib/r2/client.ts` configures its own. */
export function awsClient(origin: FakeS3): AwsS3Client {
  return new AwsS3Client({
    endpoint: origin.url,
    credentials: {
      accessKeyId: CREDENTIALS.accessKeyId,
      secretAccessKey: CREDENTIALS.secretAccessKey,
    },
    forcePathStyle: true,
    region: REGION,
  });
}

/**
 * The Bun client for the same bucket.
 *
 * No `virtualHostedStyle`, which is the counterpart of the aws-sdk's
 * `forcePathStyle: true` — Bun addresses path style unless told otherwise, so
 * the R2 requirement is satisfied by the default rather than by an option.
 */
export function bunClient(origin: FakeS3, bucket = PUBLIC_BUCKET): S3Client {
  return new S3Client({
    ...CREDENTIALS,
    bucket,
    endpoint: origin.url,
    region: REGION,
  });
}
