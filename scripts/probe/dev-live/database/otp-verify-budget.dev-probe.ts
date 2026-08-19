/* eslint-disable unicorn/no-top-level-assignment-in-function, unicorn/no-break-in-nested-loop --
   Dev probe: module-level fixture ids are assigned by seed helpers and read by
   `afterAll` cleanup, and the guess loops break out of a bounded nest. Both are
   the shape of a test file. */
/**
 * ⚠️ DEV ONLY — DESTRUCTIVE — DISPOSABLE SERVICES ONLY ⚠️
 *
 * Writes to the real database in `.env`: inserts users, roles and verification
 * rows, spends OTP budgets, and deletes what it created. Not a test, not safe
 * for CI/staging/production. See `scripts/probe/dev-live/README.md`.
 *
 * Run: bun run probe:db
 *
 * ---
 *
 * C-07 / C-11 — the 24h OTP verify-failure budget is ONE budget per identity,
 * enforced transactionally in the database.
 *
 * NOT a rolling window: each proof row anchors its own 24h period, and the
 * bound is the SUM of those independently-anchored counters.
 *
 * Runs against the real database (DATABASE_URL) and the real `processOtpVerify`.
 * It seeds its own user + role and removes them afterwards.
 *
 * What it pins down:
 *  - the budget spans PURPOSES (a second flow does not buy a second allowance)
 *  - the budget spans TRANSPORTS (sms -> whatsapp does not either) — C-11
 *  - email and phone keep separate budgets
 *  - only attempts that actually compare a code are charged
 *  - a correct code refunds its charge, in the same transaction
 *
 */
import type { OtpChannel, OtpPurpose } from '@/utils/validation/otp';

import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import {
  roles,
  users,
  verificationCodes,
  verificationSessions,
} from '@/db/schema';
import { afterAll, expect, test } from 'bun:test';

import { hashOtpCode, processOtpVerify } from '@/utils/otp';
import {
  OTP_MAX_DAILY_VERIFY_ATTEMPTS,
  OTP_MAX_VERIFY_ATTEMPTS,
} from '@/utils/validation/constants';

const STAMP = process.env.PROBE_STAMP ?? '900000001';
const EMAIL = `otp-budget-probe-${STAMP}@probe.test`;
const PHONE = `9665${STAMP.slice(0, 8)}`;
const ROLE_NAME = `probe-role-${STAMP}`;
const RIGHT_CODE = '123456';
const WRONG_CODE = '000000';

let userId = '';
let roleId = '';
let c11UserId = '';
let c11RoleId = '';

async function seed() {
  const [role] = await db
    .insert(roles)
    .values({ roleName: ROLE_NAME, scope: 'standard', isActive: true })
    .returning({ id: roles.id });
  roleId = role!.id;

  const [user] = await db
    .insert(users)
    .values({
      name: 'OTP budget probe',
      email: EMAIL,
      phoneNumber: PHONE,
      roleId,
      isActive: true,
    })
    .returning({ id: users.id });
  userId = user!.id;
}

/** A fresh, unblocked proof row with a live code, as `processOtpSend` leaves it. */
async function seedSession(
  channel: OtpChannel,
  purpose: OtpPurpose,
  identifier: string,
  targetIdentifier: string | null = null
) {
  const [row] = await db
    .insert(verificationSessions)
    .values({
      userId,
      channel,
      identifier,
      purpose,
      targetIdentifier,
      attemptNumber: 1,
    })
    .returning({ id: verificationSessions.id });

  await db.insert(verificationCodes).values({
    sessionId: row!.id,
    code: await hashOtpCode(RIGHT_CODE),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });

  return row!.id;
}

