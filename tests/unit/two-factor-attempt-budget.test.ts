/**
 * `spendChallengeAttempt` — the shared per-challenge failure budget.
 *
 * Tested against a stub adapter rather than through an endpoint because the
 * property is an INTERLEAVING: what a second caller sees between the first
 * caller's spend and its outcome. Driving that through HTTP means racing two
 * requests and asserting on whichever order the scheduler picked, which is a
 * flake rather than a test. The stub models the one adapter behaviour the
 * protocol relies on — `consumeVerificationValue` returns the latest row for an
 * identifier and deletes every row for it — so the ordering is chosen here.
 *
 * The eager re-arm this replaced wrote the counter back at the pre-increment
 * value before returning, so N parallel guesses each read the same count and
 * cost one attempt between them. `budget is not readable between a spend and its
 * outcome` is the case that fails against it.
 */
import { expect, test } from 'bun:test';
import type { AuthContext } from '@/lib/auth/two-factor-challenge';

import {
  spendChallengeAttempt,
  TWO_FACTOR_ALLOWED_ATTEMPTS,
} from '@/lib/auth/two-factor-challenge';

interface StoredValue {
  value: string;
  expiresAt: Date;
}

/**
 * Rows per identifier, newest last. `consume` takes the newest and drops the
 * rest, which is what the Drizzle path does (`ORDER BY createdAt DESC LIMIT 1`
 * followed by a `deleteMany` for the identifier).
 */
function stubContext(seed: Record<string, string>) {
  const rows = new Map<string, StoredValue[]>();
  const expiresAt = new Date(Date.now() + 600_000);
  for (const [identifier, value] of Object.entries(seed))
    rows.set(identifier, [{ value, expiresAt }]);

  const deleted: string[] = [];

  const ctx = {
    responseHeaders: new Headers(),
    setCookie: () => {},
    context: {
      responseHeaders: new Headers(),
      createAuthCookie: (name: string) => ({ name, attributes: {} }),
      // `invalidateChallenge` expires the do-not-remember marker too, so the
      // abandoned attempt cannot leave its answer behind for the next one.
      authCookies: {
        dontRememberToken: { name: 'dont_remember', attributes: {} },
      },
      internalAdapter: {
        consumeVerificationValue: async (identifier: string) => {
          const bucket = rows.get(identifier);
          if (!bucket || bucket.length === 0) return null;
          const latest = bucket.at(-1) ?? null;
          rows.set(identifier, []);
          return latest;
        },
        createVerificationValue: async (data: {
          value: string;
          identifier: string;
          expiresAt: Date;
        }) => {
          const bucket = rows.get(data.identifier) ?? [];
          bucket.push({ value: data.value, expiresAt: data.expiresAt });
          rows.set(data.identifier, bucket);
          return data;
        },
        deleteVerificationByIdentifier: async (identifier: string) => {
          deleted.push(identifier);
          rows.delete(identifier);
        },
      },
    },
    // The stub implements exactly the surface `spendChallengeAttempt` and
    // `invalidateChallenge` reach; a faithful `GenericEndpointContext` is
    // hundreds of members wide and none of the rest is touched.
  } as unknown as AuthContext;

  return { ctx, rows, deleted };
}

const CHALLENGE = '2fa-harness-challenge';
const COUNTER = `2fa-attempts-${CHALLENGE}`;

test('a fresh challenge grants an attempt', async () => {
  const { ctx } = stubContext({ [COUNTER]: '0' });
  const attempt = await spendChallengeAttempt(ctx, CHALLENGE);
  expect(attempt.ok).toBe(true);
});

test('the budget is not readable between a spend and its outcome', async () => {
  const { ctx } = stubContext({ [COUNTER]: '0' });

  const first = await spendChallengeAttempt(ctx, CHALLENGE);
  expect(first.ok).toBe(true);

  // The row is consumed and not written back, so a request arriving while the
  // first is still verifying finds nothing and is refused rather than reading
  // the pre-increment count and evaluating a code against a stale budget.
  const concurrent = await spendChallengeAttempt(ctx, CHALLENGE);
  expect(concurrent.ok).toBe(false);

  await first.recordFailure();

  // And once the outcome is recorded the budget is available again.
  const next = await spendChallengeAttempt(ctx, CHALLENGE);
  expect(next.ok).toBe(true);
});

test('a recorded failure costs exactly one attempt', async () => {
  const { ctx, rows } = stubContext({ [COUNTER]: '0' });

  for (let spent = 1; spent <= TWO_FACTOR_ALLOWED_ATTEMPTS; spent += 1) {
    const attempt = await spendChallengeAttempt(ctx, CHALLENGE);
    expect(attempt.ok).toBe(true);
    await attempt.recordFailure();
    expect(rows.get(COUNTER)?.at(-1)?.value).toBe(String(spent));
  }

  // The ceiling refuses, and takes the whole challenge with it rather than only
  // the attempt.
  const exhausted = await spendChallengeAttempt(ctx, CHALLENGE);
  expect(exhausted.ok).toBe(false);
});

test('crossing the ceiling invalidates the challenge and its counter', async () => {
  const { ctx, deleted } = stubContext({
    [COUNTER]: String(TWO_FACTOR_ALLOWED_ATTEMPTS),
  });

  const attempt = await spendChallengeAttempt(ctx, CHALLENGE);
  expect(attempt.ok).toBe(false);
  expect(deleted).toContain(CHALLENGE);
  expect(deleted).toContain(COUNTER);
});

test('restore returns the budget a non-verdict exit borrowed', async () => {
  const { ctx, rows } = stubContext({ [COUNTER]: '2' });

  const attempt = await spendChallengeAttempt(ctx, CHALLENGE);
  expect(attempt.ok).toBe(true);
  // Nothing was proven either way — a quota rejection, a transport fault — so
  // the count goes back unchanged rather than the challenge losing its counter.
  await attempt.restore();
  expect(rows.get(COUNTER)?.at(-1)?.value).toBe('2');

  const next = await spendChallengeAttempt(ctx, CHALLENGE);
  expect(next.ok).toBe(true);
});

test('an unparseable counter is exhausted, not zero', async () => {
  for (const corrupt of ['', 'nine', '-1', '1e400']) {
    const { ctx } = stubContext({ [COUNTER]: corrupt });
    const attempt = await spendChallengeAttempt(ctx, CHALLENGE);
    expect(attempt.ok).toBe(false);
  }
});

test('a missing counter row refuses rather than granting a fresh budget', async () => {
  const { ctx } = stubContext({});
  const attempt = await spendChallengeAttempt(ctx, CHALLENGE);
  expect(attempt.ok).toBe(false);
});
