import type { Handler } from '@/lib/http/contract';

import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { enforceRateLimit, ipIdentifier } from '@/lib/rate-limit';
import { sanitizeForLog } from '@/utils';

import { HTTP_STATUS, MSG_PAGE_NOT_FOUND } from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  requireJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { processOtpSend } from '@/utils/otp';
import { OTP_ENABLED, sendOtpSchema } from '@/utils/validation/otp';

import { ensureMinDelay, otpMsg } from '../messages';

// Stripped of per-identifier counters so fake and real paths return the same
// shape. Exposing attemptsRemaining leaks whether the account exists.
const GENERIC_SEND_DATA = {
  nextAllowedIn: 30,
};

export const POST: Handler = async (ctx) => {
  // Start timing before any work so the floor covers the entire request,
  // including the user lookup and (on the real path) delivery.
  const start = Date.now();
  try {
    if (!OTP_ENABLED)
      throw new CustomError(MSG_PAGE_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    const captchaOk = await verifyTurnstileRequest(ctx.headers);
    if (!captchaOk) {
      // Not a privacy-sensitive status — return immediately without burning
      // the full timing floor.
      return handleApiError(
        new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN)
      );
    }

    // Coarse per-IP cap after captcha verification: blocks a single IP
    // (or botnet node) from rotating through identifiers to bypass the
    // per-identifier cap and pump SMS / WhatsApp / email delivery cost.
    await enforceRateLimit({
      scope: 'otp.send.ip',
      identifier: ipIdentifier(ctx.headers),
      limit: 60,
      window: 60,
      failClosed: true,
    });

    const body = requireJsonBody(ctx.body);

    const parsed = sendOtpSchema.safeParse(body);
    if (!parsed.success)
      // Generic 422 — Zod's per-field message would distinguish "email shape"
      // from "phone shape" and leak which channel the schema accepted.
      throw new CustomError(otpMsg.invalidInput, HTTP_STATUS.UNPROCESSABLE);

    const { channel } = parsed.data;
    const identifier =
      channel === 'email' ? parsed.data.email : parsed.data.phoneNumber;
    const entityName = channel === 'email' ? 'البريد الإلكتروني' : 'رقم الهاتف';

    // Per-identifier cap applied after privacy unification so real and fake
    // paths are capped the same way.
    await enforceRateLimit({
      scope: `otp.send.${channel}`,
      identifier: identifier.toLowerCase(),
      limit: 5,
      window: 3600,
      failClosed: true,
    });

    const genericResponse = () =>
      apiSuccess({
        message: otpMsg.sendSuccess,
        data: GENERIC_SEND_DATA,
      });

    const whereClause =
      channel === 'email'
        ? eq(users.email, identifier)
        : eq(users.phoneNumber, identifier);

    const [userData] = await db
      .select({
        id: users.id,
        emailVerified: users.emailVerified,
        phoneNumberVerified: users.phoneNumberVerified,
      })
      .from(users)
      .where(
        and(whereClause, isNull(users.deletedAt), eq(users.isActive, true))
      )
      .limit(1);

    if (
      !userData ||
      (channel === 'email' && userData.emailVerified) ||
      (channel !== 'email' && userData.phoneNumberVerified)
    ) {
      await ensureMinDelay(Date.now() - start);
      return genericResponse();
    }

    try {
      await processOtpSend({
        userId: userData.id,
        identifier,
        channel,
        sendTo: identifier,
        entityName,
      });
    } catch (error) {
      // Delivery / internal failures must NOT distinguish real accounts
      // from fake ones during a provider outage — that's a binary oracle
      // for account existence. Privacy-sensitive CustomErrors
      // (BAD_REQUEST / NOT_FOUND / TOO_MANY_REQUESTS) are also collapsed
      // by the outer catch; here we additionally swallow delivery failures.
      console.error(sanitizeForLog({ msg: 'otp.send.deliveryFailed', error }));
    }

    await ensureMinDelay(Date.now() - start);

    return genericResponse();
  } catch (error) {
    await ensureMinDelay(Date.now() - start);

    // Privacy-sensitive statuses collapse to the same generic success the
    // fake path returns, so an attacker can't distinguish
    // unknown-identifier / already-verified / throttled.
    if (
      error instanceof CustomError &&
      (error.status === HTTP_STATUS.BAD_REQUEST ||
        error.status === HTTP_STATUS.NOT_FOUND ||
        error.status === HTTP_STATUS.TOO_MANY_REQUESTS)
    ) {
      return apiSuccess({
        message: otpMsg.sendSuccess,
        data: GENERIC_SEND_DATA,
      });
    }

    return handleApiError(error, otpMsg.sendError);
  }
};
