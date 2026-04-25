import type { Handler, HandlerCookie } from '@/lib/http/contract';

import { and, eq, isNull, ne } from 'drizzle-orm';

import { otpMsg } from '@/app/api/auth/otp/messages';
import { sessions, users, verificationSessions } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { isUniqueViolation, sanitizeForLog } from '@/utils';
import { auditLog, getAuditMeta } from '@/lib/audit';
import { auth } from '@/lib/auth';
import { LoginRejected, verifyLoginAttempt } from '@/lib/auth/login-guard';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { parseSetCookieHeaders } from '@/lib/http/contract';
import { requireSession } from '@/lib/http/session';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import {
  HTTP_STATUS,
  MSG_INSUFFICIENT_PERMISSIONS,
  MSG_NOT_FOUND,
  MSG_UPDATE_ERROR,
} from '@/utils/api-messages';
import {
  apiSuccess,
  getErrorHeaders,
  handleApiError,
  requireJsonBody,
  resolveUserUniqueViolation,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { changeEmailSchema } from '@/utils/validation/auth';

import { userMsg } from '../../messages';

export const POST: Handler = async (ctx) => {
  try {
    const { userId, sessionId } = await requireSession(ctx);

    await enforceRateLimit({
      scope: 'users.me.change-email.post',
      identifier: userIdentifier(userId),
      limit: 5,
      failClosed: true,
    });

    const captchaOk = await verifyTurnstileRequest(ctx.headers);
    if (!captchaOk)
      throw new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN);

    const body = requireJsonBody(ctx.body);
    const parsed = changeEmailSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        parsed.error.issues[0].message,
        HTTP_STATUS.UNPROCESSABLE
      );

    const auditMeta = getAuditMeta(ctx);

    // Run the password check in its own short tx so the outer mutation
    // doesn't hold FOR UPDATE across argon2.
    // TODO: test moving verifyLoginAttempt INSIDE the
    // mutation tx below (under the same FOR UPDATE on users) so two
    // concurrent self-credential submissions can't both pass verify and
    // race to write. Measure the latency impact of holding the user row
    // lock across argon2 (~100-500ms) before committing to this.
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

    await withTransaction(async (tx) => {
      // Fresh DB read under FOR UPDATE — the cookie-cached session can be up
      // to 5 minutes stale. A freshly-deactivated or demoted admin must be
      // blocked from rotating their email during the staleness window.
      const [currentUser] = await tx
        .select({
          id: users.id,
          email: users.email,
          roleId: users.roleId,
        })
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

      if (!currentUser.roleId)
        throw new CustomError(
          MSG_INSUFFICIENT_PERMISSIONS,
          HTTP_STATUS.FORBIDDEN
        );

      if (currentUser.email === parsed.data.newEmail)
        throw new CustomError(
          userMsg.newEmailSameAsCurrent,
          HTTP_STATUS.BAD_REQUEST
        );

      // The partial unique index on email enforces uniqueness — any collision
      // surfaces as a unique-violation caught below and mapped to CONFLICT.
      await tx
        .update(users)
        .set({ email: parsed.data.newEmail })
        .where(eq(users.id, userId));

      if (sessionId) {
        await tx
          .delete(sessions)
          .where(and(eq(sessions.userId, userId), ne(sessions.id, sessionId)));
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

    // Refresh cookie cache outside the try/catch that reports update failure —
    // the DB change already committed. Pipe the refreshed Set-Cookie values
    // into HandlerOutput.cookies so the framework adapter writes them; the
    // Next adapter's implicit cookie mutation is not portable to other adapters.
    let refreshedCookies: HandlerCookie[] = [];
    try {
      const refreshed = await auth.api.getSession({
        headers: ctx.headers,
        query: { disableCookieCache: true },
        returnHeaders: true,
      });
      refreshedCookies = parseSetCookieHeaders(
        refreshed.headers.getSetCookie()
      );
    } catch (e) {
      console.error('cookie cache refresh failed:', sanitizeForLog(e));
    }

    return apiSuccess({
      message: userMsg.emailChanged,
      cookies: refreshedCookies.length ? refreshedCookies : undefined,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return handleApiError(
        new CustomError(
          resolveUserUniqueViolation(error),
          HTTP_STATUS.CONFLICT
        ),
        undefined,
        getErrorHeaders(error)
      );
    }
    return handleApiError(error, MSG_UPDATE_ERROR);
  }
};
