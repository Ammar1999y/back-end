import type { RecoveryVerdict } from '@/lib/auth/recovery-second-factor';
import type { Handler } from '@/lib/http/contract';
import type { OtpChannel } from '@/utils/validation/otp';

import { and, eq, isNull } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { accounts, users } from '@/db/schema';
import { auditLog, getAuditMeta } from '@/lib/audit';
import { checkPasswordCompromise } from '@/lib/auth/check-password';
import { hashPassword } from '@/lib/auth/password';
import {
  consumeRecoveryGrant,
  readRecoveryGrant,
  spendRecoveryAttempt,
} from '@/lib/auth/recovery-grant';
import {
  consumeRecoveryBackupCode,
  verifyRecoveryTotp,
} from '@/lib/auth/recovery-second-factor';
import { revokeOtherSessions, revokePendingProofs } from '@/lib/auth/rotation';
import {
  readEnrollmentState,
  recoveryOptions,
} from '@/lib/auth/two-factor-challenge';
import { enforceRateLimit, ipIdentifier } from '@/lib/rate-limit';

import {
  CREDENTIAL_PROVIDER_ID,
  HTTP_STATUS,
  MSG_PAGE_NOT_FOUND,
} from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  requireJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { otpGuessWasEvaluated, processOtpVerify } from '@/utils/otp';
import { OTP_ENABLED, recoveryCompleteSchema } from '@/utils/validation/otp';

import { ensureMinDelay, otpMsg, twoFactorMsg } from '../../otp/messages';

/**
 * Forgot-password step 3, and the half that makes the reset a two-possession
 * operation.
 *
 * ⚠️ The grant is NOT sufficient alone. Holding it proves the recovery contact
 * and nothing else; this endpoint writes the password only after a factor from
 * the grant's own issued set — excluding the contact that recovery code arrived
 * on — has been proven in this request. Both the proof and the write happen
 * against the SAME grant, which is consumed in the write's transaction, so a
 * grant cannot be spent twice.
 */
export const POST: Handler = async (ctx) => {
  const start = Date.now();
  try {
    if (!OTP_ENABLED)
      throw new CustomError(MSG_PAGE_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    await enforceRateLimit({
      scope: 'forgot.complete.ip',
      identifier: ipIdentifier(ctx.headers),
      limit: 30,
      window: 60,
      failClosed: true,
    });

    const body = requireJsonBody(await ctx.readJson());
    const parsed = recoveryCompleteSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(otpMsg.invalidInput, HTTP_STATUS.UNPROCESSABLE);
    const {
      grant: grantToken,
      option: requested,
      code: suppliedCode,
      newPassword,
    } = parsed.data;

    const grant = await readRecoveryGrant(grantToken);
    if (!grant)
      throw new CustomError(otpMsg.invalidOrExpired, HTTP_STATUS.BAD_REQUEST);

    // The issued set intersected with CURRENT capability. Narrowing only: a
    // method enrolled since the grant was minted is not something the holder was
    // challenged on, and one removed since is no longer a factor at all.
    const state = await readEnrollmentState(grant.userId);
    const issued = new Set(grant.options);
    const option = recoveryOptions(state, grant.excludeContactKind).find(
      (entry) => issued.has(entry.id) && entry.id === requested
    );
    if (!option)
      throw new CustomError(otpMsg.invalidOrExpired, HTTP_STATUS.BAD_REQUEST);

    // Screened and hashed before the attempt is spent: neither depends on the
    // account, so a rejection here costs the user nothing.
    await checkPasswordCompromise(newPassword);
    const hashedPassword = await hashPassword(newPassword);

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        phoneNumber: users.phoneNumber,
      })
      .from(users)
      .where(
        and(
          eq(users.id, grant.userId),
          eq(users.isActive, true),
          isNull(users.deletedAt)
        )
      )
      .limit(1);
    if (!user)
      throw new CustomError(otpMsg.invalidOrExpired, HTTP_STATUS.BAD_REQUEST);

    const attempt = await spendRecoveryAttempt(grantToken);
    if (!attempt.ok)
      throw new CustomError(
        twoFactorMsg.tooManyAttempts,
        HTTP_STATUS.BAD_REQUEST
      );

    const auditMeta = getAuditMeta(ctx);
    let verdict: RecoveryVerdict = 'unavailable';
    try {
      if (option.method === 'totp')
        verdict = await verifyRecoveryTotp(user.id, suppliedCode);
      else if (option.method === 'backup_code')
        verdict = await consumeRecoveryBackupCode(user.id, suppliedCode);
      else if (option.method === 'otp' && option.channel) {
        const destination =
          option.contactKind === 'email' ? user.email : user.phoneNumber;
        if (!destination)
          throw new CustomError(
            otpMsg.invalidOrExpired,
            HTTP_STATUS.BAD_REQUEST
          );
        await processOtpVerify({
          userId: user.id,
          userEmail: user.email,
          channel: option.channel as OtpChannel,
          purpose: 'two_factor',
          identifier: destination,
          code: suppliedCode,
          auditMeta,
        });
        verdict = 'matched';
      }
    } catch (caught) {
      // The same rule the sign-in challenge follows: only a code that was
      // COMPARED and lost is a guess. A missing OTP proof row or a fault before
      // the comparison produced no verdict and is refunded.
      await (otpGuessWasEvaluated(caught)
        ? attempt.recordFailure()
        : attempt.restore());
      throw caught;
    }

    if (verdict !== 'matched') {
      // The TOTP and backup-code checks report the same distinction as a
      // verdict: `rejected` was compared, `unavailable` never got that far.
      await (verdict === 'rejected'
        ? attempt.recordFailure()
        : attempt.restore());
      throw new CustomError(twoFactorMsg.invalidCode, HTTP_STATUS.BAD_REQUEST);
    }

    // One transaction: the grant is spent, the password is written, and every
    // session, pending proof and trusted device goes with it. Recovery revokes
    // device trust — the person doing this may not be the account's owner.
    const written = await withTransaction(async (tx) => {
      // The user row first, then the grant rows: every other writer that
      // touches this user's `verifications` rows already holds the user lock.
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, user.id))
        .for('update');

      if (!(await consumeRecoveryGrant(tx, grantToken, user.id))) return false;

      const [account] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.userId, user.id),
            eq(accounts.providerId, CREDENTIAL_PROVIDER_ID)
          )
        )
        .for('update');
      if (!account) return false;

      await tx
        .update(accounts)
        .set({ password: hashedPassword })
        .where(eq(accounts.id, account.id));

      await revokeOtherSessions(tx, user.id);
      await revokePendingProofs(tx, user.id);

      await auditLog(tx, {
        userId: user.id,
        userEmail: user.email,
        action: 'UPDATE',
        tableName: 'accounts',
        recordId: account.id,
        oldData: {},
        newData: {
          passwordReset: true,
          recoverySecondFactor: option.id,
          recoveryExcludedContact: grant.excludeContactKind,
        },
        meta: auditMeta,
      });
      return true;
    });

    if (!written)
      throw new CustomError(otpMsg.invalidOrExpired, HTTP_STATUS.BAD_REQUEST);

    await ensureMinDelay(Date.now() - start);
    return apiSuccess({
      message: otpMsg.passwordResetSuccess,
      data: { reset: true },
    });
  } catch (error) {
    await ensureMinDelay(Date.now() - start);
    return handleApiError(error, otpMsg.passwordResetError);
  }
};
