/** Behavior gates for every security decision that consumes timestamptz strings. */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SeededUser, SignedInSession } from '../helpers/session';

import { eq, sql } from 'drizzle-orm';

import { app } from '@/app';
import { parseCursor } from '@/app/api/dash/users/[id]/sessions/pagination';
import { db } from '@/db';
import {
  sessions,
  users,
  verificationCodes,
  verificationSessions,
} from '@/db/schema';
import { MAX_FAILED_ATTEMPTS } from '@/lib/auth/login-guard';
import { generateUuidV7 } from '@/lib/id';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import { hashOtpCode, processOtpSend, processOtpVerify } from '@/utils/otp';

import { resetTables } from '../helpers/database';
import { sentMail } from '../helpers/mailbox';
import {
  authedRequest,
  baseHeaders,
  seedUser,
  signedInUser,
} from '../helpers/session';

const FIVE_MINUTES = 5 * 60 * 1000;
const RIGHT_CODE = '123456';

interface Fixture {
  locked: SeededUser;
  otp: SeededUser;
  cursor: SignedInSession;
}

const state: { fixture: Fixture | null } = { fixture: null };

function fx(): Fixture {
  if (!state.fixture) throw new Error('fixture not seeded');
  return state.fixture;
}

async function rejected(operation: Promise<unknown>): Promise<CustomError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof CustomError) return error;
    throw error;
  }
  throw new Error('expected operation to reject');
}

async function otpState(id: string) {
  const [row] = await db
    .select({
      attemptNumber: verificationSessions.attemptNumber,
      verifyAttemptNumber: verificationSessions.verifyAttemptNumber,
      isBlocked: verificationSessions.isBlocked,
      blockedUntil: verificationSessions.blockedUntil,
      nextAllowedAt: verificationSessions.nextAllowedAt,
    })
    .from(verificationSessions)
    .where(eq(verificationSessions.id, id));
  return row ?? null;
}

beforeAll(async () => {
  await resetTables();
  state.fixture = {
    locked: await seedUser(),
    otp: await seedUser(),
    cursor: await signedInUser(),
  };
});

test('CI executes these gates in an explicit non-UTC timezone', () => {
  if (process.env.REQUIRE_NON_UTC_TZ !== '1') return;

  expect(process.env.TZ).toBe('Asia/Riyadh');
  expect(new Date().getTimezoneOffset()).not.toBe(0);
});

