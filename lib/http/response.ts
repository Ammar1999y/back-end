import type { HandlerOutput } from './contract';

import { responsePayload, serializeSetCookie } from './contract';

/**
 * Every API response is per-user, credentialed, or an error. None of them may
 * be stored by a shared cache, and `no-store` is the only directive that says
 * so to every intermediary including the browser's back/forward cache.
 *
 * A handler that genuinely serves a public cacheable body opts out by setting
 * its own `Cache-Control` in `HandlerOutput.headers` — this is a default, not
 * an override.
 */
export const DEFAULT_CACHE_CONTROL = 'no-store';

/** Keep Better Auth's raw cookie values and extension attributes intact across adapters. */
export function toWebResponse(output: HandlerOutput): Response {
  const headers = new Headers();
  const extraHeaders = Object.entries(output.headers ?? {});
  const cookies = output.cookies ?? [];

  for (const [key, value] of extraHeaders) headers.set(key, value);
  for (const cookie of cookies)
    headers.append('set-cookie', serializeSetCookie(cookie));

  // After the handler's own headers, so an explicit opt-out wins.
  if (!headers.has('cache-control'))
    headers.set('cache-control', DEFAULT_CACHE_CONTROL);

  return Response.json(responsePayload(output.body), {
    status: output.status,
    headers,
  });
}
