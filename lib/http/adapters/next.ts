import type { Handler, HandlerInput, HandlerOutput } from '../contract';

import { NextResponse } from 'next/server';

import { getClientIp } from '@/lib/audit';
import { enforceRateLimit, ipIdentifier } from '@/lib/rate-limit';

import { handleApiError } from '@/utils/api-response';

// Coarse pre-auth limit so traffic without a valid session can't force
// repeated session lookups. Generous enough that a shared NAT egress isn't
// punished, tight enough to cap unauthenticated abuse.
const PRE_AUTH_LIMIT = 120;
const PRE_AUTH_WINDOW_S = 60;
const PRE_AUTH_SURFACE_SEGMENTS = 2;
const PRE_AUTH_SEGMENT_MAX = 40;

/**
 * Derive a per-surface limiter scope from the request path.
 *
 * A single shared scope let unrelated workloads throttle each other: anonymous
 * forgot-password / passwordless traffic and authenticated dashboard traffic
 * from the same office NAT drew on one counter, so abuse of one surface
 * produced deterministic 429/503 on the other. Two segments after `/api` is
 * the surface granularity (`/api/dash/users/<id>` -> `preauth.dash.users`,
 * `/api/auth/forgot-password/send` -> `preauth.auth.forgot-password`) — narrow
 * enough to isolate surfaces, coarse enough that dynamic ids don't explode the
 * keyspace.
 */
function preAuthScope(pathname: string): string {
  const segments = pathname
    .split('/')
    .filter(Boolean)
    .filter((segment) => segment !== 'api')
    .slice(0, PRE_AUTH_SURFACE_SEGMENTS)
    .map((segment) => segment.slice(0, PRE_AUTH_SEGMENT_MAX));
  return segments.length > 0 ? `preauth.${segments.join('.')}` : 'preauth.root';
}

/**
 * Lifts a framework-agnostic `Handler` into a Next.js App Router handler.
 *
 * Handles:
 *   - building HandlerInput from the Next `Request` and route `params`
 *   - JSON body parsing (null on parse failure — handlers decide if required)
 *   - catching thrown errors and converting to HandlerOutput via `handleApiError`
 *   - serialising HandlerOutput to NextResponse with proper headers
 *
 * When `opts.preAuthIpLimit` is true, a coarse per-IP rate limit runs before
 * the handler. Use it on authenticated surfaces (e.g. /api/dash/*) so that
 * unauthenticated traffic can't hammer the session layer.
 */
export function toNextHandler(
  handler: Handler,
  opts?: { preAuthIpLimit?: boolean }
) {
  return async (
    request: Request,
    context?: { params?: Promise<Record<string, string>> }
  ): Promise<NextResponse> => {
    try {
      const ctx = await buildContext(request, context);
      if (opts?.preAuthIpLimit) {
        // Fail-closed: this limiter exists specifically so unauthenticated
        // traffic can't hammer session lookup. Letting requests through on
        // an Upstash outage would silently strip the protection it exists
        // for, so a 503 is the correct shape during a degraded store.
        await enforceRateLimit({
          scope: preAuthScope(ctx.apiPath),
          identifier: ipIdentifier(ctx.headers),
          limit: PRE_AUTH_LIMIT,
          window: PRE_AUTH_WINDOW_S,
          failClosed: true,
        });
      }
      const output = await handler(ctx);
      return toNextResponse(output);
    } catch (error) {
      return toNextResponse(handleApiError(error));
    }
  };
}

async function buildContext(
  request: Request,
  context?: { params?: Promise<Record<string, string>> }
): Promise<HandlerInput> {
  const url = new URL(request.url);
  const params = context?.params ? await context.params : {};
  const body = await safeReadJson(request);

  return {
    body,
    query: url.searchParams,
    params: params ?? {},
    headers: request.headers,
    url: request.url,
    method: request.method,
    ip: getClientIp(request.headers) ?? '',
    userAgent: request.headers.get('user-agent'),
    apiPath: url.pathname,
    rawRequest: request,
  };
}

/**
 * Reads JSON body without throwing. Returns null when:
 *   - method cannot have a body (GET/HEAD)
 *   - body is empty
 *   - body is malformed (handlers that require a body call `requireJsonBody`)
 */
async function safeReadJson(request: Request): Promise<unknown> {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return null;

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return null;

  try {
    const text = await request.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toNextResponse(output: HandlerOutput): NextResponse {
  const response = NextResponse.json(output.body, { status: output.status });
  if (output.headers) {
    for (const [key, value] of Object.entries(output.headers)) {
      response.headers.set(key, value);
    }
  }
  if (output.cookies) {
    for (const cookie of output.cookies) {
      const { extraFlags, extra, ...nativeOptions } = cookie.options ?? {};
      response.cookies.set({
        name: cookie.name,
        value: cookie.value,
        ...nativeOptions,
      });

      // NextResponse.cookies has no slot for unmodelled attributes; append them
      // to the existing Set-Cookie line so Partitioned / Priority / etc. survive.
      if (extraFlags?.length || (extra && Object.keys(extra).length > 0)) {
        const setCookieValues = response.headers.getSetCookie();
        const lastIdx = setCookieValues.length - 1;
        let line = setCookieValues[lastIdx];
        if (line !== undefined) {
          for (const flag of extraFlags ?? []) line += `; ${flag}`;
          for (const [k, v] of Object.entries(extra ?? {}))
            line += `; ${k}=${v}`;
          setCookieValues[lastIdx] = line;
          response.headers.delete('set-cookie');
          for (const v of setCookieValues)
            response.headers.append('set-cookie', v);
        }
      }
    }
  }
  return response;
}
