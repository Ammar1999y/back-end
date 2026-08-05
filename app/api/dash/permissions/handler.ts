import { and, count, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { parseDataTableParams } from '@/db/queries/data-table';
import { rolePermissions, roles } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { auditLog, getAuditMeta } from '@/lib/audit';
import { requirePermission } from '@/lib/http/session';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';
import {
  CUSTOM_ROLE_VALUE,
  PermissionAction,
  ROLE_SCOPE,
} from '@/lib/permissions/constants';
import {
  diffPermissionMatrices,
  PERMISSION_AUDIT_VERSION,
  validatePermissionScope,
} from '@/lib/permissions/utils';

import type { FilterColumnSpecs } from '@/lib/data-table/column-specs';
import type { Handler } from '@/lib/http/contract';

import {
  HTTP_STATUS,
  MSG_CREATE_ERROR,
  MSG_CREATED,
  MSG_FETCH_ERROR,
  MSG_FETCHED,
} from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  requireJsonBody,
  handlePermissionUniqueViolation,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { adminCreatePermissionSchema } from '@/utils/validation/permissions';

import { permissionMsg } from './messages';

// See USERS_FILTER_COLUMNS for why the scan-only operator is permitted here.
const PERMISSIONS_FILTER_COLUMNS: FilterColumnSpecs = {
  roleName: { type: 'text', allowScanOnly: true },
  description: { type: 'text', allowScanOnly: true },
  isActive: { type: 'boolean' },
  createdAt: { type: 'date' },
  updatedAt: { type: 'date' },
};

export const GET: Handler = async (ctx) => {
  try {
    const { userId, scope } = await requirePermission(ctx, {
      resource: 'permissions',
      action: 'view',
    });

    await enforceRateLimit({
      scope: 'permissions.get',
      identifier: userIdentifier(userId),
      limit: 60,
    });

    const { where, orderBy, limit, offset, page, perPage, buildPageCount } =
      parseDataTableParams(roles, {
        url: ctx.url,
        filterableColumns: PERMISSIONS_FILTER_COLUMNS,
        searchableColumns: ['roleName', 'description'],
        defaultSort: { id: 'createdAt', desc: true },
      });

    const baseFilter = and(
      eq(roles.scope, ROLE_SCOPE.STANDARD),
      scope === 'own' ? eq(roles.createdBy, userId) : undefined,
      where
    );

    const [rolesWithCounts, [{ total }]] = await Promise.all([
      db
        .select({
          id: roles.id,
          roleName: roles.roleName,
          description: roles.description,
          isActive: roles.isActive,
          createdAt: roles.createdAt,
          updatedAt: roles.updatedAt,
          usersCount: sql<number>`(
            SELECT COUNT(*) FROM users
            WHERE role_id = ${roles.id} AND deleted_at IS NULL
          )`.mapWith(Number),
        })
        .from(roles)
        .where(baseFilter)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(roles).where(baseFilter),
    ]);

    return apiSuccess({
      message: MSG_FETCHED,
      data: rolesWithCounts,
      meta: {
        page,
        perPage,
        total,
        pageCount: buildPageCount(total),
      },
    });
  } catch (error) {
    return handleApiError(error, MSG_FETCH_ERROR);
  }
};

export const POST: Handler = async (ctx) => {
  try {
    const {
      session,
      userId: actorUserId,
      permissions: actorPermissions,
    } = await requirePermission(ctx, {
      resource: 'permissions',
      action: 'create',
    });

    await enforceRateLimit({
      scope: 'permissions.post',
      identifier: userIdentifier(actorUserId),
      limit: 20,
      failClosed: true,
    });

    const body = requireJsonBody(ctx.body);

    // Strict server contract: unknown keys are rejected rather than stripped.
    const validatedDataParsed = adminCreatePermissionSchema.safeParse(body);
    if (!validatedDataParsed.success)
      throw new CustomError(
        validatedDataParsed.error.issues[0].message,
        HTTP_STATUS.UNPROCESSABLE
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

    const newId = await withTransaction(async (tx) => {
      const [newRole] = await tx
        .insert(roles)
        .values({
          roleName: validatedData.roleName,
          description: validatedData.description,
          isActive: validatedData.isActive,
          createdBy: actorUserId,
        })
        .returning({ id: roles.id });

      const newPermissionsForAudit: Array<{
        pageName: string;
        permissions: unknown;
      }> = [];

      if (validatedData.permissions && validatedData.permissions.length > 0) {
        const permissionsData = validatedData.permissions.map((p) => ({
          roleId: newRole.id,
          pageName: p.name,
          permissions: p.permissions as Record<PermissionAction, boolean>,
        }));
        await tx.insert(rolePermissions).values(permissionsData);
        newPermissionsForAudit.push(
          ...permissionsData.map((p) => ({
            pageName: p.pageName as string,
            permissions: p.permissions as unknown,
          }))
        );
      }

      await auditLog(tx, {
        userId: actorUserId,
        userEmail: session.user.email,
        action: 'INSERT',
        tableName: 'roles',
        recordId: newRole.id,
        newData: {
          auditVersion: PERMISSION_AUDIT_VERSION,
          roleName: validatedData.roleName,
          description: validatedData.description,
          isActive: validatedData.isActive,
          // Same `{ pageName, permissions }` shape and `changedPermissions`
          // summary the update and custom-role events use. The request payload
          // keys pages as `name`, so it is mapped rather than stored verbatim.
          ...(newPermissionsForAudit.length && {
            permissions: newPermissionsForAudit,
            changedPermissions: diffPermissionMatrices([], newPermissionsForAudit),
          }),
        },
        meta: auditMeta,
      });

      return newRole.id;
    });

    return apiSuccess({
      message: MSG_CREATED,
      data: { id: newId },
      status: HTTP_STATUS.CREATED,
    });
  } catch (error) {
    // Only a KNOWN constraint becomes a 409; an unrecognized one falls
    // through to the 500 path so the schema/code mismatch is visible.
    const conflict = handlePermissionUniqueViolation(error, {
      nameExists: permissionMsg.nameExists,
      duplicatePagePermission: permissionMsg.duplicatePagePermission,
    });
    if (conflict) return conflict;
    return handleApiError(error, MSG_CREATE_ERROR);
  }
};
