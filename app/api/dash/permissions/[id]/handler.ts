import type { Handler } from '@/lib/http/contract';
import type {
  DashboardPage,
  PermissionAction,
} from '@/lib/permissions/constants';

import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  sql,
} from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { rolePermissions, roles, sessions, users } from '@/db/schema';
import { validID } from '@/utils';
import { auditLog, getAuditMeta } from '@/lib/audit';
import { requirePermission } from '@/lib/http/session';
import {
  CUSTOM_ROLE_VALUE,
  REQUIRE_ROLE_FOR_LOGIN,
  ROLE_SCOPE,
} from '@/lib/permissions/constants';
import {
  diffPermissionMatrices,
  PERMISSION_AUDIT_METADATA_FIELDS,
  PERMISSION_AUDIT_VERSION,
  permissionsEqual,
  refreshRoleSessions,
  sanitizePermissions,
  standardRoleFilter,
  validatePermissionScope,
  validateRolePermissionScope,
} from '@/lib/permissions/utils';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import {
  HTTP_STATUS,
  MSG_DELETE_ERROR,
  MSG_DELETED,
  MSG_FETCH_ERROR,
  MSG_FETCHED,
  MSG_INSUFFICIENT_PERMISSIONS,
  MSG_NOT_FOUND,
  MSG_UPDATE_ERROR,
  MSG_UPDATED,
} from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  handlePermissionUniqueViolation,
  requireJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { adminUpdatePermissionSchema } from '@/utils/validation/permissions';
import { idRequired, zodIssueMessage } from '@/utils/validation/rules';

import { permissionMsg } from '../messages';

export const GET: Handler = async (ctx) => {
  try {
    const { userId, scope } = await requirePermission(ctx, {
      resource: 'permissions',
      action: 'view',
    });

    await enforceRateLimit({
      scope: 'permissions.id.get',
      identifier: userIdentifier(userId),
      limit: 60,
    });

    const roleId = validID(ctx.params.id);
    if (!roleId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);

    const roleData = await db.query.roles.findFirst({
      where: (roles, { eq, and }) =>
        and(eq(roles.id, roleId), eq(roles.scope, ROLE_SCOPE.STANDARD)),
      columns: {
        id: true,
        roleName: true,
        description: true,
        isActive: true,
        createdBy: true,
      },
      with: {
        rolePermissions: {
          columns: {
            pageName: true,
            permissions: true,
          },
        },
      },
    });

    if (!roleData) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    if (scope === 'own' && roleData.createdBy !== userId)
      throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    return apiSuccess({
      message: MSG_FETCHED,
      data: {
        id: roleData.id,
        roleName: roleData.roleName,
        description: roleData.description,
        isActive: roleData.isActive,
        permissions: roleData.rolePermissions.map((p) => ({
          name: p.pageName,
          permissions: p.permissions,
        })),
      },
    });
  } catch (error) {
    return handleApiError(error, MSG_FETCH_ERROR);
  }
};

