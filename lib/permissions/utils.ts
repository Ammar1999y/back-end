import type {
  DashboardPage,
  PermissionAction,
  PermissionObject,
  SessionMetadata,
} from './constants';
import type { WsTx } from '@/db/ws';
import type { EntityID } from '@/types';

import { and, eq, isNull, ne, notInArray, sql } from 'drizzle-orm';

import { db } from '@/db';
import { rolePermissions, roles, users } from '@/db/schema';
import { auditLog } from '@/lib/audit';
import { generateUuidV7 } from '@/lib/id';

import {
  HTTP_STATUS,
  MSG_CANNOT_GRANT_UNOWNED_PERMISSIONS,
  MSG_CREATE_ERROR,
  MSG_NOT_FOUND,
} from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

import {
  CUSTOM_ROLE_VALUE,
  DASHBOARD_PAGES,
  DEFAULT_PAGE_PERMISSIONS,
  PERMISSION_ACTIONS,
  ROLE_SCOPE,
  SUPERSEDING_ACTION,
} from './constants';

type DbOrTx = typeof db | WsTx;
type RolePolicyTarget =
  { roleName?: string | null; scope?: string | null } | null | undefined;

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
    // Lock the role row so concurrent writers serialize.
    //
    // The reason for upsert + prune below is NOT that readers could see an
    // intermediate empty state — under MVCC no other transaction observes this
    // one's uncommitted writes, so that earlier justification was wrong. It is
    // kept because it preserves row identity and timestamps (a DELETE+INSERT
    // resets `created_at` and breaks anything referencing the row), writes only
    // what changed, and keeps the audit diff meaningful.
    await tx
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.id, roleId))
      .for('update');
  } else {
    const [customRole] = await tx
      .insert(roles)
      .values({
        roleName: `custom-${generateUuidV7()}`,
        scope: CUSTOM_ROLE_VALUE,
        isActive: true,
        createdBy: createdBy ?? null,
      })
      .returning({ id: roles.id });

    if (!customRole)
      throw new CustomError(MSG_CREATE_ERROR, HTTP_STATUS.INTERNAL_ERROR);

    roleId = customRole.id;
  }

  const permsData = permissions.map((p) => ({
    roleId,
    pageName: p.name,
    permissions: p.permissions as Record<PermissionAction, boolean>,
  }));

  // Per-row UPSERT against ux_role_permissions_role_page: unchanged pages keep
  // their row and its `created_at`, changed pages are rewritten in place. For a
  // brand-new role there are no conflicts.
  await tx
    .insert(rolePermissions)
    .values(permsData)
    .onConflictDoUpdate({
      target: [rolePermissions.roleId, rolePermissions.pageName],
      set: { permissions: sql`excluded.permissions` },
    });

  // Reusing an existing role: prune pages dropped from the new payload so the
  // final set matches exactly.
  if (existingRoleId) {
    const newPageNames = permsData.map((p) => p.pageName);
    await tx
      .delete(rolePermissions)
      .where(
        and(
          eq(rolePermissions.roleId, roleId),
          notInArray(rolePermissions.pageName, newPageNames)
        )
      );
  }

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
  // `hasOwn`, not `in`: `in` admits `constructor`/`__proto__`, and
  // `sanitized[pageName] =` below would then set the prototype, not a key.
  return Object.hasOwn(DASHBOARD_PAGES, page);
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
  const toKey = (rows: Array<{ pageName: string; permissions: unknown }>) => {
    const normalized = normalizeFullPermissions(rows);
    return JSON.stringify(
      Object.entries(normalized)
        .toSorted(([x], [y]) => x.localeCompare(y))
        .map(([pageName, permissions]) => [
          pageName,
          Object.entries(permissions).toSorted(([x], [y]) =>
            x.localeCompare(y)
          ),
        ])
    );
  };
  return toKey(a) === toKey(b);
}

/**
 * List the `page.action` pairs that differ between two permission sets, in the
 * form `users.delete: false -> true`. Both sides are normalised to the full
 * dashboard matrix first so ordering and missing pages can't fake a change.
 */
