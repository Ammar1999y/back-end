/**
 * The 24-hour OTP verify-FAILURE budget: ONE budget per identity, enforced
 * transactionally in `verification_sessions.verify_attempt_daily`.
 *
 * Ported from `scripts/probe/dev-live/database/otp-verify-budget.dev-probe.ts`,
 * which is the specification for what is asserted here. Three things the port
 * removed rather than translated: the probe's own user/role seeding (`seedUser`),
 * its `PROBE_STAMP`-derived identifiers (the database is per-worker and
 * truncated, so a unique-per-run address buys nothing) and its `afterAll`
 * row-by-row cleanup (`resetTables` in `beforeAll` replaces it, and the old form
 * could not clean up after a failure between its own inserts).
 *
 * **It is an ANCHORED FIXED window, never a rolling one.** Each proof row
 * anchors its own 24-hour period at `verify_attempt_window_start`, and the bound
 * is the SUM of those independently-anchored counters. The row keeps no
 * per-failure timestamps, so the whole counter ages out together when its anchor
 * passes 24 hours — which is why two full budgets can fall inside one moving
 * 24-hour interval, one just before an anchor expires and one just after. That
 * is the accepted limitation recorded in `utils/otp.ts`, and the last describe
 * block asserts it as behaviour rather than leaving it as a comment.
 *
 * **Every denial is asserted by ROW STATE, not only by status.** The budget lives
 * in a column, and a 429 cannot tell "denied because the identity's budget is
 * spent" from "denied because this row's cycle is blocked" from "denied because
 * the code was wrong and crossed a cap". `verify_attempt_daily` can: an attempt
 * that reached a code comparison is charged, and one that never did is not.
 *
 * Seam: the real `processOtpVerify` against a real PostgreSQL transaction. The
 * SQLite limiter is deliberately not reset here — the verify path counts nothing
 * in it (the `otp.send.*` chain and the global breaker are the send path), so
 * there is no limiter budget in this file for a stale row to deny.
 */
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from 'bun:test';
import type {
  OtpChannel,
  OtpPurpose,
  PhoneOtpChannel,
} from '@/utils/validation/otp';

import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { verificationCodes, verificationSessions } from '@/db/schema';
import { generateUuidV7 } from '@/lib/id';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import { hashOtpCode, processOtpVerify } from '@/utils/otp';
import {
  OTP_BLOCK_DURATION_HOURS,
  OTP_EXPIRY_MINUTES,
  OTP_MAX_DAILY_VERIFY_ATTEMPTS,
  OTP_MAX_VERIFY_ATTEMPTS,
} from '@/utils/validation/constants';
import { OTP_PURPOSES, PHONE_OTP_CHANNELS } from '@/utils/validation/otp';

import { resetTables } from '../helpers/database';
import { seedUser } from '../helpers/session';

/** The code every seeded proof row will match. */
const RIGHT_CODE = '123456';
const WRONG_CODE = '000000';
/** Shared freely: the budget keys on `userId`, and every test seeds its own. */
const PHONE = '966500000001';

const HOUR_MS = 60 * 60 * 1000;

/**
 * How many separate proof rows one identity needs to spend the whole daily
 * budget, given each row admits `OTP_MAX_VERIFY_ATTEMPTS` per send cycle.
 *
 * Derived, not written down: at 15 and 5 it is three rows, and if either
 * constant moves the arithmetic below moves with it instead of going quietly
 * wrong.
 */
const ROWS_TO_EXHAUST = Math.ceil(
  OTP_MAX_DAILY_VERIFY_ATTEMPTS / OTP_MAX_VERIFY_ATTEMPTS
);

/**
 * `chk_change_purpose_has_target` (db/schema.ts): a target identifier exists iff
 * the purpose is a contact change. Named rather than derived from the `change_`
 * prefix — `change_password` shares it and must NOT carry a target.
 */
const CHANGE_PURPOSES = new Set<OtpPurpose>(['change_email', 'change_phone']);

/** Purposes this file spends the budget across, and one it leaves pristine. */
const SPEND_PURPOSES = OTP_PURPOSES.slice(0, ROWS_TO_EXHAUST);
const UNTOUCHED_PURPOSE = OTP_PURPOSES[ROWS_TO_EXHAUST];

interface ProofOptions {
  userId: string;
  channel: OtpChannel;
  purpose: OtpPurpose;
  identifier: string;
}

