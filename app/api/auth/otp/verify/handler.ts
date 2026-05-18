import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';
import { auditLog, getAuditMeta } from '@/lib/audit';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { enforceRateLimit, ipIdentifier } from '@/lib/rate-limit';

import type { Handler } from '@/lib/http/contract';

import { HTTP_STATUS, MSG_PAGE_NOT_FOUND } from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  requireJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { processOtpVerify } from '@/utils/otp';
import { OTP_ENABLED, verifyOtpSchema } from '@/utils/validation/otp';

import { ensureMinDelay, otpMsg } from '../messages';

export const POST: Handler = async (ctx) => {
  // Start timing before any DB work so the floor covers lookup time too.
  const start = Date.now();
  try {
    if (!OTP_ENABLED)
      throw new CustomError(MSG_PAGE_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    const captchaOk = await verifyTurnstileRequest(ctx.headers);
    if (!captchaOk) {
      return handleApiError(
        new CustomError(otpMsg.captchaFailed, HTTP_STATUS.FORBIDDEN)
      );
    }

    // Coarse per-IP cap to stop a single IP / botnet node from spraying
    // 6-digit codes across many identifiers and side-stepping the
    // per-identifier verify cap.
    await enforceRateLimit({
      scope: 'otp.verify.ip',
      identifier: ipIdentifier(ctx.headers),
      limit: 60,
      window: 60,
      failClosed: true,
    });

    const body = requireJsonBody(ctx.body);

    const parsed = verifyOtpSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(otpMsg.invalidInput, HTTP_STATUS.UNPROCESSABLE);

    const { channel, code } = parsed.data;
    const identifier =
      channel === 'email' ? parsed.data.email : parsed.data.phoneNumber;

    await enforceRateLimit({
      scope: `otp.verify.${channel}`,
      identifier: identifier.toLowerCase(),
      limit: 10,
      window: 600,
      failClosed: true,
    });

    const whereClause =
      channel === 'email'
        ? eq(users.email, identifier)
        : eq(users.phoneNumber, identifier);

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

    await processOtpVerify({
      userId: userData.id,
      userEmail: userData.email,
      channel,
      identifier,
      code,
      auditMeta,
      onVerified: async (tx) => {
        // Look up the current state under the active filter so we can
        // distinguish "user is still active and we are flipping the flag"
        // from "user vanished mid-flow". Without this split, a deactivation
        // between OTP send and verify would be silently reported as success.
        const [currentUser] = await tx
          .select({
            emailVerified: users.emailVerified,
            phoneNumberVerified: users.phoneNumberVerified,
          })
          .from(users)
          .where(
            and(
              eq(users.id, userData.id),
              isNull(users.deletedAt),
              eq(users.isActive, true)
            )
          )
          .for('update');

        if (!currentUser) {
          throw new CustomError(
            otpMsg.invalidOrExpired,
            HTTP_STATUS.BAD_REQUEST
          );
        }

        const isAlreadyVerified =
          channel === 'email'
            ? currentUser.emailVerified
            : currentUser.phoneNumberVerified;

        // Idempotent re-verification: skip the UPDATE and the audit row so
        // the log only reflects real transitions.
        if (isAlreadyVerified) return;

        const verifiedField =
          channel === 'email'
            ? { emailVerified: true }
            : { phoneNumberVerified: true };

        await tx
          .update(users)
          .set(verifiedField)
          .where(eq(users.id, userData.id));

        const verifiedFieldName =
          channel === 'email' ? 'emailVerified' : 'phoneNumberVerified';
        await auditLog(tx, {
          userId: userData.id,
          userEmail: userData.email,
          action: 'UPDATE',
          tableName: 'users',
          recordId: userData.id,
          oldData: { [verifiedFieldName]: false },
          newData: { [verifiedFieldName]: true },
          meta: auditMeta,
        });
      },
    });

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
