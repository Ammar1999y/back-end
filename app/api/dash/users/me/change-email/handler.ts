import type { Handler } from '@/lib/http/contract';

import { and, eq, isNull } from 'drizzle-orm';

import { otpMsg } from '@/app/api/auth/otp/messages';
import { db } from '@/db';
import { users } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { getAuditMeta } from '@/lib/audit';
import { LoginRejected, verifyLoginAttempt } from '@/lib/auth/login-guard';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { requireSession } from '@/lib/http/session';
import {
  enforceOtpSendQuota,
  enforceRateLimit,
  userIdentifier,
} from '@/lib/rate-limit';

import {
  HTTP_STATUS,
  MSG_INSUFFICIENT_PERMISSIONS,
  MSG_NOT_FOUND,
  MSG_UPDATE_ERROR,
} from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  requireJsonBody,
  handleUserUniqueViolation,
} from '@/utils/api-response';
import { OTP_AUTO_VERIFY } from '@/utils/config';
import { CustomError } from '@/utils/error-class';
import { processOtpSend } from '@/utils/otp';
import { changeEmailSchema } from '@/utils/validation/auth';
import { EMAIL_OTP_AVAILABLE } from '@/utils/validation/otp';

import { userMsg } from '../../messages';
import { commitEmailChange, refreshSessionCookies } from '../contact-change';

/**
 * Initiate an email change. The new address is NEVER written to `users.email`
 * here — it stays a pending, unverified change until ownership of the new
 * address is proven:
 *  - normal flow: an OTP is sent to the NEW address; the change is committed at
 *    POST /change-email/verify only after the code matches.
 *  - OTP_AUTO_VERIFY: the change is committed immediately (no code), since the
 *    deployment has opted out of real verification.
 * Either way the current password re-auth is required to initiate.
 */
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

    const newEmail = parsed.data.newEmail;
    const auditMeta = getAuditMeta(ctx);

    // Verification must be possible before we accept the request — otherwise we
    // would either send to a dead channel or strand the change forever.
    if (!OTP_AUTO_VERIFY && !EMAIL_OTP_AVAILABLE)
      throw new CustomError(
        userMsg.verificationUnavailable,
        HTTP_STATUS.SERVICE_UNAVAILABLE
      );

    // Re-auth in its own short tx so the later mutation doesn't hold a row lock
    // across argon2.
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

    // A "taken" address is NOT rejected here: revealing it before the user
    // proves ownership of the new address would be an account-enumeration
    // oracle. Uniqueness is enforced authoritatively by the unique index at
    // commit time (→ 409). We only reject same-as-current (reveals nothing).
    const [currentUser] = await db
      .select({
        email: users.email,
        roleId: users.roleId,
        isActive: users.isActive,
      })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);

    if (!currentUser || !currentUser.isActive)
      throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    if (!currentUser.roleId)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );
    if (currentUser.email === newEmail)
      throw new CustomError(
        userMsg.newEmailSameAsCurrent,
        HTTP_STATUS.BAD_REQUEST
      );

    if (OTP_AUTO_VERIFY) {
      // Bypass: commit the change now, no code entry.
      await withTransaction((tx) =>
        commitEmailChange({
          tx,
          userId,
          newEmail,
          keepSessionId: sessionId,
          auditMeta,
        })
      );

      return apiSuccess({
        message: userMsg.emailChanged,
        data: { autoVerified: true },
        cookies: await refreshSessionCookies(ctx.headers),
      });
    }

    // Aggregate per-destination cap (shared with every other send surface) so
    // the same address can't be targeted repeatedly across actors/endpoints.
    await enforceOtpSendQuota({
      channel: 'email',
      destination: newEmail,
      surface: 'contact_change',
    });

    // Normal flow: send the code to the NEW address bound to change_email.
    await processOtpSend({
      userId,
      identifier: newEmail,
      channel: 'email',
      purpose: 'change_email',
      targetIdentifier: newEmail,
      sendTo: newEmail,
      entityName: 'البريد الإلكتروني',
    });

    return apiSuccess({
      message: userMsg.emailChangeCodeSent,
      data: { otpSent: true },
    });
  } catch (error) {
    // Only a KNOWN constraint becomes a 409; an unrecognized one falls
    // through to the 500 path so the schema/code mismatch is visible.
    const conflict = handleUserUniqueViolation(error);
    if (conflict) return conflict;
    return handleApiError(error, MSG_UPDATE_ERROR);
  }
};
