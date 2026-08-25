import type {
  AccessScope,
  AllScopedAction,
  DashboardPage,
  PermissionAction,
} from './constants';
import type { EntityID } from '@/types';

import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { db } from '@/db';
import { rolePermissions, roles, sessions, users } from '@/db/schema';
import { validID } from '@/utils';
import { auth } from '@/lib/auth';
import { assertLiveSession } from '@/lib/auth/live-session';

import {
  HTTP_STATUS,
  MSG_INSUFFICIENT_PERMISSIONS,
  MSG_LOGIN_REQUIRED,
} from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

import { OWN_ACTION_MAP, SUPERSEDING_ACTION } from './constants';
import { getUserPermissions, sanitizePermissions } from './utils';

const SCOPED_ACTIONS = new Set<PermissionAction>(
  Object.keys(OWN_ACTION_MAP) as PermissionAction[]
);
const READ_ACTIONS = new Set<PermissionAction>(['view', 'viewOwn']);

/**
 * Resolve allowed/scope for a given action against a permissions matrix.
 *
 * - An all-scoped action (`view`/`edit`/`delete`): the unrestricted grant first,
 *   then the `Own` variant with `scope: 'own'`.
 * - An own-scoped action (`viewOwn`/`editOwn`/`deleteOwn`): the superseding
 *   unrestricted grant first, then the own grant itself.
 * - Anything else: exact match only.
 *
 * Exported, which its own comment below already assumed ("exported to every
 * future call site") while the keyword was missing. It is the highest-value pure
 * function in the repository — a bug here is an authorization bypass — and while
 * it was private every case in its matrix cost a session and a database round
 * trip, which is a materially weaker test of it. See
 * `tests/unit/permission-scope.test.ts`.
 */
export function resolveActionScope(
  permissions:
    | Record<string, Record<string, boolean>>
    | Partial<Record<DashboardPage, Record<PermissionAction, boolean>>>,
  resource: DashboardPage,
  action: PermissionAction
): { allowed: boolean; scope: AccessScope | null } {
  const pagePerms = permissions?.[resource];

  // An own-scoped action asked for DIRECTLY. Handled first because the generic
  // path below would answer both of its cases wrongly: holding `edit` while
  // requesting `editOwn` was denied outright, and holding only `editOwn` while
  // requesting `editOwn` was answered `scope: 'all'` — an own-scoped grant
  // reported as unrestricted access. No route asks for an own variant today, so
  // neither is currently reachable; the function is exported to every future
  // call site, which is exactly how a latent trap becomes a live one.
  const superseding = SUPERSEDING_ACTION[action];
  if (superseding) {
    if (pagePerms?.[superseding] === true)
      return { allowed: true, scope: 'all' };
    if (pagePerms?.[action] === true) return { allowed: true, scope: 'own' };
    return { allowed: false, scope: null };
  }

  if (pagePerms?.[action] === true) return { allowed: true, scope: 'all' };
  if (SCOPED_ACTIONS.has(action)) {
    const ownAction = OWN_ACTION_MAP[action as AllScopedAction];
    if (pagePerms?.[ownAction] === true) return { allowed: true, scope: 'own' };
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
  if (!session || !userId)
    throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);

  // Write/mutation actions always verify from DB; read actions use cache
  const shouldForceDB = forceDB || !READ_ACTIONS.has(action);

  if (shouldForceDB) {
    // The session ROW is verified here, not just the user and role.
    //
    // `getSession` is served from Better Auth's cookie cache for up to
    // `cookieCache.maxAge`, and that cached copy stays valid after the row
    // behind it is deleted. Credential rotation (password/email/phone change,
    // admin edit) revokes sessions by deleting rows — so without this join a
    // revoked session kept performing writes for the rest of the cache window,
    // which is precisely what revocation is supposed to prevent. Reloading the
    // user and permissions was not enough: an active user with an active role
    // passed every other check.
    const sessionId = validID(session.session.id);
    if (!sessionId)
      throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);

    // Single query: session + user + role + permissions in one round-trip.
    const rows = await db
      .select({
        roleId: users.roleId,
        roleName: roles.roleName,
        roleScope: roles.scope,
        roleIsActive: roles.isActive,
        pageName: rolePermissions.pageName,
        pagePermissions: rolePermissions.permissions,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .leftJoin(roles, eq(users.roleId, roles.id))
      .leftJoin(rolePermissions, eq(roles.id, rolePermissions.roleId))
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.userId, userId),
          gt(sessions.expiresAt, sql`now()`),
          isNull(users.deletedAt),
          eq(users.isActive, true)
        )
      );

    // Covers both "user is gone/inactive" and "this session was revoked".
    const [sessionRow] = rows;
    if (!sessionRow)
      throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);

    const roleId = sessionRow.roleId;
    if (!roleId)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    if (sessionRow.roleIsActive === false)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    const rolePerms = rows.flatMap((r) =>
      r.pageName == null
        ? []
        : [{ pageName: r.pageName, permissions: r.pagePermissions }]
    );

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
      session,
      userId,
      sessionId: validID(session.session.id),
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
    session,
    userId,
    sessionId: validID(session.session.id),
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
  if (!session || !userId)
    throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);

  const hasWriteAction = checks.some((c) => !READ_ACTIONS.has(c.action));
  const shouldForceDB = forceDB || hasWriteAction;

  let roleId: EntityID | null = validID(session?.user.roleId) ?? null;

  if (shouldForceDB) {
    // Same revocation check as `checkUserPermission` — this path authorizes
    // writes too, so a revoked session must not survive here either.
    await assertLiveSession(session?.session.id, userId);

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
    session,
    userId,
    sessionId: validID(session.session.id),
  };
}
