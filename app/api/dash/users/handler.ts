import type { FilterColumnSpecs } from '@/lib/data-table/column-specs';
import type { Handler } from '@/lib/http/contract';

import { and, count, eq, isNull } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { parseDataTableParams } from '@/db/queries/data-table';
import { accounts, roles, users } from '@/db/schema';
import { validID } from '@/utils';
import { auditLog, getAuditMeta } from '@/lib/audit';
import { checkPasswordCompromise } from '@/lib/auth/check-password';
import { hashPassword } from '@/lib/auth/password';
import { requirePermission } from '@/lib/http/session';
import { CUSTOM_ROLE_VALUE } from '@/lib/permissions/constants';
import {
  auditCustomRolePermissions,
  createCustomRole,
  nonSystemRoleFilter,
  validateAssignableRole,
  validatePermissionScope,
  validateRolePermissionScope,
} from '@/lib/permissions/utils';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

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
  handleUserForeignKeyViolation,
  handleUserUniqueViolation,
  requireJsonBody,
} from '@/utils/api-response';
import { PHONE_ENABLED } from '@/utils/config';
import { CustomError } from '@/utils/error-class';
import { createUserSchema } from '@/utils/validation/auth';
import { zodIssueMessage } from '@/utils/validation/rules';

import { userMsg } from './messages';

// Server-owned filter contract. Keys are the allowlist; the type decides
// which operators and value shapes are accepted (see lib/data-table/column-specs).
// `allowScanOnly` enables the "does not contain" operator the UI offers. It is
// a guaranteed sequential scan, which is acceptable on a dashboard-sized users
// table; turn it off here first if this table ever grows.
const USERS_FILTER_COLUMNS: FilterColumnSpecs = {
  name: { type: 'text', allowScanOnly: true },
  email: { type: 'text', allowScanOnly: true },
  isActive: { type: 'boolean' },
  createdAt: { type: 'date' },
  updatedAt: { type: 'date' },
};

export const GET: Handler = async (ctx) => {
  try {
    const { userId, scope } = await requirePermission(ctx, {
      resource: 'users',
      action: 'view',
    });

    await enforceRateLimit({
      scope: 'users.get',
      identifier: userIdentifier(userId),
      limit: 60,
    });

    const { where, orderBy, limit, offset, page, perPage, buildPageCount } =
      parseDataTableParams(users, {
        url: ctx.url,
        filterableColumns: USERS_FILTER_COLUMNS,
        searchableColumns: ['name', 'email'],
        defaultSort: { id: 'createdAt', desc: true },
      });

    const baseFilter = and(
      isNull(users.deletedAt),
      nonSystemRoleFilter(),
      scope === 'own' ? eq(users.createdBy, userId) : undefined,
      where
    );

    const [dashboardUsers, [totalRow]] = await Promise.all([
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

    const total = totalRow?.total ?? 0;

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
};

export const POST: Handler = async (ctx) => {
  try {
    const {
      session,
      userId: actorUserId,
      permissions: actorPermissions,
    } = await requirePermission(ctx, { resource: 'users', action: 'create' });

    await enforceRateLimit({
      scope: 'users.post',
      identifier: userIdentifier(actorUserId),
      limit: 20,
      failClosed: true,
    });

    const body = requireJsonBody(await ctx.readJson());

    const validatedDataParsed = createUserSchema.safeParse(body);
    if (!validatedDataParsed.success)
      throw new CustomError(
        zodIssueMessage(validatedDataParsed.error),
        HTTP_STATUS.UNPROCESSABLE
      );

    const validatedData = validatedDataParsed.data;
    const isCustomRole = validatedData.roleId === CUSTOM_ROLE_VALUE;

    if (isCustomRole && actorPermissions?.['permissions']?.['create'] !== true)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    if (actorPermissions && isCustomRole && validatedData.permissions?.length)
      validatePermissionScope(actorPermissions, validatedData.permissions);

    // Run HIBP check before argon2 so we don't pay hashing cost on rejected passwords.
    await checkPasswordCompromise(validatedData.password);

    const hashedPassword = await hashPassword(validatedData.password);
    const auditMeta = getAuditMeta(ctx);

    const newId = await withTransaction(async (tx) => {
      if (!isCustomRole)
        await validateAssignableRole(validID(validatedData.roleId), tx);
      if (actorPermissions && !isCustomRole)
        await validateRolePermissionScope(
          actorPermissions,
          validID(validatedData.roleId),
          tx
        );

      const customPermissions =
        isCustomRole && validatedData.permissions?.length
          ? validatedData.permissions
          : null;

      const assignedRoleId = customPermissions
        ? await createCustomRole(tx, customPermissions, null, actorUserId)
        : validatedData.roleId;

      const [newUser] = await tx
        .insert(users)
        .values({
          name: validatedData.name,
          email: validatedData.email,
          roleId: validID(assignedRoleId),
          isActive: validatedData.isActive,
          createdBy: actorUserId,
          // Admin-set number is unproven → phoneNumberVerified stays false
          // (the DB default). Only persisted when phone is enabled.
          ...(PHONE_ENABLED &&
            validatedData.phoneNumber && {
              phoneNumber: validatedData.phoneNumber,
            }),
        })
        .returning({ id: users.id });

      if (!newUser)
        throw new CustomError(MSG_CREATE_ERROR, HTTP_STATUS.INTERNAL_ERROR);

      const userId = newUser.id;

      await tx.insert(accounts).values({
        accountId: userId,
        providerId: CREDENTIAL_PROVIDER_ID,
        userId: userId,
        password: hashedPassword,
      });

      await auditLog(tx, {
        userId: actorUserId,
        userEmail: session.user.email,
        action: 'INSERT',
        tableName: 'users',
        recordId: userId,
        newData: {
          name: validatedData.name,
          email: validatedData.email,
          roleId: assignedRoleId,
          isActive: validatedData.isActive,
          ...(PHONE_ENABLED &&
            validatedData.phoneNumber && {
              phoneNumber: validatedData.phoneNumber,
            }),
        },
        meta: auditMeta,
      });

      // The user event above records only the role id. Without this the
      // permission matrix a custom role was born with is unrecoverable.
      if (customPermissions)
        await auditCustomRolePermissions(tx, {
          actorUserId,
          actorEmail: session.user.email,
          roleId: validID(assignedRoleId),
          newPermissions: customPermissions.map((p) => ({
            pageName: p.name as string,
            permissions: p.permissions as unknown,
          })),
          targetUserId: userId,
          meta: auditMeta,
        });

      return userId;
    });

    return apiSuccess({
      message: MSG_CREATED,
      data: { id: newId },
      status: HTTP_STATUS.CREATED,
    });
  } catch (error) {
    // Only a KNOWN constraint becomes a 409; an unrecognized one falls
    // through to the 500 path so the schema/code mismatch is visible.
    const conflict = handleUserUniqueViolation(error);
    if (conflict) return conflict;
    const badRole = handleUserForeignKeyViolation(error, {
      roleNotFound: userMsg.roleNotFound,
    });
    if (badRole) return badRole;
    return handleApiError(error, MSG_CREATE_ERROR);
  }
};
