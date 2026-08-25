/**
 * `getPresignedUrl` — the export with the least visible failure mode.
 *
 * It hands a URL to a browser and never sees the outcome, so nothing in this
 * repository would notice a wrong signature: the URL looks right, and R2 answers
 * 403 to somebody else. "Bun produced a URL" is therefore not evidence, which is
 * why `shared/sigv4.ts` recomputes the signature from the URL's own inputs and
 * the first test below calibrates that oracle against
 * `@aws-sdk/s3-request-presigner` — the implementation currently in production —
 * before it is pointed at Bun.
 *
 * The other half of the file is the expiry clamp in `lib/r2/client.ts`, which
 * turns out to be load-bearing in both directions after the migration, in a way
 * it was not before.
 */
import { S3Client } from 'bun';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import {
  ASCII_KEY,
  awsClient,
  bunClient,
  CREDENTIALS,
  PRIVATE_BUCKET,
  PUBLIC_BUCKET,
  REALISTIC_KEY,
  REGION,
} from './shared/clients';
import { assertLocalOnly, startFakeS3 } from './shared/fake-s3';
import { verifyPresignedUrl } from './shared/sigv4';

const origin = await startFakeS3();
const aws = awsClient(origin);
const bun = bunClient(origin);

/** `lib/r2/client.ts`: `DEFAULT_PRESIGNED_URL_EXPIRY`, and the two bounds. */
const DEFAULT_EXPIRY = 300;
const MAX_EXPIRY = 604_800;
const MIN_EXPIRY = 1;

const RESPONSE_OVERRIDES = {
  disposition: 'attachment; filename="quarterly-report.webp"',
  type: 'image/webp',
};

const params = (url: string) =>
  Object.fromEntries(new URL(url).searchParams.entries());

beforeEach(() => {
  origin.reset();
});

afterAll(async () => {
  assertLocalOnly(origin);
  await origin.stop();
});

describe('the oracle', () => {
  test('verifies a URL from @aws-sdk/s3-request-presigner', async () => {
    // The calibration. If this fails, nothing else in this file means anything —
    // the oracle would be wrong rather than Bun.
    const url = await getSignedUrl(
      aws,
      new GetObjectCommand({
        Bucket: PUBLIC_BUCKET,
        Key: REALISTIC_KEY,
        ResponseContentDisposition: RESPONSE_OVERRIDES.disposition,
        ResponseContentType: RESPONSE_OVERRIDES.type,
      }),
      { expiresIn: DEFAULT_EXPIRY }
    );

    const verification = verifyPresignedUrl(url, CREDENTIALS.secretAccessKey);
    expect(verification.valid).toBe(true);
    expect(verification.scope.region).toBe(REGION);
    expect(verification.scope.service).toBe('s3');
    expect(verification.expiresIn).toBe(DEFAULT_EXPIRY);
  });

  test('rejects a URL whose path was edited after signing', () => {
    const url = bun.presign(REALISTIC_KEY, { expiresIn: DEFAULT_EXPIRY });
    const tampered = url.replace('/temp/', '/private/');

    expect(verifyPresignedUrl(url, CREDENTIALS.secretAccessKey).valid).toBe(
      true
    );
    expect(
      verifyPresignedUrl(tampered, CREDENTIALS.secretAccessKey).valid
    ).toBe(false);
  });

  test('rejects a URL signed with a different secret', () => {
    const url = bun.presign(REALISTIC_KEY, { expiresIn: DEFAULT_EXPIRY });
    expect(verifyPresignedUrl(url, 'not-the-secret').valid).toBe(false);
  });
});

