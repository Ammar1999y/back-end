/**
 * The JS pre-check in `rateLimit` that `SQL_CONSUME` cannot perform for itself.
 *
 * The statement is max-aware only on the CONFLICT branch: both the INSERT and
 * the window-rollover branch write `cost` unconditionally, so a cost over the
 * whole budget would be admitted and STORED above `max`. Its own doc says so
 * (`lib/rate-limit/store.ts`) and names the caller as the thing that has to
 * refuse. That makes the guard a fail-closed control on the primitive every auth
 * and OTP limit shares — and nothing exercised it: the only `cost` assertions in
 * the suite were in `tests/fixtures/_sqlite-semantics-child.cjs`, which drives
 * the SQL directly and never loads `lib/rate-limit/index.ts`. Changing
 * `cost < 1` to `cost < 0`, or deleting the guard, left the suite green while a
 * `cost = 0` request became free forever.
 *
 * Both halves are asserted for every rejected value: the refusal, AND that
 * nothing was written — a guard that refuses after storing the row has already
 * spent the budget it was protecting.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { rateLimit } from '@/lib/rate-limit';
import { getRateLimitStore } from '@/lib/rate-limit/store';

import { resetSqliteStores } from '../helpers/sqlite';

const LIMIT = 10;
const WINDOW = 60;

/** A fresh key per case, so one case's stored row cannot answer the next. */
const keySeed = { value: 0 };
function nextKey(): string {
  keySeed.value += 1;
  return `test.cost.guard:${keySeed.value}`;
}

function storedRows(): { key: string; count: number }[] {
  return getRateLimitStore()
    .db.prepare('SELECT key, count FROM rate_limit ORDER BY key')
    .all<{ key: string; count: number }>();
}

beforeEach(() => {
  resetSqliteStores();
});

describe('rateLimit refuses a cost it cannot account for', () => {
  test.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['over the whole budget', LIMIT + 1],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('cost %s is refused without a write', async (_label, cost) => {
    const identifier = nextKey();

    const result = await rateLimit({
      identifier,
      limit: LIMIT,
      window: WINDOW,
      cost,
    });

    expect(result.success).toBe(false);
    expect(result.degraded).toBe(false);
    expect(result.remaining).toBe(0);
    // The row is the budget. A refusal that still wrote one would have spent it.
    expect(storedRows()).toEqual([]);
  });

  test('the whole budget in one request is admitted exactly once', async () => {
    const identifier = nextKey();

    const first = await rateLimit({
      identifier,
      limit: LIMIT,
      window: WINDOW,
      cost: LIMIT,
    });
    expect(first.success).toBe(true);
    expect(first.remaining).toBe(0);
    expect(storedRows()).toEqual([{ key: identifier, count: LIMIT }]);

    // Even a single unit now crosses `max`, and the denial writes nothing —
    // the stored count stays exactly the budget rather than climbing past it.
    const second = await rateLimit({
      identifier,
      limit: LIMIT,
      window: WINDOW,
    });
    expect(second.success).toBe(false);
    expect(storedRows()).toEqual([{ key: identifier, count: LIMIT }]);
  });

  test('an omitted cost spends one unit', async () => {
    const identifier = nextKey();

    const result = await rateLimit({
      identifier,
      limit: LIMIT,
      window: WINDOW,
    });

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(LIMIT - 1);
    expect(storedRows()).toEqual([{ key: identifier, count: 1 }]);
  });

  test('costs sum, and the sum is what the limit is compared against', async () => {
    const identifier = nextKey();

    const four = await rateLimit({
      identifier,
      limit: LIMIT,
      window: WINDOW,
      cost: 4,
    });
    expect(four.success).toBe(true);

    const six = await rateLimit({
      identifier,
      limit: LIMIT,
      window: WINDOW,
      cost: 6,
    });
    expect(six.success).toBe(true);
    expect(storedRows()).toEqual([{ key: identifier, count: LIMIT }]);

    // 4 + 6 + 1 > 10: refused, and again with no write.
    const over = await rateLimit({ identifier, limit: LIMIT, window: WINDOW });
    expect(over.success).toBe(false);
    expect(storedRows()).toEqual([{ key: identifier, count: LIMIT }]);
  });
});
