/**
 * The R2 sink.
 *
 * **The `fetch` router in `./egress.ts` cannot see R2 traffic.**
 * `@aws-sdk/client-s3` resolves `NodeHttpHandler.create(...)` — `node:http`/
 * `node:https`, not `fetch` — so replacing `globalThis.fetch` never intercepts a
 * single S3 call. Verified in `node_modules/@aws-sdk/client-s3/dist-cjs/index.js`.
 *
 * So the boundary is the module, same as SMTP: a `mock.module` installed once
 * from the PRELOAD, never from a test file. Process-wide replacement of a shared
 * module is only safe when it is uniform, and the preload is the only place that
 * can guarantee that. See `./mailbox.ts` for the same argument at length.
 *
 * **Stateful, not merely recording.** The media library reads back what it
 * wrote — `HeadObject` after a copy, `ListObjectsV2` for reconciliation, a 412
 * from `If-None-Match: *` on a key that exists — so the stub keeps a per-bucket
 * map of objects and answers from it, with the error shapes the real SDK uses
 * (`NotFound`, `NoSuchKey`, `PreconditionFailed`, each with `$metadata`).
 * Behaviour that was MEASURED against R2 and matters to a caller is reproduced:
 * deleting a missing key succeeds, `DeleteObjects` refuses more than 1000 keys
 * with `MalformedXML`, `CopyObject` copies headers unless `REPLACE` is given, a
 * SHA-256 checksum is kept on the object that was written with it and is NOT
 * carried by a copy, and the ETag of a copy equals its source's.
 *
 * Command inputs are the SDK's own exported types, so a production call that
 * omits a required field or names one the SDK does not have fails `tsc` here as
 * well as against the real client.
 */
import { createHash } from 'node:crypto';
import type {
  CopyObjectCommandInput,
  DeleteObjectCommandInput,
  DeleteObjectsCommandInput,
  GetObjectCommandInput,
  HeadObjectCommandInput,
  ListObjectsV2CommandInput,
  PutObjectCommandInput,
} from '@aws-sdk/client-s3';

interface CommandInputs {
  PutObject: PutObjectCommandInput;
  DeleteObject: DeleteObjectCommandInput;
  DeleteObjects: DeleteObjectsCommandInput;
  CopyObject: CopyObjectCommandInput;
  GetObject: GetObjectCommandInput;
  HeadObject: HeadObjectCommandInput;
  ListObjectsV2: ListObjectsV2CommandInput;
}

type StoreOpKind = keyof CommandInputs;

/** One command as `send` sees it: the kind selects the SDK input type. */
type Command = {
  [K in StoreOpKind]: { kind: K; input: CommandInputs[K] };
}[StoreOpKind];

/** One recorded object-store operation, in the shape the command carried. */
export interface StoreOp {
  kind: StoreOpKind;
  bucket?: string;
  key?: string;
  /** `DeleteObjects` only: every key in the request, in order. */
  keys?: string[];
  contentType?: string;
  /** Byte length of a PutObject body, so a size assertion needs no buffer. */
  bytes?: number;
  /** `CopyObject` only: `<bucket>/<percent-encoded key>` as sent on the wire. */
  copySource?: string;
  metadataDirective?: string;
  ifNoneMatch?: string;
}

interface StoredObject {
  /**
   * The stored bytes themselves, so the ETag can be their MD5 the way R2's
   * single-part ETag is. With the ETag standing in for the byte length, the
   * copy verification's `etag !== source.etag` clause restated its length
   * clause and no test could tell the two apart.
   */
  body: Buffer;
  bytes: number;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
  /** Base64, as the SDK sends and returns it. */
  checksumSha256?: string;
}

const ops: StoreOp[] = [];
const objects = new Map<string, StoredObject>();

/**
 * Failure injection, in a holder rather than a bare `let` so the setters below
 * stay ordinary exported functions.
 *
 * `failKinds` is what makes rollback paths testable: an operation that cannot be
 * made to fail leaves its recovery branch unreachable.
 */
const state: {
  failKinds: Map<StoreOpKind, string | undefined>;
  failKeys: Map<StoreOpKind, Set<string>>;
  corruptNextCopy: boolean;
  preconditionNextPut: 'own' | 'foreign' | 'empty' | null;
} = {
  failKinds: new Map(),
  failKeys: new Map(),
  corruptNextCopy: false,
  preconditionNextPut: null,
};

/**
 * What `getSignedUrl` hands back: a distinct URL per object so an assertion can
 * tell which object was signed, on a host no test ever fetches.
 */
const PRESIGNED_HOST = 'https://signed.example.invalid';

