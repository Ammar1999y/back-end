import type { PermissionAction } from '@/lib/permissions/constants';

import { headers } from 'next/headers';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { db } from '@/db';
import { rolePermissions, roles, sessions, users } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { isUniqueViolation, validID } from '@/utils';
import { auditLog } from '@/lib/audit';
import { checkUserPermission } from '@/lib/permissions/checker';
import {
  CUSTOM_ROLE_VALUE,
  ROLE_SCOPE,
} from '@/lib/permissions/constants';
import {
  normalizeFullPermissions,
  refreshRoleSessions,
  sanitizePermissions,
  standardRoleFilter,
  validatePermissionScope,
  validateRolePermissionScope,
} from '@/lib/permissions/utils';

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
  parseJsonBody,
  resolvePermissionUniqueViolation,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { updatePermissionSchema } from '@/utils/validation/permissions';
import { idRequired } from '@/utils/validation/rules';

import { permissionMsg } from '../messages';

function comparablePermissionsJSON(
  rows: Array<{ pageName: string; permissions: Record<string, boolean> }>
) {
  const normalized = normalizeFullPermissions(rows);

  return JSON.stringify(
    Object.entries(normalized)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([pageName, permissions]) => [
        pageName,
        Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b)),
      ])
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await checkUserPermission({
      headers: await headers(),
      resource: 'permissions',
      action: 'view',
    });

    const { id: _id } = await params;
    const roleId = validID(_id);
    if (!roleId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);

    const roleData = await db.query.roles.findFirst({
      where: (roles, { eq, and }) =>
        and(
          eq(roles.id, roleId),
          eq(roles.scope, ROLE_SCOPE.STANDARD)
        ),
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
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const {
      session,
      permissions: actorPermissions,
      roleId: actorRoleId,
    } = await checkUserPermission({
      headers: await headers(),
      resource: 'permissions',
      action: 'edit',
    });
    const { id } = await params;

    const body = await parseJsonBody(request);

    const validatedDataParsed = updatePermissionSchema.safeParse({
      ...body,
      id,
    });

    if (!validatedDataParsed.success)
      throw new CustomError(
        validatedDataParsed.error.issues[0].message,
        HTTP_STATUS.UNPROCESSABLE
      );

    const roleId = validatedDataParsed.data.id;

    if (actorRoleId === roleId)
      throw new CustomError(
        permissionMsg.cannotEditOwnRole,
        HTTP_STATUS.FORBIDDEN
      );
    const validatedData = validatedDataParsed.data;

    if (validatedData.roleName.startsWith(CUSTOM_ROLE_VALUE))
      throw new CustomError(
        permissionMsg.customPrefixForbidden(CUSTOM_ROLE_VALUE),
        HTTP_STATUS.BAD_REQUEST
      );

    // Actor cannot grant permissions they don't hold
    if (actorPermissions && validatedData.permissions?.length) {
      validatePermissionScope(actorPermissions, validatedData.permissions);
    }

    await withTransaction(async (tx) => {
      let permissionsChanged = false;
      const [existingRole] = await tx
        .select({
          id: roles.id,
          isActive: roles.isActive,
          roleName: roles.roleName,
          description: roles.description,
        })
        .from(roles)
        .where(standardRoleFilter(roleId))
        .for('update');

      if (!existingRole?.id)
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

      // Actor must hold all permissions the role currently has before any edit
      if (actorPermissions) {
        await validateRolePermissionScope(actorPermissions, roleId, tx);
      }

      // Deactivation has same effect as deletion (session wipe) — require delete permission
      if (
        existingRole.isActive &&
        validatedData.isActive === false &&
        actorPermissions?.['permissions']?.['delete'] !== true
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
        .returning({ id: roles.id });

      if (!roleUpdated)
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

      // Capture old permissions before any mutation for audit trail
      let oldPermissionsForAudit: Array<{
        pageName: string;
        permissions: unknown;
      }> = [];

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

        permissionsChanged =
          comparablePermissionsJSON(
            existingPermissions.map((p) => ({
              pageName: p.pageName,
              permissions: p.permissions as Record<string, boolean>,
            }))
          ) !==
          comparablePermissionsJSON(
            permissionsData.map((p) => ({
              pageName: p.pageName,
              permissions: p.permissions,
            }))
          );

        if (permissionsChanged) {
          // Save old permissions before deleting them
          oldPermissionsForAudit = existingPermissions.map((p) => ({
            pageName: p.pageName,
            permissions: p.permissions,
          }));

          await tx
            .delete(rolePermissions)
            .where(eq(rolePermissions.roleId, roleId));

          await tx.insert(rolePermissions).values(permissionsData);
        }
      }

      await auditLog(tx, {
        userId: session!.user.id,
        userEmail: session!.user.email,
        action: 'UPDATE',
        tableName: 'roles',
        recordId: roleId,
        oldData: {
          roleName: existingRole.roleName,
          description: existingRole.description,
          isActive: existingRole.isActive,
          ...(permissionsChanged && {
            permissions: oldPermissionsForAudit,
          }),
        },
        newData: {
          roleName: validatedData.roleName,
          description: validatedData.description,
          isActive: validatedData.isActive,
          permissionsChanged,
        },
        request,
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
        validatedData.roleName !== existingRole.roleName ||
        permissionsChanged
      ) {
        // Pass pre-computed metadata when permissions were provided to avoid re-reading from DB
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
    });

    return apiSuccess({ message: MSG_UPDATED });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return handleApiError(
        new CustomError(
          resolvePermissionUniqueViolation(error, {
            nameExists: permissionMsg.nameExists,
            duplicatePagePermission: permissionMsg.duplicatePagePermission,
            fallback: MSG_UPDATE_ERROR,
          }),
          HTTP_STATUS.CONFLICT
        )
      );
    }
    return handleApiError(error, MSG_UPDATE_ERROR);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { session, permissions: actorPermissions } =
      await checkUserPermission({
        headers: await headers(),
        resource: 'permissions',
        action: 'delete',
      });

    const { id: _id } = await params;
    const roleId = validID(_id);
    if (!roleId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);

    await withTransaction(async (tx) => {
      const [existingRole] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(standardRoleFilter(roleId))
        .for('update');
      if (!existingRole)
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

      // Enforce scope — actor must hold all permissions the role contains
      if (actorPermissions) {
        await validateRolePermissionScope(actorPermissions, roleId, tx);
      }

      // Atomic delete — eliminates race between EXISTS check and DELETE
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

      if (deleted.rows.length === 0)
        throw new CustomError(permissionMsg.hasUsers, HTTP_STATUS.BAD_REQUEST);

      await auditLog(tx, {
        userId: session!.user.id,
        userEmail: session!.user.email,
        action: 'DELETE',
        tableName: 'roles',
        recordId: roleId,
        request,
      });
    });

    return apiSuccess({ message: MSG_DELETED });
  } catch (error) {
    return handleApiError(error, MSG_DELETE_ERROR);
  }
}
