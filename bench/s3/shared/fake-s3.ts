/**
 * A recording S3-compatible origin, served on 127.0.0.1 by `Bun.serve`.
 *
 * Every cheaper approach to this comparison measures the wrong thing. Stubbing
 * either client's own module tests the stub; presigning alone exercises the
 * signer and never a request. What has to be compared is **what arrives at the
 * bucket** — method, path, query, headers, body — because that is the whole of
 * the contract `lib/r2/client.ts` has with Cloudflare, and it is the only part a
 * migration can break invisibly.
 *
 * So both clients are pointed here and the recordings are diffed.
 * `@aws-sdk/client-s3` speaks `node:http` and Bun's `S3Client` speaks its own
 * native HTTP stack; neither can tell this apart from R2, and neither is mocked.
 *
 * It is also the containment boundary: no credential in this suite unlocks
 * anything, and `assertLocalOnly` fails a run in which a client resolved an
 * endpoint other than this one.
 */
/** One request as it arrived, flattened so a diff reads cleanly. */
export interface RecordedRequest {
  method: string;
  /** Pathname only — `/bucket/key` under path style. */
  path: string;
  /** Decoded query parameters, which is where presigning puts everything. */
  query: Record<string, string>;
  /**
   * The query string exactly as it arrived, `?` stripped.
   *
   * Kept alongside the decoded form because SigV4 canonicalizes the *encoded*
   * query, and a decoded `+` is indistinguishable from a space — re-encoding
   * `query` would break verification of any request containing either.
   */
  rawQuery: string;
  /** Lowercased header names, as HTTP delivers them. */
  headers: Record<string, string>;
  /** Request body. Empty for GET/HEAD/DELETE. */
  body: Uint8Array<ArrayBuffer>;
  /** `Host`, which is what distinguishes path from virtual-hosted style. */
  host: string;
}

export interface FakeS3Options {
  /**
   * Answer `PUT`/`DELETE` with `Content-Length: 0` and `Connection: close` —
   * the response shape Bun 1.4 lists as previously misreported as
   * `ConnectionClosed`, "fixing spurious retries through connection-recycling
   * proxies" (#33292).
   */
  closeDelimited?: boolean;
  /**
   * Hold every response this long. Without a delay nothing is ever in flight at
   * the same moment, so `peakConcurrency` — the only way to observe whether
   * `queueSize` is honoured — would always read 1.
   */
  delayMs?: number;
}

/**
 * Headers that differ per request or per client library and carry no contract.
 * Removing them is what lets a header diff between the two clients be read as a
 * behavioural difference rather than as noise.
 */
const VOLATILE_HEADERS = new Set([
  'authorization',
  'x-amz-date',
  'x-amz-content-sha256',
  'user-agent',
  'amz-sdk-invocation-id',
  'amz-sdk-request',
  'connection',
  'host',
  'accept',
  'accept-encoding',
  'content-length',
]);

export interface FakeS3 {
  /** Endpoint to hand both clients, e.g. `http://127.0.0.1:53211`. */
  readonly url: string;
  readonly port: number;
  /** Every request since the last `reset()`, in arrival order. */
  readonly requests: readonly RecordedRequest[];
  /** Stored objects keyed by `bucket/key`, so a write round-trips to a read. */
  readonly objects: Map<
    string,
    { body: Uint8Array<ArrayBuffer>; headers: Record<string, string> }
  >;
  /** Requests of one method, which is what most assertions want. */
  of(method: string): readonly RecordedRequest[];
  /** The single request of one method; throws unless there is exactly one. */
  one(method: string): RecordedRequest;
  /**
   * Headers a client chose to send, minus the per-request noise. What is left is
   * the part a migration has to keep.
   */
  meaningfulHeaders(request: RecordedRequest): Record<string, string>;
  /** Force the next `times` responses to `method` to fail, for error paths. */
  failNext(method: string, status: number, code: string, times?: number): void;
  /** Most requests ever in flight at once. Needs `delayMs` to exceed 1. */
  peakConcurrency(): number;
  /**
   * Every `Host` seen since the server started, and NOT cleared by `reset()` —
   * `assertLocalOnly` runs once at the end of a file, and a per-test reset would
   * leave it checking only the last test's requests.
   */
  readonly hosts: ReadonlySet<string>;
  /** Seed an object without going through a client. */
  put(
    bucketAndKey: string,
    body: string | Uint8Array<ArrayBuffer>,
    headers?: Record<string, string>
  ): void;
  reset(): void;
  stop(): Promise<void>;
}

function xml(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    headers: { 'content-type': 'application/xml' },
  });
}

