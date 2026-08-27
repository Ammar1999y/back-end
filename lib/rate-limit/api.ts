import type { EntityID } from '@/types';
import type { OtpChannel } from '@/utils/validation/otp';

import { sanitizeForLog } from '@/utils';
import { getClientIp } from '@/lib/audit';

import {
  HTTP_STATUS,
  MSG_SERVICE_UNAVAILABLE,
  MSG_TOO_MANY_REQUESTS,
} from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import { isPhoneChannel } from '@/utils/validation/otp';

import { rateLimit } from './index';

// The app runs on a VPS behind Cloudflare, which always injects
// `cf-connecting-ip`. A null result from `getClientIp` therefore means a
// misconfigured deployment or direct origin access; fail closed instead of
// pooling traffic into a shared `ip:unknown` bucket. In development
// `getClientIp` resolves a loopback fallback instead, so this path is
// production-only.
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

// TODO(proxy-trust): the header this resolves is trusted on syntax alone —
// see the note on TRUSTED_IP_HEADERS in lib/audit.ts and
// reports/should-ignore.md #63.
export function ipIdentifier(headers: Headers): string {
  const ip = getClientIp(headers);
  if (!ip) {
    console.error(
      sanitizeForLog({
        msg: 'missing client ip headers',
        cf: headers.get('cf-connecting-ip'),
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
// Two layers, each bounding a different thing:
//   global  -> total outbound provider spend (circuit breaker)
//   surface -> messages to ONE destination from ONE surface
// Per-IP limits stay as an additional layer at the call sites; they bound a
// single caller, not aggregate cost.
//
// There is deliberately no budget SHARED across surfaces. A cross-surface
// per-destination cap has only two placements and both are defects: charged
// pre-lookup, unproductive requests naming a victim's address spend the
// victim's allowance on every other surface at zero cost to the attacker;
// charged post-lookup, whether it was spent is observable from another
// surface, which is an account-state oracle — measured, five `verify_contact`
// requests then two `passwordless` ones returned [200x6, 429] for a real
// unverified address and [200x7] for an unknown one. Per-surface budgets
// charged pre-lookup have neither property; per-destination aggregate is then
// bounded by surface count x cap, under the global daily breaker.

export type OtpContactKind = 'email' | 'phone';

/**
 * SMS and WhatsApp deliver to the same number and cost the same money, so they
 * share one destination budget. Keying quotas on the channel let a caller
 * double both the delivery cap and the block budget by switching transport.
 */
export const otpContactKind = (channel: OtpChannel): OtpContactKind =>
  isPhoneChannel(channel) ? 'phone' : 'email';

/** Independent send budgets so one surface can't starve another. */
export type OtpSendSurface =
  'verify_contact' | 'recovery' | 'passwordless' | 'contact_change';

/** Aggregate outbound send ATTEMPTS per contact kind per day. */
const OTP_GLOBAL_SEND_CAP_PER_DAY = 2000;
/**
 * Send attempts to one destination per hour from a single surface.
 *
 * Sized for a real user who resends: below ~5 a legitimate retry hits the cap.
 */
const OTP_SURFACE_SEND_CAP_PER_HOUR = 5;
/** Verify attempts against one destination, across every purpose. */
const OTP_DESTINATION_VERIFY_CAP = 10;
const OTP_DESTINATION_VERIFY_WINDOW_S = 600;

const ONE_HOUR_S = 3600;
const ONE_DAY_S = 86_400;

/**
 * The send quota. Charged pre-lookup, on every request, from every surface.
 *
 * Pre-lookup on purpose: applying it after the account lookup would cap real
 * accounts and not fake ones, which is an existence oracle. Keyed by
 * destination, so naming addresses nobody owns only exhausts budget for those
 * addresses — and keyed by SURFACE, so exhausting it costs the victim nothing
 * on any other surface, and recovery keeps its own reserved capacity. That
 * combination is what makes it safe to charge unconditionally.
 *
 * Fails closed: losing the limiter on a paid-delivery path is a cost/abuse
 * event. The app-wide breaker is deliberately NOT here.
 */
export async function enforceOtpSurfaceSendQuota(opts: {
  channel: OtpChannel;
  /** Normalized destination (email address / phone number). */
  destination: string;
  surface: OtpSendSurface;
}): Promise<void> {
  await enforceRateLimit({
    scope: `otp.send.surface.${opts.surface}.${otpContactKind(opts.channel)}`,
    identifier: opts.destination.toLowerCase(),
    limit: OTP_SURFACE_SEND_CAP_PER_HOUR,
    window: ONE_HOUR_S,
    failClosed: true,
  });
}

/**
 * App-wide delivery breaker, charged by `processOtpSend` immediately before
 * dispatch. This is the ONE quota every user shares, so what may charge it
 * decides who can deny OTP to everyone else: charged pre-lookup with the rest
 * of the chain, ~2000 requests naming nonexistent addresses exhausted a full
 * day of delivery for the whole application at zero cost to the attacker.
 *
 * Privacy is unaffected — the per-destination caps still run pre-lookup, and a
 * rejection here surfaces as the same generic success the handlers already
 * return. Charged before dispatch, not after: a provider that is timing out is
 * exactly when the breaker has to trip.
 */
export async function enforceOtpGlobalSendBudget(opts: {
  channel: OtpChannel;
}): Promise<void> {
  await enforceRateLimit({
    scope: 'otp.send.global',
    identifier: otpContactKind(opts.channel),
    limit: OTP_GLOBAL_SEND_CAP_PER_DAY,
    window: ONE_DAY_S,
    failClosed: true,
  });
}

/**
 * Verify-side quota against one destination.
 *
 * **Recovery gets its own key, for the reason the send side already states.**
 * One shared key across every purpose looked like the stricter design — "rotating
 * the purpose can't multiply the per-identifier attempt budget" — but it made
 * password recovery deniable for the price of ten HTTP requests: an attacker who
 * knows an address POSTs `/api/auth/otp/verify` ten times with a junk code, the
 * 10/600 s budget is spent, and for the rest of the window the victim's
 * `/api/auth/forgot-password/reset` throws 429 BEFORE the account lookup, so a
 * CORRECT recovery code cannot be redeemed. Sustained cost: one request per
 * minute per victim; one IP's 60/min covers sixty victims at once.
 *
 * Splitting it costs nothing in brute-force resistance, because this limiter was
 * never the authority on that. The authority is the per-proof database counter
 * `OTP_MAX_VERIFY_ATTEMPTS` plus `verification_sessions.verifyAttemptDaily`,
 * both per-user, both transactional, and both reached AFTER this.
 *
 * `surface` is required rather than defaulted: a new verify entry point must
 * decide which budget it spends, not inherit one.
 */
export async function enforceOtpVerifyQuota(opts: {
  channel: OtpChannel;
  identifier: string;
  surface: OtpSendSurface;
}): Promise<void> {
  const kind = otpContactKind(opts.channel);
  await enforceRateLimit({
    scope:
      opts.surface === 'recovery'
        ? `otp.verify.dest.recovery.${kind}`
        : `otp.verify.dest.${kind}`,
    identifier: opts.identifier.toLowerCase(),
    limit: OTP_DESTINATION_VERIFY_CAP,
    window: OTP_DESTINATION_VERIFY_WINDOW_S,
    failClosed: true,
  });
}

/**
 * The 24h verify-FAILURE budget deliberately does NOT live here. It was
 * enforced twice — in the limiter store and in the proof row — which cost a
 * consume-then-refund protocol, a hand-rebuilt refund key, and a failure mode
 * where one store blip locked a user out of every OTP flow for 24h. The
 * surviving authority is `verification_sessions.verifyAttemptDaily`, enforced
 * transactionally in `processOtpVerify`. Verify attempts are still bounded by the
 * limiter per destination (`enforceOtpVerifyQuota`) and per user (endpoint
 * limiters).
 */

/**
 * Check a fixed-window rate limit for the current request.
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
