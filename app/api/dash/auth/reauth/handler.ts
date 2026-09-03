import type { Handler } from '@/lib/http/contract';

import { getAuditMeta } from '@/lib/audit';
import { mintAdminReauth } from '@/lib/auth/admin-reauth';
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

/**
 * Opens the administrator's re-authentication window.
 *
 * ⚠️ Not a login and not a session: the caller already holds both. This says the
 * person at the keyboard is still the account's owner, for the class of actions
 * that lower ANOTHER account's security posture — `D12` lists them, and
 * `requirePermission({ reauth: true })` is where they read it.
 *
 * The answer is a proof the client sends back in `x-reauth-proof`. A WINDOW
 * rather than a single use, because a per-request prompt on every row of a batch
 * is what gets the control disabled.
 */
export const POST: Handler = async (ctx) => {
  try {
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

    const { expiresIn } = await mintAdminReauth(userId, sessionId);
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
