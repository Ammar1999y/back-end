import type {
  DashboardPage,
  PermissionAction,
  SessionMetadata,
} from './constants';

import { validID } from '@/utils';
import { auth } from '@/lib/auth';

import { CustomError } from '@/utils/error-class';

import { SUPER_ADMIN_ROLE } from './constants';
import { getUserPermissions } from './utils';

export async function checkUserPermission(params: {
  headers: Headers;
  resource: DashboardPage;
  action: PermissionAction;
  forceDB?: boolean;
  throwError?: boolean;
}) {
  const {
    headers,
    resource,
    action,
    forceDB = false,
    throwError = true,
  } = params;

  const session = await auth.api.getSession({ headers });
  const userId = validID(session?.user.id);
  if (!userId) throw new CustomError('قم بتسجيل الدخول اولا', 401);

  const roleId = session?.user.roleId;
  const roleName = (session?.session?.metadata as SessionMetadata)?.roleName;

  if (!roleId) throw new CustomError('ليس لديك صلاحيه', 403);

  // SuperAdmin has full access
  if (roleName === SUPER_ADMIN_ROLE) {
    return {
      allowed: true,
      source: forceDB ? 'database' : 'cache',
      session,
    };
  }

  const permissions = await getUserPermissions({
    session: session.session,
    roleId,
    forceDB,
  });

  const allowed = permissions?.[resource]?.[action] === true;

  if (!allowed && throwError) throw new CustomError('ليس لديك صلاحيه', 403);

  return {
    allowed: allowed,
    source: forceDB ? 'database' : 'cache',
    session,
  };
}

/**
 * التحقق من عدة صلاحيات دفعة واحدة
 * @returns { permissions, session }
 */
export async function checkMultiplePermissions(params: {
  headers: Headers;
  checks: Array<{ resource: DashboardPage; action: PermissionAction }>;
  forceDB?: boolean;
}): Promise<{
  permissions: Record<string, boolean>;
  session: Awaited<ReturnType<typeof auth.api.getSession>>;
}> {
  const { headers, checks, forceDB } = params;

  const session = await auth.api.getSession({ headers });
  const userId = validID(session?.user.id);
  if (!userId) throw new CustomError('قم بتسجيل الدخول اولا', 401);

  const roleId = session?.user.roleId;
  if (!roleId) throw new CustomError('ليس لديك صلاحيه', 403);

  const allPermissions = await getUserPermissions({
    session: session.session,
    roleId,
    forceDB,
  });

  const permissions = checks.reduce(
    (acc, { resource, action }) => {
      acc[`${resource}.${action}`] =
        allPermissions?.[resource]?.[action] === true;
      return acc;
    },
    {} as Record<string, boolean>
  );

  return { permissions, session };
}
