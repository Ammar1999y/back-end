import type { Handler } from '@/lib/http/contract';
import type { OtpChannel } from '@/utils/validation/otp';

import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';
import { readRecoveryGrant } from '@/lib/auth/recovery-grant';
import {
  readEnrollmentState,
  recoveryOptions,
} from '@/lib/auth/two-factor-challenge';
import {
  enforceOtpSurfaceSendQuota,
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
import {
  OTP_ENABLED,
  recoverySecondFactorSendSchema,
} from '@/utils/validation/otp';

import { otpMsg } from '../../../otp/messages';

/**
 * Sends the second-factor code for a recovery grant.
 *
 * ⚠️ The destination is read from the USER ROW and the option must be one the
 * grant issued, so nothing here can redirect a code: a caller holding the grant
 * cannot name `otp:email` on a grant whose recovery code arrived by email, and
 * cannot name a contact the account does not hold.
 *
 * Its own send budget (`recovery_second_factor`), because a shared one would let
 * the anonymous contact-verification surface exhaust the only channel a locked
 * out user has left.
 */
export const POST: Handler = async (ctx) => {
  try {
    if (!OTP_ENABLED)
      throw new CustomError(MSG_PAGE_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    await enforceRateLimit({
      scope: 'forgot.second-factor.send.ip',
      identifier: ipIdentifier(ctx.headers),
      limit: 30,
      window: 60,
      failClosed: true,
    });

    const body = requireJsonBody(await ctx.readJson());
    const parsed = recoverySecondFactorSendSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(otpMsg.invalidInput, HTTP_STATUS.UNPROCESSABLE);
    const { grant: grantToken, option: requested } = parsed.data;

    const grant = await readRecoveryGrant(grantToken);
    if (!grant)
      throw new CustomError(otpMsg.invalidOrExpired, HTTP_STATUS.BAD_REQUEST);

    // The issued set narrowed by CURRENT capability: an enrolment that has gone
    // since the grant was minted is not an option, and one that appeared is not
    // one either.
    const state = await readEnrollmentState(grant.userId);
    const issued = new Set(grant.options);
    const option = recoveryOptions(state, grant.excludeContactKind).find(
      (entry) =>
        issued.has(entry.id) && entry.method === 'otp' && entry.id === requested
    );
    if (!option?.channel)
      throw new CustomError(otpMsg.invalidOrExpired, HTTP_STATUS.BAD_REQUEST);

    const [user] = await db
      .select({ email: users.email, phoneNumber: users.phoneNumber })
      .from(users)
      .where(eq(users.id, grant.userId))
      .limit(1);
    const destination =
      option.contactKind === 'email' ? user?.email : user?.phoneNumber;
    if (!destination)
      throw new CustomError(otpMsg.invalidOrExpired, HTTP_STATUS.BAD_REQUEST);

    await enforceOtpSurfaceSendQuota({
      channel: option.channel as OtpChannel,
      destination,
      surface: 'recovery_second_factor',
    });

    const { nextAllowedIn } = await processOtpSend({
      userId: grant.userId,
      identifier: destination,
      channel: option.channel as OtpChannel,
      purpose: 'two_factor',
      sendTo: destination,
      entityName:
        option.contactKind === 'email' ? 'البريد الإلكتروني' : 'رقم الهاتف',
    });

    return apiSuccess({
      message: otpMsg.sendSuccess,
      data: { nextAllowedIn },
    });
  } catch (error) {
    return handleApiError(error, otpMsg.sendError);
  }
};