/** A fresh, unblocked proof row with a live code — what `processOtpSend` leaves. */
async function seedProof(options: ProofOptions): Promise<string> {
  const [row] = await db
    .insert(verificationSessions)
    .values({
      userId: options.userId,
      channel: options.channel,
      identifier: options.identifier,
      purpose: options.purpose,
      targetIdentifier: CHANGE_PURPOSES.has(options.purpose)
        ? `new.${options.identifier}`
        : null,
      attemptNumber: 1,
    })
    .returning({ id: verificationSessions.id });

  const sessionId = row?.id;
  if (!sessionId) throw new Error('seedProof inserted no session row');

  await db.insert(verificationCodes).values({
    sessionId,
    // The production envelope from the production helper. A hand-written hash
    // would satisfy `verifyOtpCode` only by accident and would stop the day the
    // envelope or the keyring moves.
    code: hashOtpCode(RIGHT_CODE),
    expiresAt: new Date(
      Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000
    ).toISOString(),
  });

  return sessionId;
}

/**
 * The state a SERVED block plus a fresh code leaves behind, without calling a
 * provider: `processOtpSend` applies `BLOCK_EXPIRY_RESET` when it finds an
 * expired block and its upsert then sets `verifyAttemptNumber: 0` and
 * `attemptNumber + 1`, while deliberately leaving `verifyAttemptDaily` and
 * `verifyAttemptWindowStart` alone — that omission is the resend-reset bypass
 * this budget closes.
 *
 * A fixture shortcut, and the one test that does NOT take it is what licenses it:
 * "a served block returns the cycle but not the day" below drives the same reset
 * through the real verify path with `setSystemTime`, and asserts exactly these
 * columns.
 */
async function simulateServedBlockAndResend(sessionId: string): Promise<void> {
  await db
    .update(verificationSessions)
    .set({
      verifyAttemptNumber: 0,
      isBlocked: false,
      blockedUntil: null,
      attemptNumber: 1,
    })
    .where(eq(verificationSessions.id, sessionId));
}

/**
 * Moves a row's 24-hour anchor into the past.
 *
 * **This is how the anchor boundary has to be driven, and `setSystemTime` cannot
 * do it.** The window test is `NOW() - verify_attempt_window_start > INTERVAL '24
 * hours'`, evaluated by PostgreSQL, so a fake JavaScript clock does not move it;
 * `now() - <n> * interval '1 hour'` on the anchor is the same inequality from the
 * other side. `setSystemTime` IS used below for the two boundaries the production
 * code compares against the process clock: code expiry and block expiry.
 */
async function ageAnchor(sessionId: string, hours: number): Promise<void> {
  await db
    .update(verificationSessions)
    .set({
      verifyAttemptWindowStart: sql`now() - ${hours} * interval '1 hour'`,
    })
    .where(eq(verificationSessions.id, sessionId));
}

interface AttemptResult {
  status: number;
  message: string;
}

/**
 * One real verify.
 *
 * A throw that is not a `CustomError` is re-thrown rather than flattened into a
 * status: a bare `Error` here means the transaction failed for a reason no
 * assertion in this file is about, and reporting it as "status 0" would read as
 * a budget decision.
 */
async function verify(
  options: Parameters<typeof processOtpVerify>[0]
): Promise<AttemptResult> {
  try {
    await processOtpVerify(options);
    return { status: HTTP_STATUS.OK, message: '' };
  } catch (error) {
    if (!(error instanceof CustomError)) throw error;
    return { status: error.status ?? 0, message: error.message };
  }
}

/** Every column a denial has to be distinguished by. */
async function proofRow(sessionId: string) {
  const [row] = await db
    .select({
      verifyAttemptNumber: verificationSessions.verifyAttemptNumber,
      verifyAttemptDaily: verificationSessions.verifyAttemptDaily,
      attemptNumber: verificationSessions.attemptNumber,
      isBlocked: verificationSessions.isBlocked,
      blockedUntil: verificationSessions.blockedUntil,
      verifiedAt: verificationSessions.verifiedAt,
      consumedAt: verificationSessions.consumedAt,
      // Age of this row's own anchor, measured by the SERVER — the same clock
      // the production window test uses.
      anchorAgeSeconds:
        sql<number>`extract(epoch from (now() - ${verificationSessions.verifyAttemptWindowStart}))`.mapWith(
          Number
        ),
    })
    .from(verificationSessions)
    .where(eq(verificationSessions.id, sessionId));
  return row ?? null;
}

/** The STORED sum for one identity — no window filter, so it is the raw ledger. */
async function storedBudget(
  userId: string,
  contactKind: 'email' | 'phone'
): Promise<number> {
  const [row] = await db
    .select({
      used: sql<number>`coalesce(sum(${verificationSessions.verifyAttemptDaily}), 0)`.mapWith(
        Number
      ),
    })
    .from(verificationSessions)
    .where(
      and(
        eq(verificationSessions.userId, userId),
        eq(verificationSessions.contactKind, contactKind)
      )
    );
  return row?.used ?? 0;
}

async function phoneRowCount(userId: string): Promise<number> {
  const rows = await db
    .select({ id: verificationSessions.id })
    .from(verificationSessions)
    .where(
      and(
        eq(verificationSessions.userId, userId),
        eq(verificationSessions.contactKind, 'phone')
      )
    );
  return rows.length;
}

