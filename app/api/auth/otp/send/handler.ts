import type { Handler } from '@/lib/http/contract';

import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { sanitizeForLog } from '@/utils';
import { getAuditMeta } from '@/lib/audit';
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
import { OTP_AUTO_VERIFY } from '@/utils/config';
import { CustomError } from '@/utils/error-class';
import { markContactVerified, processOtpSend } from '@/utils/otp';
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

    // Coarse per-IP cap BEFORE the captcha siteverify call: bounds the outbound
    // HTTPS request to Cloudflare per IP, and blocks a single IP (or botnet
    // node) from rotating through identifiers to pump SMS / WhatsApp / email
    // delivery cost. The IP-level 429 leaks nothing about account existence
    // (it is evaluated before any DB lookup), so it propagates as-is below.
    await enforceRateLimit({
      scope: 'otp.send.ip',
      identifier: ipIdentifier(ctx.headers),
      limit: 60,
      window: 60,
      failClosed: true,
    });

    const captchaOk = await verifyTurnstileRequest(ctx.headers);
    if (!captchaOk) {
      // Not a privacy-sensitive status — return immediately without burning
      // the full timing floor.
      return handleApiError(
        new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN)
      );
    }

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

    // Per-destination quota chain, applied after privacy unification so real
    // and fake paths are capped the same way. The `verify_contact` surface has
    // its own slice of the destination budget, so public verification traffic
    // can no longer drain a victim's password-recovery delivery allowance.
    await enforceOtpSendQuota({
      channel,
      destination: identifier,
      surface: 'verify_contact',
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

    if (OTP_AUTO_VERIFY) {
      // Bypass: approve the contact instantly without generating or sending a
      // code (dev / no-OTP-provider mode). Errors are swallowed for the same
      // privacy reason as delivery failures below.
      try {
        await withTransaction((tx) =>
          markContactVerified(tx, {
            userId: userData.id,
            channel,
            auditMeta: getAuditMeta(ctx),
            onMissing: () => {
              // Distinct internal signal: the user vanished/deactivated mid-flow
              // under OTP_AUTO_VERIFY (no code involved). The client still sees
              // the generic message for privacy.
              console.error(
                sanitizeForLog({
                  msg: 'otp.send.autoVerify.userVanished',
                  userId: userData.id,
                  channel,
                })
              );
              throw new CustomError(
                otpMsg.invalidOrExpired,
                HTTP_STATUS.BAD_REQUEST
              );
            },
          })
        );
      } catch (error) {
        console.error(sanitizeForLog({ msg: 'otp.autoVerify.failed', error }));
      }
    } else {
      try {
        await processOtpSend({
          userId: userData.id,
          identifier,
          channel,
          purpose: 'verify_contact',
          sendTo: identifier,
          entityName,
        });
      } catch (error) {
        // Delivery / internal failures must NOT distinguish real accounts
        // from fake ones during a provider outage — that's a binary oracle
        // for account existence. Privacy-sensitive CustomErrors
        // (BAD_REQUEST / NOT_FOUND / TOO_MANY_REQUESTS) are also collapsed
        // by the outer catch; here we additionally swallow delivery failures.
        console.error(
          sanitizeForLog({ msg: 'otp.send.deliveryFailed', error })
        );
      }
    }

    await ensureMinDelay(Date.now() - start);

    return genericResponse();
  } catch (error) {
    await ensureMinDelay(Date.now() - start);

    // Collapse unknown-identifier / already-verified to the generic success so
    // existence can't be probed. 429 is NOT collapsed: the only throttles that
    // reach here are the pre-lookup IP and per-identifier Redis caps, which are
    // independent of the user lookup; the existence-revealing OTP block is
    // swallowed in the inner try/catch above. Propagating 429 avoids a fake 200
    // under throttling and returns a real Retry-After.
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
