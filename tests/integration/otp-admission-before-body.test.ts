/**
 * The per-IP limiter on every anonymous OTP route rejects BEFORE the body is
 * read.
 *
 * Check-then-read is the contract `lib/http/contract.ts` states, and it is what
 * makes the limiter an admission control rather than a late refusal: a request
 * that is throttled must cost the server nothing beyond the head. A status alone
 * cannot show that — a 429 issued after parsing looks identical — so the request
 * object itself is kept and its `bodyUsed` flag read afterwards: `readJson()`
 * consumes the body through `request.text()`, and nothing else on the path does.
 * (A pull-counting stream cannot do this job: Bun's `Request` constructor drains
 * a stream body eagerly, before any handler runs — measured.)
 *
 * Every handler is exhausted through its own route rather than through the
 * limiter API, so the test follows whatever budget and scope each handler
 * declares instead of copying them. Captcha is scripted to refuse while the
 * budget is spent: that path answers without the response-time floor, and it
 * still counts, because the limiter runs first.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { app } from '@/app';

import { HTTP_STATUS } from '@/utils/api-messages';

import { resetTables } from '../helpers/database';
import { scriptEgress } from '../helpers/egress';
import { baseHeaders, TEST_IP } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const TURNSTILE_HOST = 'challenges.cloudflare.com';

const ROUTES = [
  '/api/auth/otp/send',
  '/api/auth/otp/verify',
  '/api/auth/forgot-password/send',
  '/api/auth/forgot-password/reset',
  '/api/auth/passwordless/send',
];

/** Well above any per-IP budget a handler declares; a loop that gets here is a bug. */
const MAX_ADMISSIONS = 500;

/** A second address, so the control request is admitted after the first is spent. */
const CONTROL_IP = '203.0.113.9';

function request(path: string, body: string, ip = TEST_IP): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: baseHeaders({
      'content-type': 'application/json',
      'cf-connecting-ip': ip,
    }),
    body,
  });
}

async function spendBudget(path: string): Promise<number> {
  for (let n = 1; n <= MAX_ADMISSIONS; n++) {
    const response = await app.handle(request(path, '{}'));
    if (response.status === HTTP_STATUS.TOO_MANY_REQUESTS) return n;
    expect(
      response.status,
      `${path} answered ${response.status} on attempt ${n}; only a captcha refusal is expected while the budget lasts`
    ).toBe(HTTP_STATUS.FORBIDDEN);
  }
  throw new Error(
    `${path} was never throttled within ${MAX_ADMISSIONS} requests`
  );
}

beforeEach(async () => {
  await resetTables();
  resetSqliteStores();
  scriptEgress(TURNSTILE_HOST, () => Response.json({ success: false }));
});

// This file spends five per-IP budgets on purpose. Files share a worker under
// `--no-isolate`, so the spent windows must not outlive it.
afterAll(() => {
  resetSqliteStores();
});

describe.each(ROUTES)('%s', (path) => {
  test('a throttled request is refused with its body unread', async () => {
    // The limiter's window is anchored on the wall clock
    // (`windowStart = now - now % windowMs`), so a boundary can fall between
    // the request that spent the budget and the probe, and the probe then lands
    // in a fresh window as an admission. Spend again when that happens; the
    // property under test is what a throttled request costs, not which minute
    // it arrived in.
    let outcome: { throttled: Request; response: Response } | null = null;
    for (let round = 0; !outcome && round < 3; round++) {
      const admitted = await spendBudget(path);
      expect(admitted).toBeGreaterThan(1);
      const throttled = request(path, '{"probe":true}');
      const response = await app.handle(throttled);
      if (response.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
        outcome = { throttled, response };
        continue;
      }
      // Only the scripted captcha refusal is evidence of a rollover — it is
      // what an ADMITTED request answers here. Anything else is a handler
      // failure this retry must not hide.
      expect(
        response.status,
        `${path} probe answered ${response.status} on round ${round + 1}; only 429 (throttled) or 403 (admitted into a fresh window) can occur`
      ).toBe(HTTP_STATUS.FORBIDDEN);
    }
    if (!outcome)
      throw new Error(`${path}: the probe never met a spent window`);

    expect(outcome.response.status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
    expect(outcome.response.headers.get('retry-after')).not.toBeNull();
    expect(outcome.throttled.bodyUsed).toBe(false);

    // The instrument, proven on the same route: an ADMITTED request with a
    // body the schema rejects is read on its way to 422, so `bodyUsed` does
    // flip when the handler reaches the body.
    scriptEgress(TURNSTILE_HOST, () => Response.json({ success: true }));
    const admittedRequest = request(path, '{"probe":true}', CONTROL_IP);
    const control = await app.handle(admittedRequest);

    expect(control.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(admittedRequest.bodyUsed).toBe(true);
  }, 60_000);
});
