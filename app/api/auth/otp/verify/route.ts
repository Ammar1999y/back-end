import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';
import { sanitizeForLog } from '@/utils';

import { HTTP_STATUS, MSG_PAGE_NOT_FOUND } from '@/utils/api-messages';
import {
  apiError,
  apiSuccess,
  handleApiError,
  parseJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { processOtpVerify } from '@/utils/otp';
import { OTP_ENABLED, verifyOtpSchema } from '@/utils/validation/otp';

import { ensureMinDelay, otpMsg } from '../messages';

export async function POST(request: Request) {
  const genericError = () =>
    apiError({
      message: otpMsg.invalidOrExpired,
      status: HTTP_STATUS.BAD_REQUEST,
    });

  try {
    if (!OTP_ENABLED)
      throw new CustomError(MSG_PAGE_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    const body = await parseJsonBody(request);

    const parsed = verifyOtpSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        parsed.error.issues[0].message,
        HTTP_STATUS.UNPROCESSABLE
      );

    const { channel, code } = parsed.data;
    const identifier =
      channel === 'email' ? parsed.data.email : parsed.data.phoneNumber;

    // Verify identifier belongs to an existing, non-deleted, active user
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

    // User not found — generic error with minimum delay
    if (!userData) {
      await ensureMinDelay(Date.now() - start);
      return genericError();
    }

    await processOtpVerify({
      userId: userData.id,
      channel,
      code,
      onVerified: async (tx) => {
        // User lookup inside transaction — prevents TOCTOU race (2.3)
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
      // Rate limiting errors are safe to surface (don't leak user existence)
      if (error.status === HTTP_STATUS.TOO_MANY_REQUESTS)
        return handleApiError(error);

      // Expected verification failures — generic response with minimum delay
      if (
        error.status === HTTP_STATUS.BAD_REQUEST ||
        error.status === HTTP_STATUS.NOT_FOUND
      )
        return genericError();
    }

    // Unexpected server errors — log and return 500 so monitoring can detect outages
    console.error(sanitizeForLog(error));
    return apiError({
      message: otpMsg.verifyError,
      status: HTTP_STATUS.INTERNAL_ERROR,
    });
  }
}
