/**
 * An independent AWS Signature Version 4 implementation, written for this
 * benchmark and depending on neither client under test.
 *
 * It exists for two jobs the rest of the suite cannot do:
 *
 * 1. **Verify a presigned URL.** `getPresignedUrl` hands a URL to a browser and
 *    never sees the result, so "Bun produced a URL" is not evidence — a wrong
 *    signature looks exactly like a right one until R2 answers 403. This
 *    recomputes the signature from the URL's own canonical inputs, so a URL is
 *    checked against the algorithm rather than against the library that made it.
 *    It is calibrated in `presign.test.ts` by first verifying a URL from
 *    `@aws-sdk/s3-request-presigner`, which is the known-good side.
 * 2. **Sign a copy.** Bun's S3 client has no copy operation at all, and the
 *    presigned-URL route cannot carry one: S3 rejects an unsigned `x-amz-*`
 *    header, and `presign()` signs only `host`. A copy therefore needs
 *    header-based SigV4, which is what `signRequest` produces.
 *
 * Written against the AWS documented procedure for SigV4 (canonical request →
 * string to sign → derived key → signature). Not a general-purpose signer: it
 * covers the S3 shapes this benchmark sends and nothing else.
 */

/** Hex-encoded SHA-256 of an empty body, which every copy request carries. */
export const EMPTY_PAYLOAD_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const byte of view) out += byte.toString(16).padStart(2, '0');
  return out;
}

function sha256Hex(input: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(input).digest('hex');
}

function hmac(key: Uint8Array | string, message: string): Uint8Array {
  // `Bun.CryptoHasher` in HMAC mode returns the raw digest, which is what the
  // next link in the derivation chain needs as its key.
  const hasher = new Bun.CryptoHasher('sha256', key);
  return new Uint8Array(hasher.update(message).digest());
}

/**
 * RFC 3986 percent-encoding, which is what SigV4 means by "URI-encode".
 * `encodeURIComponent` leaves `!'()*` alone, and S3 does not.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replaceAll(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Raw query pairs, encoding intact.
 *
 * `URLSearchParams` cannot be used here: it decodes, and a decoded `+` is
 * indistinguishable from a space, so re-encoding would silently change the
 * canonical string and break every signature containing one.
 */
function rawQueryPairs(url: URL): [string, string][] {
  const raw = url.search.replace(/^\?/, '');
  if (!raw) return [];
  return raw.split('&').map((pair) => {
    const equals = pair.indexOf('=');
    return equals === -1
      ? ([pair, ''] as [string, string])
      : ([pair.slice(0, equals), pair.slice(equals + 1)] as [string, string]);
  });
}

function canonicalQuery(pairs: [string, string][]): string {
  return [...pairs]
    .sort((a, b) =>
      a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1
    )
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string
): Uint8Array {
  const date = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(date, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, 'aws4_request');
}

function stringToSign(
  amzDate: string,
  scope: string,
  canonicalRequest: string
): string {
  return ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join(
    '\n'
  );
}

export interface PresignVerification {
  valid: boolean;
  /** The signature the URL carries. */
  presented: string;
  /** The signature this module derives from the URL's own inputs. */
  expected: string;
  /** Parsed `X-Amz-Credential`, so a test can assert the scope directly. */
  scope: {
    accessKeyId: string;
    dateStamp: string;
    region: string;
    service: string;
  };
  signedHeaders: string[];
  expiresIn: number;
  /** The canonical request, for a readable failure. */
  canonicalRequest: string;
}

/**
 * Recomputes the signature of a presigned S3 URL from the URL itself.
 *
 * Everything except the secret comes out of the URL — credential scope, date,
 * expiry, signed headers, query — so this verifies the URL against SigV4 rather
 * than against an expectation someone typed.
 */
export function verifyPresignedUrl(
  presignedUrl: string,
  secretAccessKey: string,
  method = 'GET'
): PresignVerification {
  const url = new URL(presignedUrl);
  const pairs = rawQueryPairs(url);
  const get = (name: string) =>
    decodeURIComponent(
      pairs.find(([key]) => key === name)?.[1].replaceAll('+', '%20') ?? ''
    );

  const presented = get('X-Amz-Signature');
  const credential = get('X-Amz-Credential');
  const [accessKeyId = '', dateStamp = '', region = '', service = ''] =
    credential.split('/');
  const amzDate = get('X-Amz-Date');
  const signedHeaders = get('X-Amz-SignedHeaders').split(';').filter(Boolean);
  const expiresIn = Number(get('X-Amz-Expires'));

  // Presigned S3 requests sign the literal string `UNSIGNED-PAYLOAD` rather than
  // a body hash — there is no body at signing time.
  const canonicalHeaders = signedHeaders
    .map((name) => `${name}:${name === 'host' ? url.host : ''}\n`)
    .join('');

  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery(pairs.filter(([name]) => name !== 'X-Amz-Signature')),
    canonicalHeaders,
    signedHeaders.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const expected = hex(
    hmac(
      signingKey(secretAccessKey, dateStamp, region, service),
      stringToSign(amzDate, scope, canonicalRequest)
    )
  );

  return {
    valid: presented === expected,
    presented,
    expected,
    scope: { accessKeyId, dateStamp, region, service },
    signedHeaders,
    expiresIn,
    canonicalRequest,
  };
}

