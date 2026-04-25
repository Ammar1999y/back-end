/* eslint-disable unicorn/prefer-switch */
import { HTTP_STATUS } from '@/utils/api-messages';

import type { PaginationMeta } from '@/utils/api-response';

/**
 * Framework-agnostic request context passed to every handler.
 *
 * Built by the adapter layer from a framework-specific request object
 * (Next `Request`, Elysia `Context`, Hono `Context`) so handlers never
 * depend on the underlying framework.
 */
export interface HandlerInput {
  /** Parsed JSON body, or null when no body was sent / parsing failed. */
  body: unknown;
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
   * been consumed by the adapter while building `ctx.body`, and web `Request`
   * bodies can only be read once. If you genuinely need the raw body, clone
   * the request first (`request.clone()`) at the call site.
   */
  rawRequest: Request;
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

/**
 * Framework-agnostic response. The adapter converts this to the
 * framework's native response type.
 */
export interface HandlerOutput<T = unknown> {
  status: number;
  body: {
    success: boolean;
    message: string;
    data: T;
    meta?: PaginationMeta;
  };
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
    const segments = raw.split(';').map((s) => s.trim()).filter(Boolean);
    if (!segments.length) continue;
    const [nameValue, ...attrs] = segments;
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
        if (s === 'strict' || s === 'lax' || s === 'none') options.sameSite = s;
      } else if (eq === -1) {
        extraFlags.push(k);
      } else {
        extra[k] = v;
      }
    }
    if (extraFlags.length) options.extraFlags = extraFlags;
    if (Object.keys(extra).length) options.extra = extra;
    parsed.push({ name, value, options });
  }
  return parsed;
}
