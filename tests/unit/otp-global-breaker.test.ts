/**
 * Who charges the application-wide OTP delivery breaker.
 *
 * The breaker (`otp.send.global`, 2000/day per contact kind) is the only quota
 * every user of the deployment shares, so anything that can charge it without
 * producing a delivery is an app-wide denial of OTP at zero cost to the attacker
 * and without knowing a single account.
 *
 * ## Why this no longer mocks anything
 *
 * The previous version did `mock.module('@/lib/rate-limit/index', …)` to observe
 * which identifiers were consumed. That is a trap, twice over:
 *
 * - `mock.module` is process-wide and `mock.restore()` does not undo it
 *   (reproduced on Bun 1.4.0). Replacing the rate-limit BARREL leaked into every
 *   file that ran afterwards in the same process, which is why the sibling
 *   `rate-limit-log-boundary.test.ts` carries a comment about importing from the
 *   boundary module rather than the barrel. No lifecycle hook fixes that; the
 *   only real fixes are isolation or not mocking.
 * - It proved the mock. A stub that records `opts.identifier` asserts what the
 *   caller PASSED, not what the store was asked to count.
 *
 * The keys are directly observable instead: `enforceRateLimit` writes
 * `${scope}:${identifier}` into the real SQLite `rate_limit` table, which the
 * preload has already pointed at a temporary directory. Reading the table back
 * asserts the same property against the real store — strictly stronger, and with
 * no shared module replaced.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { OtpSendSurface } from '@/lib/rate-limit/api';

import { getRateLimitStore } from '@/lib/rate-limit/store';

import { resetSqliteStores } from '../helpers/sqlite';

/**
 * `OtpSendSurface` is a type-only union, so there is no production array to
 * import — and this list would silently stop covering a new surface. The
 * `Exclude` below makes that a COMPILE error instead: a member added to the union
 * and not to this array leaves `Missing` non-`never`, and the assignment fails.
 */
const SEND_SURFACES = [
  'verify_contact',
  'recovery',
  'passwordless',
  'contact_change',
  'two_factor',
  'recovery_second_factor',
] as const;
/** `as const` is load-bearing: `OtpSendSurface[]` would widen the element type
 *  back to the whole union and make both checks below vacuously pass. */
type MissingSurface = Exclude<OtpSendSurface, (typeof SEND_SURFACES)[number]>;
type ExtraSurface = Exclude<(typeof SEND_SURFACES)[number], OtpSendSurface>;
const _everySurfaceCovered: MissingSurface extends never ? true : never = true;
const _noInventedSurface: ExtraSurface extends never ? true : never = true;
void _everySurfaceCovered;
void _noInventedSurface;

const GLOBAL_EMAIL = 'otp.send.global:email';
const GLOBAL_PHONE = 'otp.send.global:phone';

/** Every key currently in the limiter, read out of the production table. */
function chargedKeys(): { key: string; count: number }[] {
  return getRateLimitStore()
    .db.prepare('SELECT key, count FROM rate_limit ORDER BY key')
    .all<{ key: string; count: number }>();
}

function keyNames(): string[] {
  return chargedKeys().map((row) => row.key);
}

beforeEach(() => {
  // Deleting the file, not sweeping it: a fixed-window counter inside its window
  // is not expired, so a sweep would leave every row this file wrote.
  resetSqliteStores();
});

describe('the pre-lookup send chain', () => {
  test('charges the per-surface key and NOT the shared provider breaker', async () => {
    const { enforceOtpSurfaceSendQuota } = await import('@/lib/rate-limit/api');

    // Exactly what a public send handler runs before it knows whether the
    // destination belongs to anyone: an address nobody owns.
    await enforceOtpSurfaceSendQuota({
      channel: 'email',
      destination: 'does-not-exist@example.test',
      surface: 'verify_contact',
    });

    expect(keyNames()).toContain(
      'otp.send.surface.verify_contact.email:does-not-exist@example.test'
    );

    // No key SHARED with another surface: spending this one must not reduce
    // what the same address can still receive from `passwordless` or recovery.
    expect(keyNames()).toHaveLength(1);

    // The shared breaker must not be: 2000 requests naming random nonexistent
    // addresses would otherwise exhaust OTP delivery for every real user for a
    // full day.
    expect(keyNames()).not.toContain(GLOBAL_EMAIL);
    expect(keyNames()).not.toContain(GLOBAL_PHONE);
  });

  test('recovery keeps its reserved send budget', async () => {
    const { enforceOtpSurfaceSendQuota } = await import('@/lib/rate-limit/api');

    await enforceOtpSurfaceSendQuota({
      channel: 'email',
      destination: 'someone@example.test',
      surface: 'recovery',
    });

    // Recovery's budget is its OWN key, never a slice of a shared pool:
    // reserved capacity only counts as reserved if no other surface can spend
    // it, so a refactor reintroducing a cross-surface destination budget
    // silently reintroduces a targeted account-recovery denial.
    expect(keyNames()).toContain(
      'otp.send.surface.recovery.email:someone@example.test'
    );
    expect(keyNames()).not.toContain(
      'otp.send.surface.verify_contact.email:someone@example.test'
    );
    expect(keyNames()).not.toContain(GLOBAL_EMAIL);
  });

  test('exhausting one surface leaves every other surface untouched', async () => {
    const { enforceOtpSurfaceSendQuota } = await import('@/lib/rate-limit/api');
    const destination = 'victim@example.test';

    const charge = (surface: (typeof SEND_SURFACES)[number]) =>
      enforceOtpSurfaceSendQuota({ channel: 'email', destination, surface });

    // Past the point of refusal on one surface...
    let refusals = 0;
    for (let i = 0; i < 20; i++)
      await charge('verify_contact').catch(() => {
        refusals++;
      });
    expect(refusals).toBeGreaterThan(0);

    // ...every other surface still admits its own full budget. This is the
    // property that lets the quota be charged BEFORE the account lookup: if
    // surfaces shared a budget, the choice would be between spending a victim's
    // cross-surface allowance for free (pre-lookup) and making the spend
    // observable from another surface (post-lookup, an account-state oracle).
    for (const surface of SEND_SURFACES) {
      if (surface === 'verify_contact') continue;
      await expect(charge(surface)).resolves.toBeUndefined();
    }
  });

  test.each([...SEND_SURFACES])(
    'surface %s never charges the breaker',
    async (surface) => {
      const { enforceOtpSurfaceSendQuota } =
        await import('@/lib/rate-limit/api');
      await enforceOtpSurfaceSendQuota({
        channel: 'sms',
        destination: '966500000001',
        surface,
      });
      expect(keyNames()).not.toContain(GLOBAL_PHONE);
      expect(keyNames()).not.toContain(GLOBAL_EMAIL);
    }
  );
});

describe('the delivery boundary', () => {
  test('charges the breaker, and sms and whatsapp share one bucket', async () => {
    const { enforceOtpGlobalSendBudget } = await import('@/lib/rate-limit/api');

    await enforceOtpGlobalSendBudget({ channel: 'whatsapp' });
    await enforceOtpGlobalSendBudget({ channel: 'sms' });
    await enforceOtpGlobalSendBudget({ channel: 'email' });

    // Asserted by stored COUNT rather than by a recorded call list, which is what
    // the real store makes possible: sms and whatsapp deliver to the same number
    // and cost the same money, so keying on the channel would let a caller double
    // a paid budget by switching transport. Two calls, one row, count 2.
    expect(chargedKeys()).toEqual([
      { key: GLOBAL_EMAIL, count: 1 },
      { key: GLOBAL_PHONE, count: 2 },
    ]);
  });
});