function errorXml(status: number, code: string, key: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code>` +
      `<Message>${code}</Message><Key>${key}</Key>` +
      `<RequestId>fake-s3</RequestId></Error>`,
    { status, headers: { 'content-type': 'application/xml' } }
  );
}

/** Stable weak ETag over the body, so `stat()` and `list()` return something. */
function etagOf(body: Uint8Array<ArrayBuffer>): string {
  return `"${Bun.hash.wyhash(body).toString(16).padStart(16, '0')}"`;
}

export async function startFakeS3(
  options: FakeS3Options = {}
): Promise<FakeS3> {
  const requests: RecordedRequest[] = [];
  const objects = new Map<
    string,
    { body: Uint8Array<ArrayBuffer>; headers: Record<string, string> }
  >();
  const failures: {
    method: string;
    status: number;
    code: string;
    times: number;
  }[] = [];
  /** Part bodies of in-flight multipart uploads, so completion can join them. */
  const parts = new Map<string, Map<number, Uint8Array<ArrayBuffer>>>();
  const concurrency = { current: 0, peak: 0 };
  const hosts = new Set<string>();

  const takeFailure = (method: string) => {
    const pending = failures.find((f) => f.method === method && f.times > 0);
    if (!pending) return undefined;
    pending.times -= 1;
    return pending;
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());
    const headers: Record<string, string> = {};
    for (const [name, value] of request.headers) headers[name] = value;
    const query: Record<string, string> = {};
    for (const [name, value] of url.searchParams) query[name] = value;

    const host = request.headers.get('host') ?? '';
    hosts.add(host);

    requests.push({
      method: request.method,
      path: url.pathname,
      query,
      rawQuery: url.search.replace(/^\?/, ''),
      headers,
      body,
      host,
    });

    // Path style, so the bucket is the first segment. Keeping it in the map
    // key means two buckets never collide.
    const objectKey = decodeURIComponent(url.pathname.replace(/^\//, ''));

    const failure = takeFailure(request.method);
    if (failure) return errorXml(failure.status, failure.code, objectKey);

    const closing: Record<string, string> = options.closeDelimited
      ? { connection: 'close', 'content-length': '0' }
      : {};

    // ---- multipart -----------------------------------------------------
    if (request.method === 'POST' && url.searchParams.has('uploads')) {
      parts.set(objectKey, new Map());
      return xml(
        `<InitiateMultipartUploadResult><Bucket>b</Bucket>` +
          `<Key>${objectKey}</Key><UploadId>fake-upload-id</UploadId>` +
          `</InitiateMultipartUploadResult>`
      );
    }
    if (request.method === 'PUT' && url.searchParams.has('uploadId')) {
      const number = Number(url.searchParams.get('partNumber'));
      parts.get(objectKey)?.set(number, body);
      return new Response(null, {
        status: 200,
        headers: { etag: etagOf(body) },
      });
    }
    if (request.method === 'POST' && url.searchParams.has('uploadId')) {
      const collected = parts.get(objectKey);
      const ordered = [...(collected?.entries() ?? [])].sort(
        ([a], [b]) => a - b
      );
      const total = ordered.reduce((sum, [, part]) => sum + part.byteLength, 0);
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const [, part] of ordered) {
        joined.set(part, offset);
        offset += part.byteLength;
      }
      parts.delete(objectKey);
      objects.set(objectKey, { body: joined, headers: {} });
      return xml(
        `<CompleteMultipartUploadResult><Location>${url.href}</Location>` +
          `<Bucket>b</Bucket><Key>${objectKey}</Key>` +
          `<ETag>${etagOf(joined)}</ETag></CompleteMultipartUploadResult>`
      );
    }
    if (request.method === 'DELETE' && url.searchParams.has('uploadId')) {
      parts.delete(objectKey);
      return new Response(null, { status: 204 });
    }

    // ---- list ----------------------------------------------------------
    if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      // A list request addresses the bucket itself, so the path is `/bucket`
      // or `/bucket/` depending on the client.
      const bucket = objectKey.replace(/\/$/, '');
      const matching = [...objects.entries()]
        .filter(([key]) => key.startsWith(`${bucket}/${prefix}`))
        .map(([key, value]) => ({
          key: key.slice(bucket.length + 1),
          size: value.body.byteLength,
          etag: etagOf(value.body),
        }));
      return xml(
        `<ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix>` +
          `<KeyCount>${matching.length}</KeyCount><MaxKeys>1000</MaxKeys>` +
          `<IsTruncated>false</IsTruncated>` +
          matching
            .map(
              (object) =>
                `<Contents><Key>${object.key}</Key>` +
                `<LastModified>2026-01-01T00:00:00.000Z</LastModified>` +
                `<ETag>${object.etag}</ETag><Size>${object.size}</Size>` +
                `<StorageClass>STANDARD</StorageClass>` +
                `<ChecksumAlgorithm>CRC32</ChecksumAlgorithm>` +
                `<ChecksumType>FULL_OBJECT</ChecksumType></Contents>`
            )
            .join('') +
          `</ListBucketResult>`
      );
    }

    // ---- copy ----------------------------------------------------------
    const copySource = request.headers.get('x-amz-copy-source');
    if (request.method === 'PUT' && copySource) {
      const source = decodeURIComponent(copySource.replace(/^\//, ''));
      const existing = objects.get(source);
      if (!existing) return errorXml(404, 'NoSuchKey', source);
      objects.set(objectKey, {
        body: existing.body,
        headers: { ...existing.headers },
      });
      return xml(
        `<CopyObjectResult><ETag>${etagOf(existing.body)}</ETag>` +
          `<LastModified>2026-01-01T00:00:00.000Z</LastModified>` +
          `</CopyObjectResult>`
      );
    }

    // ---- single-object verbs -------------------------------------------
    if (request.method === 'PUT') {
      objects.set(objectKey, { body, headers });
      return new Response(null, {
        status: 200,
        headers: { etag: etagOf(body), ...closing },
      });
    }
    if (request.method === 'DELETE') {
      objects.delete(objectKey);
      return new Response(null, { status: 204, headers: { ...closing } });
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      const stored = objects.get(objectKey);
      if (!stored) return errorXml(404, 'NoSuchKey', objectKey);

      const responseHeaders: Record<string, string> = {
        etag: etagOf(stored.body),
        'last-modified': 'Thu, 01 Jan 2026 00:00:00 GMT',
        'content-type':
          stored.headers['content-type'] ?? 'application/octet-stream',
      };
      const cacheControl = stored.headers['cache-control'];
      if (cacheControl) responseHeaders['cache-control'] = cacheControl;
      const disposition = stored.headers['content-disposition'];
      if (disposition) responseHeaders['content-disposition'] = disposition;
      // Echoed because that is how S3 returns user metadata, and it is what
      // `HeadObject` populates `Metadata` from — so an assertion can follow a
      // header all the way into the object rather than only onto the wire.
      for (const [name, value] of Object.entries(stored.headers))
        if (name.startsWith('x-amz-meta-')) responseHeaders[name] = value;

      // Presigned overrides, which is what `getPresignedUrl`'s
      // `responseContentDisposition`/`responseContentType` exist to set. S3
      // lets the query win over what was stored.
      const overrideDisposition = url.searchParams.get(
        'response-content-disposition'
      );
      if (overrideDisposition)
        responseHeaders['content-disposition'] = overrideDisposition;
      const overrideType = url.searchParams.get('response-content-type');
      if (overrideType) responseHeaders['content-type'] = overrideType;

      // `Range` is what `slice()` is supposed to become on the wire.
      const range = request.headers.get('range');
      const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : stored.body.byteLength - 1;
        const slice = stored.body.slice(start, end + 1);
        return new Response(request.method === 'HEAD' ? null : slice, {
          status: 206,
          headers: {
            ...responseHeaders,
            'content-range': `bytes ${start}-${end}/${stored.body.byteLength}`,
            'content-length': String(slice.byteLength),
          },
        });
      }

      return new Response(request.method === 'HEAD' ? null : stored.body, {
        status: 200,
        headers: {
          ...responseHeaders,
          'content-length': String(stored.body.byteLength),
        },
      });
    }

    return errorXml(405, 'MethodNotAllowed', objectKey);
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      concurrency.current += 1;
      concurrency.peak = Math.max(concurrency.peak, concurrency.current);
      try {
        const response = await handle(request);
        if (options.delayMs) await Bun.sleep(options.delayMs);
        return response;
      } finally {
        concurrency.current -= 1;
      }
    },
  });

  const port = server.port;
  if (typeof port !== 'number')
    throw new Error('fake S3 origin did not bind a port');

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    objects,
    of(method) {
      return requests.filter((request) => request.method === method);
    },
    one(method) {
      const matching = requests.filter((request) => request.method === method);
      if (matching.length !== 1)
        throw new Error(
          `expected exactly one ${method}, saw ${matching.length}: ` +
            JSON.stringify(requests.map((r) => `${r.method} ${r.path}`))
        );
      const only = matching[0];
      if (!only) throw new Error('unreachable');
      return only;
    },
    meaningfulHeaders(request) {
      const kept: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers))
        if (!VOLATILE_HEADERS.has(name)) kept[name] = value;
      return kept;
    },
    failNext(method, status, code, times = 1) {
      failures.push({ method, status, code, times });
    },
    peakConcurrency() {
      return concurrency.peak;
    },
    hosts,
    put(bucketAndKey, body, headers = {}) {
      const bytes =
        typeof body === 'string' ? new TextEncoder().encode(body) : body;
      objects.set(bucketAndKey, { body: bytes, headers });
    },
    reset() {
      requests.length = 0;
      objects.clear();
      parts.clear();
      failures.length = 0;
      concurrency.peak = 0;
    },
    async stop() {
      await server.stop(true);
    },
  };
}

/**
 * Fails the run if any client reached anywhere but the fake origin.
 *
 * A misconfigured endpoint is the one mistake in this suite that could touch a
 * real bucket, and without this it would read as an ordinary assertion failure.
 */
export function assertLocalOnly(origin: FakeS3): void {
  // Over `origin.hosts` rather than `origin.requests`: the request log is
  // cleared between tests, so iterating it would only ever check the last one.
  for (const seen of origin.hosts) {
    const host = seen.split(':')[0];
    if (host !== '127.0.0.1')
      throw new Error(`a request left the loopback interface: ${seen}`);
  }
}
