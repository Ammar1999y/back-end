/**
 * A provider that never answers, seen from `processOtpSend`.
 *
 * `otp-send-boundary.test.ts` pins what a REJECTED delivery does to the proof
 * row. This pins the same contract for a delivery that merely never finishes:
 * the caller is released at `PROVIDER_TIMEOUT_MS`, the outcome is the fixed
 * delivery failure, and the refund runs — attempt and cooldown back, code row
 * gone — so a message the user may never receive cannot cost them a send and
 * cannot stay verifiable. The stub here is the mailbox's own delay, so this
 * proves the deadline holds through `sendMailWithDeadline` regardless of what
 * the transport does; the socket-level half is `tests/process/smtp-deadline`.
 */
import { beforeAll, describe, expect, test } from 'bun:test';

import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { verificationCodes, verificationSessions } from '@/db/schema';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import { processOtpSend, PROVIDER_TIMEOUT_MS } from '@/utils/otp';

import { resetTables } from '../helpers/database';
import { delayMail, sentMail } from '../helpers/mailbox';
import { seedUser } from '../helpers/session';

/** Past the deadline by enough that a timer skew cannot make the stub win. */
const STALL_MS = PROVIDER_TIMEOUT_MS + 1500;

const fixture: {
  userId: string;
  email: string;
  threw: unknown;
  ms: number;
  /** What the stub had recorded once its own timer landed. */
  deliveredTo: (string | undefined)[];
} = { userId: '', email: '', threw: null, ms: 0, deliveredTo: [] };

beforeAll(async () => {
  await resetTables();
  const user = await seedUser({ emailVerified: false });
  fixture.userId = user.userId;
  fixture.email = user.email;

  delayMail(STALL_MS);

  const started = performance.now();
  try {
    await processOtpSend({
      userId: user.userId,
      identifier: user.email,
      channel: 'email',
      purpose: 'verify_contact',
      sendTo: user.email,
      entityName: 'البريد الإلكتروني',
    });
  } catch (error) {
    fixture.threw = error;
  }
  fixture.ms = performance.now() - started;

  // The stub's own timer is still running; let it land inside this hook so its
  // late push cannot surprise a later file in the same worker — and read it
  // here, because the shared `beforeEach` clears the mailbox before each test.
  await Bun.sleep(STALL_MS - fixture.ms + 500);
  fixture.deliveredTo = sentMail().map((message) => message.to);
}, 30_000);

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

describe('a delivery that never finishes', () => {
  test('releases the caller at the deadline with the fixed delivery failure', () => {
    expect(fixture.ms).toBeGreaterThanOrEqual(PROVIDER_TIMEOUT_MS - 50);
    expect(fixture.ms).toBeLessThan(STALL_MS);
    expect(fixture.threw).toBeInstanceOf(CustomError);
    expect((fixture.threw as CustomError).status).toBe(
      HTTP_STATUS.INTERNAL_ERROR
    );
  });

  test('refunds the attempt and the cooldown', async () => {
    const row = await proofRow();
    expect(row).not.toBeNull();
    expect(row?.attemptNumber).toBe(0);
    expect(row?.nextAllowedAt).toBeNull();
  });

  test('removes the code, so a message that may still arrive proves nothing', async () => {
    const row = await proofRow();
    const codes = await db
      .select({ code: verificationCodes.code })
      .from(verificationCodes)
      .where(eq(verificationCodes.sessionId, row?.id ?? ''));
    expect(codes).toHaveLength(0);
  });

  test('the transport did finish later, which is exactly the case the refund exists for', () => {
    expect(fixture.deliveredTo).toEqual([fixture.email]);
  });
});
