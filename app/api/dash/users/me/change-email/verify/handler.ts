import type { Handler } from '@/lib/http/contract';

import { otpMsg } from '@/app/api/auth/otp/messages';
import { withTransaction } from '@/db/ws';
import { getAuditMeta } from '@/lib/audit';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { requireSession } from '@/lib/http/session';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import { HTTP_STATUS, MSG_UPDATE_ERROR } from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  handleUserUniqueViolation,
  requireJsonBody,
} from '@/utils/api-response';
import { OTP_AUTO_VERIFY } from '@/utils/config';
import { CustomError } from '@/utils/error-class';
import { processOtpVerify } from '@/utils/otp';
import { changeEmailVerifySchema } from '@/utils/validation/auth';
import { zodIssueMessage } from '@/utils/validation/rules';

import { userMsg } from '../../../messages';
import { commitEmailChange, refreshSessionCookies } from '../../contact-change';

/**
 * Step 2 of the email change: verify the OTP that was sent to the NEW address
 * and, in the SAME transaction, commit `email = newEmail` + `emailVerified =
 * true` and revoke the user's other sessions. Verification and the sensitive
 * action are atomic, so there is no verify→commit replay window.
 */
export const POST: Handler = async (ctx) => {
  try {
    const { session, userId, sessionId } = await requireSession(ctx);

    await enforceRateLimit({
      scope: 'users.me.change-email.verify.post',
      identifier: userIdentifier(userId),
      limit: 10,
      failClosed: true,
    });

    const captchaOk = await verifyTurnstileRequest(ctx.headers);
    if (!captchaOk)
      throw new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN);

    const body = requireJsonBody(ctx.body);
    const parsed = changeEmailVerifySchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        zodIssueMessage(parsed.error),
        HTTP_STATUS.UNPROCESSABLE
      );

    const newEmail = parsed.data.newEmail;
    const auditMeta = getAuditMeta(ctx);

    // OTP_AUTO_VERIFY commits directly (idempotent if initiate already did).
    // Otherwise the session lookup keyed by (userId, contactKind, purpose,
    // identifier) means the code can only commit the address it was issued for.
    await (OTP_AUTO_VERIFY
      ? withTransaction((tx) =>
          commitEmailChange({
            tx,
            userId,
            newEmail,
            keepSessionId: sessionId,
            auditMeta,
          })
        )
      : processOtpVerify({
          userId,
          userEmail: session.user.email,
          channel: 'email',
          purpose: 'change_email',
          identifier: newEmail,
          code: parsed.data.code,
          auditMeta,
          // Commit the address bound to the proven session, not the request body.
          onVerified: (tx, matched) =>
            commitEmailChange({
              tx,
              userId,
              newEmail: matched.targetIdentifier ?? newEmail,
              keepSessionId: sessionId,
              keepVerificationSessionId: matched.verificationSessionId,
              auditMeta,
            }),
        }));

    return apiSuccess({
      message: userMsg.emailChanged,
      data: { verified: true },
      cookies: await refreshSessionCookies(ctx.headers),
    });
  } catch (error) {
    // Only a KNOWN constraint becomes a 409; an unrecognized one falls
    // through to the 500 path so the schema/code mismatch is visible.
    const conflict = handleUserUniqueViolation(error);
    if (conflict) return conflict;
    return handleApiError(error, MSG_UPDATE_ERROR);
  }
};
