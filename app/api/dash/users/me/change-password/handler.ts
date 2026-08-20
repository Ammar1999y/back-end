import type { VerifiedPasswordProof } from '@/lib/auth/login-guard';
import type { Handler } from '@/lib/http/contract';

import { and, eq, isNull } from 'drizzle-orm';

import { otpMsg } from '@/app/api/auth/otp/messages';
import { accounts, users } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { auditLog, getAuditMeta } from '@/lib/audit';
import { checkPasswordCompromise } from '@/lib/auth/check-password';
import { LoginRejected, verifyLoginAttempt } from '@/lib/auth/login-guard';
import { hashPassword } from '@/lib/auth/password';
import { revokeOtherSessions, revokePendingProofs } from '@/lib/auth/rotation';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { requireSession } from '@/lib/http/session';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import {
  CREDENTIAL_PROVIDER_ID,
  HTTP_STATUS,
  MSG_INSUFFICIENT_PERMISSIONS,
  MSG_UPDATE_ERROR,
} from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  requireJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { changePasswordSchema } from '@/utils/validation/auth';
import { zodIssueMessage } from '@/utils/validation/rules';

import { userMsg } from '../../messages';

export const POST: Handler = async (ctx) => {
  try {
    const { session, userId, sessionId } = await requireSession(ctx);

    await enforceRateLimit({
      scope: 'users.me.change-password.post',
      identifier: userIdentifier(userId),
      limit: 5,
      failClosed: true,
    });

    const captchaOk = await verifyTurnstileRequest(ctx.headers);
    if (!captchaOk)
      throw new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN);

    const body = requireJsonBody(await ctx.readJson());
    const parsed = changePasswordSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        zodIssueMessage(parsed.error),
        HTTP_STATUS.UNPROCESSABLE
      );

    if (parsed.data.currentPassword === parsed.data.newPassword)
      throw new CustomError(
        userMsg.newPasswordSameAsCurrent,
        HTTP_STATUS.BAD_REQUEST
      );

    await checkPasswordCompromise(parsed.data.newPassword);

    const auditMeta = getAuditMeta(ctx);

    // Keep Argon2 outside the mutation transaction. The returned proof is
    // consumed with a compare-and-swap condition under the account row lock.
    let passwordProof: VerifiedPasswordProof;
    try {
      passwordProof = await verifyLoginAttempt({
        userId,
        password: parsed.data.currentPassword,
        skipTimingGuard: true,
        returnPasswordProof: true,
        auditMeta,
      });
    } catch (e) {
      if (e instanceof LoginRejected)
        throw new CustomError(
          userMsg.currentPasswordIncorrect,
          HTTP_STATUS.BAD_REQUEST
        );
      throw e;
    }

    const hashedPassword = await hashPassword(parsed.data.newPassword);

    await withTransaction(async (tx) => {
      // Fresh DB read under FOR SHARE, inside the same tx as the mutation,
      // so a concurrent admin deactivation/demotion is visible and blocks
      // the password rotation. The cookie-cached session can be up to 5
      // minutes stale — checking outside the tx leaves a TOCTOU window.
      const [freshUser] = await tx
        .select({ roleId: users.roleId, isActive: users.isActive })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .for('share');

      if (!freshUser || !freshUser.isActive || !freshUser.roleId)
        throw new CustomError(
          MSG_INSUFFICIENT_PERMISSIONS,
          HTTP_STATUS.FORBIDDEN
        );

      const [account] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.id, passwordProof.accountId),
            eq(accounts.userId, userId),
            eq(accounts.providerId, CREDENTIAL_PROVIDER_ID),
            eq(accounts.password, passwordProof.expectedHash)
          )
        )
        .for('update');

      if (!account)
        throw new CustomError(
          userMsg.passwordUpdateFailed,
          HTTP_STATUS.BAD_REQUEST
        );

      await tx
        .update(accounts)
        .set({ password: hashedPassword })
        .where(eq(accounts.id, account.id));

      if (sessionId) await revokeOtherSessions(tx, userId, sessionId);

      // Revoking sessions alone is not enough: an unconsumed forgot-password
      // or passwordless proof issued before this change would still reset the
      // NEW password. Rotation invalidates every pending proof.
      await revokePendingProofs(tx, userId);

      await auditLog(tx, {
        userId,
        userEmail: session.user.email,
        action: 'UPDATE',
        tableName: 'accounts',
        recordId: account.id,
        oldData: {},
        newData: { passwordChanged: true },
        meta: auditMeta,
      });
    });

    return apiSuccess({ message: userMsg.passwordChanged });
  } catch (error) {
    return handleApiError(error, MSG_UPDATE_ERROR);
  }
};
