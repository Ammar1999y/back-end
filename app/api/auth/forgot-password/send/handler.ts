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

// Same privacy-preserving generic payload as otp/send.
const GENERIC_SEND_DATA = { nextAllowedIn: 30 };

/**
 * Forgot-password step 1: send a code (purpose=forgot_password) to whichever
 * enabled channel the user chose. Always uses a REAL code — the OTP_AUTO_VERIFY
 * bypass never short-circuits password recovery. Response is identical for
 * known / unknown identifiers (no account enumeration).
 */
export const POST: Handler = async (ctx) => {
  const start = Date.now();
  try {
    if (!OTP_ENABLED)
      throw new CustomError(MSG_PAGE_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    // Per-IP cap BEFORE captcha so the outbound siteverify call is bounded per
    // IP. The IP-level 429 is pre-lookup and leaks nothing about existence.
    await enforceRateLimit({
      scope: 'forgot.send.ip',
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

    const body = requireJsonBody(await ctx.readJson());
    const parsed = sendOtpSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(otpMsg.invalidInput, HTTP_STATUS.UNPROCESSABLE);

    const { channel } = parsed.data;
    const identifier =
      channel === 'email' ? parsed.data.email : parsed.data.phoneNumber;
    const entityName = channel === 'email' ? 'البريد الإلكتروني' : 'رقم الهاتف';

    // Recovery gets its own surface slice of the destination budget, so it
    // stays available even when contact-verification traffic is being sprayed
    // at the same address.
    await enforceOtpSendQuota({
      channel,
      destination: identifier,
      surface: 'recovery',
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
        purpose: 'forgot_password',
        sendTo: identifier,
        entityName,
      });
    } catch (error) {
      // Swallow delivery/throttle failures so they can't be used as an
      // account-existence oracle.
      console.error(sanitizeForLog({ msg: 'forgot.send.failed', error }));
    }

    await ensureMinDelay(Date.now() - start);
    return genericResponse();
  } catch (error) {
    await ensureMinDelay(Date.now() - start);
    // 429 is not collapsed: the throttles reaching here are the pre-lookup IP
    // and per-identifier limiter caps, which leak nothing about account existence.
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