describe("Bun's presigned URLs", () => {
  test('carry a signature that verifies, on a key with spaces and non-ASCII letters', () => {
    const verification = verifyPresignedUrl(
      bun.presign(REALISTIC_KEY, { expiresIn: DEFAULT_EXPIRY }),
      CREDENTIALS.secretAccessKey
    );

    expect(verification.valid).toBe(true);
    expect(verification.signedHeaders).toEqual(['host']);
    expect(verification.scope.accessKeyId).toBe(CREDENTIALS.accessKeyId);
  });

  test('default to GET and to the same path aws-sdk signs', async () => {
    const fromAws = await getSignedUrl(
      aws,
      new GetObjectCommand({ Bucket: PUBLIC_BUCKET, Key: REALISTIC_KEY }),
      { expiresIn: DEFAULT_EXPIRY }
    );
    const fromBun = bun.presign(REALISTIC_KEY, { expiresIn: DEFAULT_EXPIRY });

    expect(new URL(fromBun).pathname).toBe(new URL(fromAws).pathname);
    expect(params(fromBun)['X-Amz-Algorithm']).toBe('AWS4-HMAC-SHA256');
    expect(params(fromBun)['X-Amz-Credential']).toBe(
      params(fromAws)['X-Amz-Credential']
    );
    expect(params(fromBun)['X-Amz-SignedHeaders']).toBe('host');
  });

  test('map responseContentDisposition/responseContentType onto the same query parameters', async () => {
    // These are the two options `getPresignedUrl` accepts, and they are what
    // makes a download arrive with a filename instead of inline. Bun spells them
    // `contentDisposition` and `type`; the wire form has to be identical.
    const fromBun = params(
      bun.presign(REALISTIC_KEY, {
        expiresIn: DEFAULT_EXPIRY,
        contentDisposition: RESPONSE_OVERRIDES.disposition,
        type: RESPONSE_OVERRIDES.type,
      })
    );
    const fromAws = params(
      await getSignedUrl(
        aws,
        new GetObjectCommand({
          Bucket: PUBLIC_BUCKET,
          Key: REALISTIC_KEY,
          ResponseContentDisposition: RESPONSE_OVERRIDES.disposition,
          ResponseContentType: RESPONSE_OVERRIDES.type,
        }),
        { expiresIn: DEFAULT_EXPIRY }
      )
    );

    expect(fromBun['response-content-disposition']).toBe(
      RESPONSE_OVERRIDES.disposition
    );
    expect(fromBun['response-content-type']).toBe(RESPONSE_OVERRIDES.type);
    expect(fromBun['response-content-disposition']).toBe(
      fromAws['response-content-disposition']
    );
    expect(fromBun['response-content-type']).toBe(
      fromAws['response-content-type']
    );
  });

  test('omit the three parameters aws-sdk adds, none of which R2 needs', async () => {
    const fromAws = params(
      await getSignedUrl(
        aws,
        new GetObjectCommand({ Bucket: PUBLIC_BUCKET, Key: ASCII_KEY }),
        { expiresIn: DEFAULT_EXPIRY }
      )
    );
    const fromBun = params(
      bun.presign(ASCII_KEY, { expiresIn: DEFAULT_EXPIRY })
    );

    // aws-sdk's own bookkeeping. A shorter URL is the only consequence.
    expect(fromAws['x-id']).toBe('GetObject');
    expect(fromAws['X-Amz-Content-Sha256']).toBe('UNSIGNED-PAYLOAD');
    expect(fromAws['x-amz-checksum-mode']).toBe('ENABLED');
    expect(fromBun['x-id']).toBeUndefined();
    expect(fromBun['X-Amz-Content-Sha256']).toBeUndefined();
    expect(fromBun['x-amz-checksum-mode']).toBeUndefined();
  });

  test('are produced without a network request, as the docs claim', () => {
    bun.presign(REALISTIC_KEY, { expiresIn: DEFAULT_EXPIRY });
    bun.presign(REALISTIC_KEY, { expiresIn: DEFAULT_EXPIRY, method: 'PUT' });
    expect(origin.requests).toHaveLength(0);
  });

  test('select the bucket per call, which is how bucketType has to be honoured', () => {
    // `getPresignedUrl` takes `bucketType`, so the URL must be able to name
    // either bucket without building a second client.
    expect(
      new URL(bun.presign(ASCII_KEY, { expiresIn: 60 })).pathname
    ).toContain(`/${PUBLIC_BUCKET}/`);
    expect(
      new URL(bun.presign(ASCII_KEY, { expiresIn: 60, bucket: PRIVATE_BUCKET }))
        .pathname
    ).toContain(`/${PRIVATE_BUCKET}/`);
  });
});

