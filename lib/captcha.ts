import { sanitizeForLog } from '@/utils';

import { getClientIp } from './audit';

// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const CAPTCHA_HEADER = 'x-captcha-response';

const MAX_TOKEN_LENGTH = 2048;

/** Fails closed on any error. */
export async function verifyTurnstileToken(
  token: string,
  remoteIp?: string | null
): Promise<boolean> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return false;

  const secretKey =
    process.env.NODE_ENV === 'development'
      ? TEST_SECRET_KEY
      : process.env.TURNSTILE_SECRET_KEY;

  if (!secretKey) {
    console.error('[captcha] TURNSTILE_SECRET_KEY missing — rejecting request');
    return false;
  }

  const body = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { success?: boolean };
    return data.success === true;
  } catch (error) {
    console.error(sanitizeForLog(error));
    return false;
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
