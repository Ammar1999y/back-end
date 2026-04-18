import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';
import { sanitizeForLog } from '@/utils';
import { enforceRateLimit, ipIdentifier } from '@/lib/rate-limit';

import type { Handler } from '@/lib/http/contract';

import { HTTP_STATUS, MSG_PAGE_NOT_FOUND } from '@/utils/api-messages';
import {
  apiError,
  apiSuccess,
  handleApiError,
  requireJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { processOtpVerify } from '@/utils/otp';
import { OTP_ENABLED, verifyOtpSchema } from '@/utils/validation/otp';

import { ensureMinDelay, otpMsg } from '../messages';

export const POST: Handler = async (ctx) => {
  const genericError = () =>
    apiError({
      message: otpMsg.invalidOrExpired,
      status: HTTP_STATUS.BAD_REQUEST,
    });

  try {
    if (!OTP_ENABLED)
      throw new CustomError(MSG_PAGE_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    await enforceRateLimit({
      scope: 'otp.verify',
      identifier: ipIdentifier(ctx.headers),
      limit: 10,
    });

    const body = requireJsonBody(ctx.body);

    const parsed = verifyOtpSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        parsed.error.issues[0].message,
        HTTP_STATUS.UNPROCESSABLE
      );

    const { channel, code } = parsed.data;
    const identifier =
      channel === 'email' ? parsed.data.email : parsed.data.phoneNumber;

    const whereClause =
      channel === 'email'
        ? eq(users.email, identifier)
        : eq(users.phoneNumber, identifier);

    const [userData] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(whereClause, isNull(users.deletedAt), eq(users.isActive, true))
      )
      .limit(1);
    const start = Date.now();

    if (!userData) {
      await ensureMinDelay(Date.now() - start);
      return genericError();
    }

    await processOtpVerify({
      userId: userData.id,
      channel,
      code,
      onVerified: async (tx) => {
        const verifiedField =
          channel === 'email'
            ? { emailVerified: true }
            : { phoneNumberVerified: true };

        const [updated] = await tx
          .update(users)
          .set(verifiedField)
          .where(and(eq(users.id, userData.id), isNull(users.deletedAt)))
          .returning({ id: users.id });

        if (!updated)
          throw new CustomError(
            otpMsg.invalidOrExpired,
            HTTP_STATUS.BAD_REQUEST
          );
      },
    });

    await ensureMinDelay(Date.now() - start);

    return apiSuccess({
      message: otpMsg.verifySuccess(channel),
      data: { verified: true },
    });
  } catch (error) {
    if (error instanceof CustomError) {
      if (error.status === HTTP_STATUS.TOO_MANY_REQUESTS)
        return handleApiError(error);

      if (
        error.status === HTTP_STATUS.BAD_REQUEST ||
        error.status === HTTP_STATUS.NOT_FOUND
      )
        return genericError();
    }

    console.error(sanitizeForLog(error));
    return apiError({
      message: otpMsg.verifyError,
      status: HTTP_STATUS.INTERNAL_ERROR,
    });
  }
};