describe('a presigned URL actually works end to end', () => {
  test('GET returns the object and applies the response-content overrides', async () => {
    origin.put(`${PUBLIC_BUCKET}/${ASCII_KEY}`, 'the-bytes', {
      'content-type': 'image/webp',
    });

    const response = await fetch(
      bun.presign(ASCII_KEY, {
        expiresIn: DEFAULT_EXPIRY,
        contentDisposition: RESPONSE_OVERRIDES.disposition,
        type: 'application/octet-stream',
      })
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('the-bytes');
    expect(response.headers.get('content-disposition')).toBe(
      RESPONSE_OVERRIDES.disposition
    );
    expect(response.headers.get('content-type')).toBe(
      'application/octet-stream'
    );
  });

  test('PUT uploads through the URL, which is the direct-upload case', async () => {
    const response = await fetch(
      bun.presign('uploads/direct.webp', { method: 'PUT', expiresIn: 60 }),
      { method: 'PUT', body: 'uploaded-without-credentials' }
    );

    expect(response.status).toBe(200);
    expect(
      new TextDecoder().decode(
        origin.objects.get(`${PUBLIC_BUCKET}/uploads/direct.webp`)?.body
      )
    ).toBe('uploaded-without-credentials');
    // The credential never left the server; the request carried no Authorization.
    expect(origin.one('PUT').headers['authorization']).toBeUndefined();
  });
});

describe('expiry — where the clamp in lib/r2/client.ts earns its place', () => {
  test('the requested expiry reaches the URL verbatim, within bounds', () => {
    for (const expiresIn of [MIN_EXPIRY, DEFAULT_EXPIRY, 3600, MAX_EXPIRY]) {
      expect(
        Number(params(bun.presign(ASCII_KEY, { expiresIn }))['X-Amz-Expires'])
      ).toBe(expiresIn);
    }
  });

  test('Bun throws below 1 second, where aws-sdk signed it', async () => {
    // A behavioural difference the clamp already hides: `Math.max(1, …)` means
    // no caller can reach this. Without the clamp, `expiresIn: 0` would go from
    // a useless-but-quiet URL to a thrown TypeError.
    for (const expiresIn of [0, -1]) {
      expect(() => bun.presign(ASCII_KEY, { expiresIn })).toThrow(
        /expiresIn must be great/
      );
      const awsUrl = await getSignedUrl(
        aws,
        new GetObjectCommand({ Bucket: PUBLIC_BUCKET, Key: ASCII_KEY }),
        { expiresIn }
      );
      expect(params(awsUrl)['X-Amz-Expires']).toBe(String(expiresIn));
    }
  });

  test('Bun signs beyond seven days without complaint, where aws-sdk refused', async () => {
    // The inverse, and the more dangerous one: SigV4 caps presigned expiry at
    // one week, so this URL is rejected by R2 at use time rather than at
    // creation. aws-sdk refused to build it at all. The clamp is what keeps that
    // unreachable — it must survive the migration.
    const beyondLimit = MAX_EXPIRY + 1;
    const url = bun.presign(ASCII_KEY, { expiresIn: beyondLimit });
    expect(params(url)['X-Amz-Expires']).toBe(String(beyondLimit));
    expect(verifyPresignedUrl(url, CREDENTIALS.secretAccessKey).valid).toBe(
      true
    );

    await expect(
      getSignedUrl(
        aws,
        new GetObjectCommand({ Bucket: PUBLIC_BUCKET, Key: ASCII_KEY }),
        { expiresIn: beyondLimit }
      )
    ).rejects.toThrow(/less than one week/);
  });
});

describe('presign options beyond the current call site', () => {
  test('every method the type allows is accepted, and an unknown one throws', () => {
    for (const method of ['GET', 'PUT', 'HEAD', 'DELETE', 'POST'] as const) {
      const verification = verifyPresignedUrl(
        bun.presign(ASCII_KEY, { method, expiresIn: 60 }),
        CREDENTIALS.secretAccessKey,
        method
      );
      expect(verification.valid).toBe(true);
    }

    let thrown: unknown;
    try {
      // Deliberately outside the union, which is the whole point of the check.
      bun.presign(ASCII_KEY, { method: 'PATCH' as 'PUT', expiresIn: 60 });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string } | undefined)?.code).toBe(
      'ERR_S3_INVALID_METHOD'
    );
  });

  test('a colon in the access key id is left unencoded — oven-sh/bun#24422, still open', () => {
    // Reproduced on Bun 1.4.0: `presign` emits `TENANT:KEYID%2F…` where SigV4
    // requires `TENANT%3AKEYID%2F…`. Bun signs the form it emits, so it is
    // self-consistent and this suite's oracle accepts it — the mismatch appears
    // only at a server that canonicalizes the query the way the specification
    // does, which is why it is reported against S3-compatible providers whose
    // keys look like `tenant:key`.
    //
    // Not a blocker for R2, whose access key ids are 32 hex characters, and the
    // second half of this test is what makes that a checked claim rather than an
    // assumption. Kept so a provider change surfaces here.
    const colonKey = new S3Client({
      accessKeyId: 'TENANT:KEYID',
      secretAccessKey: CREDENTIALS.secretAccessKey,
      bucket: PUBLIC_BUCKET,
      endpoint: origin.url,
      region: REGION,
    });
    const rawCredential = (url: string) =>
      new URL(url).search
        .slice(1)
        .split('&')
        .find((pair) => pair.startsWith('X-Amz-Credential=')) ?? '';

    expect(
      rawCredential(colonKey.presign(ASCII_KEY, { expiresIn: 60 }))
    ).toContain('TENANT:KEYID');

    // An R2-shaped key: 32 hex characters, nothing SigV4 needs to escape.
    const r2Shaped = new S3Client({
      accessKeyId: 'ac2f9e1b4d6c8a0f3e5d7b9c1a2f4e6d',
      secretAccessKey: CREDENTIALS.secretAccessKey,
      bucket: PUBLIC_BUCKET,
      endpoint: origin.url,
      region: REGION,
    });
    const credential = rawCredential(
      r2Shaped.presign(ASCII_KEY, { expiresIn: 60 })
    );
    expect(credential).not.toMatch(/[^A-Za-z0-9%=_\-.~]/);
    expect(credential).toContain('%2F');
  });

  test('acl rides in the query and is covered by the signature', () => {
    const url = bun.presign(ASCII_KEY, {
      acl: 'public-read',
      expiresIn: 60,
    });

    expect(params(url)['X-Amz-Acl']).toBe('public-read');
    const verification = verifyPresignedUrl(url, CREDENTIALS.secretAccessKey);
    expect(verification.valid).toBe(true);
    // Signed, so it cannot be edited to `public-read-write` in transit.
    expect(
      verifyPresignedUrl(
        url.replace('public-read', 'public-read-write'),
        CREDENTIALS.secretAccessKey
      ).valid
    ).toBe(false);
  });
});
