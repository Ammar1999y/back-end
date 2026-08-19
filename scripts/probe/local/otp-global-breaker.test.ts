/**
 * C-02 — who charges the application-wide OTP delivery breaker.
 *
 * The breaker (`otp.send.global`, 2000/day per contact kind) is the only quota
 * that is shared by every user of the deployment, so anything that can charge it
 * without producing a delivery is an app-wide denial of OTP with no provider
 * cost to the attacker.
 *
 * `rateLimit` is stubbed so the identifiers actually consumed are observable;
 * everything above it is the real code path.
 *
 * Run: bun run probe:local  (or bun test scripts/probe/local)
 */
import { expect, mock, test } from 'bun:test';

const consumed: string[] = [];

await mock.module('@/lib/rate-limit/index', () => ({
  rateLimit: async (opts: { identifier: string; limit: number }) => {
    consumed.push(opts.identifier);
    return {
      success: true,
      limit: opts.limit,
      remaining: opts.limit - 1,
      retryAfter: 0,
      degraded: false,
    };
  },
  refundRateLimit: async () => {},
}));

const { enforceOtpSendQuota } = await import('@/lib/rate-limit/api');

const GLOBAL = 'otp.send.global:email';

test('the pre-lookup quota chain does NOT charge the shared provider breaker', async () => {
  consumed.length = 0;

  // Exactly what a public send handler runs before it knows whether the
  // destination belongs to anyone: an address nobody owns.
  await enforceOtpSendQuota({
    channel: 'email',
    destination: 'does-not-exist@example.test',
    surface: 'verify_contact',
  });

  // The per-surface and per-destination layers are what make the endpoint
  // enumeration-resistant, so they must still be charged here.
  expect(consumed).toContain(
    'otp.send.surface.verify_contact.email:does-not-exist@example.test'
  );
  expect(consumed).toContain('otp.send.dest.email:does-not-exist@example.test');

  // The shared breaker must not be: 2000 requests naming random nonexistent
  // addresses would otherwise exhaust OTP delivery for every real user for a
  // full day, at zero provider cost and without knowing a single account.
  expect(consumed).not.toContain(GLOBAL);
});

test('recovery keeps its reserved destination budget and still skips the breaker', async () => {
  consumed.length = 0;

  await enforceOtpSendQuota({
    channel: 'email',
    destination: 'someone@example.test',
    surface: 'recovery',
  });

  expect(consumed).toContain(
    'otp.send.dest.recovery.email:someone@example.test'
  );
  expect(consumed).not.toContain('otp.send.dest.email:someone@example.test');
  expect(consumed).not.toContain(GLOBAL);
});

test('the breaker is charged at the delivery boundary instead', async () => {
  const { enforceOtpGlobalSendBudget } = await import('@/lib/rate-limit/api');
  consumed.length = 0;

  await enforceOtpGlobalSendBudget({ channel: 'whatsapp' });
  await enforceOtpGlobalSendBudget({ channel: 'sms' });
  await enforceOtpGlobalSendBudget({ channel: 'email' });

  // sms and whatsapp deliver to the same number and cost the same money, so
  // they share one bucket; email has its own.
  expect(consumed).toEqual([
    'otp.send.global:phone',
    'otp.send.global:phone',
    GLOBAL,
  ]);
});
