import type {
  DashboardPage,
  PermissionAction,
  PermissionObject,
  SessionMetadata,
} from './constants';
import type { WsTx } from '@/db/ws';

import { and, eq, isNull, ne, sql } from 'drizzle-orm';

import { db } from '@/db';
import { rolePermissions, roles, users } from '@/db/schema';
import { EntityID } from '@/types';
import { v7 as uuidv7 } from 'uuid';

import {
  HTTP_STATUS,
  MSG_CANNOT_GRANT_UNOWNED_PERMISSIONS,
  MSG_NOT_FOUND,
} from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

import {
  CUSTOM_ROLE_VALUE,
  DASHBOARD_PAGES,
  DEFAULT_PAGE_PERMISSIONS,
  PERMISSION_ACTIONS,
  ROLE_SCOPE,
} from './constants';

type DbOrTx = typeof db | WsTx;
type RolePolicyTarget =
  | { roleName?: string | null; scope?: string | null }
  | null
  | undefined;

/**
 * Reusable predicate for roles that are editable/visible in dashboard handlers.
 * Excludes system-scope roles (created by the developer, not editable via dashboard).
 */
export function nonSystemRoleFilter() {
  return ne(roles.scope, ROLE_SCOPE.SYSTEM);
}

/**
 * Runtime guard for fetched role objects.
 */
export function isProtectedSystemRole(role: RolePolicyTarget): boolean {
  return role?.scope === ROLE_SCOPE.SYSTEM;
}

/**
 * Reusable filter: only standard-scope roles.
 * Use in all queries that should exclude system/custom roles.
 */
export function standardRoleFilter(roleId: EntityID) {
  return and(eq(roles.id, roleId), eq(roles.scope, ROLE_SCOPE.STANDARD));
}

/**
 * Create a custom role with permissions inside a transaction.
 * If existingRoleId is provided, reuses it (clears old permissions first) and
 * leaves the existing `createdBy` untouched.
 * Otherwise creates a new role with scope='custom' stamped with `createdBy`.
 */
export async function createCustomRole(
  tx: WsTx,
  permissions: Array<{
    name: DashboardPage;
    permissions: Record<string, boolean>;
  }>,
  existingRoleId?: EntityID | null,
  createdBy?: EntityID
): Promise<EntityID> {
  let roleId: EntityID;

  if (existingRoleId) {
    roleId = existingRoleId;
    // Lock the role row to prevent concurrent reads from seeing empty permissions
    await tx
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.id, roleId))
      .for('update');
    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
  } else {
    const [customRole] = await tx
      .insert(roles)
      .values({
        roleName: `custom-${uuidv7()}`,
        scope: CUSTOM_ROLE_VALUE,
        isActive: true,
        createdBy: createdBy ?? null,
      })
      .returning({ id: roles.id });
    roleId = customRole.id;
  }

  const permsData = permissions.map((p) => ({
    roleId,
    pageName: p.name,
    permissions: p.permissions as Record<PermissionAction, boolean>,
  }));
  await tx.insert(rolePermissions).values(permsData);

  return roleId;
}

/**
 * Validate that a role ID refers to an assignable role:
 * - Exists in the database
 * - Is active
 * - Has 'standard' scope (not system/custom)
 */
export async function validateAssignableRole(
  roleId: EntityID,
  tx: WsTx
): Promise<void> {
  // FOR SHARE prevents role deactivation/deletion between validation and assignment
  const [role] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(and(standardRoleFilter(roleId), eq(roles.isActive, true)))
    .for('share');
  if (!role) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
}

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
      DEFAULT_PAGE_PERMISSIONS.find((p) => p.name === perm.pageName)
        ?.availablePermissions || [];

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
 * Normalize permissions to include ALL dashboard pages with ALL actions.
 * Missing pages/actions default to false — ensures consistent comparison.
 */
export function normalizeFullPermissions(
  rolePerms: Array<{ pageName: string; permissions: unknown }>
): PermissionObject {
  const sanitized = sanitizePermissions(rolePerms);
  const full = {} as PermissionObject;

  for (const page of DEFAULT_PAGE_PERMISSIONS) {
    const pagePerms = {} as Record<PermissionAction, boolean>;
    for (const action of ALL_ACTIONS)
      pagePerms[action] = sanitized[page.name]?.[action] === true;
    full[page.name] = pagePerms;
  }

  return full;
}

/**
 * Compare two sets of role permissions for semantic equality. Normalises
 * into the full dashboard-page matrix first so ordering, missing pages, and
 * missing actions can't produce false negatives.
 */
