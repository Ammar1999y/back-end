import type { ConsumeRow } from './store';

import { sanitizeForLog } from '@/utils';

import { getRateLimitStore } from './store';
import { describeStoreFailure } from './store-failure';

export {
  enforceOtpGlobalSendBudget,
  enforceOtpSendQuota,
  enforceOtpVerifyQuota,
  enforceRateLimit,
  ipIdentifier,
  otpContactKind,
  userIdentifier,
} from './api';

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the next request is allowed. 0 when success is true. */
  retryAfter: number;
  /** true when the backing store failed and we defaulted to fail-open. */
  degraded: boolean;
}

/**
 * Fixed-window rate limit check.
 *
 * `identifier` should encode the scope (e.g. `users.create:<ip>`).
 *
 * Fixed window, not the approximate sliding window this used to inherit from
 * `@upstash/ratelimit`. The trade is bounded and was taken deliberately: at a
 * window boundary a caller can fit up to 2x the limit into a short burst, while
 * the sustained rate is unchanged. In exchange the check is one atomic statement
 * over one row — verified to lose no updates across four concurrent processes —
 * and `remaining` is exact rather than an approximation. For the global daily OTP
 * budget a fixed window is also the more faithful model: it IS a calendar-day
 * cost cap, not a rolling one.
 *
 * There is no retry loop. The former 2-attempt/50ms backoff was shaped for HTTP
 * against Upstash; a local SQLite failure means the disk or schema is broken, and
 * retrying twice cannot fix that. The one genuinely transient local failure —
 * `SQLITE_BUSY` under multi-process contention — is handled by `busy_timeout` in
 * the driver, which is where it belongs.
 */
export async function rateLimit(opts: {
  identifier: string;
  limit: number;
  window: number;
}): Promise<RateLimitResult> {
  const windowMs = opts.window * 1000;

  try {
    const now = Date.now();
    const windowStart = now - (now % windowMs);
    const admitted = getRateLimitStore().consume.get<ConsumeRow>(
      opts.identifier,
      windowStart,
      windowStart + windowMs,
      opts.limit
    );

    // No row means the admission was refused without writing: the key exists, is
    // in THIS window, and is already at the limit. `windowStart` below is the
    // value we just bound, and the statement's WHERE proves the stored row
    // matched it — so no follow-up read is needed. Reading it back was also a
    // race: a concurrent process can roll the row into the next window between
    // the denied UPSERT and the read, which overstated `retryAfter` by a whole
    // window (measured 61s where 1s was correct).
    if (!admitted) {
      return {
        success: false,
        limit: opts.limit,
        remaining: 0,
        // Floor to 1s so a compliant client doesn't hot-loop when the window
        // rolls over within the current second.
        retryAfter: Math.max(
          1,
          Math.ceil((windowStart + windowMs - now) / 1000)
        ),
        degraded: false,
      };
    }

    const used = Number(admitted.count);
    return {
      success: true,
      limit: opts.limit,
      remaining: Math.max(0, opts.limit - used),
      retryAfter: 0,
      degraded: false,
    };
  } catch (error) {
    console.error(sanitizeForLog(describeStoreFailure(error, opts)));
    return {
      success: true,
      limit: opts.limit,
      remaining: opts.limit,
      retryAfter: 0,
      degraded: true,
    };
  }
}

/**
 * No refund primitive here, deliberately. A refund cannot be transactional with
 * the work it refunds, so every failure to apply one silently over-charges a real
 * user. If a future budget needs outcome-specific accounting, prefer a counter
 * that commits with the outcome.
 */
