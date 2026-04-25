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
  /** true when the backing store failed and we defaulted to fail-open. */
  degraded: boolean;
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

const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_RETRY_BASE_MS = 50;

/**
 * Sliding-window rate limit check.
 *
 * `identifier` should encode the scope (e.g. `users.create:<ip>`). Retries
 * transient store errors before falling through to fail-open; every failure
 * is logged so degraded mode is observable.
 */
export async function rateLimit(opts: {
  identifier: string;
  limit: number;
  window: number;
}): Promise<RateLimitResult> {
  const limiter = getLimiter(opts.limit, opts.window);

  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
    try {
      const result = await limiter.limit(opts.identifier);
      return {
        success: result.success,
        limit: result.limit,
        remaining: result.remaining,
        // Floor to 1s so a compliant client doesn't hot-loop when reset
        // lands within the current second.
        retryAfter: result.success
          ? 0
          : Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)),
        degraded: false,
      };
    } catch (error) {
      console.error(
        sanitizeForLog({
          msg: 'rate-limit store error',
          attempt,
          identifier: opts.identifier,
          error,
        })
      );
      if (attempt < RATE_LIMIT_RETRIES) {
        await new Promise((r) =>
          setTimeout(r, RATE_LIMIT_RETRY_BASE_MS * (attempt + 1))
        );
      }
    }
  }

  return {
    success: true,
    limit: opts.limit,
    remaining: opts.limit,
    retryAfter: 0,
    degraded: true,
  };
}