function objectId(bucket: string | undefined, key: string | undefined) {
  return `${bucket ?? ''}/${key ?? ''}`;
}

export function storeOps(): readonly StoreOp[] {
  return ops;
}

/** Operations of one kind, which is what most assertions actually want. */
export function storeOpsOf(kind: StoreOpKind): readonly StoreOp[] {
  return ops.filter((op) => op.kind === kind);
}

/** Whether the stub currently holds `key` in `bucket`. */
export function storeHas(bucket: string, key: string): boolean {
  return objects.has(objectId(bucket, key));
}

/** Every key the stub holds in `bucket`, sorted. */
function storeKeys(bucket: string): string[] {
  const prefix = `${bucket}/`;
  const keys: string[] = [];
  for (const id of objects.keys())
    if (id.startsWith(prefix)) keys.push(id.slice(prefix.length));
  return keys.toSorted((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}

/** The headers the stub holds for one object, or `null`. */
export function storedObject(
  bucket: string,
  key: string
): Readonly<StoredObject> | null {
  return objects.get(objectId(bucket, key)) ?? null;
}

export function resetObjectStore(): void {
  ops.length = 0;
  objects.clear();
  state.failKinds.clear();
  state.failKeys.clear();
  state.corruptNextCopy = false;
  state.preconditionNextPut = null;
}

/** Lifts every injected failure and keeps the objects: "the outage is over". */
export function clearObjectStoreFailures(): void {
  state.failKinds.clear();
  state.failKeys.clear();
  state.corruptNextCopy = false;
  state.preconditionNextPut = null;
}

/**
 * How the NEXT `PutObject` fails its `If-None-Match: *` precondition — the
 * three states a caller has to tell apart, and cannot without help:
 *
 * - `own`: the body is stored and then the call rejects, which is what the
 *   SDK's retry of a committed first attempt sees (measured against the
 *   installed client);
 * - `foreign`: a different object of the same length holds the key, and it
 *   carries no checksum of ours;
 * - `empty`: the call rejects with nothing at the key at all.
 */
export function preconditionFailNextPut(
  outcome: 'own' | 'foreign' | 'empty'
): void {
  state.preconditionNextPut = outcome;
}

/**
 * Makes the next `CopyObject` write the source's LENGTH with different bytes.
 *
 * A corruption that changes the length is caught by the length comparison
 * alone, so without this the ETag half of the copy verification is asserted by
 * nothing and would pass every test if it were deleted.
 */
export function corruptNextCopy(): void {
  state.corruptNextCopy = true;
}

/**
 * Makes every subsequent operation of `kind` reject, until the next reset.
 *
 * `errorName` selects the SDK error shape (`PreconditionFailed`, `NoSuchKey`,
 * …) so a caller's classification of the failure is what gets tested; omitted,
 * the rejection is an anonymous transport-style error.
 */
export function failObjectStore(kind: StoreOpKind, errorName?: string): void {
  state.failKinds.set(kind, errorName);
}

/**
 * Makes `kind` reject for ONE key, leaving its siblings working.
 *
 * `failObjectStore` is kind-wide, which cannot express the case the retention
 * sweep's partial-failure branch is defined by: one object's delete fails, a
 * sibling's succeeds. For `DeleteObjects` the key lands in the response's
 * `Errors` list rather than rejecting the call, which is how R2 reports it.
 */
export function failObjectStoreKey(kind: StoreOpKind, key: string): void {
  const keys = state.failKeys.get(kind) ?? new Set<string>();
  keys.add(key);
  state.failKeys.set(kind, keys);
}

const STATUS_BY_NAME: Record<string, number> = {
  NotFound: 404,
  NoSuchKey: 404,
  PreconditionFailed: 412,
  MalformedXML: 400,
};

/** The SDK's error shape: a name, and `$metadata.httpStatusCode`. */
class StubS3Error extends Error {
  readonly $metadata: { httpStatusCode: number };
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
    this.$metadata = { httpStatusCode: STATUS_BY_NAME[name] ?? 500 };
  }
}

function bodyLength(body: unknown): number | undefined {
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (body instanceof Uint8Array) return body.byteLength;
  return undefined;
}

/** The body as bytes; anything the stub cannot read is stored as empty, as its length already was. */
function bodyBytes(body: unknown): Buffer {
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.alloc(0);
}

function decodeCopySource(source: string): { bucket: string; key: string } {
  const slash = source.indexOf('/');
  const bucket = source.slice(0, slash);
  const key = source
    .slice(slash + 1)
    .split('/')
    .map(decodeURIComponent)
    .join('/');
  return { bucket, key };
}

/** Same length, different bytes: what `corruptNextCopy` writes. */
function corrupted(body: Buffer): Buffer {
  const copy = Buffer.from(body);
  if (copy.length > 0) copy[0] = (copy[0] ?? 0) ^ 0xff;
  return copy;
}

/** R2's single-part ETag is the content MD5 (measured), and so is this one. */
const etagOf = (object: StoredObject) =>
  `"${createHash('md5').update(object.body).digest('hex')}"`;

function record(cmd: Command): void {
  const { input } = cmd;
  ops.push({
    kind: cmd.kind,
    bucket: input.Bucket,
    key: 'Key' in input ? input.Key : undefined,
    ...(cmd.kind === 'DeleteObjects' && {
      keys: (cmd.input.Delete?.Objects ?? []).flatMap((entry) =>
        typeof entry.Key === 'string' ? [entry.Key] : []
      ),
    }),
    contentType: 'ContentType' in input ? input.ContentType : undefined,
    bytes: 'Body' in input ? bodyLength(input.Body) : undefined,
    copySource: 'CopySource' in input ? input.CopySource : undefined,
    metadataDirective:
      'MetadataDirective' in input ? input.MetadataDirective : undefined,
    ifNoneMatch: 'IfNoneMatch' in input ? input.IfNoneMatch : undefined,
  });
}

/**
 * The replacement for `@aws-sdk/client-s3`.
 *
 * The command classes are real classes rather than plain factories because
 * production does `new PutObjectCommand({...})` and `getSignedUrl(client,
 * command, …)`; `send` dispatches on the recorded kind rather than on
 * `constructor.name`, which a bundler is free to rename.
 */
export function s3ClientStub(): Record<string, unknown> {
  class StubCommand<K extends StoreOpKind> {
    constructor(
      readonly kind: K,
      readonly input: CommandInputs[K]
    ) {}
  }

  const command = <K extends StoreOpKind>(kind: K) =>
    class extends StubCommand<K> {
      constructor(input: CommandInputs[K]) {
        super(kind, input);
      }
    };

  class S3Client {
    async send(cmd: Command): Promise<Record<string, unknown>> {
      record(cmd);
      const { input } = cmd;

      if (state.failKinds.has(cmd.kind)) {
        const name = state.failKinds.get(cmd.kind);
        throw name
          ? new StubS3Error(name, `object store: injected ${cmd.kind} ${name}`)
          : new Error(`object store: injected ${cmd.kind} failure`);
      }
      const failing = state.failKeys.get(cmd.kind);
      if (
        cmd.kind !== 'DeleteObjects' &&
        'Key' in input &&
        input.Key &&
        failing?.has(input.Key)
      )
        throw new Error(
          `object store: injected ${cmd.kind} failure for ${input.Key}`
        );

      switch (cmd.kind) {
        case 'PutObject': {
          const id = objectId(cmd.input.Bucket, cmd.input.Key);
          if (cmd.input.IfNoneMatch === '*' && objects.has(id))
            throw new StubS3Error(
              'PreconditionFailed',
              'At least one of the pre-conditions you specified did not hold.'
            );
          const precondition = state.preconditionNextPut;
          if (precondition) {
            state.preconditionNextPut = null;
            const written = bodyBytes(cmd.input.Body);
            if (precondition !== 'empty')
              objects.set(id, {
                body: precondition === 'own' ? written : corrupted(written),
                bytes: written.byteLength,
                contentType: cmd.input.ContentType,
                cacheControl: cmd.input.CacheControl,
                contentDisposition: cmd.input.ContentDisposition,
                metadata: cmd.input.Metadata,
                ...(precondition === 'own' && {
                  checksumSha256: cmd.input.ChecksumSHA256,
                }),
              });
            throw new StubS3Error(
              'PreconditionFailed',
              'At least one of the pre-conditions you specified did not hold.'
            );
          }
          const body = bodyBytes(cmd.input.Body);
          objects.set(id, {
            body,
            bytes: body.byteLength,
            contentType: cmd.input.ContentType,
            cacheControl: cmd.input.CacheControl,
            contentDisposition: cmd.input.ContentDisposition,
            metadata: cmd.input.Metadata,
            checksumSha256: cmd.input.ChecksumSHA256,
          });
          return {};
        }
        case 'DeleteObject': {
          objects.delete(objectId(cmd.input.Bucket, cmd.input.Key));
          return {};
        }
        case 'DeleteObjects': {
          const requested = cmd.input.Delete?.Objects ?? [];
          if (requested.length === 0 || requested.length > 1000)
            throw new StubS3Error(
              'MalformedXML',
              'The number of keys in the request must be between 1 and 1000 inclusive.'
            );
          const errors: Array<{ Key: string; Code: string }> = [];
          for (const entry of requested) {
            if (typeof entry.Key !== 'string') continue;
            if (failing?.has(entry.Key)) {
              errors.push({ Key: entry.Key, Code: 'InternalError' });
              continue;
            }
            objects.delete(objectId(cmd.input.Bucket, entry.Key));
          }
          return { Errors: errors };
        }
        case 'CopyObject': {
          const source = decodeCopySource(cmd.input.CopySource ?? '');
          const existing = objects.get(objectId(source.bucket, source.key));
          if (!existing)
            throw new StubS3Error(
              'NoSuchKey',
              'The specified key does not exist.'
            );
          const copied = state.corruptNextCopy
            ? corrupted(existing.body)
            : existing.body;
          state.corruptNextCopy = false;
          // The checksum stays with the source either way (measured).
          objects.set(
            objectId(cmd.input.Bucket, cmd.input.Key),
            cmd.input.MetadataDirective === 'REPLACE'
              ? {
                  body: copied,
                  bytes: existing.bytes,
                  contentType: cmd.input.ContentType,
                  cacheControl: cmd.input.CacheControl,
                  contentDisposition: cmd.input.ContentDisposition,
                  metadata: cmd.input.Metadata,
                }
              : { ...existing, body: copied, checksumSha256: undefined }
          );
          return { CopyObjectResult: { ETag: etagOf(existing) } };
        }
        case 'HeadObject': {
          const existing = objects.get(
            objectId(cmd.input.Bucket, cmd.input.Key)
          );
          if (!existing) throw new StubS3Error('NotFound', 'UnknownError');
          return {
            ContentLength: existing.bytes,
            ContentType: existing.contentType,
            CacheControl: existing.cacheControl,
            ContentDisposition: existing.contentDisposition,
            Metadata: existing.metadata,
            ETag: etagOf(existing),
            ...(cmd.input.ChecksumMode === 'ENABLED' &&
              existing.checksumSha256 && {
                ChecksumSHA256: existing.checksumSha256,
              }),
          };
        }
        case 'ListObjectsV2': {
          const prefix = cmd.input.Prefix ?? '';
          const keys = storeKeys(cmd.input.Bucket ?? '').filter((key) =>
            key.startsWith(prefix)
          );
          const pageSize = Math.min(cmd.input.MaxKeys ?? 1000, 1000);
          const start = cmd.input.ContinuationToken
            ? Number(cmd.input.ContinuationToken)
            : 0;
          const page = keys.slice(start, start + pageSize);
          const truncated = start + pageSize < keys.length;
          return {
            Contents: page.map((key) => ({
              Key: key,
              Size: objects.get(objectId(cmd.input.Bucket, key))?.bytes ?? 0,
            })),
            KeyCount: page.length,
            IsTruncated: truncated,
            ...(truncated && {
              NextContinuationToken: String(start + pageSize),
            }),
          };
        }
        case 'GetObject': {
          return {};
        }
      }
    }
  }

  const api = {
    S3Client,
    PutObjectCommand: command('PutObject'),
    DeleteObjectCommand: command('DeleteObject'),
    DeleteObjectsCommand: command('DeleteObjects'),
    CopyObjectCommand: command('CopyObject'),
    GetObjectCommand: command('GetObject'),
    HeadObjectCommand: command('HeadObject'),
    ListObjectsV2Command: command('ListObjectsV2'),
  };
  return { ...api, default: api };
}

/**
 * The replacement for `@aws-sdk/s3-request-presigner`.
 *
 * The URL names the bucket and key it was asked to sign, and carries the
 * response overrides as query parameters, so a test can assert WHAT was signed
 * without parsing a real SigV4 query string.
 */
export function presignerStub(): Record<string, unknown> {
  const getSignedUrl = async (
    _client: unknown,
    command: { input?: GetObjectCommandInput },
    options?: { expiresIn?: number }
  ) => {
    const input: Partial<GetObjectCommandInput> = command.input ?? {};
    const url = new URL(
      `${PRESIGNED_HOST}/${input.Bucket ?? ''}/${(input.Key ?? '')
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`
    );
    url.searchParams.set('X-Amz-Expires', String(options?.expiresIn ?? 300));
    const disposition = input.ResponseContentDisposition;
    if (typeof disposition === 'string')
      url.searchParams.set('response-content-disposition', disposition);
    url.searchParams.set('sig', 'stub');
    return url.href;
  };
  const api = { getSignedUrl };
  return { ...api, default: api };
}
