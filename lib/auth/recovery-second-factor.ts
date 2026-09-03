/**
 * Proving a second factor during password recovery, where there is neither a
 * session nor a sign-in challenge to hang it off.
 *
 * The set this can be asked for is decided by `recoveryOptions` in
 * `two-factor-challenge.ts`; this module only checks what it is handed.
 *
 * Each check answers with a VERDICT rather than a boolean, because the caller
 * holds an attempt budget that is spent on guesses only: `rejected` is a code
 * that was compared and lost, `unavailable` is a check that never reached a
 * comparison — no credential, a decrypt failure, an unacknowledged set, a spend
 * lost to a concurrent request — and is refunded.
 */
import type { EntityID } from '@/types';

import { and, eq } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { twoFactorCredentials } from '@/db/schema';
import { createOTP } from '@better-auth/utils/otp';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';

import { auth } from '../auth';

export type RecoveryVerdict = 'matched' | 'rejected' | 'unavailable';

/**
 * The key the two-factor material is stored under.
 *
 * Read from Better Auth's own resolved context rather than from the environment:
 * `secretConfig` is what the plugin encrypts with, and a second derivation here
 * would silently stop matching the day a deployment configures `BETTER_AUTH_SECRETS`.
 */
async function secretKey() {
  const context = await auth.$context;
  return context.secretConfig;
}

/** A TOTP code, with the one-period tolerance every other verifier here allows. */
export async function verifyRecoveryTotp(
  userId: EntityID,
  code: string
): Promise<RecoveryVerdict> {
  const [credential] = await db
    .select({
      secret: twoFactorCredentials.secret,
      verified: twoFactorCredentials.verified,
    })
    .from(twoFactorCredentials)
    .where(eq(twoFactorCredentials.userId, userId))
    .limit(1);
  if (!credential?.verified) return 'unavailable';

  const secret = await symmetricDecrypt({
    key: await secretKey(),
    data: credential.secret,
  }).catch(() => null);
  if (!secret) return 'unavailable';
  return (await createOTP(secret).verify(code, { window: 1 }))
    ? 'matched'
    : 'rejected';
}

/**
 * Spends one backup code.
 *
 * ⚠️ The rewrite is guarded on the blob it READ. That is what makes consumption
 * single-use under concurrency — two requests holding the same code cannot both
 * spend it — and it is the protocol the plugin's own verifier uses on the same
 * column, so the two cannot disagree about what "spent" means.
 */
export async function consumeRecoveryBackupCode(
  userId: EntityID,
  code: string
): Promise<RecoveryVerdict> {
  const key = await secretKey();
  const [credential] = await db
    .select({
      id: twoFactorCredentials.id,
      backupCodes: twoFactorCredentials.backupCodes,
      acknowledgedVersion: twoFactorCredentials.backupCodesAcknowledgedVersion,
      version: twoFactorCredentials.backupCodesVersion,
    })
    .from(twoFactorCredentials)
    .where(eq(twoFactorCredentials.userId, userId))
    .limit(1);
  if (!credential || credential.acknowledgedVersion !== credential.version)
    return 'unavailable';

  const decrypted = await symmetricDecrypt({
    key,
    data: credential.backupCodes,
  }).catch(() => null);
  if (!decrypted) return 'unavailable';

  let codes: unknown;
  try {
    codes = JSON.parse(decrypted);
  } catch {
    return 'unavailable';
  }
  if (
    !Array.isArray(codes) ||
    !codes.every((entry) => typeof entry === 'string')
  )
    return 'unavailable';
  if (!codes.includes(code)) return 'rejected';

  const remaining = codes.filter((entry) => entry !== code);
  const reEncrypted = await symmetricEncrypt({
    key,
    data: JSON.stringify(remaining),
  });

  return withTransaction(async (tx) => {
    const [updated] = await tx
      .update(twoFactorCredentials)
      .set({
        backupCodes: reEncrypted,
        backupCodesRemaining: remaining.length,
      })
      .where(
        and(
          eq(twoFactorCredentials.id, credential.id),
          eq(twoFactorCredentials.backupCodes, credential.backupCodes)
        )
      )
      .returning({ id: twoFactorCredentials.id });
    // A lost swap means another request rewrote the set first. The code matched
    // what this request read, so it is not a guess — and it may already be spent.
    return updated ? 'matched' : 'unavailable';
  });
}
