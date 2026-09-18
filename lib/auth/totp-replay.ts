/**
 * One TOTP code, once — the reservation RFC 6238 §5.2 requires and the
 * verifiers do not perform.
 *
 * `createOTP(secret).verify(code, { window: 1 })` answers "is this code
 * acceptable right now", and stays true for the whole 30-second period plus the
 * period either side. Nothing recorded that a code had already been spent, so an
 * observed code opened a second session for roughly 90 seconds after its owner
 * used it. Three verifiers share the same secret and the same window — the
 * library's sign-in endpoint, enrolment confirmation, and password recovery — so
 * the reservation lives here rather than in any one of them.
 *
 * The claim is a guarded UPDATE, not a read-then-write: two requests presenting
 * the same code race on `last_totp_step < step`, and PostgreSQL lets exactly one
 * of them through.
 */
import type { Tx } from '@/db';
import type { EntityID } from '@/types';

import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { db } from '@/db';
import { twoFactorCredentials } from '@/db/schema';
import { createOTP } from '@better-auth/utils/otp';

/** The library's defaults, and therefore this application's. */
const TOTP_PERIOD_S = 30;
const TOTP_WINDOW = 1;

/**
 * The window to reserve over when the accept/reject decision belongs to ANOTHER
 * verifier — the library's `/two-factor/verify-totp`, which re-reads the clock
 * and re-verifies after this reservation has run.
 *
 * ⚠️ Not a wider tolerance. Reserving a step only marks it spent; the delegate
 * still decides. What the extra period buys is the guarantee the delegation
 * needs: every step the delegate can accept is a step this looked at. Its window
 * is `[L-1, L+1]` around ITS clock reading, ours `[C-w, C+w]` around an earlier
 * one, so at `w = 1` a step boundary crossed between the two reads leaves `L+1`
 * unreserved — a code accepted, a session issued, and the code still replayable.
 * At `w = 2` that holds for any clock movement smaller than one period inside a
 * single request, and `lib/auth/two-factor.ts` refuses the completion outright
 * if it ever does not.
 */
export const DELEGATED_TOTP_WINDOW = TOTP_WINDOW + 1;

export type TotpVerdict = 'matched' | 'rejected' | 'replayed';

type Executor = Tx | typeof db;

/**
 * `constantTimeEqualOTP` from `@better-auth/utils/otp`, which is not exported.
 *
 * On sign-in this comparison runs BEFORE the library's, so it is the one an
 * attacker measures; `===` returns at the first differing digit.
 */
function constantTimeEqual(input: string, expected: string): boolean {
  let difference = input.length ^ expected.length;
  for (let index = 0; index < expected.length; index++)
    /* eslint-disable-next-line unicorn/prefer-code-point -- a fixed step per
       UTF-16 unit is what makes the loop's work independent of the input;
       `codePointAt` consumes a surrogate pair in one step */
    difference |= input.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

/** The step a code is valid for, or `null` when it is valid for none. */
async function matchedStep(
  secret: string,
  code: string,
  window: number
): Promise<number | null> {
  const current = Math.floor(Date.now() / (TOTP_PERIOD_S * 1000));
  const otp = createOTP(secret, { period: TOTP_PERIOD_S });
  let found: number | null = null;
  // Every candidate is generated AND compared even after a hit, so neither the
  // work nor the timing depends on which step matched. The window is walked
  // newest-first so the highest matching step wins, which is the one worth
  // reserving.
  for (let offset = window; offset >= -window; offset--) {
    const step = current + offset;
    const matches = constantTimeEqual(code, await otp.hotp(step));
    if (matches && found === null) found = step;
  }
  return found;
}

/**
 * Reserve `step` for this user's credential.
 *
 * `false` means some earlier request already claimed this step or a later one —
 * that is, the code has been spent. A user with no credential row also gets
 * `false`; there is nothing to verify against.
 */
async function claimStep(
  userId: EntityID,
  step: number,
  executor: Executor
): Promise<boolean> {
  const claimed = await executor
    .update(twoFactorCredentials)
    .set({ lastTotpStep: step })
    .where(
      and(
        eq(twoFactorCredentials.userId, userId),
        or(
          isNull(twoFactorCredentials.lastTotpStep),
          lt(twoFactorCredentials.lastTotpStep, sql`${step}::bigint`)
        )
      )
    )
    .returning({ id: twoFactorCredentials.id });
  return claimed.length > 0;
}

/**
 * Verify a TOTP code AND spend it, in that order.
 *
 * `'replayed'` is deliberately distinct from `'rejected'` so a caller can log
 * the difference; both must reach the user as the same invalid-code answer,
 * because "that code was already used" tells an attacker their capture was
 * good.
 *
 * ⚠️ `executor` is not an optimisation. A caller inside a transaction must hand
 * its own over: the default reaches for a second connection out of
 * `MAX_POOL_CONNECTIONS`, and a request that holds one while waiting for another
 * is how the whole pool deadlocks under concurrency.
 */
export async function consumeTotpCode(
  userId: EntityID,
  secret: string,
  code: string,
  options: { executor?: Executor; window?: number } = {}
): Promise<TotpVerdict> {
  const step = await matchedStep(secret, code, options.window ?? TOTP_WINDOW);
  if (step === null) return 'rejected';
  return (await claimStep(userId, step, options.executor ?? db))
    ? 'matched'
    : 'replayed';
}
