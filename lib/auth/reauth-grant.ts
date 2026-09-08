// Grants are consumed once and require the same live user session; their user-valued rows participate in credential rotation.
import crypto from 'node:crypto';
import type { AuthContext } from './two-factor-challenge';
import type { EntityID } from '@/types';

import { validID } from '@/utils';
import { APIError } from 'better-auth/api';

import {
  CUSTOM_AUTH_CODE,
  HTTP_STATUS,
  MSG_INVALID_CREDENTIALS,
} from '@/utils/api-messages';

import { hasAdminReauth } from './admin-reauth';
import { reauthenticationRequired } from './api-error';
import { authAuditMeta } from './audit-meta';
import { LoginRejected, verifyLoginAttempt } from './login-guard';
import { resolveRequestSession } from './two-factor-challenge';

const GRANT_BYTES = 24;

/** Long enough for a WebAuthn ceremony a user has to walk through, and no longer. */
const REAUTH_GRANT_MAX_AGE_S = 600;

export type ReauthPurpose = 'two_factor_enrolment';

const identifierOf = (purpose: ReauthPurpose, token: string) =>
  `reauth-${purpose}-${token}`;

export async function mintReauthGrant(
  ctx: AuthContext,
  params: { userId: EntityID; purpose: ReauthPurpose }
): Promise<string> {
  const token = crypto.randomBytes(GRANT_BYTES).toString('base64url');
  await ctx.context.internalAdapter.createVerificationValue({
    value: params.userId,
    identifier: identifierOf(params.purpose, token),
    expiresAt: new Date(Date.now() + REAUTH_GRANT_MAX_AGE_S * 1000),
  });
  return token;
}

/**
 * Spends the grant, and answers `false` for every reason it could not be spent —
 * absent, expired, another user's, another purpose's, already used.
 */
export async function consumeReauthGrant(
  ctx: AuthContext,
  params: { userId: EntityID; purpose: ReauthPurpose; token: unknown }
): Promise<boolean> {
  if (typeof params.token !== 'string' || params.token.length === 0)
    return false;

  const consumed = await ctx.context.internalAdapter
    .consumeVerificationValue(identifierOf(params.purpose, params.token))
    .catch(() => null);
  if (!consumed || consumed.expiresAt <= new Date()) return false;
  return validID(consumed.value) === params.userId;
}

// App-owned 2FA endpoints do not reach the library password hook; they use this boundary.
export async function requireReauthPassword(
  ctx: AuthContext,
  userId: EntityID
): Promise<void> {
  const supplied = (ctx.body as { password?: unknown } | undefined)?.password;
  if (supplied === undefined) {
    const session = await resolveRequestSession(ctx);
    if (
      session?.userId === userId &&
      (await hasAdminReauth(session.sessionId, userId))
    )
      return;
    throw reauthenticationRequired();
  }
  if (typeof supplied !== 'string')
    throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
      message: MSG_INVALID_CREDENTIALS,
      code: CUSTOM_AUTH_CODE,
    });

  try {
    await verifyLoginAttempt({
      userId,
      password: supplied,
      // The caller already holds a session; the timing floor guards anonymous
      // enumeration, which this is not.
      skipTimingGuard: true,
      auditMeta: authAuditMeta(ctx),
      purpose: 'reauth_two_factor',
    });
  } catch (error) {
    if (error instanceof LoginRejected)
      throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
        message: MSG_INVALID_CREDENTIALS,
        code: CUSTOM_AUTH_CODE,
      });
    throw error;
  }
}
