import type { BodyPolicy, HandlerInput, HandlerRequestMeta } from './contract';

import { getClientIp } from '@/lib/audit';

const JSON_TYPE = 'application/json';
const MULTIPART_TYPE = 'multipart/form-data';

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
  policy: BodyPolicy
): HandlerInput {
  const request = meta.rawRequest;
  const canHaveBody = methodCanHaveBody(meta.method);
  const essence = mediaTypeEssence(request.headers.get('content-type'));

  const jsonAllowed = policy === 'json' && canHaveBody && essence === JSON_TYPE;
  const multipartAllowed =
    policy === 'multipart' && canHaveBody && essence === MULTIPART_TYPE;

  return {
    ...meta,
    readJson: memoise(jsonAllowed, () => safeReadJson(request)),
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
 * Matcher and runtime parser agree end to end on the pinned Bun. They did not
 * up to 1.3.14, where `Request.formData()` matched `form-data` case-SENSITIVELY
 * and threw on `Multipart/Form-Data`; 1.4.0 — the floor `server.ts` asserts —
 * made it case-insensitive, and all three spellings now parse (measured). The
 * regression cases in `tests/unit/request-body-policy.test.ts` are what catch a
 * floor regression rather than leaving it to be inferred — this pointer is the
 * only thing tying a version-gated behaviour to its guard, so it has to name the
 * file that actually holds them.
 */
function mediaTypeEssence(contentType: string | null): string {
  if (!contentType) return '';
  const [essence] = contentType.split(';', 1);
  return essence?.trim().toLowerCase() ?? '';
}

/**
 * Reads a JSON body without throwing. Returns null on an empty or malformed
 * body; handlers that require one call `requireJsonBody`, which turns the null
 * into a 400. Parsing here must never throw, or a malformed body would surface
 * as a 500 instead.
 */
async function safeReadJson(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
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
