import { getClientIp } from '@/lib/audit';

import { HTTP_STATUS, MSG_TOO_MANY_REQUESTS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

import { rateLimit } from './index';

/** Shared bucket for requests whose IP cannot be determined. */
const UNKNOWN_IP = 'unknown';

export function ipIdentifier(headers: Headers): string {
  return `ip:${getClientIp(headers) ?? UNKNOWN_IP}`;
}

export function userIdentifier(userId: string): string {
  return `user:${userId}`;
}

/**
 * Check a sliding-window rate limit for the current request.
 *
 * Throws `CustomError(429)` with `responseHeaders` set (Retry-After +
 * X-RateLimit-*) when the caller is over the limit; the error handler /
 * adapter layer converts it to the framework-specific response.
 *
 * Scope keeps per-endpoint counters independent even when two endpoints
 * share the same identifier (e.g. two actions for the same user).
 */
export async function enforceRateLimit(opts: {
  scope: string;
  identifier: string;
  limit: number;
  /** Window duration in seconds. Defaults to 60. */
  window?: number;
}): Promise<void> {
  const window = opts.window ?? 60;
  const result = await rateLimit({
    identifier: `${opts.scope}:${opts.identifier}`,
    limit: opts.limit,
    window,
  });

  if (result.success) return;

  const error = new CustomError(
    MSG_TOO_MANY_REQUESTS,
    HTTP_STATUS.TOO_MANY_REQUESTS
  );
  error.responseHeaders = {
    'Retry-After': String(result.retryAfter),
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
  };
  throw error;
}
