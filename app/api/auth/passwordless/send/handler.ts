import type { Handler } from '@/lib/http/contract';

import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { userContactColumn } from '@/db/queries';
import { users } from '@/db/schema';
import { sanitizeForLog } from '@/utils';
import { verifyTurnstileRequest } from '@/lib/captcha';
import {
  enforceOtpSendQuota,
  enforceRateLimit,
  ipIdentifier,
} from '@/lib/rate-limit';

import { HTTP_STATUS, MSG_PAGE_NOT_FOUND } from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  requireJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { processOtpSend } from '@/utils/otp';
import { OTP_ENABLED, sendOtpSchema } from '@/utils/validation/otp';

import { ensureMinDelay, otpMsg } from '../../otp/messages';

const GENERIC_SEND_DATA = { nextAllowedIn: 30 };

/**
 * Passwordless login step 1: send a sign-in code (purpose=passwordless_login)
 * to whichever enabled channel the user chose. Always a REAL code (the
 * OTP_AUTO_VERIFY bypass never auto-issues a login). Privacy-preserving:
 * known/unknown identifiers get the same response + timing.
 */
export const POST: Handler = async (ctx) => {
  const start = Date.now();
  try {
    if (!OTP_ENABLED)
      throw new CustomError(MSG_PAGE_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    // Per-IP cap BEFORE captcha so the outbound siteverify call is bounded per
    // IP. The IP-level 429 is pre-lookup and leaks nothing about account
    // existence, so it propagates as-is (not collapsed) below.
    await enforceRateLimit({
      scope: 'passwordless.send.ip',
      identifier: ipIdentifier(ctx.headers),
      limit: 60,
      window: 60,
      failClosed: true,
    });

    const captchaOk = await verifyTurnstileRequest(ctx.headers);
    if (!captchaOk)
      return handleApiError(
        new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN)
      );

    const body = requireJsonBody(ctx.body);
    const parsed = sendOtpSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(otpMsg.invalidInput, HTTP_STATUS.UNPROCESSABLE);

    const { channel } = parsed.data;
    const identifier =
      channel === 'email' ? parsed.data.email : parsed.data.phoneNumber;
    const entityName = channel === 'email' ? 'البريد الإلكتروني' : 'رقم الهاتف';

    await enforceOtpSendQuota({
      channel,
      destination: identifier,
      surface: 'passwordless',
    });

    const genericResponse = () =>
      apiSuccess({ message: otpMsg.sendSuccess, data: GENERIC_SEND_DATA });

    const [userData] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(userContactColumn(channel), identifier),
          isNull(users.deletedAt),
          eq(users.isActive, true)
        )
      )
      .limit(1);

    if (!userData) {
      await ensureMinDelay(Date.now() - start);
      return genericResponse();
    }

    try {
      await processOtpSend({
        userId: userData.id,
        identifier,
        channel,
        purpose: 'passwordless_login',
        sendTo: identifier,
        entityName,
      });
    } catch (error) {
      console.error(sanitizeForLog({ msg: 'passwordless.send.failed', error }));
    }

    await ensureMinDelay(Date.now() - start);
    return genericResponse();
  } catch (error) {
    await ensureMinDelay(Date.now() - start);
    // 429 is not collapsed: the throttles reaching here are the pre-lookup IP
    // and per-identifier Redis caps, which leak nothing about account existence.
    if (
      error instanceof CustomError &&
      (error.status === HTTP_STATUS.BAD_REQUEST ||
        error.status === HTTP_STATUS.NOT_FOUND)
    ) {
      return apiSuccess({
        message: otpMsg.sendSuccess,
        data: GENERIC_SEND_DATA,
      });
    }
    return handleApiError(error, otpMsg.sendError);
  }
};
