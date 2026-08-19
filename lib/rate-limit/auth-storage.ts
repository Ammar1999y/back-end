import type { AuthConsumeRow, AuthEntryRow } from './store';
import type { BetterAuthRateLimitStorage } from '@better-auth/core';

import { sanitizeForLog } from '@/utils';

import { getRateLimitStore } from './store';
import { describeAuthStoreFailure } from './store-failure';

/**
 * Better Auth's row shape. Declared locally rather than imported: the exported
 * `RateLimit` type is generic over plugin and option inference, and assigning
 * this object to `BetterAuthRateLimitStorage` below is what actually proves
 * compatibility — the compiler rejects a mismatch either way.
 */
type RateLimitEntry = {
  key: string;
  count: number;
  lastRequest: number;
};

/**
 * TTL is a cleanup boundary, not a correctness one: expiry is filtered on read
 * and `consume` resets the count when the window rolls over. Any value
 * comfortably larger than the longest configured window is fine.
 */
const TTL_MS = 3_600_000;

export const authRateLimitStorage: BetterAuthRateLimitStorage = {
  /**
   * Atomic check-and-increment. Better Auth prefers this over `get`/`set` when
   * present, and its own type documents why: performing both in one step "closes
   * the concurrent-bypass gap of the separate get/set path: N simultaneous
   * requests can no longer all pass a stale read before any increment lands."
   *
   * That gap is the reason this exists rather than being left to the fallback.
   * On the login limiter it is a credential-stuffing bypass: parallel sign-in
   * attempts could all read the same pre-increment count. The single-statement
   * form here was verified to lose no updates across four concurrent processes,
   * and benchmarked no slower than the get-then-set pair it replaces — one
   * statement instead of two. Treat that as a direction, not a guarantee: the
   * measurement was on Windows, not the Linux target.
   *
   * `consume` is optional in @better-auth/core 1.6 and becomes the sole required
   * member in 1.7, which drops `get`/`set` entirely. Implementing it now is also
   * what makes that upgrade a non-event.
   */
  async consume(key: string, rule: { window: number; max: number }) {
    try {
      const windowMs = rule.window * 1000;
      const now = Date.now();
      const windowStart = now - (now % windowMs);

      const admitted = getRateLimitStore().authConsume.get<AuthConsumeRow>(
        key,
        windowStart,
        now,
        now + TTL_MS,
        rule.max
      );

      if (admitted) return { allowed: true, retryAfter: null };

      // No row means the statement deliberately updated nothing because the key
      // is already at `max` inside THIS window — so `windowStart`, the value just
      // bound, is the anchor. No follow-up read: besides being redundant it
      // raced with a concurrent window rollover. A rejected sign-in attempt also
      // must not buy the attacker a write.
      return {
        allowed: false,
        retryAfter: Math.max(
          1,
          Math.ceil((windowStart + windowMs - now) / 1000)
        ),
      };
    } catch (error) {
      console.error(sanitizeForLog(describeAuthStoreFailure(error, 'consume')));
      // Fail-closed: rethrow so better-auth surfaces the error instead of
      // treating the attempt as "no prior record". Losing the limiter on
      // /sign-in/email would let an attacker burn unlimited credential-stuffing
      // attempts during an outage.
      throw error;
    }
  },

  /**
   * Retained because `get`/`set` are still required members of the interface in
   * 1.6, and any version that does not call `consume` falls back to them. This
   * path is non-atomic by construction — that is the gap `consume` closes — so it
   * must not become the primary path again.
   */
  async get(key: string) {
    try {
      const row = getRateLimitStore().authGet.get<AuthEntryRow>(
        key,
        Date.now()
      );
      if (!row) return null;
      return {
        key: row.key,
        count: Number(row.count),
        lastRequest: Number(row.last_request),
      } satisfies RateLimitEntry;
    } catch (error) {
      console.error(sanitizeForLog(describeAuthStoreFailure(error, 'get')));
      throw error;
    }
  },

  async set(key: string, value: RateLimitEntry) {
    try {
      const now = Date.now();
      getRateLimitStore().authSet.run(
        key,
        value.count,
        value.lastRequest,
        value.lastRequest,
        now + TTL_MS
      );
    } catch (error) {
      console.error(sanitizeForLog(describeAuthStoreFailure(error, 'set')));
      throw error;
    }
  },
};