async function codeCount(sessionId: string): Promise<number> {
  const rows = await db
    .select({ id: verificationCodes.id })
    .from(verificationCodes)
    .where(eq(verificationCodes.sessionId, sessionId));
  return rows.length;
}

/**
 * The status a charged wrong guess must answer with.
 *
 * Both answers mean the code WAS compared. 429 is what a guess that also crossed
 * a cap reports — the per-cycle one or the daily one — and it is still charged,
 * which is why the expectation is computed from the constants instead of being a
 * literal table that would quietly stop matching.
 */
function chargedStatus(inCycle: number, spentBefore: number): number {
  const crossesCycle = inCycle >= OTP_MAX_VERIFY_ATTEMPTS;
  const crossesDaily = spentBefore + 1 >= OTP_MAX_DAILY_VERIFY_ATTEMPTS;
  return crossesCycle || crossesDaily
    ? HTTP_STATUS.TOO_MANY_REQUESTS
    : HTTP_STATUS.BAD_REQUEST;
}

/** A user with nothing but a role — the verify path reads no other column. */
async function freshIdentity(): Promise<{ userId: string; email: string }> {
  const user = await seedUser();
  return { userId: user.userId, email: user.email };
}

beforeAll(async () => {
  await resetTables();
});

afterEach(() => {
  // `bun:test` exports no bare `useRealTimers` (it lives on `jest`/`vi`);
  // `setSystemTime()` with no argument IS the documented reset.
  setSystemTime();
});

