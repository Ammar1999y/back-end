import type { BodyPolicy, HandlerInput, HandlerRequestMeta } from './contract';

import { getClientIp } from '@/lib/audit';

import { HTTP_STATUS, MSG_BODY_TOO_LARGE } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

const JSON_TYPE = 'application/json';
const MULTIPART_TYPE = 'multipart/form-data';

/**
 * Bounds framework buffering before route-specific payload validation. Sized
 * for the largest admitted file — a 10 MB document (`MAX_DOCUMENT_SIZE_MB`)
 * plus multipart framing; every per-file cap is enforced again inside the
 * handler.
 *
 * Here rather than in `app.ts` so the two body ceilings sit together and so the
 * OpenAPI generator can publish both without importing the framework file it is
 * deliberately independent of.
 */
export const MAX_REQUEST_BODY_BYTES = 12 * 1024 * 1024;

/**
 * Default ceiling on a body that is parsed into memory, kept separate from
 * `MAX_REQUEST_BODY_BYTES` so no JSON route inherits the multipart allowance:
 * `JSON.parse` is synchronous, so a body admitted here stalls every other
 * in-flight request — the health check included — for as long as it takes.
 *
 * Far above every schema in the repository, so a rich-text body added later
 * fits without a change; a route that genuinely needs more says so with
 * `maxJsonBodyBytes` rather than raising this. Media never travels inside a
 * JSON body — it is uploaded through the media routes and referenced by id.
 */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

/**
 * Builds the head-only part of the request context — no body byte is read.
 *
 * Shared by every adapter rather than reimplemented per framework: Next, Elysia
 * and Hono all hand out a standard `Request`, and body handling is the one
 * piece of the adapter with security-relevant behaviour (what counts as
 * "no body", what a malformed body does, what gets parsed at all). Two copies
 * of it would drift.
 */
export function buildRequestMeta(
  request: Request,
  params: Record<string, string> = {}
): HandlerRequestMeta {
  const url = new URL(request.url);

  return {
    query: url.searchParams,
    params,
    headers: request.headers,
    url: request.url,
    method: request.method,
    // TODO(proxy-trust): resolved from a trusted header validated by syntax
    // only — see the note on TRUSTED_IP_HEADERS in lib/audit.ts and
    // reports/should-ignore.md #63.
    ip: getClientIp(request.headers) ?? '',
    userAgent: request.headers.get('user-agent'),
    apiPath: url.pathname,
    rawRequest: request,
  };
}

/**
 * Completes a `HandlerRequestMeta` into a `HandlerInput` under the route's
 * declared body policy.
 *
 * **Synchronous, and it reads nothing.** Both readers are lazy, so the adapter
 * layer never touches the body stream — the handler does, when it chooses to.
 * That is what makes "check, then read" hold for EVERY route rather than only
 * for the ones whose admission check happens to live in the adapter: a route
 * whose limiter is inside its own handler (the OTP endpoints, which carry
 * per-identifier budgets instead of the coarse per-IP one) now also rejects
 * before anything is parsed.
 *
 * The policy still decides what is readable at all. A `json` route's
 * `readFormData()` returns null no matter what the client sent, and vice versa,
 * so the client cannot choose the parser.
 *
 * The caller is responsible for making sure the body is still unread — on
 * Elysia that means registering the route with `parse: 'none'`.
 */
export function withBodyPolicy(
  meta: HandlerRequestMeta,
  policy: BodyPolicy,
  /** Per-route override; see `MAX_JSON_BODY_BYTES` for why the default is low. */
  maxJsonBodyBytes: number = MAX_JSON_BODY_BYTES
): HandlerInput {
  const request = meta.rawRequest;
  const canHaveBody = methodCanHaveBody(meta.method);
  const essence = mediaTypeEssence(request.headers.get('content-type'));

  const jsonAllowed = policy === 'json' && canHaveBody && essence === JSON_TYPE;
  const multipartAllowed =
    policy === 'multipart' && canHaveBody && essence === MULTIPART_TYPE;

  return {
    ...meta,
    readJson: memoise(jsonAllowed, () =>
      safeReadJson(request, maxJsonBodyBytes)
    ),
    readFormData: memoise(multipartAllowed, () => safeReadFormData(request)),
  };
}

/**
 * A web `Request` body reads exactly once, so a second call must not re-read
 * it: the first result is cached, including the `null` that a malformed body
 * produces. Without this, a handler that reads its body twice would succeed on
 * the first call and throw `Body has already been used` on the second.
 *
 * When the policy forbids the read, the reader is a constant `null` — it never
 * touches the stream, so a `json` route cannot be made to parse multipart by
 * sending a multipart `Content-Type`.
 */
function memoise<T>(
  allowed: boolean,
  read: () => Promise<T | null>
): () => Promise<T | null> {
  if (!allowed) return () => Promise.resolve(null);

  let pending: Promise<T | null> | null = null;
  return () => {
    pending ??= read();
    return pending;
  };
}

function methodCanHaveBody(method: string): boolean {
  const upper = method.toUpperCase();
  return upper !== 'GET' && upper !== 'HEAD';
}

/**
 * The media type's essence: type/subtype, lowercased, parameters stripped.
 *
 * Compared for EQUALITY by the caller, not with `includes`. Substring matching
 * accepted `application/jsonx` as JSON; media types are case-insensitive per
 * RFC 9110 §8.3 and a parameter (`; boundary=…`, `; charset=utf-8`) is not part
 * of the type.
 *
 * Matching case-insensitively only agrees with `Request.formData()` at or above
 * the runtime floor `server.ts` asserts — below it `Multipart/Form-Data` threw
 * instead of parsing. `tests/unit/request-body-policy.test.ts` holds the cases
 * that fail if that floor is ever lowered; nothing else ties the two together.
 */
