import type { Handler } from '@/lib/http/contract';

import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { userContactColumn } from '@/db/queries';
import { users } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { sanitizeForLog } from '@/utils';
import { getAuditMeta } from '@/lib/audit';
import { verifyTurnstileRequest } from '@/lib/captcha';
import {
  enforceOtpVerifyQuota,
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
import { markContactVerified, processOtpVerify } from '@/utils/otp';
import { OTP_ENABLED, verifyOtpSchema } from '@/utils/validation/otp';

import { ensureMinDelay, otpMsg } from '../messages';

export const POST: Handler = async (ctx) => {
  // Start timing before any DB work so the floor covers lookup time too.
  const start = Date.now();
  try {
    if (!OTP_ENABLED)
      throw new CustomError(MSG_PAGE_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    // Coarse per-IP cap BEFORE captcha so the outbound siteverify call is
    // bounded per IP, and a single IP / botnet node can't spray 6-digit codes
    // across identifiers to side-step the per-identifier verify cap.
    await enforceRateLimit({
      scope: 'otp.verify.ip',
      identifier: ipIdentifier(ctx.headers),
      limit: 60,
      window: 60,
      failClosed: true,
    });

    const captchaOk = await verifyTurnstileRequest(ctx.headers);
    if (!captchaOk) {
      return handleApiError(
        new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN)
      );
    }

    const body = requireJsonBody(ctx.body);

    const parsed = verifyOtpSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(otpMsg.invalidInput, HTTP_STATUS.UNPROCESSABLE);

    const { channel, code } = parsed.data;
    const identifier =
      channel === 'email' ? parsed.data.email : parsed.data.phoneNumber;

    await enforceOtpVerifyQuota({ channel, identifier });

    const whereClause = eq(userContactColumn(channel), identifier);

    const [userData] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(
        and(whereClause, isNull(users.deletedAt), eq(users.isActive, true))
      )
      .limit(1);

    if (!userData) {
      // Raise the generic "invalid/expired" error so the catch branch applies
      // the same timing floor as the real path.
      throw new CustomError(otpMsg.invalidOrExpired, HTTP_STATUS.BAD_REQUEST);
    }

    const auditMeta = getAuditMeta(ctx);

    const onMissing = (): never => {
      // user vanished/deactivated mid-flow — distinct internal signal so this
      // isn't confused with a wrong code; client still sees the generic error.
      console.error(
        sanitizeForLog({
          msg: 'otp.verify.userVanished',
          userId: userData.id,
          channel,
        })
      );
      throw new CustomError(otpMsg.invalidOrExpired, HTTP_STATUS.BAD_REQUEST);
    };

    // OTP_AUTO_VERIFY bypass flips the flag on request without validating a
    // code (lets a frontend that still calls verify succeed idempotently).
    // Otherwise markContactVerified runs inside the verify transaction, after a
    // real code match, under the FOR UPDATE lock on the user row.
    await (OTP_AUTO_VERIFY
      ? withTransaction((tx) =>
          markContactVerified(tx, {
            userId: userData.id,
            channel,
            auditMeta,
            onMissing,
          })
        )
      : processOtpVerify({
          userId: userData.id,
          userEmail: userData.email,
          channel,
          purpose: 'verify_contact',
          identifier,
          code,
          auditMeta,
          onVerified: (tx) =>
            markContactVerified(tx, {
              userId: userData.id,
              channel,
              auditMeta,
              onMissing,
            }),
        }));

    await ensureMinDelay(Date.now() - start);

    return apiSuccess({
      message: otpMsg.verifySuccess(channel),
      data: { verified: true },
    });
  } catch (error) {
    await ensureMinDelay(Date.now() - start);

    // Collapse all privacy-sensitive statuses into the same generic shape so
    // attackers can't distinguish unknown user / bad code / missing session.
    // 429 keeps its own headers, 503 must surface so failClosed rate-limit
    // outages aren't masked as a wrong OTP, and unknown errors fall through
    // to the centralised handler.
    if (
      error instanceof CustomError &&
      error.status !== HTTP_STATUS.TOO_MANY_REQUESTS &&
      error.status !== HTTP_STATUS.SERVICE_UNAVAILABLE &&
      error.status !== HTTP_STATUS.INTERNAL_ERROR &&
      error.status !== HTTP_STATUS.UNPROCESSABLE
    ) {
      const generic = new CustomError(
        otpMsg.invalidOrExpired,
        HTTP_STATUS.BAD_REQUEST
      );
      generic.responseHeaders = error.responseHeaders;
      return handleApiError(generic);
    }

    return handleApiError(error, otpMsg.verifyError);
  }
};
