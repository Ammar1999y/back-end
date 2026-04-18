import type { BetterAuthRateLimitStorage } from '@better-auth/core';

import { sanitizeForLog } from '@/utils';

import { redis } from './client';

type RateLimitEntry = {
  key: string;
  count: number;
  lastRequest: number;
};

const KEY_PREFIX = 'ba:rl:';

// TTL is a safety net for Redis memory cleanup, not a correctness boundary:
// better-auth resets `count` itself when `now - lastRequest > window`. Any value
// comfortably larger than the longest configured window is fine.
const TTL_SECONDS = 3600;

export const authRateLimitStorage: BetterAuthRateLimitStorage = {
  async get(key: string) {
    try {
      return await redis.get<RateLimitEntry>(`${KEY_PREFIX}${key}`);
    } catch (error) {
      // Fail-open: let better-auth treat this as "no prior record" and proceed.
      console.warn(
        '[rate-limit] redis get failed, allowing request:',
        sanitizeForLog(error)
      );
      return null;
    }
  },
  async set(key: string, value: RateLimitEntry) {
    try {
      await redis.set(`${KEY_PREFIX}${key}`, value, { ex: TTL_SECONDS });
    } catch (error) {
      // Fail-open: dropping the increment is safer than blocking legitimate users.
      console.warn(
        '[rate-limit] redis set failed, allowing request:',
        sanitizeForLog(error)
      );
    }
  },
};