describe('future timestamps remain future outside UTC', () => {
  test('an armed account lock refuses a correct password', async () => {
    const lockedUntil = new Date(Date.now() + FIVE_MINUTES).toISOString();
    await db
      .update(users)
      .set({ failedLoginAttempts: MAX_FAILED_ATTEMPTS, lockedUntil })
      .where(eq(users.id, fx().locked.userId));

    const [before] = await db
      .select({
        failedLoginAttempts: users.failedLoginAttempts,
        lockedUntil: users.lockedUntil,
      })
      .from(users)
      .where(eq(users.id, fx().locked.userId));
    expect(Date.parse(before?.lockedUntil ?? '')).toBeGreaterThan(Date.now());

    const response = await app.handle(
      new Request('http://localhost/api/auth/sign-in/email', {
        method: 'POST',
        headers: baseHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          email: fx().locked.email,
          password: fx().locked.password,
        }),
      })
    );

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    const [after] = await db
      .select({
        failedLoginAttempts: users.failedLoginAttempts,
        lockedUntil: users.lockedUntil,
      })
      .from(users)
      .where(eq(users.id, fx().locked.userId));
    expect(after).toEqual(before);
    expect(
      await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, fx().locked.userId))
    ).toEqual([]);
  });

  test('a blocked verification row refuses send without delivery or mutation', async () => {
    const [session] = await db
      .insert(verificationSessions)
      .values({
        userId: fx().otp.userId,
        channel: 'email',
        identifier: fx().otp.email,
        purpose: 'verify_contact',
        attemptNumber: 1,
        isBlocked: true,
        blockedUntil: new Date(Date.now() + FIVE_MINUTES).toISOString(),
      })
      .returning({ id: verificationSessions.id });
    if (!session) throw new Error('blocked send fixture was not inserted');
    const before = await otpState(session.id);

    const error = await rejected(
      processOtpSend({
        userId: fx().otp.userId,
        identifier: fx().otp.email,
        channel: 'email',
        purpose: 'verify_contact',
        sendTo: fx().otp.email,
        entityName: 'email',
      })
    );

    expect(error.status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
    expect(await otpState(session.id)).toEqual(before);
    expect(sentMail()).toEqual([]);
  });

  test('a blocked verification row refuses a correct code without consuming it', async () => {
    const [session] = await db
      .insert(verificationSessions)
      .values({
        userId: fx().otp.userId,
        channel: 'email',
        identifier: fx().otp.email,
        purpose: 'forgot_password',
        attemptNumber: 1,
        isBlocked: true,
        blockedUntil: new Date(Date.now() + FIVE_MINUTES).toISOString(),
      })
      .returning({ id: verificationSessions.id });
    if (!session) throw new Error('blocked verify fixture was not inserted');
    await db.insert(verificationCodes).values({
      sessionId: session.id,
      code: hashOtpCode(RIGHT_CODE),
      expiresAt: new Date(Date.now() + FIVE_MINUTES * 2).toISOString(),
    });
    const before = await otpState(session.id);

    const error = await rejected(
      processOtpVerify({
        userId: fx().otp.userId,
        channel: 'email',
        purpose: 'forgot_password',
        identifier: fx().otp.email,
        code: RIGHT_CODE,
      })
    );

    expect(error.status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
    expect(await otpState(session.id)).toEqual(before);
    expect(
      await db
        .select({ id: verificationCodes.id })
        .from(verificationCodes)
        .where(eq(verificationCodes.sessionId, session.id))
    ).toHaveLength(1);
  });

  test('a live resend cooldown refuses send without delivery or mutation', async () => {
    const [session] = await db
      .insert(verificationSessions)
      .values({
        userId: fx().otp.userId,
        channel: 'email',
        identifier: fx().otp.email,
        purpose: 'passwordless_login',
        attemptNumber: 1,
        nextAllowedAt: new Date(Date.now() + FIVE_MINUTES).toISOString(),
      })
      .returning({ id: verificationSessions.id });
    if (!session) throw new Error('cooldown fixture was not inserted');
    const before = await otpState(session.id);

    const error = await rejected(
      processOtpSend({
        userId: fx().otp.userId,
        identifier: fx().otp.email,
        channel: 'email',
        purpose: 'passwordless_login',
        sendTo: fx().otp.email,
        entityName: 'email',
      })
    );

    expect(error.status).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
    expect(await otpState(session.id)).toEqual(before);
    expect(sentMail()).toEqual([]);
  });

  test('a session-list cursor preserves the stored instant and advances', async () => {
    const actor = fx().cursor;
    const [current] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, actor.user.userId));
    if (!current) throw new Error('signed-in fixture has no session');

    const currentCreatedAt = new Date(Date.now() - 60_000).toISOString();
    await db
      .update(sessions)
      .set({ createdAt: currentCreatedAt })
      .where(eq(sessions.id, current.id));
    const olderId = generateUuidV7();
    await db.insert(sessions).values({
      id: olderId,
      userId: actor.user.userId,
      token: `timezone-cursor-${olderId}`,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    const first = await app.handle(
      authedRequest(
        actor,
        `/api/dash/users/${actor.user.userId}/sessions?limit=1`
      )
    );
    const firstBody = (await first.json()) as {
      data?: { sessions?: { id: string }[]; nextCursor?: string | null };
    };
    const cursor = firstBody.data?.nextCursor ?? null;
    expect(first.status).toBe(HTTP_STATUS.OK);
    expect(firstBody.data?.sessions?.map((row) => row.id)).toEqual([
      current.id,
    ]);
    expect(cursor).not.toBeNull();

    const parsed = parseCursor(cursor);
    const stored = await db.execute<{ epoch_ms: string }>(sql`
      select extract(epoch from created_at) * 1000 as epoch_ms
      from sessions
      where id = ${current.id}
    `);
    expect(parsed?.id).toBe(current.id);
    expect(parsed?.createdAt.getTime()).toBe(Number(stored[0]?.epoch_ms));

    const second = await app.handle(
      authedRequest(
        actor,
        `/api/dash/users/${actor.user.userId}/sessions?limit=1&cursor=${encodeURIComponent(cursor ?? '')}`
      )
    );
    const secondBody = (await second.json()) as {
      data?: { sessions?: { id: string }[]; nextCursor?: string | null };
    };
    expect(second.status).toBe(HTTP_STATUS.OK);
    expect(secondBody.data?.sessions?.map((row) => row.id)).toEqual([olderId]);
    expect(secondBody.data?.nextCursor).toBeNull();
  });
});
