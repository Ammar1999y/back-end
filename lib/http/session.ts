import type { HandlerInput } from './contract';
import type {
  DashboardPage,
  PermissionAction,
} from '@/lib/permissions/constants';

import { validID } from '@/utils';
import { auth } from '@/lib/auth';
import { assertLiveSession } from '@/lib/auth/live-session';
import {
  checkMultiplePermissions,
  checkUserPermission,
} from '@/lib/permissions/checker';

import {
  HTTP_STATUS,
  MSG_INSUFFICIENT_PERMISSIONS,
  MSG_LOGIN_REQUIRED,
} from '@/utils/api-messages';
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

/**
 * Authorisation for a route that a grant on ANY ONE of several actions unlocks.
 *
 * The image upload is the case that needs it. An image is uploaded *for* a
 * resource, so the question is "may this caller create or edit that resource",
 * not a permission belonging to the upload endpoint itself — the endpoint holds
 * no data of its own. `requirePermission` cannot express that: it takes a single
 * action and throws on the first miss, so a `create`-only holder and an
 * `edit`-only holder could not both pass one call.
 *
 * Delegates to `checkMultiplePermissions` rather than calling
 * `checkUserPermission` once per action: it resolves every check from ONE
 * permissions read, and it forces the database path — including the live-session
 * assertion — as soon as any requested action is a write. Looping the
 * single-action helper would repeat the session lookup per action and,
 * `throwError: false` being per-call, would leak a 403 for the first miss.
 *
 * Returns the subset actually granted, so a caller that needs to distinguish
 * them (create vs edit) can, without asking again.
 */
export async function requireAnyPermission(
  ctx: HandlerInput,
  opts: {
    resource: DashboardPage;
    actions: readonly [PermissionAction, ...PermissionAction[]];
    forceDB?: boolean;
  }
) {
  const { permissions, session, userId, sessionId } =
    await checkMultiplePermissions({
      headers: ctx.headers,
      checks: opts.actions.map((action) => ({
        resource: opts.resource,
        action,
      })),
      forceDB: opts.forceDB,
    });

  const granted = opts.actions.filter(
    (action) => permissions[`${opts.resource}.${action}`] === true
  );

  if (granted.length === 0)
    throw new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);

  return { session, userId, sessionId, granted };
}
