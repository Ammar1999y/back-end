import type {
  DashboardPage,
  PermissionAction,
  PermissionObject,
  SessionMetadata,
} from './constants';

import { eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import type { WsTx } from '@/db/ws';
import { sessions, users } from '@/db/schema';

type DbOrTx = typeof db | WsTx;

import {
  DASHBOARD_PAGES,
  DEFAULT_PAGE_PERMISSIONS,
  PERMISSION_ACTIONS,
} from './constants';

/**
 * Type guard to check if a string is a valid DashboardPage key
 */
function isValidDashboardPage(page: string): page is DashboardPage {
  return page in DASHBOARD_PAGES;
}

const ALL_ACTIONS = Object.keys(PERMISSION_ACTIONS) as PermissionAction[];

/**
 * Sanitize permissions data to only include valid pages and their defined actions.
 * - Unknown pages are excluded
 * - Only actions defined in DEFAULT_PAGE_PERMISSIONS for each page are kept
 * - Unknown/undefined actions default to false
 */
export function sanitizePermissions(
  rolePerms: Array<{ pageName: string; permissions: unknown }>
): Partial<PermissionObject> {
  const sanitized: Partial<PermissionObject> = {};

  for (const perm of rolePerms) {
    if (!isValidDashboardPage(perm.pageName)) continue;

    const availableActions =
      DEFAULT_PAGE_PERMISSIONS.find(
        (p) => p.name === perm.pageName
      )?.availablePermissions || [];

    const rawPerms = (perm.permissions || {}) as Record<string, boolean>;
    const pagePerms = {} as Record<PermissionAction, boolean>;

    for (const action of ALL_ACTIONS) {
      pagePerms[action] = availableActions.includes(action)
        ? rawPerms[action] === true
        : false;
    }

    sanitized[perm.pageName] = pagePerms;
  }

  return sanitized;
}

/**
 * Sanitize cached permissions from session metadata.
 * Converts the PermissionObject format to the array format expected by sanitizePermissions.
 */
function sanitizeCachedPermissions(
  cached: Partial<PermissionObject>
): Partial<PermissionObject> {
  const entries = Object.entries(cached).map(([pageName, perms]) => ({
    pageName,
    permissions: perms,
  }));
  return sanitizePermissions(entries);
}

export async function getUserPermissions({
  roleId,
  session,
  forceDB = false,
}: {
  roleId: string | null;
  session: { metadata?: SessionMetadata | unknown } | null;
  forceDB?: boolean;
}): Promise<Partial<PermissionObject>> {
  // Return sanitized cached permissions if available and not forcing DB lookup
  if (!forceDB && (session?.metadata as SessionMetadata)?.permissions) {
    return sanitizeCachedPermissions(
      (session?.metadata as SessionMetadata).permissions as PermissionObject
    );
  }

  if (!roleId) return {};

  // Fetch role with its permissions
  const roleData = await db.query.roles.findFirst({
    where: (rolesTable, { eq, and }) =>
      and(eq(rolesTable.id, roleId), eq(rolesTable.isActive, true)),
    with: {
      rolePermissions: true,
    },
  });

  if (!roleData?.rolePermissions) return {};

  return sanitizePermissions(roleData.rolePermissions);
}

/**
 * Refresh session metadata for all users with a specific role.
 * Updates permissions in-place without invalidating sessions (users stay logged in).
 */
export async function refreshRoleSessions(
  roleId: string,
  tx?: WsTx
): Promise<void> {
  const executor: DbOrTx = tx ?? db;

  const roleData = await executor.query.roles.findFirst({
    where: (rolesTable, { eq }) => eq(rolesTable.id, roleId),
    columns: { roleName: true },
    with: { rolePermissions: true },
  });

  if (!roleData) return;

  const permissions = sanitizePermissions(roleData.rolePermissions);

  const metadataPatch = JSON.stringify({
    roleName: roleData.roleName,
    permissions,
  });

  await executor.execute(sql`
    UPDATE sessions
    SET metadata = COALESCE(metadata, '{}'::jsonb) || ${metadataPatch}::jsonb
    WHERE user_id IN (
      SELECT id FROM users WHERE role_id = ${roleId}
    )
  `);
}

/**
 * Refresh session metadata for a specific user.
 * Fetches the user's current role and updates permissions in-place.
 */
export async function refreshUserSessions(userId: string): Promise<void> {
  const userData = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { roleId: true },
    with: {
      role: {
        columns: { roleName: true },
        with: { rolePermissions: true },
      },
    },
  });

  if (!userData?.role) return;

  const permissions = sanitizePermissions(userData.role.rolePermissions);

  const metadataPatch = JSON.stringify({
    roleId: userData.roleId,
    roleName: userData.role.roleName,
    permissions,
  });

  await db
    .update(sessions)
    .set({
      metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${metadataPatch}::jsonb`,
    })
    .where(eq(sessions.userId, userId));
}
