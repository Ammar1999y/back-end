import type { Handler } from '@/lib/http/contract';

import { getAuditMeta } from '@/lib/audit';
import { mintAdminReauth } from '@/lib/auth/admin-reauth';
import { authenticationStartedAt } from '@/lib/auth/authentication-time';
import { LoginRejected, verifyLoginAttempt } from '@/lib/auth/login-guard';
import { requireSession } from '@/lib/http/session';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import {
  HTTP_STATUS,
  MSG_INVALID_CREDENTIALS,
  MSG_REAUTH_GRANTED,
  MSG_UPDATE_ERROR,
} from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  requireJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { passwordSchema } from '@/utils/validation/rules';

export const POST: Handler = async (ctx) => {
  try {
    const startedAt = await authenticationStartedAt();
    const { userId, sessionId } = await requireSession(ctx);

    // Per user, not per IP: this is an authenticated password check, and the
    // budget that matters is how many guesses one account can make.
    await enforceRateLimit({
      scope: 'dash.reauth',
      identifier: userIdentifier(userId),
      limit: 10,
      failClosed: true,
    });

    const body = requireJsonBody(await ctx.readJson());
    const parsed = passwordSchema.safeParse(
      (body as { password?: unknown }).password
    );
    if (!parsed.success)
      throw new CustomError(MSG_INVALID_CREDENTIALS, HTTP_STATUS.UNAUTHORIZED);

    try {
      await verifyLoginAttempt({
        userId,
        password: parsed.data,
        // The caller is already authenticated; the timing floor guards
        // anonymous enumeration, which this is not.
        skipTimingGuard: true,
        auditMeta: getAuditMeta(ctx),
        purpose: 'reauth_two_factor',
      });
    } catch (error) {
      if (error instanceof LoginRejected)
        throw new CustomError(
          MSG_INVALID_CREDENTIALS,
          HTTP_STATUS.UNAUTHORIZED
        );
      throw error;
    }

    const { expiresIn } = await mintAdminReauth(
      userId,
      sessionId,
      'password',
      undefined,
      startedAt
    );
    // No token in the body: the window is bound to THIS session, so the caller
    // simply continues on the same cookie. A bearer token would add a secret to
    // leak and no security — anyone who can send the cookie can send it too.
    return apiSuccess({
      message: MSG_REAUTH_GRANTED,
      data: { expiresIn },
    });
  } catch (error) {
    return handleApiError(error, MSG_UPDATE_ERROR);
  }
};
