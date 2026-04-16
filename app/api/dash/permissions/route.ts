import { headers } from 'next/headers';
import { and, count, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { parseDataTableParams } from '@/db/queries/data-table';
import { rolePermissions, roles } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { isUniqueViolation } from '@/utils';
import { auditLog } from '@/lib/audit';
import { checkUserPermission } from '@/lib/permissions/checker';
import {
  CUSTOM_ROLE_VALUE,
  PermissionAction,
  ROLE_SCOPE,
} from '@/lib/permissions/constants';
import { validatePermissionScope } from '@/lib/permissions/utils';

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
  parseJsonBody,
  resolvePermissionUniqueViolation,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { createPermissionSchema } from '@/utils/validation/permissions';

import { permissionMsg } from './messages';

const PERMISSIONS_ALLOWED_COLUMNS = new Set([
  'roleName',
  'description',
  'isActive',
  'createdAt',
  'updatedAt',
]);

export async function GET(request: Request) {
  try {
    await checkUserPermission({
      headers: await headers(),
      resource: 'permissions',
      action: 'view',
    });

    const { where, orderBy, limit, offset, page, perPage, buildPageCount } =
      parseDataTableParams(roles, {
        url: request.url,
        allowedColumns: PERMISSIONS_ALLOWED_COLUMNS,
        searchableColumns: ['roleName', 'description'],
        defaultSort: { id: 'createdAt', desc: true },
      });

    const baseFilter = and(eq(roles.scope, ROLE_SCOPE.STANDARD), where);

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
}

export async function POST(request: Request) {
  try {
    const { session, permissions: actorPermissions } =
      await checkUserPermission({
        headers: await headers(),
        resource: 'permissions',
        action: 'create',
      });

    const body = await parseJsonBody(request);

    const validatedDataParsed = createPermissionSchema.safeParse(body);
    if (!validatedDataParsed.success)
      throw new CustomError(
        validatedDataParsed.error.issues[0].message,
        HTTP_STATUS.UNPROCESSABLE
      );

    const validatedData = validatedDataParsed.data;

    if (validatedData.roleName.startsWith(`${CUSTOM_ROLE_VALUE}-`))
      throw new CustomError(
        permissionMsg.customPrefixForbidden(`${CUSTOM_ROLE_VALUE}-`),
        HTTP_STATUS.BAD_REQUEST
      );

    // Actor cannot grant permissions they don't hold
    if (actorPermissions && validatedData.permissions?.length) {
      validatePermissionScope(actorPermissions, validatedData.permissions);
    }

    const newId = await withTransaction(async (tx) => {
      const [newRole] = await tx
        .insert(roles)
        .values({
          roleName: validatedData.roleName,
          description: validatedData.description,
          isActive: validatedData.isActive,
        })
        .returning({ id: roles.id });

      if (validatedData.permissions && validatedData.permissions.length > 0) {
        const permissionsData = validatedData.permissions.map((p) => ({
          roleId: newRole.id,
          pageName: p.name,
          permissions: p.permissions as Record<PermissionAction, boolean>,
        }));
        await tx.insert(rolePermissions).values(permissionsData);
      }

      await auditLog(tx, {
        userId: session!.user.id,
        userEmail: session!.user.email,
        action: 'INSERT',
        tableName: 'roles',
        recordId: newRole.id,
        newData: {
          roleName: validatedData.roleName,
          description: validatedData.description,
          isActive: validatedData.isActive,
          permissions: validatedData.permissions,
        },
        request,
      });

      return newRole.id;
    });

    return apiSuccess({
      message: MSG_CREATED,
      data: { id: newId },
      status: HTTP_STATUS.CREATED,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return handleApiError(
        new CustomError(
          resolvePermissionUniqueViolation(error, {
            nameExists: permissionMsg.nameExists,
            duplicatePagePermission: permissionMsg.duplicatePagePermission,
            fallback: MSG_CREATE_ERROR,
          }),
          HTTP_STATUS.CONFLICT
        )
      );
    }
    return handleApiError(error, MSG_CREATE_ERROR);
  }
}
