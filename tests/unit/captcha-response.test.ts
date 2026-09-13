/**
 * What `lib/captcha.ts` accepts from Cloudflare.
 *
 * The verdict is a boolean off a THIRD-PARTY body, and the module's whole
 * contract is that it fails closed. Asserting the shape (`as { success?:
 * boolean }`) made that true only by accident of what a property access does to
 * each malformed value — `null.success` throws into the catch, a string's is
 * `undefined`, an array's likewise — so the cases below are what keeps the
 * runtime check honest rather than the assertion.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { verifyTurnstileRequest } from '@/lib/captcha';

const HEADER = 'x-captcha-response';
/* eslint-disable unicorn/no-unnecessary-global-this, unicorn/no-global-object-property-assignment -- the point of these cases IS what `lib/captcha.ts` gets back from the global `fetch`, so the stub has to be installed on the global object and restored from it */
const realFetch = globalThis.fetch;

function headers(): Headers {
  return new Headers({ [HEADER]: 'a-token' });
}

/** Answers every outbound call with one body, as a 200. */
function answerWith(body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  process.env.TURNSTILE_SECRET_KEY ??= 'unit-test-secret';
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the siteverify body', () => {
  test('accepts exactly `success: true`', async () => {
    answerWith({ success: true });
    expect(await verifyTurnstileRequest(headers())).toBe(true);
  });

  test.each([
    ['a refusal', { success: false }],
    ['a truthy non-boolean', { success: 'true' }],
    ['a numeric one', { success: 1 }],
    ['no success field', { 'error-codes': ['bad-request'] }],
    ['null', null],
    ['an array', [{ success: true }]],
    ['a bare string', '"success"'],
    ['a bare number', 7],
  ])('refuses %s', async (_label, body) => {
    answerWith(body);
    expect(await verifyTurnstileRequest(headers())).toBe(false);
  });

  test('refuses a body that is not JSON at all', async () => {
    globalThis.fetch = (async () =>
      new Response('<html>service unavailable</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof globalThis.fetch;
    expect(await verifyTurnstileRequest(headers())).toBe(false);
  });

  test('refuses when no token header is present, without calling out', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return Response.json({ success: true });
    }) as unknown as typeof globalThis.fetch;

    expect(await verifyTurnstileRequest(new Headers())).toBe(false);
    expect(called).toBe(false);
  });
});