export function diffPermissionMatrices(
  before: Array<{ pageName: string; permissions: unknown }>,
  after: Array<{ pageName: string; permissions: unknown }>
): string[] {
  const from = normalizeFullPermissions(before);
  const to = normalizeFullPermissions(after);
  const changed: string[] = [];

  for (const page of DEFAULT_PAGE_PERMISSIONS) {
    for (const action of ALL_ACTIONS) {
      const wasGranted = from[page.name]?.[action] === true;
      const isGranted = to[page.name]?.[action] === true;
      if (wasGranted !== isGranted)
        changed.push(`${page.name}.${action}: ${wasGranted} -> ${isGranted}`);
    }
  }

  return changed;
}

type PermissionAuditRows = Array<{ pageName: string; permissions: unknown }>;

/**
 * Version marker on every role/permission audit payload.
 *
 * Consumers need to know which contract a stored row follows: matrices are
 * recorded as submitted (`{ pageName, permissions }`, listing only the pages
 * involved) with `changedPermissions` carrying the normalised
 * `page.action: before -> after` diff. Storing the full dashboard matrix on
 * every row instead would be mostly zeros and would push large grants past the
 * audit byte cap. Bump this if either side of that contract changes.
 */
export const PERMISSION_AUDIT_VERSION = 1;

/**
 * Keys in a role/permission audit payload that describe the event, not the
 * role. They must not appear in `changedFields` — `forUserId` and
 * `changedPermissions` exist only on the new side, so counting them reported a
 * changed field on every event, including ones that changed nothing.
 */
export const PERMISSION_AUDIT_METADATA_FIELDS = [
  'auditVersion',
  'scope',
  'forUserId',
  'changedPermissions',
] as const;

/**
 * Write the forensic record for a CUSTOM role's permission matrix.
 *
 * Custom roles are created/mutated as a side effect of a user create or
 * update. The user audit row carries no matrix, and an in-place custom edit
 * doesn't even change `role_id` — so without this event there is no way to
 * reconstruct who granted a sensitive permission. Format mirrors the
 * standard-role audit in the permissions endpoints so both role types share
 * one contract.
 */
export async function auditCustomRolePermissions(
  tx: WsTx,
  params: {
    actorUserId: EntityID;
    actorEmail: string;
    roleId: EntityID;
    /** Absent for a freshly created custom role. */
    oldPermissions?: PermissionAuditRows;
    newPermissions: PermissionAuditRows;
    /** The user the custom role belongs to — the reason it exists. */
    targetUserId: EntityID;
    meta: { ip: string | null; userAgent: string | null; apiPath: string };
  }
): Promise<void> {
  const isCreate = params.oldPermissions === undefined;
  const changedPermissions = diffPermissionMatrices(
    params.oldPermissions ?? [],
    params.newPermissions
  );

  await auditLog(tx, {
    userId: params.actorUserId,
    userEmail: params.actorEmail,
    action: isCreate ? 'INSERT' : 'UPDATE',
    tableName: 'roles',
    recordId: params.roleId,
    oldData: isCreate
      ? null
      : {
          auditVersion: PERMISSION_AUDIT_VERSION,
          scope: CUSTOM_ROLE_VALUE,
          permissions: params.oldPermissions,
        },
    newData: {
      auditVersion: PERMISSION_AUDIT_VERSION,
      scope: CUSTOM_ROLE_VALUE,
      forUserId: params.targetUserId,
      permissions: params.newPermissions,
      changedPermissions,
    },
    metadataFields: PERMISSION_AUDIT_METADATA_FIELDS,
    meta: params.meta,
  });
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
/**
 * Does the actor hold `action`, directly or through supersession?
 *
 * `PERMISSION_ACTIONS` states the rule the rest of the system follows: holding
 * `view` makes `viewOwn` redundant, and likewise for edit/delete. An exact-match
 * comparison contradicted it — an actor with `edit` on all records was refused
 * when granting `editOwn`, a strict subset of what they already hold. That is a
 * wrong denial, not a safe default: it blocks legitimate role assignment and
 * hides sessions the actor is entitled to see.
 */
function actorHoldsAction(
  actorPagePerms: Partial<Record<PermissionAction, boolean>> | undefined,
  action: string
): boolean {
  if (actorPagePerms?.[action as PermissionAction] === true) return true;
  const superseding = SUPERSEDING_ACTION[action];
  return !!superseding && actorPagePerms?.[superseding] === true;
}

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
      if (granted === true && !actorHoldsAction(actorPagePerms, action))
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

  if (perms.length === 0) return;

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
