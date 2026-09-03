/**
 * A live OTP proof written straight into the tables, hashed by the production
 * helper.
 *
 * Direct SQL rather than a send request: the send path defers delivery and never
 * returns the code it issued, so a test that goes through it cannot present the
 * right one. `hashOtpCode` is the same envelope the real send writes, so the
 * verify path is exercised for real.
 */
import type { OtpChannel, OtpPurpose } from '@/utils/validation/otp';

import { db } from '@/db';
import { verificationCodes, verificationSessions } from '@/db/schema';

import { hashOtpCode } from '@/utils/otp';
import { OTP_EXPIRY_MINUTES } from '@/utils/validation/constants';

import { assertHarnessDatabase } from './database';

export interface SeededOtpProof {
  sessionId: string;
  code: string;
}

export async function seedOtpProof(options: {
  userId: string;
  identifier: string;
  purpose: OtpPurpose;
  code: string;
  channel?: OtpChannel;
}): Promise<SeededOtpProof> {
  await assertHarnessDatabase();

  const [row] = await db
    .insert(verificationSessions)
    .values({
      userId: options.userId,
      channel: options.channel ?? 'email',
      identifier: options.identifier,
      purpose: options.purpose,
      attemptNumber: 1,
    })
    .returning({ id: verificationSessions.id });
  if (!row) throw new Error('seedOtpProof inserted no session');

  await db.insert(verificationCodes).values({
    sessionId: row.id,
    code: hashOtpCode(options.code),
    expiresAt: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000),
  });

  return { sessionId: row.id, code: options.code };
}
