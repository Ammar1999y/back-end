/**
 * The transaction boundary in `processOtpSend`: delivery runs AFTER the commit.
 *
 * Ported from `scripts/probe/dev-live/database/otp-send-boundary.dev-probe.ts`,
 * which is the first of the five dev probes to move because the harness's SMTP
 * stub broke it: that probe depended on a REAL SMTP connection failing fast
 * because `SMTP_USER`/`SMTP_PASS` were unset, and carried
 * `skipIf(SMTP_CONFIGURED)` so it would not mail a live address. With
 * `mock.module('nodemailer')` installed by the base preload it stopped failing,
 * so `bun run probe:db` reported `delivery failure still surfaces to the caller`
 * as a genuine failure. `failNextMail()` is the seam that replaces it — the
 * failure is now requested rather than depended on, so the `skipIf` is gone and
 * the assertion runs everywhere instead of only on a machine with no SMTP
 * credentials.
 *
 * ---
 *
 * This is the one assertion that distinguishes the current behaviour from the
 * old, and it is deliberately the *uncomfortable* half of the trade-off. Before
 * the change `sendOtp` ran inside `withTransaction`, so a delivery failure rolled
 * the session and the code back. Now it does not:
 *
 *  - `processOtpSend` still throws, so the caller and the client see the failure
 *  - the verification session row SURVIVES, with its attempt spent
 *  - the code row SURVIVES, and expires on its own
 *
 * If someone later "fixes" the burnt attempt by moving delivery back inside the
 * transaction, or by adding a compensating decrement, these assertions fail and
 * say why. The reasoning for accepting it is at the call site in `utils/otp.ts`.
 *
 * Two things the port removed rather than translated: the `PROBE_STAMP`-derived
 * email (the database is per-worker and truncated, so a unique-per-run address
 * buys nothing) and the `afterAll` row-by-row cleanup (`resetTables` replaces it,
 * and the old version could not clean up after a failure between its inserts).
 */
import { beforeAll, describe, expect, test } from 'bun:test';

import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import {
  roles,
  users,
  verificationCodes,
  verificationSessions,
} from '@/db/schema';
import { generateUuidV7 } from '@/lib/id';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import { processOtpSend } from '@/utils/otp';

import { resetTables } from '../helpers/database';
import { failNextMail, sentMail, settleDelivery } from '../helpers/mailbox';

/** `emailSchema` only accepts a handful of domains; the send path re-validates. */
const EMAIL = 'otp.boundary.probe@gmail.com';

const fixture: { userId: string; threw: unknown } = {
  userId: '',
  threw: null,
};

beforeAll(async () => {
  await resetTables();

  const roleId = generateUuidV7();
  const userId = generateUuidV7();

  await db.insert(roles).values({
    id: roleId,
    // Full id: a UUID v7 prefix is its timestamp, so a truncated one collides
    // between two roles seeded in the same millisecond.
    roleName: `otp-boundary-${roleId.replaceAll('-', '')}`,
    scope: 'standard',
    isActive: true,
  });
  await db.insert(users).values({
    id: userId,
    name: 'OTP boundary fixture',
    email: EMAIL,
    roleId,
    isActive: true,
  });
  fixture.userId = userId;

  // Requested, not depended on. The old probe needed the environment to have no
  // SMTP credentials; this states the condition under test outright.
  failNextMail(
    Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 })
  );

  try {
    await processOtpSend({
      userId,
      identifier: EMAIL,
      channel: 'email',
      purpose: 'verify_contact',
      sendTo: EMAIL,
      entityName: 'البريد الإلكتروني',
    });
  } catch (error) {
    fixture.threw = error;
  }
});

async function proofRow() {
  const rows = await db
    .select({
      id: verificationSessions.id,
      attemptNumber: verificationSessions.attemptNumber,
      nextAllowedAt: verificationSessions.nextAllowedAt,
    })
    .from(verificationSessions)
    .where(
      and(
        eq(verificationSessions.userId, fixture.userId),
        eq(verificationSessions.purpose, 'verify_contact')
      )
    );
  return rows[0] ?? null;
}

describe('a delivery failure after prepare', () => {
  test('surfaces to the caller', () => {
    expect(fixture.threw).not.toBeNull();
  });

  test('the throw came from the delivery boundary, not from an earlier check', async () => {
    // Without this the assertions below would also pass if `processOtpSend` threw
    // BEFORE attempting delivery — a different bug with identical symptoms. The
    // discriminator is the error's identity: `sendOtpEmail` converts a transport
    // failure into a `CustomError(MSG_EMAIL_SEND_FAILED, 500)` specifically so the
    // transport's own message cannot escape, and no earlier check produces that.
    expect(fixture.threw).toBeInstanceOf(CustomError);
    expect((fixture.threw as CustomError).status).toBe(
      HTTP_STATUS.INTERNAL_ERROR
    );
    // And nothing was recorded as delivered, so the stub rejected rather than
    // silently accepting the message.
    await settleDelivery();
    expect(sentMail()).toEqual([]);
  });

  test('refunds the attempt and cooldown', async () => {
    const row = await proofRow();
    expect(row).not.toBeNull();
    expect(row?.attemptNumber).toBe(0);
    expect(row?.nextAllowedAt).toBeNull();
  });

  test('removes the undelivered code', async () => {
    const row = await proofRow();
    expect(row).not.toBeNull();

    const codes = await db
      .select({ code: verificationCodes.code })
      .from(verificationCodes)
      .where(eq(verificationCodes.sessionId, row?.id ?? ''));

    expect(codes).toHaveLength(0);
  });
});
