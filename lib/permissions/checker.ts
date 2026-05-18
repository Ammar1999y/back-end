import type {
  AccessScope,
  AllScopedAction,
  DashboardPage,
  PermissionAction,
} from './constants';

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

import { OWN_ACTION_MAP } from './constants';
import { getUserPermissions, sanitizePermissions } from './utils';
import { EntityID } from '@/types';

const SCOPED_ACTIONS = new Set<PermissionAction>(
  Object.keys(OWN_ACTION_MAP) as PermissionAction[]
);
const READ_ACTIONS = new Set<PermissionAction>(['view', 'viewOwn']);

/**
 * Resolve allowed/scope for a given action against a permissions matrix:
 * - For scoped actions (`view`/`edit`/`delete`): tries the unrestricted
 *   action first, then falls back to the `Own` variant.
 * - For all other actions: only the exact action is considered.
 */
function resolveActionScope(
  permissions: Record<string, Record<string, boolean>> | Partial<
    Record<DashboardPage, Record<PermissionAction, boolean>>
  >,
  resource: DashboardPage,
  action: PermissionAction
): { allowed: boolean; scope: AccessScope | null } {
  const pagePerms = permissions?.[resource];
  if (pagePerms?.[action] === true) return { allowed: true, scope: 'all' };
  if (SCOPED_ACTIONS.has(action)) {
    const ownAction = OWN_ACTION_MAP[action as AllScopedAction];
    if (pagePerms?.[ownAction] === true)
      return { allowed: true, scope: 'own' };
  }
  return { allowed: false, scope: null };
}

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

  // Write/mutation actions always verify from DB; read actions use cache
  const shouldForceDB = forceDB || !READ_ACTIONS.has(action);

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

    const { allowed, scope } = resolveActionScope(
      permissions,
      resource,
      action
    );
    if (!allowed && throwError)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    return {
      allowed,
      scope,
      source: 'database' as const,
      session: session!,
      userId,
      sessionId: validID(session!.session.id),
      roleId,
      permissions,
    };
  }

  // Cache path (read operations)
  const roleId = validID(session?.user.roleId) ?? null;

  if (!roleId)
    throw new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);

  const permissions = await getUserPermissions({
    session: session?.session ?? null,
    roleId,
    forceDB: false,
  });

  const { allowed, scope } = resolveActionScope(permissions, resource, action);
  if (!allowed && throwError)
    throw new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);

  return {
    allowed,
    scope,
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

  const hasWriteAction = checks.some((c) => !READ_ACTIONS.has(c.action));
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
      acc[`${resource}.${action}`] = resolveActionScope(
        allPermissions,
        resource,
        action
      ).allowed;
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