/** The subset of a recorded request that SigV4 covers. */
export interface VerifiableRequest {
  method: string;
  path: string;
  rawQuery: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface RequestVerification {
  valid: boolean;
  presented: string;
  expected: string;
  scope: {
    accessKeyId: string;
    dateStamp: string;
    region: string;
    service: string;
  };
  signedHeaders: string[];
  /**
   * Whether `x-amz-content-sha256` matches the body that arrived. `undefined`
   * when the client declared `UNSIGNED-PAYLOAD` or `STREAMING-*`, which is not a
   * hash and so cannot disagree with anything.
   */
  payloadMatchesBody?: boolean;
  canonicalRequest: string;
}

/**
 * Recomputes the header-auth signature of a request that arrived at the origin.
 *
 * The signed-header list comes out of the request's own `Authorization`, so this
 * verifies whatever the client chose to sign rather than a list written here —
 * which is what lets one function check both clients, whose header sets differ.
 */
export function verifyRecordedRequest(
  request: VerifiableRequest,
  secretAccessKey: string
): RequestVerification {
  const authorization = request.headers['authorization'] ?? '';
  const credential = /Credential=([^,\s]+)/.exec(authorization)?.[1] ?? '';
  const signedHeaders = (
    /SignedHeaders=([^,\s]+)/.exec(authorization)?.[1] ?? ''
  )
    .split(';')
    .filter(Boolean);
  const presented = /Signature=([0-9a-f]+)/.exec(authorization)?.[1] ?? '';

  const [accessKeyId = '', dateStamp = '', region = '', service = ''] =
    credential.split('/');
  const amzDate = request.headers['x-amz-date'] ?? '';
  const declaredPayload =
    request.headers['x-amz-content-sha256'] ?? EMPTY_PAYLOAD_SHA256;

  const canonicalHeaders = signedHeaders
    .map((name) => `${name}:${(request.headers[name] ?? '').trim()}\n`)
    .join('');

  const canonicalRequest = [
    request.method,
    request.path,
    canonicalQuery(
      request.rawQuery
        ? request.rawQuery.split('&').map((pair) => {
            const equals = pair.indexOf('=');
            return equals === -1
              ? ([pair, ''] as [string, string])
              : ([pair.slice(0, equals), pair.slice(equals + 1)] as [
                  string,
                  string,
                ]);
          })
        : []
    ),
    canonicalHeaders,
    signedHeaders.join(';'),
    declaredPayload,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const expected = hex(
    hmac(
      signingKey(secretAccessKey, dateStamp, region, service),
      stringToSign(amzDate, scope, canonicalRequest)
    )
  );

  const isHash = /^[0-9a-f]{64}$/.test(declaredPayload);

  return {
    valid: presented === expected && presented.length > 0,
    presented,
    expected,
    scope: { accessKeyId, dateStamp, region, service },
    signedHeaders,
    payloadMatchesBody: isHash
      ? sha256Hex(request.body) === declaredPayload
      : undefined,
    canonicalRequest,
  };
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Header-based SigV4 for a request with no body — which is what a server-side
 * copy is: `PUT /bucket/destination` carrying `x-amz-copy-source`.
 *
 * Every `x-amz-*` header is signed, because S3 refuses a request that presents
 * one it did not sign. That is the reason a presigned URL cannot express a copy
 * and this function has to exist.
 */
export function signRequest(params: {
  method: string;
  /** Full URL including the bucket under path style. */
  url: string;
  headers: Record<string, string>;
  credentials: SigV4Credentials;
  /** Hex SHA-256 of the body. Defaults to the empty-body hash. */
  payloadSha256?: string;
  /** Fixed clock, so a test can assert a byte-exact signature. */
  now?: Date;
}): SignedRequest {
  const {
    method,
    url: target,
    headers,
    credentials,
    payloadSha256 = EMPTY_PAYLOAD_SHA256,
    now = new Date(),
  } = params;
  const service = credentials.service ?? 's3';
  const url = new URL(target);

  const amzDate = `${now.toISOString().replaceAll(/[:-]|\.\d{3}/g, '')}`;
  const dateStamp = amzDate.slice(0, 8);

  const allHeaders: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadSha256,
    'x-amz-date': amzDate,
    ...Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ])
    ),
  };

  const names = Object.keys(allHeaders).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${allHeaders[name]?.trim() ?? ''}\n`)
    .join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery(rawQueryPairs(url)),
    canonicalHeaders,
    signedHeaders,
    payloadSha256,
  ].join('\n');

  const scope = `${dateStamp}/${credentials.region}/${service}/aws4_request`;
  const signature = hex(
    hmac(
      signingKey(
        credentials.secretAccessKey,
        dateStamp,
        credentials.region,
        service
      ),
      stringToSign(amzDate, scope, canonicalRequest)
    )
  );

  return {
    url: url.href,
    headers: {
      ...allHeaders,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}
