import type {
  DashboardPage,
  PermissionAction,
} from '@/lib/permissions/constants';

import { auth } from '@/lib/auth';
import {
  checkMultiplePermissions,
  checkUserPermission,
} from '@/lib/permissions/checker';

import {
  HTTP_STATUS,
  MSG_LOGIN_REQUIRED,
} from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

import type { HandlerInput } from './contract';

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

/** Multi-permission variant — delegates to `checkMultiplePermissions`. */
export function requireMultiplePermissions(
  ctx: HandlerInput,
  opts: {
    checks: Array<{ resource: DashboardPage; action: PermissionAction }>;
    forceDB?: boolean;
  }
) {
  return checkMultiplePermissions({
    headers: ctx.headers,
    checks: opts.checks,
    forceDB: opts.forceDB,
  });
}

/**
 * Loads the active Better Auth session from ctx.headers.
 * Throws 401 when no authenticated user is present.
 * Use this when you need the session but don't need a permission check.
 */
export async function requireSession(ctx: HandlerInput) {
  const session = await auth.api.getSession({ headers: ctx.headers });
  if (!session?.user?.id)
    throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);
  return session;
}
