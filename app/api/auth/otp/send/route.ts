import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';

import { HTTP_STATUS, MSG_PAGE_NOT_FOUND } from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  parseJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { processOtpSend } from '@/utils/otp';
import { OTP_MAX_ATTEMPTS } from '@/utils/validation/constants';
import { OTP_ENABLED, sendOtpSchema } from '@/utils/validation/otp';

import { ensureMinDelay, otpMsg } from '../messages';

// Default fake values returned when no real work is done (user not found / already verified).
// Must match the shape of a real response so attackers can't distinguish.
const GENERIC_SEND_DATA = {
  nextAllowedIn: 30,
  attemptsRemaining: OTP_MAX_ATTEMPTS - 1,
};

export async function POST(request: Request) {
  try {
    if (!OTP_ENABLED)
      throw new CustomError(MSG_PAGE_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    const body = await parseJsonBody(request);

    const parsed = sendOtpSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        parsed.error.issues[0].message,
        HTTP_STATUS.UNPROCESSABLE
      );

    const { channel } = parsed.data;
    const identifier =
      channel === 'email' ? parsed.data.email : parsed.data.phoneNumber;
    const entityName = channel === 'email' ? 'البريد الإلكتروني' : 'رقم الهاتف';

    const genericResponse = () =>
      apiSuccess({
        message: otpMsg.sendSuccess,
        data: GENERIC_SEND_DATA,
      });

    // Verify identifier belongs to an existing, non-deleted, active user
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
    const start = Date.now();

    // User not found or inactive — generic response with minimum delay
    // Already verified for this channel — same generic response with minimum delay
    if (
      !userData ||
      (channel === 'email' && userData.emailVerified) ||
      (channel !== 'email' && userData.phoneNumberVerified)
    ) {
      await ensureMinDelay(Date.now() - start);
      return genericResponse();
    }

    const result = await processOtpSend({
      userId: userData.id,
      identifier,
      channel,
      sendTo: identifier,
      entityName,
    });

    await ensureMinDelay(Date.now() - start);

    return apiSuccess({
      message: otpMsg.sendSuccess,
      data: result,
    });
  } catch (error) {
    return handleApiError(error, otpMsg.sendError);
  }
}
