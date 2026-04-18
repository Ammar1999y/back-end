import { and, eq, ne } from 'drizzle-orm';

import { accounts, sessions } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { validID } from '@/utils';
import { auditLog, getAuditMeta } from '@/lib/audit';
import { hashPassword } from '@/lib/auth';
import { checkPasswordCompromise } from '@/lib/auth/check-password';
import { LoginRejected, verifyLoginAttempt } from '@/lib/auth/login-guard';
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

import { userMsg } from '../../messages';

export const POST: Handler = async (ctx) => {
  try {
    const session = await requireSession(ctx);
    const userId = validID(session.user.id);

    if (!session.user.roleId)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    await enforceRateLimit({
      scope: 'users.me.change-password.post',
      identifier: userIdentifier(userId),
      limit: 5,
    });

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

    const hashedPassword = await hashPassword(parsed.data.newPassword);
    const auditMeta = getAuditMeta(ctx);

    await withTransaction(async (tx) => {
      try {
        await verifyLoginAttempt({
          userId,
          password: parsed.data.currentPassword,
          skipTimingGuard: true,
          tx,
        });
      } catch (e) {
        if (e instanceof LoginRejected)
          throw new CustomError(
            userMsg.currentPasswordIncorrect,
            HTTP_STATUS.BAD_REQUEST
          );
        throw e;
      }

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

      const currentSessionId = validID(session.session.id);
      if (currentSessionId) {
        await tx
          .delete(sessions)
          .where(
            and(eq(sessions.userId, userId), ne(sessions.id, currentSessionId))
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
