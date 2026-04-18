import { Ratelimit } from '@upstash/ratelimit';

import { sanitizeForLog } from '@/utils';

import { redis } from './client';

export { authRateLimitStorage } from './auth-storage';
export { enforceRateLimit, ipIdentifier, userIdentifier } from './api';

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the next request is allowed. 0 when success is true. */
  retryAfter: number;
}

// Ratelimit instances bake (limit, window) into themselves, so we cache per
// configuration. Per-identifier scoping happens inside .limit(identifier).
const limiters = new Map<string, Ratelimit>();

function getLimiter(limit: number, window: number): Ratelimit {
  const cacheKey = `${limit}:${window}`;
  let limiter = limiters.get(cacheKey);
  if (!limiter) {
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, `${window} s`),
      prefix: 'rl',
      analytics: false,
    });
    limiters.set(cacheKey, limiter);
  }
  return limiter;
}

/**
 * Sliding-window rate limit check backed by Upstash Redis.
 *
 * `identifier` should encode the scope you want to limit (e.g. `users.create:<ip>`
 * or `otp.send:<userId>`). Two callers sharing the same identifier share the
 * same counter — include an endpoint/action prefix to keep them independent.
 *
 * Fails open on Redis errors: the request is allowed and a warning is logged.
 */
export async function rateLimit(opts: {
  identifier: string;
  limit: number;
  /** Window duration in seconds. */
  window: number;
}): Promise<RateLimitResult> {
  try {
    const result = await getLimiter(opts.limit, opts.window).limit(
      opts.identifier
    );
    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      retryAfter: result.success
        ? 0
        : Math.max(0, Math.ceil((result.reset - Date.now()) / 1000)),
    };
  } catch (error) {
    console.warn('[rate-limit] check failed, allowing request:', sanitizeForLog(error));
    return {
      success: true,
      limit: opts.limit,
      remaining: opts.limit,
      retryAfter: 0,
    };
  }
}