describe('one budget per identity', () => {
  test('it spans PURPOSES: a second flow does not buy a second allowance', async () => {
    const { userId } = await freshIdentity();

    // One row per purpose, all against the SAME phone. `purpose` is still part
    // of the unique key, so these are genuinely separate rows with separate
    // per-cycle counters: four rows x 5 = 20 guesses if the budget were
    // per-row, against a documented bound of 15.
    const spendRows: string[] = [];
    for (const purpose of SPEND_PURPOSES)
      spendRows.push(
        await seedProof({
          userId,
          channel: 'sms',
          purpose,
          identifier: PHONE,
        })
      );
    const pristine = await seedProof({
      userId,
      channel: 'sms',
      purpose: UNTOUCHED_PURPOSE!,
      identifier: PHONE,
    });

    // Spend row by row, no resends. Each row gives its per-cycle allowance and
    // then reports 429 on the guess that crosses it — that guess was still
    // compared, so it is still charged.
    let spent = 0;
    const observed: number[][] = [];
    const expected: number[][] = [];
    for (const [index, purpose] of SPEND_PURPOSES.entries()) {
      const seen: number[] = [];
      const want: number[] = [];
      for (
        let inCycle = 1;
        inCycle <= OTP_MAX_VERIFY_ATTEMPTS &&
        spent < OTP_MAX_DAILY_VERIFY_ATTEMPTS;
        inCycle++
      ) {
        want.push(chargedStatus(inCycle, spent));
        const result = await verify({
          userId,
          channel: 'sms',
          purpose,
          identifier: PHONE,
          code: WRONG_CODE,
        });
        seen.push(result.status);
        spent++;
      }
      observed.push(seen);
      expected.push(want);
      // Every guess on this row was charged to the row it was made on.
      const row = await proofRow(spendRows[index]!);
      expect(row?.verifyAttemptDaily).toBe(seen.length);
    }

    expect(observed).toEqual(expected);
    expect(spent).toBe(OTP_MAX_DAILY_VERIFY_ATTEMPTS);
    // The bound is the SUM across the identity's rows, which is what makes the
    // three separate flows one allowance.
    expect(await storedBudget(userId, 'phone')).toBe(
      OTP_MAX_DAILY_VERIFY_ATTEMPTS
    );

    // The pristine row: never guessed against, live code, full per-cycle
    // allowance — and refused.
    const before = await proofRow(pristine);
    expect(before?.verifyAttemptDaily).toBe(0);
    expect(before?.verifyAttemptNumber).toBe(0);
    expect(before?.isBlocked).toBe(false);

    const denied = await verify({
      userId,
      channel: 'sms',
      purpose: UNTOUCHED_PURPOSE!,
      identifier: PHONE,
      code: WRONG_CODE,
    });
    expect(denied.status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);

    // The discriminator a status cannot carry: the counters did not move, so
    // this request never reached a code comparison. It was refused by the
    // identity's spent budget, not by a wrong code and not by its own cycle.
    const after = await proofRow(pristine);
    expect(after?.verifyAttemptDaily).toBe(0);
    expect(after?.verifyAttemptNumber).toBe(0);
    // ...and the refusal armed the block on the row it was made against.
    expect(after?.isBlocked).toBe(true);
    expect(after?.blockedUntil).not.toBeNull();
    expect(await storedBudget(userId, 'phone')).toBe(
      OTP_MAX_DAILY_VERIFY_ATTEMPTS
    );
  }, 30_000);

  // Both directions, derived from the production export rather than written out:
  // `PHONE_OTP_CHANNELS` is the declaration that sms and whatsapp reach one
  // phone, so a channel added to it is covered here the day it is added.
  const transportPairs: [PhoneOtpChannel, PhoneOtpChannel][] =
    PHONE_OTP_CHANNELS.flatMap((blocked) =>
      PHONE_OTP_CHANNELS.filter((other) => other !== blocked).map(
        (switched): [PhoneOtpChannel, PhoneOtpChannel] => [blocked, switched]
      )
    );

  test.each([...transportPairs])(
    'it spans TRANSPORTS: a block over %s buys nothing over %s',
    async (blockedVia, switchedTo) => {
      const { userId } = await freshIdentity();
      const sessionId = await seedProof({
        userId,
        channel: blockedVia,
        purpose: 'verify_contact',
        identifier: PHONE,
      });

      // Burn exactly ONE cycle. Reaching the daily cap first would mask the
      // per-cycle state this case exists to check.
      const statuses: number[] = [];
      for (let inCycle = 1; inCycle <= OTP_MAX_VERIFY_ATTEMPTS; inCycle++) {
        const result = await verify({
          userId,
          channel: blockedVia,
          purpose: 'verify_contact',
          identifier: PHONE,
          code: WRONG_CODE,
        });
        statuses.push(result.status);
      }
      expect(statuses).toEqual(
        Array.from({ length: OTP_MAX_VERIFY_ATTEMPTS }, (_, i) =>
          chargedStatus(i + 1, i)
        )
      );

      const blocked = await proofRow(sessionId);
      expect(blocked?.verifyAttemptNumber).toBe(OTP_MAX_VERIFY_ATTEMPTS);
      expect(blocked?.verifyAttemptDaily).toBe(OTP_MAX_VERIFY_ATTEMPTS);
      expect(blocked?.isBlocked).toBe(true);
      // Only a third of the daily budget is gone, so the daily cap is NOT what
      // refuses the transport switch below — the shared per-cycle block is.
      expect(await storedBudget(userId, 'phone')).toBeLessThan(
        OTP_MAX_DAILY_VERIFY_ATTEMPTS
      );

      const switched = await verify({
        userId,
        channel: switchedTo,
        purpose: 'verify_contact',
        identifier: PHONE,
        code: WRONG_CODE,
      });
      expect(switched.status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);

      // One row, one block, one counter — not two of each. The switch resolved
      // to the SAME row (`contact_kind` is generated from the channel), so there
      // is no untouched row sitting unblocked with a live code.
      expect(await phoneRowCount(userId)).toBe(1);
      const afterSwitch = await proofRow(sessionId);
      expect(afterSwitch?.verifyAttemptDaily).toBe(OTP_MAX_VERIFY_ATTEMPTS);
      expect(afterSwitch?.verifyAttemptNumber).toBe(OTP_MAX_VERIFY_ATTEMPTS);
      // Nothing was charged and the block was not re-stamped: an already-blocked
      // session is refused before the code is looked at, so a switching attacker
      // cannot extend the penalty either.
      expect(afterSwitch?.blockedUntil).toBe(blocked?.blockedUntil ?? null);
    },
    30_000
  );

  test('email and phone keep SEPARATE budgets', async () => {
    const { userId, email } = await freshIdentity();

    let spent = 0;
    for (const purpose of SPEND_PURPOSES) {
      await seedProof({ userId, channel: 'sms', purpose, identifier: PHONE });
      for (
        let inCycle = 1;
        inCycle <= OTP_MAX_VERIFY_ATTEMPTS &&
        spent < OTP_MAX_DAILY_VERIFY_ATTEMPTS;
        inCycle++
      ) {
        await verify({
          userId,
          channel: 'sms',
          purpose,
          identifier: PHONE,
          code: WRONG_CODE,
        });
        spent++;
      }
    }
    expect(await storedBudget(userId, 'phone')).toBe(
      OTP_MAX_DAILY_VERIFY_ATTEMPTS
    );

    // The phone side is spent: a pristine phone row is refused without a
    // charge, which is the "budget spent" shape rather than the "wrong code"
    // one.
    const phonePristine = await seedProof({
      userId,
      channel: 'sms',
      purpose: UNTOUCHED_PURPOSE!,
      identifier: PHONE,
    });
    const phoneDenied = await verify({
      userId,
      channel: 'sms',
      purpose: UNTOUCHED_PURPOSE!,
      identifier: PHONE,
      code: WRONG_CODE,
    });
    expect(phoneDenied.status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
    const phoneRow = await proofRow(phonePristine);
    expect(phoneRow?.verifyAttemptDaily).toBe(0);

    // The email side is untouched by any of it. The proof is that the wrong
    // code is CHARGED: the request reached a comparison, so email had budget.
    const emailSession = await seedProof({
      userId,
      channel: 'email',
      purpose: 'verify_contact',
      identifier: email,
    });
    const emailWrong = await verify({
      userId,
      channel: 'email',
      purpose: 'verify_contact',
      identifier: email,
      code: WRONG_CODE,
    });
    expect(emailWrong.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const emailRow = await proofRow(emailSession);
    expect(emailRow?.verifyAttemptDaily).toBe(1);
    expect(await storedBudget(userId, 'email')).toBe(1);

    // And the phone ledger did not absorb the email charge.
    expect(await storedBudget(userId, 'phone')).toBe(
      OTP_MAX_DAILY_VERIFY_ATTEMPTS
    );

    // A correct code still works on the email side while phone is locked out.
    const emailRight = await verify({
      userId,
      channel: 'email',
      purpose: 'verify_contact',
      identifier: email,
      code: RIGHT_CODE,
    });
    expect(emailRight.status).toBe(HTTP_STATUS.OK);
  }, 30_000);
});

describe('only an attempt that COMPARES a code is charged', () => {
  test('an expired code is refused for free', async () => {
    const { userId, email } = await freshIdentity();
    const sessionId = await seedProof({
      userId,
      channel: 'email',
      purpose: 'verify_contact',
      identifier: email,
    });

    // One real guess first, so the assertion below is "the counter did not move"
    // and not "the counter is zero because nothing works".
    const guess = await verify({
      userId,
      channel: 'email',
      purpose: 'verify_contact',
      identifier: email,
      code: WRONG_CODE,
    });
    expect(guess.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const charged = await proofRow(sessionId);
    expect(charged?.verifyAttemptDaily).toBe(1);

    // The code-expiry boundary, and `setSystemTime` is the right instrument for
    // it: the active-code lookup compares `expires_at` against
    // `new Date().toISOString()`, built from the PROCESS clock.
    setSystemTime(new Date(Date.now() + (OTP_EXPIRY_MINUTES + 1) * 60 * 1000));

    const expired = await verify({
      userId,
      channel: 'email',
      purpose: 'verify_contact',
      identifier: email,
      code: WRONG_CODE,
    });
    expect(expired.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(expired.message).toContain('انتهت صلاحية');

    // Nothing to compare against, so nothing charged — neither counter moved.
    // Charging here is what turned an expired code into a targeted six-hour
    // denial with no guessing involved.
    const after = await proofRow(sessionId);
    expect(after?.verifyAttemptDaily).toBe(1);
    expect(after?.verifyAttemptNumber).toBe(1);
    expect(after?.isBlocked).toBe(false);
  });

  test('a purpose with no proof row is refused for free', async () => {
    const { userId, email } = await freshIdentity();
    const sessionId = await seedProof({
      userId,
      channel: 'email',
      purpose: 'verify_contact',
      identifier: email,
    });

    const missing = await verify({
      userId,
      channel: 'email',
      purpose: 'passwordless_login',
      identifier: email,
      code: WRONG_CODE,
    });
    expect(missing.status).toBe(HTTP_STATUS.NOT_FOUND);
    // The throw is before any counter, and before any row is created: a verify
    // must not be able to conjure a proof row for a purpose nobody sent.
    expect(await storedBudget(userId, 'email')).toBe(0);
    const rows = await db
      .select({ id: verificationSessions.id })
      .from(verificationSessions)
      .where(
        and(
          eq(verificationSessions.userId, userId),
          eq(verificationSessions.purpose, 'passwordless_login')
        )
      );
    expect(rows).toHaveLength(0);
    const cleared = await proofRow(sessionId);
    expect(cleared?.verifyAttemptDaily).toBe(0);
  });

  test('an unknown user is refused identically — no enumeration', async () => {
    const { userId, email } = await freshIdentity();
    await seedProof({
      userId,
      channel: 'email',
      purpose: 'verify_contact',
      identifier: email,
    });

    const known = await verify({
      userId,
      channel: 'email',
      purpose: 'forgot_password',
      identifier: email,
      code: WRONG_CODE,
    });
    const unknown = await verify({
      userId: generateUuidV7(),
      channel: 'email',
      purpose: 'forgot_password',
      identifier: email,
      code: WRONG_CODE,
    });

    // Same status and the same message: "this user has no proof row for this
    // purpose" and "there is no such user" must not be distinguishable.
    expect(unknown.status).toBe(known.status);
    expect(unknown.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(unknown.message).toBe(known.message);
  });

  test('no denial message carries an id, an identifier or the code', async () => {
    const { userId, email } = await freshIdentity();
    const sessionId = await seedProof({
      userId,
      channel: 'email',
      purpose: 'verify_contact',
      identifier: email,
    });

    const messages: string[] = [];
    // Wrong code, then the same row again once its cycle is blocked, then a
    // purpose with no row: the three denial messages this function can produce
    // besides the expiry one.
    for (let inCycle = 1; inCycle <= OTP_MAX_VERIFY_ATTEMPTS + 1; inCycle++) {
      const result = await verify({
        userId,
        channel: 'email',
        purpose: 'verify_contact',
        identifier: email,
        code: WRONG_CODE,
      });
      messages.push(result.message);
    }
    const crossPurpose = await verify({
      userId,
      channel: 'email',
      purpose: 'change_password',
      identifier: email,
      code: WRONG_CODE,
    });
    messages.push(crossPurpose.message);

    for (const message of messages) {
      expect(message).not.toContain(sessionId);
      expect(message).not.toContain(userId);
      expect(message).not.toContain(email);
      expect(message).not.toContain(RIGHT_CODE);
      expect(message).not.toContain(WRONG_CODE);
    }
    // And the two failures a client must distinguish still are distinguishable
    // from each other, which is the reason a bare "invalid" is not enough here.
    expect(new Set(messages).size).toBeGreaterThan(1);
  });
});

describe('a correct code refunds its charge', () => {
  test('verify_contact takes the whole ledger row with it', async () => {
    const { userId, email } = await freshIdentity();
    const sessionId = await seedProof({
      userId,
      channel: 'email',
      purpose: 'verify_contact',
      identifier: email,
    });

    const wrong = await verify({
      userId,
      channel: 'email',
      purpose: 'verify_contact',
      identifier: email,
      code: WRONG_CODE,
    });
    expect(wrong.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(await storedBudget(userId, 'email')).toBe(1);

    const right = await verify({
      userId,
      channel: 'email',
      purpose: 'verify_contact',
      identifier: email,
      code: RIGHT_CODE,
    });
    expect(right.status).toBe(HTTP_STATUS.OK);

    // A pure ownership proof deletes its row, so the charge goes with it — the
    // budget is stored ON the row, which is also why a credential rotation or
    // the retention sweep forgives failed attempts.
    expect(await proofRow(sessionId)).toBeNull();
    expect(await codeCount(sessionId)).toBe(0);
    expect(await storedBudget(userId, 'email')).toBe(0);
  });

  test('a retained purpose gives back only the token it took', async () => {
    const { userId, email } = await freshIdentity();
    const sessionId = await seedProof({
      userId,
      channel: 'email',
      purpose: 'forgot_password',
      identifier: email,
    });

    const wrong = await verify({
      userId,
      channel: 'email',
      purpose: 'forgot_password',
      identifier: email,
      code: WRONG_CODE,
    });
    expect(wrong.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const row1 = await proofRow(sessionId);
    expect(row1?.verifyAttemptDaily).toBe(1);

    const right = await verify({
      userId,
      channel: 'email',
      purpose: 'forgot_password',
      identifier: email,
      code: RIGHT_CODE,
    });
    expect(right.status).toBe(HTTP_STATUS.OK);

    // The row survives as an auditable single-use record, so the refund has to
    // be visible in the counter itself. 1, not 2: the earlier FAILURE stays
    // charged and the success gives back only the token it took on the way in.
    // Without the refund this reads 2 — which is how the 16th successful login
    // in a day used to be rejected. 0 would be a different bug: a success would
    // launder every earlier failure.
    const row = await proofRow(sessionId);
    expect(row?.verifyAttemptDaily).toBe(1);
    // Same row, same transaction: the cycle is closed and the code is gone, so
    // the refund committed with the consumption rather than beside it.
    expect(row?.verifyAttemptNumber).toBe(0);
    expect(row?.attemptNumber).toBe(0);
    expect(row?.isBlocked).toBe(false);
    expect(row?.verifiedAt).not.toBeNull();
    expect(row?.consumedAt).not.toBeNull();
    expect(await codeCount(sessionId)).toBe(0);
  });

  test('the charge is transactional: a failing onVerified refunds it too', async () => {
    const { userId, email } = await freshIdentity();
    const other = await seedProof({
      userId,
      channel: 'email',
      purpose: 'forgot_password',
      identifier: email,
    });
    await verify({
      userId,
      channel: 'email',
      purpose: 'forgot_password',
      identifier: email,
      code: WRONG_CODE,
    });
    expect(await storedBudget(userId, 'email')).toBe(1);

    const sessionId = await seedProof({
      userId,
      channel: 'email',
      purpose: 'change_email',
      identifier: email,
    });

    // The charge has to be taken BEFORE the code can be checked to stay atomic,
    // so the only thing that makes it a failure counter is that it comes back
    // when the attempt was not a failure. This is the strong form of "in the
    // same transaction": the sensitive action itself fails, and the charge, the
    // refund and the consumption all roll back together.
    const sentinel = new Error('onVerified refused to commit');
    const seen: { targetIdentifier: string | null } = { targetIdentifier: '' };
    await expect(
      processOtpVerify({
        userId,
        channel: 'email',
        purpose: 'change_email',
        identifier: email,
        code: RIGHT_CODE,
        onVerified: async (_tx, matched) => {
          // The callback reads the PROVEN row, not the request — worth pinning
          // here because it is the value a rotation would commit.
          seen.targetIdentifier = matched.targetIdentifier;
          throw sentinel;
        },
      })
    ).rejects.toThrow(sentinel);
    expect(seen.targetIdentifier).toBe(`new.${email}`);

    // Nothing survived the rollback: not the charge, not the cycle increment,
    // not the consumption stamps, and not the code deletion.
    const row = await proofRow(sessionId);
    expect(row?.verifyAttemptDaily).toBe(0);
    expect(row?.verifyAttemptNumber).toBe(0);
    expect(row?.verifiedAt).toBeNull();
    expect(row?.consumedAt).toBeNull();
    expect(await codeCount(sessionId)).toBe(1);
    // The identity's other row is untouched, so the rollback was scoped to the
    // transaction and not to the whole ledger.
    const row2 = await proofRow(other);
    expect(row2?.verifyAttemptDaily).toBe(1);
    expect(await storedBudget(userId, 'email')).toBe(1);
  });
});

describe('the ANCHORED fixed 24-hour window', () => {
  test('charges do not move the anchor, and the counter ages out as a block', async () => {
    const { userId } = await freshIdentity();
    const sessionId = await seedProof({
      userId,
      channel: 'sms',
      purpose: 'verify_contact',
      identifier: PHONE,
    });

    for (let inCycle = 1; inCycle <= OTP_MAX_VERIFY_ATTEMPTS; inCycle++)
      await verify({
        userId,
        channel: 'sms',
        purpose: 'verify_contact',
        identifier: PHONE,
        code: WRONG_CODE,
      });
    const row3 = await proofRow(sessionId);
    expect(row3?.verifyAttemptDaily).toBe(OTP_MAX_VERIFY_ATTEMPTS);

    // Boundary 1: INSIDE the window. The anchor is put 23 hours back, so those
    // five failures sit in a live period with an hour left on it.
    await ageAnchor(sessionId, 23);
    await simulateServedBlockAndResend(sessionId);

    for (let inCycle = 1; inCycle <= OTP_MAX_VERIFY_ATTEMPTS; inCycle++)
      await verify({
        userId,
        channel: 'sms',
        purpose: 'verify_contact',
        identifier: PHONE,
        code: WRONG_CODE,
      });

    const live = await proofRow(sessionId);
    // The new failures accumulate on the SAME counter...
    expect(live?.verifyAttemptDaily).toBe(OTP_MAX_VERIFY_ATTEMPTS * 2);
    // ...and did NOT re-stamp the anchor. A window that slid forward on every
    // charge would never expire under sustained guessing.
    expect(live?.anchorAgeSeconds).toBeGreaterThan(22.5 * 60 * 60);

    // Boundary 2: PAST the window, by a minute. The row keeps no per-failure
    // timestamps, so the whole counter is forgiven at once and restarts at 1 —
    // this is the anchored fixed window, and the ten failures it just dropped
    // include five that were charged moments ago.
    await ageAnchor(sessionId, 24 + 1 / 60);
    await simulateServedBlockAndResend(sessionId);

    const reopened = await verify({
      userId,
      channel: 'sms',
      purpose: 'verify_contact',
      identifier: PHONE,
      code: WRONG_CODE,
    });
    // 400, not 429: the guess was compared and charged against a budget that
    // has reopened.
    expect(reopened.status).toBe(HTTP_STATUS.BAD_REQUEST);

    const reanchored = await proofRow(sessionId);
    expect(reanchored?.verifyAttemptDaily).toBe(1);
    expect(reanchored?.anchorAgeSeconds).toBeLessThan(60);
  }, 30_000);

  test('the bound is the SUM of independently-anchored counters', async () => {
    const { userId } = await freshIdentity();
    const [older, newer] = [
      await seedProof({
        userId,
        channel: 'sms',
        purpose: 'verify_contact',
        identifier: PHONE,
      }),
      await seedProof({
        userId,
        channel: 'sms',
        purpose: 'passwordless_login',
        identifier: PHONE,
      }),
    ];

    const burnCycle = async (purpose: OtpPurpose): Promise<number[]> => {
      const statuses: number[] = [];
      for (let inCycle = 1; inCycle <= OTP_MAX_VERIFY_ATTEMPTS; inCycle++) {
        const result = await verify({
          userId,
          channel: 'sms',
          purpose,
          identifier: PHONE,
          code: WRONG_CODE,
        });
        statuses.push(result.status);
      }
      return statuses;
    };

    await burnCycle('verify_contact');
    await burnCycle('passwordless_login');
    expect(await storedBudget(userId, 'phone')).toBe(
      OTP_MAX_VERIFY_ATTEMPTS * 2
    );

    // Each row anchors its OWN period. Ageing one past 24 hours drops its
    // contribution to the sum while the other's stays live — the two counters
    // do not share a window, only a bound.
    await ageAnchor(older, 25);

    // So the identity can spend the full budget again on the live row, even
    // though the ledger already records five failures on the aged one. This is
    // the accepted limitation stated as behaviour: two full budgets can fall
    // inside one moving 24-hour interval, one just before an anchor expires
    // and one just after.
    let spentOnNewer = OTP_MAX_VERIFY_ATTEMPTS;
    while (spentOnNewer < OTP_MAX_DAILY_VERIFY_ATTEMPTS) {
      await simulateServedBlockAndResend(newer);
      const statuses = await burnCycle('passwordless_login');
      spentOnNewer += statuses.length;
    }

    const live = await proofRow(newer);
    expect(live?.verifyAttemptDaily).toBe(OTP_MAX_DAILY_VERIFY_ATTEMPTS);
    // The aged row still HOLDS its five; it simply does not count.
    const row4 = await proofRow(older);
    expect(row4?.verifyAttemptDaily).toBe(OTP_MAX_VERIFY_ATTEMPTS);
    expect(await storedBudget(userId, 'phone')).toBe(
      OTP_MAX_DAILY_VERIFY_ATTEMPTS + OTP_MAX_VERIFY_ATTEMPTS
    );

    // And the bound is real once the live counters alone reach it: a pristine
    // row on the same phone is refused without a charge.
    const pristine = await seedProof({
      userId,
      channel: 'whatsapp',
      purpose: UNTOUCHED_PURPOSE!,
      identifier: PHONE,
    });
    const denied = await verify({
      userId,
      channel: 'whatsapp',
      purpose: UNTOUCHED_PURPOSE!,
      identifier: PHONE,
      code: WRONG_CODE,
    });
    expect(denied.status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
    const row5 = await proofRow(pristine);
    expect(row5?.verifyAttemptDaily).toBe(0);
  }, 60_000);

  test('a served block returns the cycle but not the day', async () => {
    const { userId } = await freshIdentity();
    const sessionId = await seedProof({
      userId,
      channel: 'sms',
      purpose: 'verify_contact',
      identifier: PHONE,
    });

    for (let inCycle = 1; inCycle <= OTP_MAX_VERIFY_ATTEMPTS; inCycle++)
      await verify({
        userId,
        channel: 'sms',
        purpose: 'verify_contact',
        identifier: PHONE,
        code: WRONG_CODE,
      });
    const blocked = await proofRow(sessionId);
    expect(blocked?.isBlocked).toBe(true);
    const anchorBefore = blocked?.anchorAgeSeconds ?? 0;

    // Boundary 3: block expiry. `blockedUntil` is compared against `new Date()`
    // in the verify path, so THIS one is the process clock and `setSystemTime`
    // drives it — unlike the 24-hour anchor, which PostgreSQL evaluates.
    setSystemTime(
      new Date(Date.now() + OTP_BLOCK_DURATION_HOURS * HOUR_MS + 60_000)
    );

    // A live code as of the shifted clock, since the seeded one has expired by
    // now and an expired code never reaches the counters.
    await db
      .update(verificationCodes)
      .set({
        expiresAt: new Date(
          Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000
        ).toISOString(),
      })
      .where(eq(verificationCodes.sessionId, sessionId));

    const afterBlock = await verify({
      userId,
      channel: 'sms',
      purpose: 'verify_contact',
      identifier: PHONE,
      code: WRONG_CODE,
    });
    // 400, not 429: the served block gave the per-cycle allowance back, so
    // this guess was compared.
    expect(afterBlock.status).toBe(HTTP_STATUS.BAD_REQUEST);

    const row = await proofRow(sessionId);
    // The per-cycle counter restarted...
    expect(row?.verifyAttemptNumber).toBe(1);
    expect(row?.isBlocked).toBe(false);
    expect(row?.blockedUntil).toBeNull();
    // ...and the day did NOT. Six hours of block does not refund the daily
    // budget, and the anchor is untouched by block expiry: that bound ages out
    // on its own anchor only. A status assertion cannot tell these apart.
    expect(row?.verifyAttemptDaily).toBe(OTP_MAX_VERIFY_ATTEMPTS + 1);
    expect(row?.anchorAgeSeconds).toBeGreaterThanOrEqual(anchorBefore);
    expect(row?.anchorAgeSeconds).toBeLessThan(60 * 60);
  }, 30_000);
});
