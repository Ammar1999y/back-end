import { headers } from 'next/headers';
import { and, eq, isNull, ne } from 'drizzle-orm';

import { sessions, users, verificationSessions } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { isUniqueViolation, validID } from '@/utils';
import { auditLog } from '@/lib/audit';
import { auth } from '@/lib/auth';
import { LoginRejected, verifyLoginAttempt } from '@/lib/auth/login-guard';

import {
  HTTP_STATUS,
  MSG_EMAIL_EXISTS,
  MSG_INSUFFICIENT_PERMISSIONS,
  MSG_LOGIN_REQUIRED,
  MSG_NOT_FOUND,
  MSG_UPDATE_ERROR,
} from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  parseJsonBody,
  resolveUserUniqueViolation,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { changeEmailSchema } from '@/utils/validation/auth';

import { userMsg } from '../../messages';

export async function POST(request: Request) {
  try {
    const reqHeaders = await headers();
    const session = await auth.api.getSession({ headers: reqHeaders });

    const userId = validID(session?.user.id);
    if (!userId)
      throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);

    if (!session?.user.roleId)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    const body = await parseJsonBody(request);
    const parsed = changeEmailSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        parsed.error.issues[0].message,
        HTTP_STATUS.UNPROCESSABLE
      );

    await withTransaction(async (tx) => {
      // Brute-force protection inside the transaction — eliminates TOCTOU race
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

      // Lock user row and get current email
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

      // Check new email is not already in use (EXISTS for efficiency)
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

      // Invalidate all other sessions
      const currentSessionId = validID(session.session.id);
      if (currentSessionId) {
        await tx
          .delete(sessions)
          .where(
            and(eq(sessions.userId, userId), ne(sessions.id, currentSessionId))
          );
      }

      // Invalidate pending OTP sessions (email changed — old OTPs no longer valid)
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
        request,
      });
    });

    // TODO: Force cookie cache refresh so the current session reflects the new email immediately
    await auth.api.getSession({
      headers: await headers(),
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
}
