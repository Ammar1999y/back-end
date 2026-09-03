/**
 * A short-lived, single-use proof that the holder re-entered their password.
 *
 * It exists for the operations that cannot carry a password themselves: the
 * WebAuthn ceremonies are the library's endpoints with the library's bodies, and
 * a per-request password prompt on a multi-step ceremony is what gets a control
 * disabled rather than used. So the password is proven ONCE, in a POST of ours,
 * and the completing request presents the grant.
 *
 * Constraints, and none of them is optional:
 *   - bound to one user, and to one purpose;
 *   - single-use — `consumeVerificationValue` hands the row to exactly one
 *     concurrent caller;
 *   - short-lived;
 *   - never sufficient alone. Every consumer still requires a live session for
 *     the same user, so a leaked grant is not a credential.
 *
 * Stored in `verifications` with the user id as the VALUE, which is what makes
 * `revokeTwoFactorState`'s `WHERE value = userId` sweep it on a credential
 * rotation.
 */
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

import { API_PATH_MAX, getClientIp, USER_AGENT_MAX } from '../audit';
import { LoginRejected, verifyLoginAttempt } from './login-guard';

const GRANT_BYTES = 24;

/** Long enough for a WebAuthn ceremony a user has to walk through, and no longer. */
export const REAUTH_GRANT_MAX_AGE_S = 600;

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

/**
 * The password re-check every security-lowering 2FA transition takes.
 *
 * Not `PASSWORD_PROOF_PATHS`: that list exists to mint a proof for Better Auth's
 * own stubbed `password.verify`, and these are this deployment's endpoints,
 * which never reach it. The check is the same one, called directly — so a
 * hijacked session cannot add a factor it controls, remove one it does not, or
 * turn the feature off.
 */
export async function requireReauthPassword(
  ctx: AuthContext,
  userId: EntityID
): Promise<void> {
  const supplied = (ctx.body as { password?: unknown } | undefined)?.password;
  if (typeof supplied !== 'string')
    throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
      message: MSG_INVALID_CREDENTIALS,
      code: CUSTOM_AUTH_CODE,
    });

  const headers = ctx.headers ?? ctx.request?.headers ?? new Headers();
  try {
    await verifyLoginAttempt({
      userId,
      password: supplied,
      // The caller already holds a session; the timing floor guards anonymous
      // enumeration, which this is not.
      skipTimingGuard: true,
      auditMeta: {
        ip: getClientIp(headers),
        userAgent: headers.get('user-agent')?.slice(0, USER_AGENT_MAX) ?? null,
        apiPath: (ctx.path ?? '').slice(0, API_PATH_MAX),
      },
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
