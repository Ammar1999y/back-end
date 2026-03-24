import { headers } from 'next/headers';
import { and, count, eq, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { parseDataTableParams } from '@/db/queries/data-table';
import { accounts, roles, users } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { isForeignKeyViolation, isUniqueViolation } from '@/utils';
import { auditLog } from '@/lib/audit';
import { hashPassword } from '@/lib/auth';
import { checkUserPermission } from '@/lib/permissions/checker';
import { CUSTOM_ROLE_VALUE } from '@/lib/permissions/constants';
import {
  createCustomRole,
  nonSystemRoleFilter,
  validateAssignableRole,
  validatePermissionScope,
  validateRolePermissionScope,
} from '@/lib/permissions/utils';

import {
  CREDENTIAL_PROVIDER_ID,
  HTTP_STATUS,
  MSG_CREATE_ERROR,
  MSG_CREATED,
  MSG_FETCH_ERROR,
  MSG_FETCHED,
  MSG_INSUFFICIENT_PERMISSIONS,
} from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  parseJsonBody,
  resolveUserUniqueViolation,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { createUserSchema } from '@/utils/validation/auth';

import { userMsg } from './messages';

const USERS_ALLOWED_COLUMNS = new Set([
  'name',
  'email',
  'isActive',
  'createdAt',
  'updatedAt',
]);

export async function GET(request: Request) {
  try {
    await checkUserPermission({
      headers: await headers(),
      resource: 'users',
      action: 'view',
    });

    const { where, orderBy, limit, offset, page, perPage, buildPageCount } =
      parseDataTableParams(users, {
        url: request.url,
        allowedColumns: USERS_ALLOWED_COLUMNS,
        searchableColumns: ['name', 'email'],
        defaultSort: { id: 'createdAt', desc: true },
      });

    const baseFilter = and(
      isNull(users.deletedAt),
      nonSystemRoleFilter(),
      where
    );

    //  No transaction needed for read-only queries
    const [dashboardUsers, [{ total }]] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          isActive: users.isActive,
          roleId: users.roleId,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
          role: {
            id: roles.id,
            roleName: roles.roleName,
            scope: roles.scope,
          },
        })
        .from(users)
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(baseFilter)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(users)
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(baseFilter),
    ]);

    return apiSuccess({
      message: MSG_FETCHED,
      data: dashboardUsers.map(({ role, ...u }) => ({
        ...u,
        roleId:
          role?.scope === CUSTOM_ROLE_VALUE ? CUSTOM_ROLE_VALUE : u.roleId,
        role: role ? { id: role.id, roleName: role.roleName } : null,
      })),
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
        resource: 'users',
        action: 'create',
      });

    const body = await parseJsonBody(request);

    const validatedDataParsed = createUserSchema.safeParse(body);
    if (!validatedDataParsed.success)
      throw new CustomError(
        validatedDataParsed.error.issues[0].message,
        HTTP_STATUS.UNPROCESSABLE
      );

    const validatedData = validatedDataParsed.data;
    const isCustomRole = validatedData.roleId === CUSTOM_ROLE_VALUE;

    // Verify actor has permission to manage custom roles (no extra query)
    if (
      isCustomRole &&
      actorPermissions?.['permissions']?.['create'] !== true
    )
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    // Validate custom role permissions synchronously (no DB needed)
    if (actorPermissions && isCustomRole && validatedData.permissions?.length)
      validatePermissionScope(actorPermissions, validatedData.permissions);

    const hashedPassword = await hashPassword(validatedData.password);

    const newId = await withTransaction(async (tx) => {
      if (!isCustomRole) {
        await validateAssignableRole(validatedData.roleId, tx);
      }

      //  Scope check inside transaction — prevents TOCTOU race
      if (actorPermissions && !isCustomRole) {
        await validateRolePermissionScope(
          actorPermissions,
          validatedData.roleId,
          tx
        );
      }

      const assignedRoleId =
        isCustomRole && validatedData.permissions?.length
          ? await createCustomRole(tx, validatedData.permissions)
          : validatedData.roleId;

      const [newUser] = await tx
        .insert(users)
        .values({
          name: validatedData.name,
          email: validatedData.email,
          roleId: assignedRoleId,
          isActive: validatedData.isActive,
        })
        .returning({ id: users.id });

      const userId = newUser.id;

      await tx.insert(accounts).values({
        accountId: userId,
        providerId: CREDENTIAL_PROVIDER_ID,
        userId: userId,
        password: hashedPassword,
      });

      await auditLog(tx, {
        userId: session!.user.id,
        userEmail: session!.user.email,
        action: 'INSERT',
        tableName: 'users',
        recordId: userId,
        newData: {
          name: validatedData.name,
          email: validatedData.email,
          roleId: assignedRoleId,
          isActive: validatedData.isActive,
        },
        request,
      });

      return userId;
    });

    return apiSuccess({
      message: MSG_CREATED,
      data: { id: newId },
      status: HTTP_STATUS.CREATED,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return handleApiError(
        new CustomError(resolveUserUniqueViolation(error), HTTP_STATUS.CONFLICT)
      );
    }
    //  Concurrent role deletion — surface as friendly 400
    if (isForeignKeyViolation(error)) {
      return handleApiError(
        new CustomError(userMsg.roleNotFound, HTTP_STATUS.BAD_REQUEST)
      );
    }
    return handleApiError(error, MSG_CREATE_ERROR);
  }
}
