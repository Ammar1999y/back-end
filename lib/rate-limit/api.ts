import { getClientIp } from '@/lib/audit';
import { sanitizeForLog } from '@/utils';

import {
  HTTP_STATUS,
  MSG_SERVICE_UNAVAILABLE,
  MSG_TOO_MANY_REQUESTS,
} from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

import { rateLimit, refundRateLimit } from './index';
import { EntityID } from '@/types';

// The app runs on Vercel, or on a VPS behind Cloudflare — both always inject
// a trusted IP header (`cf-connecting-ip` / `x-vercel-forwarded-for`). A null
// result from `getClientIp` therefore means a misconfigured deployment or
// direct origin access; fail closed instead of pooling traffic into a shared
// `ip:unknown` bucket.
//
// Status is 503 (not 400): the client did nothing wrong — the trusted-proxy
// header is missing because of a server/edge misconfiguration. Using 400
// here would also let privacy-collapsing OTP catches mistake the failure
// for a normal client error and silently return a fake success.
const MSG_MISSING_CLIENT_IP = 'لا يمكن تحديد عنوان الاتصال للطلب';

/**
 * Collapse IPv6 addresses to their /64 prefix before bucketing them into a
 * rate-limit key. ISPs hand entire /64 blocks (~1.8×10¹⁹ addresses) to single
 * customers, so keying on the full address lets a single host trivially rotate
 * past per-IP caps. IPv4 is unchanged — full address.
 *
 * Inputs already passed `getClientIp`'s ipv4/ipv6 validator, so colon-form is
 * a sufficient discriminator.
 */
function ipBucket(ip: string): string {
  if (!ip.includes(':')) return ip;

  // IPv4-mapped IPv6 (e.g. ::ffff:1.2.3.4): keep the full address, the v4
  // suffix is not a /64 block.
  if (ip.includes('.')) return ip;

  // Expand "::" so we can take exactly four hextets without losing prefix
  // information when the address is compressed.
  const hasDoubleColon = ip.includes('::');
  const segments = ip.split(':');
  if (hasDoubleColon) {
    const filled: string[] = [];
    let used = false;
    for (const seg of segments) {
      if (seg === '' && !used) {
        used = true;
        const missing = 8 - segments.filter((s) => s !== '').length;
        for (let i = 0; i < missing; i++) filled.push('0');
        continue;
      }
      if (seg === '') continue;
      filled.push(seg);
    }
    while (filled.length < 8) filled.push('0');
    return filled.slice(0, 4).join(':') + '::/64';
  }

  return segments.slice(0, 4).join(':') + '::/64';
}

// TODO: set the right header to get the IP when deplay the app
export function ipIdentifier(headers: Headers): string {
  const ip = getClientIp(headers);
  if (!ip) {
    console.error(
      sanitizeForLog({
        msg: 'missing client ip headers',
        cf: headers.get('cf-connecting-ip'),
        vercel: headers.get('x-vercel-forwarded-for'),
        forwarded: headers.get('x-forwarded-for'),
        host: headers.get('host'),
        ua: headers.get('user-agent'),
      })
    );
    throw new CustomError(
      MSG_MISSING_CLIENT_IP,
      HTTP_STATUS.SERVICE_UNAVAILABLE
    );
  }
  return `ip:${ipBucket(ip)}`;
}

export function userIdentifier(userId: EntityID): string {
  return `user:${userId}`;
}

// ── OTP quotas ──────────────────────────────────────────────────────
// Hierarchical, not flat. Each layer bounds a different thing:
//   global    -> total outbound provider spend (circuit breaker)
//   destination -> total messages any one victim can be sent
//   surface   -> how much of that destination budget ONE surface may take,
//                which is what keeps capacity reserved for recovery
// Per-IP limits stay as an additional layer at the call sites; they bound a
// single caller, not aggregate cost.

export type OtpContactKind = 'email' | 'phone';

/**
 * SMS and WhatsApp deliver to the same number and cost the same money, so they
 * share one destination budget. Keying quotas on the channel let a caller
 * double both the delivery cap and the block budget by switching transport.
 */
export const otpContactKind = (channel: string): OtpContactKind =>
  channel === 'email' ? 'email' : 'phone';

/** Independent send budgets so one surface can't starve another. */
export type OtpSendSurface =
  | 'verify_contact'
  | 'recovery'
  | 'passwordless'
  | 'contact_change';

/** Aggregate outbound send ATTEMPTS per contact kind per day. */
export const OTP_GLOBAL_SEND_CAP_PER_DAY = 2000;
/**
 * Send attempts to one destination per hour, shared by every NON-recovery
 * surface. Recovery is excluded on purpose — see below.
 */
export const OTP_DESTINATION_SEND_CAP_PER_HOUR = 6;
/**
 * Recovery's own destination budget. A separate key, not a slice of the
 * shared one: with a single shared pool two non-recovery surfaces could fill
 * it between them and leave password recovery with nothing, which is a
 * targeted account-recovery denial. Reserved capacity only counts as reserved
 * if nothing else can spend it.
 */
export const OTP_RECOVERY_SEND_CAP_PER_HOUR = 5;
/** Send attempts to one destination per hour from a single surface. */
export const OTP_SURFACE_SEND_CAP_PER_HOUR = 5;
/** Verify attempts against one destination, across every purpose. */
export const OTP_DESTINATION_VERIFY_CAP = 10;
export const OTP_DESTINATION_VERIFY_WINDOW_S = 600;

const ONE_HOUR_S = 3600;
const ONE_DAY_S = 86_400;

