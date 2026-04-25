import type { DashboardPage, PermissionAction } from './constants';

import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { rolePermissions, roles, users } from '@/db/schema';
import { validID } from '@/utils';
import { auth } from '@/lib/auth';

import {
  HTTP_STATUS,
  MSG_INSUFFICIENT_PERMISSIONS,
  MSG_LOGIN_REQUIRED,
} from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

import { getUserPermissions, sanitizePermissions } from './utils';
import { EntityID } from '@/types';

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
  if (!userId)
    throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);

  // Write operations always verify from DB; reads use cache
  const shouldForceDB = forceDB || action !== 'view';

  if (shouldForceDB) {
    // Single query: fetch user + role + permissions in one round-trip
    const rows = await db
      .select({
        roleId: users.roleId,
        roleName: roles.roleName,
        roleScope: roles.scope,
        roleIsActive: roles.isActive,
        pageName: rolePermissions.pageName,
        pagePermissions: rolePermissions.permissions,
      })
      .from(users)
      .leftJoin(roles, eq(users.roleId, roles.id))
      .leftJoin(rolePermissions, eq(roles.id, rolePermissions.roleId))
      .where(
        and(
          eq(users.id, userId),
          isNull(users.deletedAt),
          eq(users.isActive, true)
        )
      );

    if (!rows.length)
      throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);

    const roleId = rows[0].roleId;
    if (!roleId)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    if (rows[0].roleIsActive === false)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    const rolePerms = rows
      .filter((r) => r.pageName != null)
      .map((r) => ({
        pageName: r.pageName!,
        permissions: r.pagePermissions,
      }));

    const permissions = sanitizePermissions(rolePerms);

    const allowed = permissions?.[resource]?.[action] === true;
    if (!allowed && throwError)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    return {
      allowed,
      source: 'database' as const,
      session: session!,
      userId,
      sessionId: validID(session!.session.id),
      roleId,
      permissions,
    };
  }

  // Cache path (view operations)
  const roleId = validID(session?.user.roleId) ?? null;

  if (!roleId)
    throw new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);

  const permissions = await getUserPermissions({
    session: session?.session ?? null,
    roleId,
    forceDB: false,
  });

  const allowed = permissions?.[resource]?.[action] === true;
  if (!allowed && throwError)
    throw new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);

  return {
    allowed,
    source: 'cache' as const,
    session: session!,
    userId,
    sessionId: validID(session!.session.id)!,
    roleId,
    permissions,
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
  session: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
  userId: EntityID;
  sessionId: EntityID;
}> {
  const { headers, checks, forceDB = false } = params;

  const session = await auth.api.getSession({ headers });
  const userId = validID(session?.user.id);
  if (!userId)
    throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);

  const hasWriteAction = checks.some((c) => c.action !== 'view');
  const shouldForceDB = forceDB || hasWriteAction;

  let roleId: EntityID | null = validID(session?.user.roleId) ?? null;

  if (shouldForceDB) {
    const [userData] = await db
      .select({
        roleId: users.roleId,
        roleName: roles.roleName,
        roleScope: roles.scope,
        roleIsActive: roles.isActive,
      })
      .from(users)
      .leftJoin(roles, eq(users.roleId, roles.id))
      .where(
        and(
          eq(users.id, userId),
          isNull(users.deletedAt),
          eq(users.isActive, true)
        )
      );

    if (!userData)
      throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);
    roleId = userData.roleId;

    if (!roleId)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    if (!userData.roleIsActive)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );
  }

  if (!roleId)
    throw new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);

  const allPermissions = await getUserPermissions({
    roleId,
    session: shouldForceDB ? null : (session?.session ?? null),
    forceDB: shouldForceDB,
  });

  const permissions = checks.reduce(
    (acc, { resource, action }) => {
      acc[`${resource}.${action}`] =
        allPermissions?.[resource]?.[action] === true;
      return acc;
    },
    {} as Record<string, boolean>
  );

  return {
    permissions,
    session: session!,
    userId,
    sessionId: validID(session!.session.id),
  };
}
