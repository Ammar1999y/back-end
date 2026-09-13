import { sanitizeForLog } from '@/utils';

import { getClientIp } from './audit';

// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const CAPTCHA_HEADER = 'x-captcha-response';

export const CAPTCHA_TOKEN_MAX_LENGTH = 2048;

// Cap the outbound siteverify call so a Cloudflare slowdown can't stall
// OTP/auth handlers indefinitely. Failure here flows through fail-closed.
const SITEVERIFY_TIMEOUT_MS = 3000;

/** Fails closed on any error. */
async function verifyTurnstileToken(
  token: string,
  remoteIp?: string | null
): Promise<boolean> {
  if (!token || token.length > CAPTCHA_TOKEN_MAX_LENGTH) return false;

  const secretKey =
    process.env.NODE_ENV === 'development'
      ? TEST_SECRET_KEY
      : process.env.TURNSTILE_SECRET_KEY;

  if (!secretKey) {
    console.error(
      JSON.stringify({
        msg: 'captcha.secret missing',
        nodeEnv: process.env.NODE_ENV ?? null,
      })
    );
    return false;
  }

  const body = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SITEVERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!response.ok) return false;
    // `unknown`, then a runtime check. Asserting `{ success?: boolean }` on a
    // third-party body happened to fail closed — `null.success` throws into the
    // catch, a string's is `undefined` — but only by accident of what the
    // property access does, and a refactor that reads the field defensively
    // would turn "the provider answered something else" into a pass.
    const data: unknown = await response.json();
    if (typeof data !== 'object' || data === null) return false;
    return (data as Record<string, unknown>)['success'] === true;
  } catch (error) {
    console.error(sanitizeForLog(error));
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Reads token from `x-captcha-response`. The remote IP is sourced only from
 * trusted proxy headers via `getClientIp` — we never accept a client-supplied
 * IP override, which would let an attacker forge the IP sent to Turnstile.
 */
export async function verifyTurnstileRequest(
  headers: Headers
): Promise<boolean> {
  const token = headers.get(CAPTCHA_HEADER);
  if (!token) return false;
  return verifyTurnstileToken(token, getClientIp(headers));
}
