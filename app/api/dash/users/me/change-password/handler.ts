import { and, eq, isNull, ne } from 'drizzle-orm';

import { accounts, sessions, users } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { auditLog, getAuditMeta } from '@/lib/audit';
import { hashPassword } from '@/lib/auth';
import { checkPasswordCompromise } from '@/lib/auth/check-password';
import { LoginRejected, verifyLoginAttempt } from '@/lib/auth/login-guard';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { requireSession } from '@/lib/http/session';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import type { Handler } from '@/lib/http/contract';

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

import { otpMsg } from '@/app/api/auth/otp/messages';
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

    const body = requireJsonBody(ctx.body);
    const parsed = changePasswordSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        parsed.error.issues[0].message,
        HTTP_STATUS.UNPROCESSABLE
      );

    if (parsed.data.currentPassword === parsed.data.newPassword)
      throw new CustomError(
        userMsg.newPasswordSameAsCurrent,
        HTTP_STATUS.BAD_REQUEST
      );

    await checkPasswordCompromise(parsed.data.newPassword);

    const auditMeta = getAuditMeta(ctx);

    // Run the password check in its own short tx so the outer mutation
    // doesn't hold FOR UPDATE across argon2.
    // TODO: test moving verifyLoginAttempt INSIDE the
    // mutation tx below (under the same FOR UPDATE on accounts) so two
    // concurrent self-credential submissions can't both pass verify and
    // race to write. Measure the latency impact of holding the account
    // row lock across argon2 (~100-500ms) before committing to this.
    try {
      await verifyLoginAttempt({
        userId,
        password: parsed.data.currentPassword,
        skipTimingGuard: true,
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
            eq(accounts.userId, userId),
            eq(accounts.providerId, CREDENTIAL_PROVIDER_ID)
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

      if (sessionId) {
        await tx
          .delete(sessions)
          .where(
            and(eq(sessions.userId, userId), ne(sessions.id, sessionId))
          );
      }

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
