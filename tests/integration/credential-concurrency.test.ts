/**
 * Three serialisation guarantees, driven CONCURRENTLY against the real database.
 *
 * Each was designed into the code — a `FOR UPDATE` lock, an advisory transaction
 * lock, a row lock around the failed-attempt counter — and each had only
 * sequential coverage, which a lock that silently stopped locking would pass.
 * The assertions here are on the rows after the burst, because a status alone
 * cannot tell "serialised" from "raced and got lucky".
 */
import { beforeAll, describe, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { users, verificationCodes, verificationSessions } from '@/db/schema';
import {
  LoginRejected,
  MAX_FAILED_ATTEMPTS,
  verifyLoginAttempt,
} from '@/lib/auth/login-guard';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import { processOtpSend, processOtpVerify } from '@/utils/otp';

import { resetTables } from '../helpers/database';
import { sentMail, settleDelivery } from '../helpers/mailbox';
import { seedOtpProof } from '../helpers/otp';
import { seedUser } from '../helpers/session';

/** Satisfies `passwordSchema`, so every attempt reaches the comparison. */
const WRONG_PASSWORD = 'Harness!Wr0ngPass';

function fulfilled<T>(outcomes: PromiseSettledResult<T>[]): T[] {
  return outcomes.flatMap((outcome) =>
    outcome.status === 'fulfilled' ? [outcome.value] : []
  );
}

function rejected<T>(outcomes: PromiseSettledResult<T>[]): unknown[] {
  return outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : []
  );
}

async function proofRows(userId: string) {
  const sessions = await db
    .select({
      id: verificationSessions.id,
      attemptNumber: verificationSessions.attemptNumber,
      verifyAttemptNumber: verificationSessions.verifyAttemptNumber,
      consumedAt: verificationSessions.consumedAt,
    })
    .from(verificationSessions)
    .where(eq(verificationSessions.userId, userId));
  const codes =
    sessions.length > 0
      ? await db
          .select({ id: verificationCodes.id })
          .from(verificationCodes)
          .where(eq(verificationCodes.sessionId, sessions[0]?.id ?? ''))
      : [];
  return { sessions, codes };
}

beforeAll(async () => {
  await resetTables();
});

describe('one correct code presented by six requests at once', () => {
  test('is consumed exactly once, and the losers are neither accepted nor charged', async () => {
    const user = await seedUser();
    const code = '135790';
    await seedOtpProof({
      userId: user.userId,
      identifier: user.email,
      purpose: 'passwordless_login',
      code,
    });

    const verify = () =>
      processOtpVerify({
        userId: user.userId,
        channel: 'email',
        purpose: 'passwordless_login',
        identifier: user.email,
        code,
      });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, () => verify())
    );

    expect(fulfilled(outcomes)).toHaveLength(1);

    // The row is held FOR UPDATE, so every loser runs after the winner deleted
    // the code and sees "nothing to verify against" — the expired-code answer,
    // which charges no attempt. Anything else here means two requests compared
    // the same code.
    const losers = rejected(outcomes);
    expect(losers).toHaveLength(5);
    for (const loser of losers) {
      expect(loser).toBeInstanceOf(CustomError);
      expect((loser as CustomError).status).toBe(HTTP_STATUS.BAD_REQUEST);
    }

    const { sessions, codes } = await proofRows(user.userId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.consumedAt).not.toBeNull();
    expect(sessions[0]?.verifyAttemptNumber).toBe(0);
    expect(codes).toHaveLength(0);
  });
});

describe('two first sends for one identifier at once', () => {
  test('serialise on the advisory lock: one row, one code, one message, one throttle', async () => {
    // A FIRST send: no row exists yet, so `FOR UPDATE` has nothing to lock and
    // only the advisory lock stands between two concurrent INSERTs — without it
    // the second one dies on the unique index as a 500.
    const user = await seedUser({ emailVerified: false });
    const send = () =>
      processOtpSend({
        userId: user.userId,
        identifier: user.email,
        channel: 'email',
        purpose: 'verify_contact',
        sendTo: user.email,
        entityName: 'البريد الإلكتروني',
      });

    const outcomes = await Promise.allSettled([send(), send()]);

    expect(fulfilled(outcomes)).toHaveLength(1);
    const [throttled] = rejected(outcomes);
    expect(throttled).toBeInstanceOf(CustomError);
    // The loser ran second and met the winner's cooldown, which is the only
    // rejection a serialised second send can produce.
    expect((throttled as CustomError).status).toBe(
      HTTP_STATUS.TOO_MANY_REQUESTS
    );

    const { sessions, codes } = await proofRows(user.userId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.attemptNumber).toBe(1);
    expect(codes).toHaveLength(1);

    await settleDelivery();
    expect(sentMail()).toHaveLength(1);
  });
});

describe('parallel wrong passwords', () => {
  test('are each counted exactly once, with no lost update', async () => {
    const user = await seedUser();
    const attempts = 3;
    expect(attempts).toBeLessThan(MAX_FAILED_ATTEMPTS);

    const outcomes = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        verifyLoginAttempt({
          email: user.email,
          password: WRONG_PASSWORD,
          skipTimingGuard: true,
        })
      )
    );

    expect(fulfilled(outcomes)).toHaveLength(0);
    for (const reason of rejected(outcomes))
      expect(reason).toBeInstanceOf(LoginRejected);

    // The counter is read, compared and incremented under the user row's
    // `FOR UPDATE`; a read-then-write without it would lose increments and
    // report fewer failures than were made.
    const [row] = await db
      .select({
        failedLoginAttempts: users.failedLoginAttempts,
        lockedUntil: users.lockedUntil,
      })
      .from(users)
      .where(eq(users.id, user.userId));
    expect(row).toEqual({ failedLoginAttempts: attempts, lockedUntil: null });
  }, 30_000);
});
