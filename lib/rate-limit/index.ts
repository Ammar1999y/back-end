import type { ConsumeRow } from './store';

import { sanitizeForLog } from '@/utils';

import { getRateLimitStore } from './store';
import { describeStoreFailure } from './store-failure';

export {
  enforceOtpGlobalSendBudget,
  enforceOtpSurfaceSendQuota,
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
 * One atomic SQLite statement keeps exact counters across processes. Fixed
 * windows preserve the sustained rate but allow up to twice the limit around a
 * boundary; `busy_timeout` handles transient writer contention.
 */
export async function rateLimit(opts: {
  identifier: string;
  limit: number;
  window: number;
  /** Units this request spends. Defaults to 1; see `SQL_CONSUME`. */
  cost?: number;
}): Promise<RateLimitResult> {
  const windowMs = opts.window * 1000;
  const cost = opts.cost ?? 1;

  // A cost over the whole budget can never be admitted, and the statement cannot
  // refuse it: both the INSERT and the window-rollover branch write `cost`
  // unconditionally. Refused here, without a write.
  if (!Number.isSafeInteger(cost) || cost < 1 || cost > opts.limit)
    return {
      success: false,
      limit: opts.limit,
      remaining: 0,
      retryAfter: opts.window,
      degraded: false,
    };

  try {
    const now = Date.now();
    const windowStart = now - (now % windowMs);
    const admitted = getRateLimitStore().consume.get<ConsumeRow>(
      opts.identifier,
      windowStart,
      cost,
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