function mediaTypeEssence(contentType: string | null): string {
  if (!contentType) return '';
  const [essence] = contentType.split(';', 1);
  return essence?.trim().toLowerCase() ?? '';
}

const tooLarge = () =>
  new CustomError(MSG_BODY_TOO_LARGE, HTTP_STATUS.CONTENT_TOO_LARGE);

/**
 * The ceiling a body may not cross, decided by the POLICY the route declares.
 *
 * Never by the `Content-Type` the caller sent: only a `multipart` route reads a
 * body it never parses into one string, so only a `multipart` route gets the
 * server-wide budget. Deciding from the claimed type instead handed the upload
 * allowance to any caller who wrote `multipart/form-data` on a sign-in.
 *
 * A mount that owns its own sub-routing declares the policy for its whole
 * prefix (`RoutePrefix.body`), because the boundary in `app.ts` has to answer
 * before the router has matched anything.
 */
export function bodyPolicyCeiling(
  policy: BodyPolicy,
  maxJsonBodyBytes: number = MAX_JSON_BODY_BYTES
): number {
  return policy === 'multipart' ? MAX_REQUEST_BODY_BYTES : maxJsonBodyBytes;
}

/**
 * Does the request SAY it is over the ceiling?
 *
 * A shortcut, never the control: a chunked request carries no `Content-Length`,
 * so a caller who cares about bypassing the ceiling simply omits it. What makes
 * it worth having anyway is position — it answers before a byte is read, from
 * the head alone, which is what lets the boundary in `app.ts` refuse a request
 * it is not going to read itself.
 */
export function declaresBodyOver(request: Request, maxBytes: number): boolean {
  const declared = Number(request.headers.get('content-length'));
  return Number.isFinite(declared) && declared > maxBytes;
}

/**
 * The same request with a body that cannot exceed `maxBytes`.
 *
 * Internal to this module: the count happens inside the stream, so WHERE the
 * refusal surfaces depends on who reads it, and for a consumer outside this
 * codebase that is not a contract worth offering. `readBoundedText` reads it
 * here and turns the refusal into a 413 at a known point; `boundedBodyRequest`
 * is the version for handing a request on.
 */
function boundRequestBody(request: Request, maxBytes: number): Request {
  if (declaresBodyOver(request, maxBytes)) throw tooLarge();

  const body = request.body;
  if (!body) return request;

  let total = 0;
  const counted = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        // Throwing here errors the stream, which cancels the source: the rest of
        // the upload stops instead of being drained after it was rejected.
        if (total > maxBytes) throw tooLarge();
        controller.enqueue(chunk);
      },
    })
  );

  // `Content-Length` is dropped with the original body, which is correct — the
  // wrapped body is a stream and the old length would describe neither what is
  // sent nor what is read.
  return new Request(request, {
    body: counted,
    duplex: 'half',
  } as RequestInit);
}

/**
 * The request body as text, refusing anything over `maxBytes`.
 *
 * Counted in the stream by `boundRequestBody` rather than after
 * `request.text()`, so the two bounds in this file are one implementation: a
 * reader-side ceiling and a hand-it-on ceiling that disagreed would be the
 * defect, not a detail.
 */
async function readBoundedText(
  request: Request,
  maxBytes: number
): Promise<string> {
  const bounded = boundRequestBody(request, maxBytes);
  if (!bounded.body) return '';
  return await bounded.text();
}

/**
 * The request, rebuilt with a body this process has already bounded — for a
 * consumer that reads the body itself and cannot be handed a reader:
 * `auth.handler`, and any future mount of that shape.
 *
 * Buffered rather than piped, and the reason is the refusal rather than the
 * bytes. A counting stream bounds the memory either way, but the 413 then
 * surfaces inside the consumer, which decides what to make of it: measured
 * against Better Auth, the same oversized body produced a 413 through one path
 * and a 500 through another depending on where its parse happened to be. Reading
 * here makes the refusal this module's, at a point the caller can catch, and
 * costs nothing extra — the consumer was going to buffer the same bytes, and
 * `maxBytes` is what bounds them.
 *
 * Text, so every mount this is used for must take a text body. That holds for
 * the whole Better Auth surface (JSON on every path it serves under POST) and is
 * the reason this is not applied to `multipart`, which keeps its own ceiling and
 * its own reader.
 */
export async function boundedBodyRequest(
  request: Request,
  maxBytes: number
): Promise<Request> {
  if (!request.body) return request;
  return new Request(request, {
    // eslint-disable-next-line unicorn/no-invalid-fetch-options -- the rule cannot see that the guard above excludes GET and HEAD, the only methods a body is invalid on: a `Request` of either never has one
    body: await readBoundedText(request, maxBytes),
  });
}

/**
 * Reads a JSON body. Returns null on an empty or malformed body; handlers that
 * require one call `requireJsonBody`, which turns the null into a 400. Parsing
 * must never throw, or a malformed body would surface as a 500 instead.
 *
 * An OVER-SIZE body is the one case that does throw, deliberately: it is a 413
 * and it is not the same answer as "unparseable". Collapsing it into `null`
 * would tell a caller its correct 2 MiB document was malformed.
 */
async function safeReadJson(
  request: Request,
  maxBytes: number
): Promise<unknown> {
  const text = await readBoundedText(request, maxBytes);
  try {
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Same contract as `safeReadJson`: a malformed multipart body is "no form",
 * not a 500. The handler decides whether that is an error.
 */
async function safeReadFormData(request: Request): Promise<FormData | null> {
  try {
    return await request.formData();
  } catch {
    return null;
  }
}
