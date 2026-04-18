import { NextResponse } from 'next/server';

import { getClientIp } from '@/lib/audit';

import { handleApiError } from '@/utils/api-response';

import type { Handler, HandlerInput, HandlerOutput } from '../contract';

/**
 * Lifts a framework-agnostic `Handler` into a Next.js App Router handler.
 *
 * Handles:
 *   - building HandlerInput from the Next `Request` and route `params`
 *   - JSON body parsing (null on parse failure — handlers decide if required)
 *   - catching thrown errors and converting to HandlerOutput via `handleApiError`
 *   - serialising HandlerOutput to NextResponse with proper headers
 *
 * Signature matches Next's App Router handler: `(request, { params })`.
 */
export function toNextHandler(handler: Handler) {
  return async (
    request: Request,
    context?: { params?: Promise<Record<string, string>> }
  ): Promise<NextResponse> => {
    try {
      const ctx = await buildContext(request, context);
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
  return response;
}
