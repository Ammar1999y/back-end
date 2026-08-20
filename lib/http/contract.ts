/* eslint-disable unicorn/prefer-switch */
import type { PaginationMeta } from '@/utils/api-response';

import { HTTP_STATUS } from '@/utils/api-messages';

/**
 * What a route is allowed to read from the request body.
 *
 * Declared per route, not inferred from the `Content-Type` the client happened
 * to send. Inference is what let a JSON-only dashboard route parse
 * attacker-supplied multipart data: the client picked the parser. Under an
 * explicit policy a `json` route never parses multipart, and a `none` route
 * never touches the body stream at all — which is what makes a token check on
 * the maintenance route run against zero parsed input.
 */
export type BodyPolicy = 'none' | 'json' | 'multipart';

/**
 * Everything about a request that is derivable from the head alone — no body
 * byte is read to produce it.
 *
 * Split out from `HandlerInput` so admission checks (the pre-auth per-IP limit,
 * a maintenance token, a path guard) can run on a request BEFORE its body is
 * parsed. Check-then-read, not read-then-check.
 */
export interface HandlerRequestMeta {
  /** URL search params. */
  query: URLSearchParams;
  /** Route params resolved by the adapter (e.g. `{ id: '...' }`). */
  params: Record<string, string>;
  /** Web-standard `Headers` — supported by Next, Elysia, and Hono. */
  headers: Headers;
  /** Absolute request URL. */
  url: string;
  /** HTTP method. */
  method: string;
  /** Client IP resolved by the adapter. Empty string when unknown. */
  ip: string;
  /** User-Agent header (trimmed to reasonable length by the adapter). */
  userAgent: string | null;
  /** API path (pathname only, no host/query). Used for audit logging. */
  apiPath: string;
  /**
   * Raw web `Request` — escape hatch for rare cases (e.g. Better Auth handler).
   *
   * ⚠️ Only `headers`, `url`, and `method` are safe to read. The body stream
   * (`.json()`, `.text()`, `.formData()`, `.arrayBuffer()`) may already have
   * been consumed by `ctx.readJson()` or `ctx.readFormData()`, and web `Request`
   * bodies can only be read once. If you genuinely need the raw body, clone the
   * request first (`request.clone()`) at the call site.
   */
  rawRequest: Request;
}

/**
 * Framework-agnostic request context passed to every handler.
 *
 * Built by the adapter layer from a framework-specific request object
 * (Next `Request`, Elysia `Context`, Hono `Context`) so handlers never
 * depend on the underlying framework.
 */
export interface HandlerInput extends HandlerRequestMeta {
  /**
   * Reads and parses the JSON body, or returns null when the route's policy is
   * not `json`, no body was sent, the media type was not `application/json`, or
   * parsing failed.
   *
   * A FUNCTION, like `readFormData`, and for the same reason. An eager `body`
   * field meant the framework layer parsed before the handler ran, so a route
   * whose only admission check is its OWN limiter — the OTP endpoints, which
   * carry per-identifier budgets instead of the coarse per-IP one — still had an
   * attacker-supplied body buffered before that limiter could reject it. Now
   * NOTHING in the adapter reads a body byte: the handler decides when, after
   * its own checks. Memoised, so a second call returns the first result.
   */
  readJson: () => Promise<unknown>;
  /**
   * Reads the multipart form, or returns null when the route's policy is not
   * `multipart` or the media type was not `multipart/form-data`.
   *
   * A FUNCTION, not a field, and that is the point: multipart is the unbounded
   * one, so nothing reads it until the handler has run its own admission checks
   * (the upload limiter). Memoised — a web `Request` body reads once, so a
   * second call returns the first result rather than throwing.
   *
   * Parsed by the adapter rather than from `rawRequest`, because reading it at
   * the call site is not portable: every framework other than Next consumes the
   * stream in its own parser first — on Elysia `rawRequest.formData()` throws
   * `Body has already been used`, which a `.catch` silently turns into
   * "no files".
   */
  readFormData: () => Promise<FormData | null>;
}

/**
 * Outgoing cookie options — intersection of what Next, Elysia, and Hono
 * support natively. Each adapter maps these to its own cookie API.
 *
 * `extra` carries attributes the adapter doesn't model explicitly
 * (e.g. `Partitioned` for CHIPS) so they can be re-emitted verbatim instead
 * of silently dropped by the parser.
 */
export interface HandlerCookieOptions {
  path?: string;
  domain?: string;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  expires?: Date;
  /** Boolean-only attributes (no `=value`), e.g. `Partitioned`. */
  extraFlags?: string[];
  /** Key=value attributes the adapter doesn't model, e.g. `Priority=High`. */
  extra?: Record<string, string>;
}

export interface HandlerCookie {
  name: string;
  value: string;
  options?: HandlerCookieOptions;
}

/** The response envelope every application endpoint returns. */
export interface HandlerEnvelope<T = unknown> {
  success: boolean;
  message: string;
  data: T;
  meta?: PaginationMeta;
}

