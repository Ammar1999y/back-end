import type { Handler } from '@/lib/http/contract';

import { otpMsg } from '@/app/api/auth/otp/messages';
import { withTransaction } from '@/db/ws';
import { getAuditMeta } from '@/lib/audit';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { requireSession } from '@/lib/http/session';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import {
  HTTP_STATUS,
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
import { processOtpVerify } from '@/utils/otp';
import { changePhoneVerifySchema } from '@/utils/validation/auth';

import { userMsg } from '../../../messages';
import { commitPhoneChange } from '../../contact-change';

/**
 * Step 2 of the phone change: verify the OTP sent to the NEW number and, in the
 * same transaction, commit `phone_number = newPhoneNumber` + `phoneNumberVerified
 * = true`. Atomic verify-commit — no replay window.
 */
export const POST: Handler = async (ctx) => {
  try {
    if (!PHONE_ENABLED)
      throw new CustomError(MSG_PAGE_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    const { session, userId, sessionId } = await requireSession(ctx);

    await enforceRateLimit({
      scope: 'users.me.change-phone.verify.post',
      identifier: userIdentifier(userId),
      limit: 10,
      failClosed: true,
    });

    const captchaOk = await verifyTurnstileRequest(ctx.headers);
    if (!captchaOk)
      throw new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN);

    const body = requireJsonBody(ctx.body);
    const parsed = changePhoneVerifySchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        parsed.error.issues[0].message,
        HTTP_STATUS.UNPROCESSABLE
      );

    const { newPhoneNumber, channel } = parsed.data;
    const auditMeta = getAuditMeta(ctx);

    await (OTP_AUTO_VERIFY
      ? withTransaction((tx) =>
          commitPhoneChange({
            tx,
            userId,
            newPhoneNumber,
            keepSessionId: sessionId,
            auditMeta,
          })
        )
      : processOtpVerify({
          userId,
          userEmail: session.user.email,
          channel,
          purpose: 'change_phone',
          identifier: newPhoneNumber,
          code: parsed.data.code,
          auditMeta,
          // Commit the number bound to the proven session, not the request body.
          onVerified: (tx, matched) =>
            commitPhoneChange({
              tx,
              userId,
              newPhoneNumber: matched.targetIdentifier ?? newPhoneNumber,
              keepSessionId: sessionId,
              keepVerificationSessionId: matched.verificationSessionId,
              auditMeta,
            }),
        }));

    return apiSuccess({
      message: userMsg.phoneChanged,
      data: { verified: true },
    });
  } catch (error) {
    // Only a KNOWN constraint becomes a 409; an unrecognized one falls
    // through to the 500 path so the schema/code mismatch is visible.
    const conflict = handleUserUniqueViolation(error);
    if (conflict) return conflict;
    return handleApiError(error, MSG_UPDATE_ERROR);
  }
};