export const PUT: Handler = async (ctx) => {
  try {
    const {
      session,
      userId: actorUserId,
      permissions: actorPermissions,
      roleId: actorRoleId,
      scope: editScope,
    } = await requirePermission(ctx, {
      resource: 'permissions',
      action: 'edit',
    });

    await enforceRateLimit({
      scope: 'permissions.id.put',
      identifier: userIdentifier(actorUserId),
      limit: 20,
      failClosed: true,
    });

    const body = requireJsonBody(await ctx.readJson());

    // Strict server contract: unknown keys are rejected rather than stripped.
    const validatedDataParsed = adminUpdatePermissionSchema.safeParse({
      ...body,
      id: ctx.params.id,
    });

    if (!validatedDataParsed.success)
      throw new CustomError(
        zodIssueMessage(validatedDataParsed.error),
        HTTP_STATUS.UNPROCESSABLE
      );

    const roleId = validatedDataParsed.data.id;

    if (actorRoleId === roleId)
      throw new CustomError(
        permissionMsg.cannotEditOwnRole,
        HTTP_STATUS.FORBIDDEN
      );
    const validatedData = validatedDataParsed.data;

    if (
      validatedData.roleName.toLowerCase().startsWith(`${CUSTOM_ROLE_VALUE}-`)
    )
      throw new CustomError(
        permissionMsg.customPrefixForbidden(`${CUSTOM_ROLE_VALUE}-`),
        HTTP_STATUS.BAD_REQUEST
      );

    if (actorPermissions && validatedData.permissions?.length) {
      validatePermissionScope(actorPermissions, validatedData.permissions);
    }

    const auditMeta = getAuditMeta(ctx);

    const updated = await withTransaction(async (tx) => {
      const [existingRole] = await tx
        .select({
          id: roles.id,
          isActive: roles.isActive,
          roleName: roles.roleName,
          description: roles.description,
          createdBy: roles.createdBy,
        })
        .from(roles)
        .where(standardRoleFilter(roleId))
        .for('update');

      if (!existingRole?.id)
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

      if (editScope === 'own' && existingRole.createdBy !== actorUserId)
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

      if (actorPermissions) {
        // Reachability: this is the role being EDITED, and 403-vs-404 here
        // told an actor without `permissions.view` which roles outrank them.
        await validateRolePermissionScope(
          actorPermissions,
          roleId,
          tx,
          'reachability'
        );
      }

      const canDeactivate =
        actorPermissions?.['permissions']?.['delete'] === true ||
        (actorPermissions?.['permissions']?.['deleteOwn'] === true &&
          existingRole.createdBy === actorUserId);

      if (
        !canDeactivate &&
        existingRole.isActive &&
        validatedData.isActive === false
      ) {
        throw new CustomError(
          MSG_INSUFFICIENT_PERMISSIONS,
          HTTP_STATUS.FORBIDDEN
        );
      }

      const [roleUpdated] = await tx
        .update(roles)
        .set({
          roleName: validatedData.roleName,
          description: validatedData.description,
          isActive: validatedData.isActive,
        })
        .where(standardRoleFilter(roleId))
        .returning({ id: roles.id, updatedAt: roles.updatedAt });

      if (!roleUpdated)
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

      let oldPermissionsForAudit: Array<{
        pageName: string;
        permissions: unknown;
      }> = [];
      let newPermissionsForAudit: Array<{
        pageName: string;
        permissions: unknown;
      }> = [];

      let permissionsChanged = false;
      if (validatedData?.permissions?.length) {
        const permissionsData = validatedData.permissions.map((p) => ({
          roleId: roleId,
          pageName: p.name,
          permissions: p.permissions as Record<PermissionAction, boolean>,
        }));

        const existingPermissions = await tx
          .select({
            pageName: rolePermissions.pageName,
            permissions: rolePermissions.permissions,
          })
          .from(rolePermissions)
          .where(eq(rolePermissions.roleId, roleId));

        permissionsChanged = !permissionsEqual(
          existingPermissions.map((p) => ({
            pageName: p.pageName,
            permissions: p.permissions as Record<string, boolean>,
          })),
          permissionsData.map((p) => ({
            pageName: p.pageName,
            permissions: p.permissions,
          }))
        );

        if (permissionsChanged) {
          oldPermissionsForAudit = existingPermissions.map((p) => ({
            pageName: p.pageName,
            permissions: p.permissions,
          }));
          newPermissionsForAudit = permissionsData.map((p) => ({
            pageName: p.pageName as string,
            permissions: p.permissions as unknown,
          }));

          // Per-row UPSERT against ux_role_permissions_role_page so unchanged
          // pages keep their created_at and we only rewrite what actually
          // differs. Rows for pages dropped from the payload are deleted in a
          // single follow-up statement.
          await tx
            .insert(rolePermissions)
            .values(permissionsData)
            .onConflictDoUpdate({
              target: [rolePermissions.roleId, rolePermissions.pageName],
              set: { permissions: sql`excluded.permissions` },
            });

          const newPageNames = permissionsData.map((p) => p.pageName);
          await tx
            .delete(rolePermissions)
            .where(
              and(
                eq(rolePermissions.roleId, roleId),
                notInArray(rolePermissions.pageName, newPageNames)
              )
            );
        }
      }

      await auditLog(tx, {
        userId: actorUserId,
        userEmail: session.user.email,
        action: 'UPDATE',
        tableName: 'roles',
        recordId: roleId,
        // Permission matrices use the SAME `{ pageName, permissions }` shape on
        // both sides, plus the same `changedPermissions` summary the custom-role
        // audit emits — one forensic contract for both role types. The request
        // payload uses `name`, so it is mapped rather than stored verbatim.
        oldData: {
          auditVersion: PERMISSION_AUDIT_VERSION,
          roleName: existingRole.roleName,
          description: existingRole.description,
          isActive: existingRole.isActive,
          ...(permissionsChanged && {
            permissions: oldPermissionsForAudit,
          }),
        },
        newData: {
          auditVersion: PERMISSION_AUDIT_VERSION,
          roleName: validatedData.roleName,
          description: validatedData.description,
          isActive: validatedData.isActive,
          ...(permissionsChanged && {
            permissions: newPermissionsForAudit,
            changedPermissions: diffPermissionMatrices(
              oldPermissionsForAudit,
              newPermissionsForAudit
            ),
          }),
        },
        metadataFields: PERMISSION_AUDIT_METADATA_FIELDS,
        meta: auditMeta,
      });

      if (existingRole.isActive && validatedData.isActive === false) {
        await tx.delete(sessions).where(
          inArray(
            sessions.userId,
            tx
              .select({ id: users.id })
              .from(users)
              .where(and(eq(users.roleId, roleId), isNull(users.deletedAt)))
          )
        );
      } else if (
        permissionsChanged ||
        validatedData.roleName !== existingRole.roleName
      ) {
        const precomputed = validatedData?.permissions?.length
          ? {
              roleName: validatedData.roleName,
              roleScope: ROLE_SCOPE.STANDARD,
              permissions: sanitizePermissions(
                validatedData.permissions.map((p) => ({
                  pageName: p.name,
                  permissions: p.permissions,
                }))
              ),
            }
          : undefined;
        await refreshRoleSessions(roleId, tx, precomputed);
      }

      return { updatedAt: roleUpdated.updatedAt };
    });

    // The client reads `updatedAt` off the response to refresh its cache;
    // returning `data: null` made it throw and surface as a false 503.
    return apiSuccess({ message: MSG_UPDATED, data: updated });
  } catch (error) {
    // Only a KNOWN constraint becomes a 409; an unrecognized one falls
    // through to the 500 path so the schema/code mismatch is visible.
    const conflict = handlePermissionUniqueViolation(error, {
      nameExists: permissionMsg.nameExists,
      duplicatePagePermission: permissionMsg.duplicatePagePermission,
    });
    if (conflict) return conflict;
    return handleApiError(error, MSG_UPDATE_ERROR);
  }
};

