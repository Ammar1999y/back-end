import type { HandlerInput } from './contract';
import type {
  DashboardPage,
  PermissionAction,
} from '@/lib/permissions/constants';

import { validID } from '@/utils';
import { auth } from '@/lib/auth';
import { assertLiveSession } from '@/lib/auth/live-session';
import { checkUserPermission } from '@/lib/permissions/checker';

import { HTTP_STATUS, MSG_LOGIN_REQUIRED } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

/**
 * Authorisation helper that reads headers from the framework-agnostic
 * `HandlerInput`. Delegates to `checkUserPermission` — same return shape,
 * just a thinner call site for handlers.
 */
export function requirePermission(
  ctx: HandlerInput,
  opts: {
    resource: DashboardPage;
    action: PermissionAction;
    forceDB?: boolean;
    throwError?: boolean;
  }
) {
  return checkUserPermission({
    headers: ctx.headers,
    resource: opts.resource,
    action: opts.action,
    forceDB: opts.forceDB,
    throwError: opts.throwError,
  });
}

/**
 * Loads the active Better Auth session from ctx.headers.
 * Throws 401 when no authenticated user is present.
 * Use this when you need the session but don't need a permission check.
 *
 * The session ROW is verified, not just the cookie. Every caller of this helper
 * is a mutation — change-password and both contact-change flows — and the cookie
 * cache stays valid for minutes after the row is deleted, so a session revoked by
 * credential rotation could still finish a contact change it had started. See
 * `assertLiveSession`.
 */
export async function requireSession(ctx: HandlerInput) {
  const session = await auth.api.getSession({ headers: ctx.headers });
  const userId = validID(session?.user?.id);
  if (!session || !userId)
    throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);

  const sessionId = await assertLiveSession(session.session.id, userId);

  return {
    session,
    userId,
    sessionId,
  };
}
