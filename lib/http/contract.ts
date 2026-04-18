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
  /** Raw web `Request` — escape hatch for rare cases (e.g. Better Auth handler). */
  rawRequest: Request;
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
}

export type Handler = (ctx: HandlerInput) => Promise<HandlerOutput>;

/** Convenience: default status codes used across adapters. */
export const DEFAULT_STATUS = HTTP_STATUS.OK;