export const DELETE: Handler = async (ctx) => {
  try {
    const {
      session,
      userId: actorUserId,
      permissions: actorPermissions,
      scope: deleteScope,
    } = await requirePermission(ctx, {
      resource: 'permissions',
      action: 'delete',
    });

    await enforceRateLimit({
      scope: 'permissions.id.delete',
      identifier: userIdentifier(actorUserId),
      limit: 10,
      failClosed: true,
    });

    const roleId = validID(ctx.params.id);
    if (!roleId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);

    const auditMeta = getAuditMeta(ctx);

    await withTransaction(async (tx) => {
      const [existingRole] = await tx
        .select({
          id: roles.id,
          roleName: roles.roleName,
          description: roles.description,
          isActive: roles.isActive,
          createdBy: roles.createdBy,
        })
        .from(roles)
        .where(standardRoleFilter(roleId))
        .for('update');
      if (!existingRole)
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

      if (deleteScope === 'own' && existingRole.createdBy !== actorUserId)
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

      const existingPermissions = await tx
        .select({
          pageName: rolePermissions.pageName,
          permissions: rolePermissions.permissions,
        })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, roleId))
        .for('share');

      if (actorPermissions) {
        const targetPerms = existingPermissions.map((p) => ({
          name: p.pageName as DashboardPage,
          permissions: (p.permissions || {}) as Record<string, boolean>,
        }));
        validatePermissionScope(actorPermissions, targetPerms);
      }

      // When REQUIRE_ROLE_FOR_LOGIN is on, the FK is RESTRICT — soft-deleted
      // users still pinning role_id would block the role DELETE with an FK
      // violation. Null them out first so the DELETE proceeds. With the flag
      // off the FK is `set null` and Postgres handles this on its own.
      //
      // FOR UPDATE on every user pinning this role first: under READ
      // COMMITTED a concurrent restore (`deleted_at = NULL`) committing
      // between our UPDATE-soft-deleted and the DELETE-not-exists check
      // would either trip the RESTRICT FK or leave the restored user with
      // role_id = NULL. Locking serialises the restore against this delete.
      if (REQUIRE_ROLE_FOR_LOGIN) {
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.roleId, roleId))
          .for('update');

        await tx
          .update(users)
          .set({ roleId: null })
          .where(and(eq(users.roleId, roleId), isNotNull(users.deletedAt)));
      }

      // SYNC: scope condition mirrors standardRoleFilter() in lib/permissions/utils.ts
      const deleted = await tx.execute(sql`
        DELETE FROM roles r
        WHERE r.id = ${roleId}
          AND r.scope = ${ROLE_SCOPE.STANDARD}
          AND NOT EXISTS (
            SELECT 1 FROM users u
            WHERE u.role_id = r.id AND u.deleted_at IS NULL
          )
        RETURNING r.id
      `);

      if (deleted.length === 0)
        throw new CustomError(permissionMsg.hasUsers, HTTP_STATUS.BAD_REQUEST);

      await auditLog(tx, {
        userId: actorUserId,
        userEmail: session.user.email,
        action: 'DELETE',
        tableName: 'roles',
        recordId: roleId,
        // Same field set the UPDATE and custom-role events record, so a
        // deleted role can be reconstructed from its own event: the snapshot
        // used to omit isActive/scope/createdBy that every sibling kept.
        oldData: {
          auditVersion: PERMISSION_AUDIT_VERSION,
          scope: ROLE_SCOPE.STANDARD,
          roleName: existingRole.roleName,
          description: existingRole.description,
          isActive: existingRole.isActive,
          createdBy: existingRole.createdBy,
          permissions: existingPermissions,
        },
        metadataFields: PERMISSION_AUDIT_METADATA_FIELDS,
        meta: auditMeta,
      });
    });

    return apiSuccess({ message: MSG_DELETED });
  } catch (error) {
    return handleApiError(error, MSG_DELETE_ERROR);
  }
};
