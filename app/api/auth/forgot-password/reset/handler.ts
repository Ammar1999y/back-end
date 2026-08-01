import type { Handler } from '@/lib/http/contract';

import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/db';
import {
  accounts,
  sessions,
  users,
  verificationSessions,
} from '@/db/schema';
import { auditLog, getAuditMeta } from '@/lib/audit';
import { checkPasswordCompromise } from '@/lib/auth/check-password';
import { hashPassword } from '@/lib/auth/password';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { enforceRateLimit, ipIdentifier, otpVerifyScope } from '@/lib/rate-limit';

import {
  CREDENTIAL_PROVIDER_ID,
  HTTP_STATUS,
  MSG_PAGE_NOT_FOUND,
} from '@/utils/api-messages';
import { apiSuccess, handleApiError, requireJsonBody } from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { processOtpVerify } from '@/utils/otp';
import { OTP_ENABLED, resetPasswordSchema } from '@/utils/validation/otp';

import { ensureMinDelay, otpMsg } from '../../otp/messages';

/**
 * Forgot-password step 2: verify the code (purpose=forgot_password) and, in the
 * same transaction, set the new password and revoke ALL of the user's sessions.
 * Always uses a real code (no OTP_AUTO_VERIFY bypass for recovery). Failures
 * collapse to a single generic error so the endpoint can't enumerate accounts.
 */
export const POST: Handler = async (ctx) => {
  const start = Date.now();
  try {
    if (!OTP_ENABLED)
      throw new CustomError(MSG_PAGE_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    // Per-IP cap BEFORE captcha so the outbound siteverify call is bounded per
    // IP; the IP-level 429 is pre-lookup and leaks nothing about existence.
    await enforceRateLimit({
      scope: 'forgot.reset.ip',
      identifier: ipIdentifier(ctx.headers),
      limit: 60,
      window: 60,
      failClosed: true,
    });

    const captchaOk = await verifyTurnstileRequest(ctx.headers);
    if (!captchaOk)
      return handleApiError(
        new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN)
      );

    const body = requireJsonBody(ctx.body);
    const parsed = resetPasswordSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(otpMsg.invalidInput, HTTP_STATUS.UNPROCESSABLE);

    const { channel, code, newPassword } = parsed.data;
    const identifier =
      channel === 'email' ? parsed.data.email : parsed.data.phoneNumber;

    await enforceRateLimit({
      scope: otpVerifyScope(channel),
      identifier: identifier.toLowerCase(),
      limit: 10,
      window: 600,
      failClosed: true,
    });

    // Breach screen + hash BEFORE the transaction (account-independent, so it
    // leaks nothing about whether the identifier exists) and so we never hold a
    // row lock across Argon2id. The compromised-password error is surfaced as-is
    // (not privacy-collapsed) — it reveals nothing about the account.
    try {
      await checkPasswordCompromise(newPassword);
    } catch (e) {
      if (e instanceof CustomError) return handleApiError(e);
      throw e;
    }
    const hashedPassword = await hashPassword(newPassword);

    const [userData] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(
        and(
          channel === 'email'
            ? eq(users.email, identifier)
            : eq(users.phoneNumber, identifier),
          isNull(users.deletedAt),
          eq(users.isActive, true)
        )
      )
      .limit(1);

    if (!userData)
      throw new CustomError(otpMsg.invalidOrExpired, HTTP_STATUS.BAD_REQUEST);

    const auditMeta = getAuditMeta(ctx);

    await processOtpVerify({
      userId: userData.id,
      userEmail: userData.email,
      channel,
      purpose: 'forgot_password',
      identifier,
      code,
      auditMeta,
      onVerified: async (tx) => {
        const [account] = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(
            and(
              eq(accounts.userId, userData.id),
              eq(accounts.providerId, CREDENTIAL_PROVIDER_ID)
            )
          )
          .for('update');

        if (!account)
          throw new CustomError(
            otpMsg.invalidOrExpired,
            HTTP_STATUS.BAD_REQUEST
          );

        await tx
          .update(accounts)
          .set({ password: hashedPassword })
          .where(eq(accounts.id, account.id));

        // Credential rotation — revoke every auth session and drop any pending
        // verification sessions (stale change_* proofs / consumed rows).
        await tx.delete(sessions).where(eq(sessions.userId, userData.id));
        await tx
          .delete(verificationSessions)
          .where(eq(verificationSessions.userId, userData.id));

        await auditLog(tx, {
          userId: userData.id,
          userEmail: userData.email,
          action: 'UPDATE',
          tableName: 'accounts',
          recordId: account.id,
          oldData: {},
          newData: { passwordReset: true },
          meta: auditMeta,
        });
      },
    });

    await ensureMinDelay(Date.now() - start);
    return apiSuccess({
      message: otpMsg.passwordResetSuccess,
      data: { reset: true },
    });
  } catch (error) {
    await ensureMinDelay(Date.now() - start);
    // Collapse privacy-sensitive statuses; keep 429/503/500/422 distinct (and
    // password-compromised surfaces its own message).
    if (
      error instanceof CustomError &&
      error.status !== HTTP_STATUS.TOO_MANY_REQUESTS &&
      error.status !== HTTP_STATUS.SERVICE_UNAVAILABLE &&
      error.status !== HTTP_STATUS.INTERNAL_ERROR &&
      error.status !== HTTP_STATUS.UNPROCESSABLE
    ) {
      const generic = new CustomError(
        otpMsg.invalidOrExpired,
        HTTP_STATUS.BAD_REQUEST
      );
      generic.responseHeaders = error.responseHeaders;
      return handleApiError(generic);
    }
    return handleApiError(error, otpMsg.passwordResetError);
  }
};