/**
 * Send-side quota chain. Fails closed at every layer: losing the limiter on a
 * paid-delivery path is a cost/abuse event, not something to shrug through.
 *
 * Order matters. Every layer is consume-on-check, so a request rejected by a
 * later layer has already spent the earlier ones. Narrowest first, global
 * last, means a request rejected by the surface or destination cap no longer
 * charges the global breaker.
 *
 * It is NOT true that only delivered messages charge it. The whole chain runs
 * before the account lookup, on purpose: applying it afterwards would cap real
 * accounts and not fake ones, which is an account-existence oracle. So a send
 * to a non-existent address, or one whose provider call later fails, still
 * spends global budget. That is the accepted price of the privacy property —
 * the breaker bounds *attempted* outbound work, not confirmed deliveries.
 */
export async function enforceOtpSendQuota(opts: {
  channel: string;
  /** Normalized destination (email address / phone number). */
  destination: string;
  surface: OtpSendSurface;
}): Promise<void> {
  const kind = otpContactKind(opts.channel);
  const destination = opts.destination.toLowerCase();
  const isRecovery = opts.surface === 'recovery';

  await enforceRateLimit({
    scope: `otp.send.surface.${opts.surface}.${kind}`,
    identifier: destination,
    limit: OTP_SURFACE_SEND_CAP_PER_HOUR,
    window: ONE_HOUR_S,
    failClosed: true,
  });

  await enforceRateLimit({
    scope: isRecovery
      ? `otp.send.dest.recovery.${kind}`
      : `otp.send.dest.${kind}`,
    identifier: destination,
    limit: isRecovery
      ? OTP_RECOVERY_SEND_CAP_PER_HOUR
      : OTP_DESTINATION_SEND_CAP_PER_HOUR,
    window: ONE_HOUR_S,
    failClosed: true,
  });

  await enforceRateLimit({
    scope: 'otp.send.global',
    identifier: kind,
    limit: OTP_GLOBAL_SEND_CAP_PER_DAY,
    window: ONE_DAY_S,
    failClosed: true,
  });
}

/**
 * Verify-side quota against one destination, shared across every purpose so
 * rotating the purpose can't multiply the per-identifier attempt budget.
 */
export async function enforceOtpVerifyQuota(opts: {
  channel: string;
  identifier: string;
}): Promise<void> {
  await enforceRateLimit({
    scope: `otp.verify.dest.${otpContactKind(opts.channel)}`,
    identifier: opts.identifier.toLowerCase(),
    limit: OTP_DESTINATION_VERIFY_CAP,
    window: OTP_DESTINATION_VERIFY_WINDOW_S,
    failClosed: true,
  });
}

/**
 * Rolling 24h verify-FAILURE budget per (user, contact kind).
 *
 * The DB counter that enforces this lives on the proof row, which is unique
 * per (user, channel, PURPOSE), so the documented daily budget was silently
 * multiplied by the number of reachable purposes. This is the one counter
 * that spans them.
 *
 * Charged for FAILURES only, but admitted ATOMICALLY: consume a token on the
 * way in, then refund the attempts that turn out not to be chargeable (a
 * correct code, or a request against an already-locked row where no code was
 * even read). Charging unconditionally would count successful verifications
 * and let ordinary passwordless use lock an account out of every OTP flow;
 * admitting on a non-consuming read would let N concurrent failures all pass
 * the same stale reading. The refund path (`rate: -1`) makes both properties
 * available at once.
 *
 * Over-limit requests do not consume — the limiter's Lua script returns before
 * its INCRBY — so a rejected attempt cannot extend its own lockout.
 */
const OTP_VERIFY_DAILY_SCOPE = 'otp.verify.daily';

function otpVerifyDailyKey(channel: string, userId: EntityID) {
  return {
    identifier: `${OTP_VERIFY_DAILY_SCOPE}.${otpContactKind(channel)}:${userId}`,
    window: ONE_DAY_S,
  };
}

/** Consume one token, rejecting (429/503) when the shared budget is spent. */
export async function enforceOtpVerifyDailyBudget(opts: {
  channel: string;
  userId: EntityID;
  limit: number;
}): Promise<void> {
  await enforceRateLimit({
    scope: `${OTP_VERIFY_DAILY_SCOPE}.${otpContactKind(opts.channel)}`,
    identifier: opts.userId,
    limit: opts.limit,
    window: ONE_DAY_S,
    failClosed: true,
  });
}

/** Return the token taken at admission when the attempt was not a failure. */
export async function refundOtpVerifyAttempt(opts: {
  channel: string;
  userId: EntityID;
  limit: number;
}): Promise<void> {
  const key = otpVerifyDailyKey(opts.channel, opts.userId);
  await refundRateLimit({ ...key, limit: opts.limit });
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
  /**
   * When true, reject with 503 if the rate-limit store is unreachable
   * instead of silently letting the request through. Use for auth/OTP
   * paths where losing the limiter is a real security event.
   */
  failClosed?: boolean;
}): Promise<void> {
  const window = opts.window ?? 60;
  const result = await rateLimit({
    identifier: `${opts.scope}:${opts.identifier}`,
    limit: opts.limit,
    window,
  });

  if (result.degraded && opts.failClosed) {
    const error = new CustomError(
      MSG_SERVICE_UNAVAILABLE,
      HTTP_STATUS.SERVICE_UNAVAILABLE
    );
    error.responseHeaders = { 'Retry-After': '30' };
    throw error;
  }

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
