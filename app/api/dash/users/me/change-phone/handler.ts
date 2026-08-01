import type { Handler } from '@/lib/http/contract';

import { and, eq, isNull } from 'drizzle-orm';

import { otpMsg } from '@/app/api/auth/otp/messages';
import { db } from '@/db';
import { users } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { isUniqueViolation } from '@/utils';
import { getAuditMeta } from '@/lib/audit';
import { LoginRejected, verifyLoginAttempt } from '@/lib/auth/login-guard';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { requireSession } from '@/lib/http/session';
import { enforceRateLimit, otpSendScope, userIdentifier } from '@/lib/rate-limit';

import {
  HTTP_STATUS,
  MSG_INSUFFICIENT_PERMISSIONS,
  MSG_NOT_FOUND,
  MSG_PAGE_NOT_FOUND,
  MSG_UPDATE_ERROR,
} from '@/utils/api-messages';
import {
  apiSuccess,
  getErrorHeaders,
  handleApiError,
  requireJsonBody,
  resolveUserUniqueViolation,
} from '@/utils/api-response';
import { OTP_AUTO_VERIFY, PHONE_ENABLED } from '@/utils/config';
import { CustomError } from '@/utils/error-class';
import { processOtpSend } from '@/utils/otp';
import { changePhoneSchema } from '@/utils/validation/auth';
import { ENABLED_OTP_CHANNELS } from '@/utils/validation/otp';

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

    const { userId } = await requireSession(ctx);

    await enforceRateLimit({
      scope: 'users.me.change-phone.post',
      identifier: userIdentifier(userId),
      limit: 5,
      failClosed: true,
    });

    const captchaOk = await verifyTurnstileRequest(ctx.headers);
    if (!captchaOk)
      throw new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN);

    const body = requireJsonBody(ctx.body);
    const parsed = changePhoneSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        parsed.error.issues[0].message,
        HTTP_STATUS.UNPROCESSABLE
      );

    const { newPhoneNumber, channel } = parsed.data;
    const auditMeta = getAuditMeta(ctx);

    if (
      !OTP_AUTO_VERIFY &&
      !(ENABLED_OTP_CHANNELS as readonly string[]).includes(channel)
    )
      throw new CustomError(
        userMsg.verificationUnavailable,
        HTTP_STATUS.SERVICE_UNAVAILABLE
      );

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
        commitPhoneChange({ tx, userId, newPhoneNumber, auditMeta })
      );

      return apiSuccess({
        message: userMsg.phoneChanged,
        data: { autoVerified: true },
      });
    }

    // Per-destination cap (shared with the public OTP send budget) so the same
    // number can't be targeted repeatedly across actors/endpoints.
    await enforceRateLimit({
      scope: otpSendScope(channel),
      identifier: newPhoneNumber.toLowerCase(),
      limit: 5,
      window: 3600,
      failClosed: true,
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
