import { getClientIp } from '@/lib/audit';
import { sanitizeForLog } from '@/utils';

import {
  HTTP_STATUS,
  MSG_SERVICE_UNAVAILABLE,
  MSG_TOO_MANY_REQUESTS,
} from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

import { rateLimit } from './index';
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

// One send budget per channel, shared across every send surface (otp /
// passwordless / forgot + authenticated change-email/phone) so rotating
// endpoints can't multiply the per-destination cap. Key with the destination.
export const otpSendScope = (channel: string) => `otp.send.${channel}`;

// One verify budget per channel, shared across all verification purposes so
// rotating the purpose can't multiply the per-identifier attempt budget. Key
// with the contact identifier.
export const otpVerifyScope = (channel: string) => `otp.verify.${channel}`;

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
