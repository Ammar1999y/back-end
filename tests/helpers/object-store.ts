/**
 * The R2 sink.
 *
 * **The `fetch` router in `./egress.ts` cannot see R2 traffic, and I asserted
 * otherwise before checking.** `@aws-sdk/client-s3` resolves
 * `NodeHttpHandler.create(...)` — `node:http`/`node:https`, not `fetch` — so
 * replacing `globalThis.fetch` never intercepts a single S3 call. Verified in
 * `node_modules/@aws-sdk/client-s3/dist-cjs/index.js`.
 *
 * What that costs in practice today is narrower than "real calls to Cloudflare":
 * `validateR2Config` is computed at module load from `R2_ACCOUNT_ID` and the two
 * credentials, so with them unset `uploadToR2`, `copyFileInR2` and
 * `getPresignedUrl` throw before any socket opens. `deleteFromR2` has no such
 * gate, so it did attempt a request against `https://undefined.r2.cloudflarestorage.com`
 * — a name that does not resolve, so it failed fast rather than reaching a real
 * bucket. The gap is therefore not a data-exfiltration risk; it is that the whole
 * R2 surface was neither observable nor scriptable, which makes the upload
 * pipeline untestable and its rollback path unassertable.
 *
 * So the boundary is the module, same as SMTP: a `mock.module` installed once
 * from the PRELOAD, never from a test file. Process-wide replacement of a shared
 * module is only safe when it is uniform, and the preload is the only place that
 * can guarantee that. See `./mailbox.ts` for the same argument at length.
 *
 * The production code ignores every `send()` result — all four call sites just
 * `await` it — so the stub only has to record, fail on demand, and hand back a
 * URL from `getSignedUrl`.
 */

/** One recorded object-store operation, in the shape the command carried. */
export interface StoreOp {
  kind: 'PutObject' | 'DeleteObject' | 'CopyObject' | 'GetObject';
  bucket?: string;
  key?: string;
  contentType?: string;
  /** Byte length of a PutObject body, so a size assertion needs no buffer. */
  bytes?: number;
}

const ops: StoreOp[] = [];

/**
 * Failure injection, in a holder rather than a bare `let` so the setters below
 * stay ordinary exported functions.
 *
 * `failKinds` is what makes the rollback path in `uploadImagesToR2` testable: it
 * cleans up already-uploaded keys when a later step fails, and that branch is
 * unreachable unless one specific operation can be made to fail.
 */
const state: {
  failKinds: Set<StoreOp['kind']>;
  failKeys: Map<StoreOp['kind'], Set<string>>;
} = { failKinds: new Set(), failKeys: new Map() };

/**
 * What `getSignedUrl` hands back. A constant, not a knob: nothing needs to vary
 * it, and `getPresignedUrl` has no production caller to vary it for. Add an
 * override when a test actually needs one.
 */
const PRESIGNED_URL = 'https://signed.example.invalid/object?sig=stub';

export function storeOps(): readonly StoreOp[] {
  return ops;
}

/** Operations of one kind, which is what most assertions actually want. */
export function storeOpsOf(kind: StoreOp['kind']): readonly StoreOp[] {
  return ops.filter((op) => op.kind === kind);
}

export function resetObjectStore(): void {
  ops.length = 0;
  state.failKinds.clear();
  state.failKeys.clear();
}

/** Makes every subsequent operation of `kind` reject, until the next reset. */
export function failObjectStore(kind: StoreOp['kind']): void {
  state.failKinds.add(kind);
}

/**
 * Makes `kind` reject for ONE key, leaving its siblings working.
 *
 * `failObjectStore` is kind-wide, which cannot express the case the retention
 * sweep's partial-failure branch is defined by: one object's delete fails, a
 * sibling's succeeds, so the succeeded row goes, the failed row stays, and
 * `hasMore` reports unfinished work. With only the kind-wide switch that branch
 * had no fixture and was left untested.
 */
export function failObjectStoreKey(kind: StoreOp['kind'], key: string): void {
  const keys = state.failKeys.get(kind) ?? new Set<string>();
  keys.add(key);
  state.failKeys.set(kind, keys);
}

interface CommandInput {
  Bucket?: string;
  Key?: string;
  ContentType?: string;
  Body?: unknown;
}

function bodyLength(body: unknown): number | undefined {
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (body instanceof Uint8Array) return body.byteLength;
  return undefined;
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
  class StubCommand {
    readonly kind: StoreOp['kind'];
    readonly input: CommandInput;
    constructor(kind: StoreOp['kind'], input: CommandInput) {
      this.kind = kind;
      this.input = input ?? {};
    }
  }

  const command = (kind: StoreOp['kind']) =>
    class extends StubCommand {
      constructor(input: CommandInput) {
        super(kind, input);
      }
    };

  class S3Client {
    async send(cmd: StubCommand): Promise<Record<string, never>> {
      ops.push({
        kind: cmd.kind,
        bucket: cmd.input.Bucket,
        key: cmd.input.Key,
        contentType: cmd.input.ContentType,
        bytes: bodyLength(cmd.input.Body),
      });
      if (state.failKinds.has(cmd.kind))
        throw new Error(`object store: injected ${cmd.kind} failure`);
      if (cmd.input.Key && state.failKeys.get(cmd.kind)?.has(cmd.input.Key))
        throw new Error(
          `object store: injected ${cmd.kind} failure for ${cmd.input.Key}`
        );
      return {};
    }
  }

  const api = {
    S3Client,
    PutObjectCommand: command('PutObject'),
    DeleteObjectCommand: command('DeleteObject'),
    CopyObjectCommand: command('CopyObject'),
    GetObjectCommand: command('GetObject'),
  };
  return { ...api, default: api };
}

/** The replacement for `@aws-sdk/s3-request-presigner`. */
export function presignerStub(): Record<string, unknown> {
  const getSignedUrl = async () => PRESIGNED_URL;
  const api = { getSignedUrl };
  return { ...api, default: api };
}