export function permissionsEqual(
  a: Array<{ pageName: string; permissions: unknown }>,
  b: Array<{ pageName: string; permissions: unknown }>
): boolean {
  const toKey = (
    rows: Array<{ pageName: string; permissions: unknown }>
  ) => {
    const normalized = normalizeFullPermissions(rows);
    return JSON.stringify(
      Object.entries(normalized)
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([pageName, permissions]) => [
          pageName,
          Object.entries(permissions).sort(([x], [y]) => x.localeCompare(y)),
        ])
    );
  };
  return toKey(a) === toKey(b);
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
  roleId: EntityID | null;
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

  const roleData = await db.query.roles.findFirst({
    where: (rolesTable, { eq, and }) =>
      and(eq(rolesTable.id, roleId), eq(rolesTable.isActive, true)),
    columns: {},
    with: {
      rolePermissions: {
        columns: { pageName: true, permissions: true },
      },
    },
  });

  if (!roleData?.rolePermissions) return {};

  return sanitizePermissions(roleData.rolePermissions);
}

/**
 * Validate that the acting user holds all permissions they are trying to grant.
 * Compares each `true` permission in `targetPermissions` against the acting user's own permissions.
 * Throws if any granted permission is not held by the acting user.
 */
export function validatePermissionScope(
  actorPermissions: Partial<PermissionObject>,
  targetPermissions: Array<{
    name: DashboardPage;
    permissions: Record<string, boolean>;
  }>
): void {
  for (const target of targetPermissions) {
    const actorPagePerms = actorPermissions[target.name];

    for (const [action, granted] of Object.entries(target.permissions)) {
      if (
        granted === true &&
        actorPagePerms?.[action as PermissionAction] !== true
      )
        throw new CustomError(
          MSG_CANNOT_GRANT_UNOWNED_PERMISSIONS,
          HTTP_STATUS.FORBIDDEN
        );
    }
  }
}

/**
 * Validate that the acting user holds all permissions of a standard role.
 * Fetches the role's permissions from DB and compares against the actor's permissions.
 * Acquires FOR SHARE lock on rolePermissions rows to prevent concurrent modification.
 */
export async function validateRolePermissionScope(
  actorPermissions: Partial<PermissionObject>,
  roleId: EntityID,
  executor: DbOrTx
): Promise<void> {
  const perms = await executor
    .select({
      pageName: rolePermissions.pageName,
      permissions: rolePermissions.permissions,
    })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId))
    .for('share');

  if (!perms.length) return;

  const targetPerms = perms.map((p) => ({
    name: p.pageName as DashboardPage,
    permissions: (p.permissions || {}) as Record<string, boolean>,
  }));

  validatePermissionScope(actorPermissions, targetPerms);
}

/**
 * Refresh session metadata for all users with a specific role.
 * Updates permissions in-place without invalidating sessions (users stay logged in).
 * When `precomputed` is provided, skips the DB read for role data.
 */
export async function refreshRoleSessions(
  roleId: EntityID,
  tx: WsTx,
  precomputed?: {
    roleName: string;
    roleScope: string;
    permissions: Partial<PermissionObject>;
  }
): Promise<void> {
  let roleName: string;
  let roleScope: string;
  let permissions: Partial<PermissionObject>;

  if (precomputed) {
    roleName = precomputed.roleName;
    roleScope = precomputed.roleScope;
    permissions = precomputed.permissions;
  } else {
    const roleData = await tx.query.roles.findFirst({
      where: (rolesTable, { eq }) => eq(rolesTable.id, roleId),
      columns: { roleName: true, scope: true },
      with: {
        rolePermissions: {
          columns: { pageName: true, permissions: true },
        },
      },
    });

    if (!roleData) return;

    roleName = roleData.roleName;
    roleScope = roleData.scope;
    permissions = sanitizePermissions(roleData.rolePermissions);
  }

  const metadataPatch = JSON.stringify({
    roleName,
    roleScope,
    permissions,
    roleId,
  });

  await tx.execute(sql`
    UPDATE sessions
    SET metadata = COALESCE(metadata, '{}'::jsonb) || ${metadataPatch}::jsonb,
        updated_at = NOW()
    WHERE user_id IN (
      SELECT id FROM users WHERE role_id = ${roleId} AND deleted_at IS NULL AND is_active = true
    )
    AND expires_at > NOW()
  `);
}

/**
 * Refresh session metadata for a specific user.
 * Fetches the user's current role and updates permissions in-place.
 */
export async function refreshUserSessions(
  userId: EntityID,
  tx?: WsTx
): Promise<void> {
  const executor: DbOrTx = tx ?? db;

  const userData = await executor.query.users.findFirst({
    where: and(eq(users.id, userId), isNull(users.deletedAt)),
    columns: { roleId: true },
    with: {
      role: {
        columns: { roleName: true, scope: true },
        with: {
          rolePermissions: {
            columns: { pageName: true, permissions: true },
          },
        },
      },
    },
  });

  if (!userData?.role) return;

  const permissions = sanitizePermissions(userData.role.rolePermissions);

  const metadataPatch = JSON.stringify({
    roleId: userData.roleId,
    roleName: userData.role.roleName,
    roleScope: userData.role.scope,
    permissions,
  });

  await executor.execute(sql`
    UPDATE sessions
    SET metadata = COALESCE(metadata, '{}'::jsonb) || ${metadataPatch}::jsonb,
        updated_at = NOW()
    WHERE user_id = ${userId}
    AND expires_at > NOW()
  `);
}
