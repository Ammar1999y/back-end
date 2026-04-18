import { and, eq, isNull, ne } from 'drizzle-orm';

import { sessions, users, verificationSessions } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { isUniqueViolation, validID } from '@/utils';
import { auditLog, getAuditMeta } from '@/lib/audit';
import { auth } from '@/lib/auth';
import { LoginRejected, verifyLoginAttempt } from '@/lib/auth/login-guard';
import { requireSession } from '@/lib/http/session';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import type { Handler } from '@/lib/http/contract';

import {
  HTTP_STATUS,
  MSG_EMAIL_EXISTS,
  MSG_INSUFFICIENT_PERMISSIONS,
  MSG_NOT_FOUND,
  MSG_UPDATE_ERROR,
} from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  requireJsonBody,
  resolveUserUniqueViolation,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { changeEmailSchema } from '@/utils/validation/auth';

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
      scope: 'users.me.change-email.post',
      identifier: userIdentifier(userId),
      limit: 5,
    });

    const body = requireJsonBody(ctx.body);
    const parsed = changeEmailSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        parsed.error.issues[0].message,
        HTTP_STATUS.UNPROCESSABLE
      );

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

      const [currentUser] = await tx
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(
          and(
            eq(users.id, userId),
            isNull(users.deletedAt),
            eq(users.isActive, true)
          )
        )
        .for('update');

      if (!currentUser)
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

      if (currentUser.email === parsed.data.newEmail)
        throw new CustomError(
          userMsg.newEmailSameAsCurrent,
          HTTP_STATUS.BAD_REQUEST
        );

      const [emailExists] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.email, parsed.data.newEmail),
            isNull(users.deletedAt),
            ne(users.id, userId)
          )
        )
        .limit(1);

      if (emailExists)
        throw new CustomError(MSG_EMAIL_EXISTS, HTTP_STATUS.CONFLICT);

      await tx
        .update(users)
        .set({ email: parsed.data.newEmail })
        .where(eq(users.id, userId));

      const currentSessionId = validID(session.session.id);
      if (currentSessionId) {
        await tx
          .delete(sessions)
          .where(
            and(eq(sessions.userId, userId), ne(sessions.id, currentSessionId))
          );
      }

      await tx
        .delete(verificationSessions)
        .where(eq(verificationSessions.userId, userId));

      await auditLog(tx, {
        userId,
        userEmail: currentUser.email,
        action: 'UPDATE',
        tableName: 'users',
        recordId: userId,
        oldData: { email: currentUser.email },
        newData: { email: parsed.data.newEmail },
        meta: auditMeta,
      });
    });

    // Force cookie cache refresh so the current session reflects the new email immediately
    await auth.api.getSession({
      headers: ctx.headers,
      query: { disableCookieCache: true },
    });

    return apiSuccess({ message: userMsg.emailChanged });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return handleApiError(
        new CustomError(resolveUserUniqueViolation(error), HTTP_STATUS.CONFLICT)
      );
    }
    return handleApiError(error, MSG_UPDATE_ERROR);
  }
};
