import { headers } from 'next/headers';
import { and, eq, ne } from 'drizzle-orm';

import { accounts, sessions } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { validID } from '@/utils';
import { auditLog } from '@/lib/audit';
import { auth, hashPassword } from '@/lib/auth';
import { checkPasswordCompromise } from '@/lib/auth/check-password';
import { LoginRejected, verifyLoginAttempt } from '@/lib/auth/login-guard';

import {
  CREDENTIAL_PROVIDER_ID,
  HTTP_STATUS,
  MSG_INSUFFICIENT_PERMISSIONS,
  MSG_LOGIN_REQUIRED,
  MSG_UPDATE_ERROR,
} from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  parseJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { changePasswordSchema } from '@/utils/validation/auth';

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
    const parsed = changePasswordSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        parsed.error.issues[0].message,
        HTTP_STATUS.UNPROCESSABLE
      );

    // Reject same-password upfront (O(1) string comparison)
    if (parsed.data.currentPassword === parsed.data.newPassword)
      throw new CustomError(
        userMsg.newPasswordSameAsCurrent,
        HTTP_STATUS.BAD_REQUEST
      );

    // HIBP check before hashing (mirrors the haveIBeenPwned plugin on built-in endpoints)
    await checkPasswordCompromise(parsed.data.newPassword);

    // Hash new password OUTSIDE the transaction (~300ms, no pool cost)
    const hashedPassword = await hashPassword(parsed.data.newPassword);

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

      // Invalidate all other sessions
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
        request,
      });
    });

    return apiSuccess({ message: userMsg.passwordChanged });
  } catch (error) {
    return handleApiError(error, MSG_UPDATE_ERROR);
  }
}
