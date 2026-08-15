import type { BetterAuthRateLimitStorage } from '@better-auth/core';

import { sanitizeForLog } from '@/utils';

import { redis } from './client';
import { describeAuthStoreFailure } from './store-failure';

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

const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 50;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(op: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await op();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES)
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError;
}

export const authRateLimitStorage: BetterAuthRateLimitStorage = {
  // Fail-closed: after retries are exhausted, rethrow so better-auth surfaces
  // the error to the request instead of treating the login/signup attempt as
  // "no prior record". Losing the limiter on /sign-in/email would let an
  // attacker burn unlimited credential-stuffing attempts during an outage.
  async get(key: string) {
    try {
      return await withRetry(() =>
        redis.get<RateLimitEntry>(`${KEY_PREFIX}${key}`)
      );
    } catch (error) {
      // NOT the raw error: `key` is `${ip}|${path}`, and the Upstash client
      // quotes the command — including that key — in its message.
      console.error(sanitizeForLog(describeAuthStoreFailure(error, 'get')));
      throw error;
    }
  },
  async set(key: string, value: RateLimitEntry) {
    try {
      await withRetry(() =>
        redis.set(`${KEY_PREFIX}${key}`, value, { ex: TTL_SECONDS })
      );
    } catch (error) {
      console.error(sanitizeForLog(describeAuthStoreFailure(error, 'set')));
      throw error;
    }
  },
};
