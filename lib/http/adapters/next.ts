import { NextResponse } from 'next/server';

import { getClientIp } from '@/lib/audit';
import { enforceRateLimit, ipIdentifier } from '@/lib/rate-limit';

import { handleApiError } from '@/utils/api-response';

import type { Handler, HandlerInput, HandlerOutput } from '../contract';

// Coarse pre-auth limit on /api/dash/* so traffic without a valid session
// can't force repeated session lookups. Generous enough that a shared NAT
// egress isn't punished, tight enough to cap unauthenticated abuse.
const DASH_PRE_AUTH_LIMIT = 120;
const DASH_PRE_AUTH_WINDOW_S = 60;

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
        await enforceRateLimit({
          scope: 'dash.preauth',
          identifier: ipIdentifier(ctx.headers),
          limit: DASH_PRE_AUTH_LIMIT,
          window: DASH_PRE_AUTH_WINDOW_S,
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
      if (extraFlags?.length || (extra && Object.keys(extra).length)) {
        const setCookieValues = response.headers.getSetCookie();
        const lastIdx = setCookieValues.length - 1;
        if (lastIdx >= 0) {
          let line = setCookieValues[lastIdx];
          for (const flag of extraFlags ?? []) line += `; ${flag}`;
          for (const [k, v] of Object.entries(extra ?? {})) line += `; ${k}=${v}`;
          setCookieValues[lastIdx] = line;
          response.headers.delete('set-cookie');
          for (const v of setCookieValues) response.headers.append('set-cookie', v);
        }
      }
    }
  }
  return response;
}
