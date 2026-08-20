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
  MSG_PAGE_NOT_FOUND,
  MSG_UPDATE_ERROR,
} from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  handleUserUniqueViolation,
  requireJsonBody,
} from '@/utils/api-response';
import { OTP_AUTO_VERIFY, PHONE_ENABLED } from '@/utils/config';
import { CustomError } from '@/utils/error-class';
import { processOtpSend } from '@/utils/otp';
import { changePhoneSchema } from '@/utils/validation/auth';
import { isChannelEnabled } from '@/utils/validation/otp';
import { zodIssueMessage } from '@/utils/validation/rules';

import { userMsg } from '../../messages';
import { commitPhoneChange } from '../contact-change';

/**
 * Initiate a phone-number change. Like email, the new
 * number is never written until ownership is proven via OTP — or committed
 * immediately under OTP_AUTO_VERIFY. The endpoint 404s entirely when phone is
 * disabled by PHONE_NUMBER_MODE.
 */
export const POST: Handler = async (ctx) => {
  try {
    if (!PHONE_ENABLED)
      throw new CustomError(MSG_PAGE_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    const { userId, sessionId } = await requireSession(ctx);

    await enforceRateLimit({
      scope: 'users.me.change-phone.post',
      identifier: userIdentifier(userId),
      limit: 5,
      failClosed: true,
    });

    const captchaOk = await verifyTurnstileRequest(ctx.headers);
    if (!captchaOk)
      throw new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN);

    const body = requireJsonBody(await ctx.readJson());
    const parsed = changePhoneSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        zodIssueMessage(parsed.error),
        HTTP_STATUS.UNPROCESSABLE
      );

    const { newPhoneNumber, channel } = parsed.data;

    if (!OTP_AUTO_VERIFY && !isChannelEnabled(channel))
      throw new CustomError(
        userMsg.verificationUnavailable,
        HTTP_STATUS.SERVICE_UNAVAILABLE
      );

    const auditMeta = getAuditMeta(ctx);
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

    const [currentUser] = await db
      .select({
        phoneNumber: users.phoneNumber,
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
    // A "taken" number is NOT rejected here: revealing it before ownership is
    // proven would be an enumeration oracle. Uniqueness is enforced by the
    // unique index at commit time (→ 409). Same-as-current reveals nothing.
    if (currentUser.phoneNumber === newPhoneNumber)
      throw new CustomError(
        userMsg.newPhoneSameAsCurrent,
        HTTP_STATUS.BAD_REQUEST
      );

    if (OTP_AUTO_VERIFY) {
      await withTransaction((tx) =>
        commitPhoneChange({
          tx,
          userId,
          newPhoneNumber,
          keepSessionId: sessionId,
          auditMeta,
        })
      );

      return apiSuccess({
        message: userMsg.phoneChanged,
        data: { autoVerified: true },
      });
    }

    // Aggregate per-destination cap. `sms` and `whatsapp` collapse onto one
    // phone budget, so switching transport no longer doubles the number of
    // paid messages a single number can be sent.
    await enforceOtpSendQuota({
      channel,
      destination: newPhoneNumber,
      surface: 'contact_change',
    });

    await processOtpSend({
      userId,
      identifier: newPhoneNumber,
      channel,
      purpose: 'change_phone',
      targetIdentifier: newPhoneNumber,
      sendTo: newPhoneNumber,
      entityName: 'رقم الهاتف',
    });

    return apiSuccess({
      message: userMsg.phoneChangeCodeSent,
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