/**
 * Escape hatch for the few endpoints whose body shape is fixed by an external
 * consumer and therefore cannot be the envelope: the Coolify health check and
 * the scheduled sweep both parse specific top-level fields, and changing them
 * would break a deployment rather than a client we control.
 *
 * A separate member of the body union rather than widening `body` to `unknown`,
 * so an ordinary handler still cannot return a shape the API contract forbids
 * by accident — it has to call `apiRaw` and say so.
 */
export interface HandlerRawBody {
  raw: unknown;
}

export type HandlerBody<T = unknown> = HandlerEnvelope<T> | HandlerRawBody;

export function isRawBody(body: HandlerBody): body is HandlerRawBody {
  return 'raw' in body;
}

/** The value an adapter should JSON-serialise for a given output. */
export function responsePayload(body: HandlerBody): unknown {
  return isRawBody(body) ? body.raw : body;
}

/**
 * Framework-agnostic response. The adapter converts this to the
 * framework's native response type.
 */
export interface HandlerOutput<T = unknown> {
  status: number;
  body: HandlerBody<T>;
  /** Additional response headers (e.g. Retry-After on 429). */
  headers?: Record<string, string>;
  /**
   * Outgoing cookies. `Set-Cookie` is the one header that legitimately
   * repeats, so cookies live on their own channel instead of `headers`.
   * Each adapter translates to its native cookie API.
   */
  cookies?: HandlerCookie[];
}

export type Handler = (ctx: HandlerInput) => Promise<HandlerOutput>;

/** Convenience: default status codes used across adapters. */
export const DEFAULT_STATUS = HTTP_STATUS.OK;

/**
 * Parse raw `Set-Cookie` header values (e.g. from Better Auth's
 * `returnHeaders: true`) into the structured `HandlerCookie` shape.
 * Attributes the adapter doesn't model (e.g. `Partitioned`, `Priority`)
 * are preserved on `options.extraFlags` / `options.extra` so the adapter
 * can re-emit them verbatim instead of silently dropping them.
 */
export function parseSetCookieHeaders(values: string[]): HandlerCookie[] {
  const parsed: HandlerCookie[] = [];
  for (const raw of values) {
    const segments = raw
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    const [nameValue, ...attrs] = segments;
    if (!nameValue) continue;
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx === -1) continue;
    const name = nameValue.slice(0, eqIdx);
    const value = nameValue.slice(eqIdx + 1);
    const options: HandlerCookieOptions = {};
    const extraFlags: string[] = [];
    const extra: Record<string, string> = {};
    for (const attr of attrs) {
      const eq = attr.indexOf('=');
      const k = eq === -1 ? attr : attr.slice(0, eq);
      const v = eq === -1 ? '' : attr.slice(eq + 1);
      const key = k.toLowerCase();
      if (key === 'path') options.path = v;
      else if (key === 'domain') options.domain = v;
      else if (key === 'max-age') options.maxAge = Number(v);
      else if (key === 'expires') options.expires = new Date(v);
      else if (key === 'httponly') options.httpOnly = true;
      else if (key === 'secure') options.secure = true;
      else if (key === 'samesite') {
        const s = v?.toLowerCase();
        // eslint-disable-next-line unicorn/prefer-includes-over-repeated-comparisons
        if (s === 'strict' || s === 'lax' || s === 'none') options.sameSite = s;
      } else if (eq === -1) {
        extraFlags.push(k);
      } else {
        extra[k] = v;
      }
    }
    if (extraFlags.length > 0) options.extraFlags = extraFlags;
    if (Object.keys(extra).length > 0) options.extra = extra;
    parsed.push({ name, value, options });
  }
  return parsed;
}

/**
 * Render a `HandlerCookie` back into one `Set-Cookie` header value — the exact
 * inverse of `parseSetCookieHeaders`, and deliberately in the same file so the
 * two cannot drift.
 *
 * Adapters whose framework has no cookie API rich enough for the full option
 * set (`Partitioned`, `Priority`, …) use this and append the result themselves.
 *
 * The name and value are emitted VERBATIM. Most of these cookies originate as
 * an already-formed `Set-Cookie` line from Better Auth, so percent-encoding
 * them here would corrupt a signed session token rather than protect anything.
 */
export function serializeSetCookie(cookie: HandlerCookie): string {
  const o = cookie.options ?? {};
  const parts = [`${cookie.name}=${cookie.value}`];

  if (o.maxAge !== undefined && Number.isFinite(o.maxAge))
    parts.push(`Max-Age=${Math.trunc(o.maxAge)}`);
  if (o.domain) parts.push(`Domain=${o.domain}`);
  if (o.path) parts.push(`Path=${o.path}`);
  // An unparsable date would serialise as "Invalid Date", which browsers treat
  // as a session cookie — silently turning a deletion into a live cookie.
  if (o.expires && !Number.isNaN(o.expires.getTime()))
    parts.push(`Expires=${o.expires.toUTCString()}`);
  if (o.httpOnly) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  if (o.sameSite)
    parts.push(
      `SameSite=${o.sameSite[0]?.toUpperCase() ?? ''}${o.sameSite.slice(1)}`
    );
  const extraFlags = o.extraFlags ?? [];
  const extraAttributes = Object.entries(o.extra ?? {});
  for (const flag of extraFlags) parts.push(flag);
  for (const [key, value] of extraAttributes) parts.push(`${key}=${value}`);

  return parts.join('; ');
}