/** What a resend does to the per-cycle counter, without calling a provider. */
async function simulateResend(sessionId: string) {
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

async function dailySum(contactKind: 'email' | 'phone') {
  const [row] = await db
    .select({
      used: sql<number>`COALESCE(SUM(${verificationSessions.verifyAttemptDaily}), 0)`.mapWith(
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

type Attempt = { status: number; message: string };

async function attempt(
  channel: OtpChannel,
  purpose: OtpPurpose,
  identifier: string,
  code: string
): Promise<Attempt> {
  try {
    await processOtpVerify({ userId, channel, purpose, identifier, code });
    return { status: 200, message: 'matched' };
  } catch (error) {
    const e = error as { status?: number; message?: string };
    return { status: e.status ?? 0, message: e.message ?? '' };
  }
}

const WRONG_CODE_STATUS = 400;
const BLOCKED_STATUS = 429;

afterAll(async () => {
  if (userId) await db.delete(users).where(eq(users.id, userId));
  if (roleId) await db.delete(roles).where(eq(roles.id, roleId));
  if (c11UserId) await db.delete(users).where(eq(users.id, c11UserId));
  if (c11RoleId) await db.delete(roles).where(eq(roles.id, c11RoleId));
});

test('the daily failure budget is shared across purposes AND transports', async () => {
  await seed();

  // Three phone flows, one row each — the key is (user, contactKind, purpose),
  // so purpose still separates rows while transport no longer does. Each row
  // carries its own per-cycle counter (5), so without a shared daily budget
  // these three rows would together allow 15+ guesses per resend cycle against
  // the same phone number.
  const smsVerify = await seedSession('sms', 'verify_contact', PHONE);
  const smsPasswordless = await seedSession('sms', 'passwordless_login', PHONE);
  const smsForgot = await seedSession('sms', 'forgot_password', PHONE);

  // Spend the budget on the sms rows, resending whenever the per-cycle cap of
  // 5 is reached — exactly what a real attacker with a resend button can do.
  //
  // Both answers count as guesses. A wrong code that also crosses the per-cycle
  // cap reports 429 rather than 400, but the code WAS compared, so it is
  // charged; only requests that never reach a comparison are free (see the
  // third test).
  const smsRows: Array<[string, OtpPurpose]> = [
    [smsVerify, 'verify_contact'],
    [smsPasswordless, 'passwordless_login'],
    [smsForgot, 'forgot_password'],
  ];

  let guesses = 0;
  outer: for (const [sessionId, purpose] of smsRows) {
    // Enough resend cycles to exhaust the shared budget from this row alone if
    // the budget were per-row.
    for (let cycle = 0; cycle < 5; cycle++) {
      await simulateResend(sessionId);
      for (let i = 0; i < OTP_MAX_VERIFY_ATTEMPTS; i++) {
        const r = await attempt('sms', purpose, PHONE, WRONG_CODE);
        expect([WRONG_CODE_STATUS, BLOCKED_STATUS]).toContain(r.status);
        guesses++;
        if (guesses >= OTP_MAX_DAILY_VERIFY_ATTEMPTS) break outer;
        if (r.status === BLOCKED_STATUS) break; // per-cycle cap → resend
      }
    }
  }

  // Exactly the documented budget was spendable, and every guess was charged.
  expect(guesses).toBe(OTP_MAX_DAILY_VERIFY_ATTEMPTS);
  expect(await dailySum('phone')).toBe(OTP_MAX_DAILY_VERIFY_ATTEMPTS);

  // C-11: the same number over the other transport gets NOTHING. It now
  // resolves to the SAME row (contactKind='phone'), so there is no untouched
  // whatsapp row left to spend — which is the fix. Before it, a separate row
  // sat unblocked with a live code and granted five more guesses.
  const viaWhatsApp = await attempt(
    'whatsapp',
    'verify_contact',
    PHONE,
    WRONG_CODE
  );
  expect(viaWhatsApp.status).toBe(BLOCKED_STATUS);

  // ...and a fresh purpose on the exhausted transport gets nothing either.
  await seedSession('sms', 'change_phone', PHONE, PHONE);
  const viaNewPurpose = await attempt('sms', 'change_phone', PHONE, WRONG_CODE);
  expect(viaNewPurpose.status).toBe(BLOCKED_STATUS);
}, 300_000);

test('email keeps its own budget, and a correct code refunds its charge', async () => {
  // The phone budget is fully spent by the test above; email must be unaffected.
  await seedSession('email', 'verify_contact', EMAIL);

  const wrong = await attempt('email', 'verify_contact', EMAIL, WRONG_CODE);
  expect(wrong.status).toBe(WRONG_CODE_STATUS);
  expect(await dailySum('email')).toBe(1);

  const right = await attempt('email', 'verify_contact', EMAIL, RIGHT_CODE);
  expect(right.status).toBe(200);

  // `verify_contact` deletes its row on success, so the charge goes with it.
  expect(await dailySum('email')).toBe(0);

  // A retained-purpose proof keeps its row, so the refund has to be visible in
  // the counter itself: one earlier FAILURE stays charged, and the successful
  // attempt gives back only the token it took on the way in. Without the refund
  // this would read 2 — which is how the 16th successful login in a day used to
  // be rejected.
  await seedSession('email', 'forgot_password', EMAIL);
  const fpWrong = await attempt('email', 'forgot_password', EMAIL, WRONG_CODE);
  expect(fpWrong.status).toBe(WRONG_CODE_STATUS);
  expect(await dailySum('email')).toBe(1);
  const fpRight = await attempt('email', 'forgot_password', EMAIL, RIGHT_CODE);
  expect(fpRight.status).toBe(200);
  expect(await dailySum('email')).toBe(1);
}, 300_000);

test('requests that never compare a code are not charged', async () => {
  const sessionId = await seedSession('email', 'change_email', EMAIL, EMAIL);
  const before = await dailySum('email');

  // Expired code: nothing to compare against.
  await db
    .update(verificationCodes)
    .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    .where(eq(verificationCodes.sessionId, sessionId));

  const expired = await attempt('email', 'change_email', EMAIL, WRONG_CODE);
  expect(expired.status).toBe(WRONG_CODE_STATUS);
  expect(expired.message).toContain('انتهت صلاحية');
  expect(await dailySum('email')).toBe(before);

  // No proof row at all: throws before any counter is touched.
  const missing = await attempt(
    'email',
    'passwordless_login',
    EMAIL,
    WRONG_CODE
  );
  expect(missing.status).toBe(404);
  expect(await dailySum('email')).toBe(before);
}, 60_000);

/**
 * C-11 acceptance test, on its own fixture so it does not inherit the exhausted
 * budget above.
 *
 * The scenario the finding actually described: block an SMS cycle, then switch
 * transport IMMEDIATELY — before the daily cap is anywhere near spent. Reaching
 * the daily cap first would mask the per-cycle state this test exists to check.
 */
test('C-11: switching transport after an SMS block buys nothing', async () => {
  const [role] = await db
    .insert(roles)
    .values({
      roleName: `${ROLE_NAME}-c11`,
      scope: 'standard',
      isActive: true,
    })
    .returning({ id: roles.id });
  c11RoleId = role!.id;

  const [user] = await db
    .insert(users)
    .values({
      name: 'C-11 probe',
      email: `c11-${STAMP}@probe.test`,
      phoneNumber: `9665${String(Number(STAMP.slice(0, 8)) + 1)}`,
      roleId: c11RoleId,
      isActive: true,
    })
    .returning({ id: users.id });
  c11UserId = user!.id;

  const phone = `9665${String(Number(STAMP.slice(0, 8)) + 1)}`;
  const previousUserId = userId;
  userId = c11UserId;
  try {
    await seedSession('sms', 'verify_contact', phone);

    // Burn exactly one cycle over SMS. The 5th crosses the per-cycle cap.
    const results: number[] = [];
    for (let i = 0; i < OTP_MAX_VERIFY_ATTEMPTS; i++) {
      const r = await attempt('sms', 'verify_contact', phone, WRONG_CODE);
      results.push(r.status);
    }

    expect(results.slice(0, 4)).toEqual([400, 400, 400, 400]);
    expect(results[4]).toBe(BLOCKED_STATUS);

    // Only 5 of the 15 daily budget is spent, so the daily cap is NOT what
    // stops the next request — the shared per-cycle block is.
    expect(await dailySum('phone')).toBe(OTP_MAX_VERIFY_ATTEMPTS);

    const viaWhatsApp = await attempt(
      'whatsapp',
      'verify_contact',
      phone,
      WRONG_CODE
    );
    expect(viaWhatsApp.status).toBe(BLOCKED_STATUS);

    // One row, one block, one counter — not two of each.
    const rows = await db
      .select({ id: verificationSessions.id })
      .from(verificationSessions)
      .where(
        and(
          eq(verificationSessions.userId, c11UserId),
          eq(verificationSessions.contactKind, 'phone')
        )
      );
    expect(rows.length).toBe(1);
  } finally {
    userId = previousUserId;
  }
}, 300_000);
