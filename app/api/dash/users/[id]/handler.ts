import type { PermissionAction } from '@/lib/permissions/constants';

import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

import { db } from '@/db';
import {
  accounts,
  rolePermissions,
  roles,
  sessions,
  users,
  verificationSessions,
} from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { EntityID } from '@/types';
import {
  getConstraintName,
  isForeignKeyViolation,
  isUniqueViolation,
  validID,
} from '@/utils';
import { auditLog, getAuditMeta } from '@/lib/audit';
import { hashPassword } from '@/lib/auth';
import { checkPasswordCompromise } from '@/lib/auth/check-password';
import { requirePermission } from '@/lib/http/session';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';
import { CUSTOM_ROLE_VALUE } from '@/lib/permissions/constants';
import { checkUserPermission } from '@/lib/permissions/checker';
import {
  createCustomRole,
  isProtectedSystemRole,
  nonSystemRoleFilter,
  normalizeFullPermissions,
  refreshUserSessions,
  validateAssignableRole,
  validatePermissionScope,
  validateRolePermissionScope,
} from '@/lib/permissions/utils';

import type { Handler } from '@/lib/http/contract';

import {
  CREDENTIAL_PROVIDER_ID,
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
  requireJsonBody,
  resolveUserUniqueViolation,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import {
  selfUpdateUserSchema,
  updateUserSchema,
} from '@/utils/validation/auth';
import { EMAIL_MAX } from '@/utils/validation/constants';
import { idRequired } from '@/utils/validation/rules';

import { userMsg } from '../messages';

type AuditMeta = ReturnType<typeof getAuditMeta>;

export const GET: Handler = async (ctx) => {
  try {
    const {
      session,
      allowed,
      permissions: actorViewPermissions,
    } = await requirePermission(ctx, {
      resource: 'users',
      action: 'view',
      throwError: false,
    });

    await enforceRateLimit({
      scope: 'users.id.get',
      identifier: userIdentifier(session!.user.id),
      limit: 60,
    });

    const targetId = validID(ctx.params.id);
    if (!targetId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);

    const currentUserId = validID(session?.user.id);
    const isSelf = currentUserId === targetId;

    if (!isSelf && !allowed)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    if (isSelf && !session?.user.roleId)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    const userData = await db.query.users.findFirst({
      where: (users, { eq, and, isNull }) =>
        and(eq(users.id, targetId), isNull(users.deletedAt)),
      columns: {
        id: true,
        name: true,
        email: true,
        isActive: true,
        roleId: true,
        createdAt: true,
        updatedAt: true,
      },
      with: {
        role: {
          columns: {
            id: true,
            roleName: true,
            scope: true,
          },
          with: {
            rolePermissions: {
              columns: {
                pageName: true,
                permissions: true,
              },
            },
          },
        },
      },
    });

    if (!userData) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    if (isProtectedSystemRole(userData.role))
      throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    if (!userData.roleId)
      throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    const permissions =
      userData.role?.rolePermissions?.map((p) => ({
        name: p.pageName,
        permissions: p.permissions,
      })) || [];

    const canViewSessions =
      isSelf || actorViewPermissions?.users?.edit === true;

    let userSessions:
      | {
          id: EntityID;
          ipAddress: string | null;
          userAgent: string | null;
          createdAt: string;
          isCurrent: boolean;
        }[]
      | undefined;

    if (canViewSessions) {
      const rows = await db
        .select({
          id: sessions.id,
          ipAddress: sessions.ipAddress,
          userAgent: sessions.userAgent,
          createdAt: sessions.createdAt,
        })
        .from(sessions)
        .where(
          and(eq(sessions.userId, targetId), gt(sessions.expiresAt, sql`now()`))
        )
        .orderBy(desc(sessions.createdAt))
        .limit(50);

      const currentSessionId = validID(session?.session.id);
      userSessions = rows.map((s) => ({
        ...s,
        isCurrent: s.id === currentSessionId,
      }));
    }

    return apiSuccess({
      message: MSG_FETCHED,
      data: {
        id: userData.id,
        name: userData.name,
        email: userData.email,
        isActive: userData.isActive,
        roleId:
          userData.role?.scope === CUSTOM_ROLE_VALUE
            ? CUSTOM_ROLE_VALUE
            : userData.roleId,
        role: userData.role
          ? {
              id: userData.role.id,
              roleName: userData.role.roleName,
            }
          : null,
        createdAt: userData.createdAt,
        updatedAt: userData.updatedAt,
        permissions,
        ...(userSessions ? { sessions: userSessions } : {}),
      },
    });
  } catch (error) {
    return handleApiError(error, MSG_FETCH_ERROR);
  }
};

async function handleSelfEdit(
  session: NonNullable<
    Awaited<ReturnType<typeof checkUserPermission>>['session']
  >,
  targetId: EntityID,
  body: Record<string, unknown>,
  auditMeta: AuditMeta
) {
  if (!session.user.roleId)
    throw new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);

  const parsed = selfUpdateUserSchema.safeParse({ ...body, id: targetId });
  if (!parsed.success)
    throw new CustomError(
      parsed.error.issues[0].message,
      HTTP_STATUS.UNPROCESSABLE
    );

  await withTransaction(async (tx) => {
    const [activeUser] = await tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(
        and(
          eq(users.id, targetId),
          isNull(users.deletedAt),
          eq(users.isActive, true)
        )
      )
      .for('update');

    if (!activeUser)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    const [updated] = await tx
      .update(users)
      .set({ name: parsed.data.name })
      .where(and(eq(users.id, targetId), isNull(users.deletedAt)))
      .returning({ id: users.id });

    if (!updated) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    await auditLog(tx, {
      userId: validID(session.user.id),
      userEmail: session.user.email,
      action: 'UPDATE',
      tableName: 'users',
      recordId: targetId,
      oldData: { name: activeUser.name },
      newData: { name: parsed.data.name },
      meta: auditMeta,
    });
  });
}

async function handleAdminEdit(
  session: NonNullable<
    Awaited<ReturnType<typeof checkUserPermission>>['session']
  >,
  actorPermissions: Awaited<
    ReturnType<typeof checkUserPermission>
  >['permissions'],
  targetId: EntityID,
  body: Record<string, unknown>,
  auditMeta: AuditMeta
) {
  const validatedDataParsed = updateUserSchema.safeParse({
    ...body,
    id: targetId,
  });

  if (!validatedDataParsed.success)
    throw new CustomError(
      validatedDataParsed.error.issues[0].message,
      HTTP_STATUS.UNPROCESSABLE
    );

  const userId = validatedDataParsed.data.id;
  const validatedData = validatedDataParsed.data;
  const isCustomRole = validatedData.roleId === CUSTOM_ROLE_VALUE;

  const password = validatedDataParsed.data.password;
  if (password) await checkPasswordCompromise(password);
  const hashedPassword = password ? await hashPassword(password) : null;

  await withTransaction(async (tx) => {
    const [lockedUser] = await tx
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        roleId: users.roleId,
        isActive: users.isActive,
        roleName: roles.roleName,
        roleScope: roles.scope,
      })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .for('update', { of: users });

    if (!lockedUser?.roleId)
      throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    if (
      isProtectedSystemRole({
        roleName: lockedUser.roleName,
        scope: lockedUser.roleScope,
      })
    )
      throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    const isCurrentlyCustom = lockedUser.roleScope === CUSTOM_ROLE_VALUE;

    if (!isCustomRole) {
      await validateAssignableRole(validatedData.roleId as EntityID, tx);
    }

    if (actorPermissions) {
      await validateRolePermissionScope(
        actorPermissions,
        lockedUser.roleId,
        tx
      );

      if (isCustomRole && validatedData.permissions?.length) {
        validatePermissionScope(actorPermissions, validatedData.permissions);
      } else if (!isCustomRole && validatedData.roleId !== lockedUser.roleId) {
        await validateRolePermissionScope(
          actorPermissions,
          validatedData.roleId as EntityID,
          tx
        );
      }
    }

    if (isCustomRole) {
      const required: PermissionAction = isCurrentlyCustom ? 'edit' : 'create';
      if (actorPermissions?.['permissions']?.[required] !== true)
        throw new CustomError(
          MSG_INSUFFICIENT_PERMISSIONS,
          HTTP_STATUS.FORBIDDEN
        );
    }

    let assignedRoleId: EntityID;
    let customPermsChanged = false;

    if (isCustomRole && validatedData.permissions?.length) {
      if (isCurrentlyCustom) {
        const oldPerms = await tx
          .select({
            pageName: rolePermissions.pageName,
            permissions: rolePermissions.permissions,
          })
          .from(rolePermissions)
          .where(eq(rolePermissions.roleId, lockedUser.roleId));

        const oldNorm = normalizeFullPermissions(
          oldPerms.map((p) => ({
            pageName: p.pageName,
            permissions: p.permissions,
          }))
        );
        const newNorm = normalizeFullPermissions(
          validatedData.permissions.map((p) => ({
            pageName: p.name,
            permissions: p.permissions,
          }))
        );

        customPermsChanged =
          JSON.stringify(oldNorm) !== JSON.stringify(newNorm);
      }

      assignedRoleId = await createCustomRole(
        tx,
        validatedData.permissions,
        isCurrentlyCustom ? lockedUser.roleId : null
      );
    } else {
      assignedRoleId = validatedData.roleId as EntityID;
    }

    const emailChanged = lockedUser.email !== validatedData.email;
    const [userUpdated] = await tx
      .update(users)
      .set({
        name: validatedData.name,
        email: validatedData.email,
        isActive: validatedData.isActive,
        roleId: assignedRoleId,
        ...(emailChanged && { emailVerified: false }),
      })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning({ id: users.id });

    if (!userUpdated)
      throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    if (isCurrentlyCustom && lockedUser.roleId !== assignedRoleId) {
      const oldCustomPerms = await tx
        .select({
          pageName: rolePermissions.pageName,
          permissions: rolePermissions.permissions,
        })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, lockedUser.roleId));

      await tx.delete(roles).where(eq(roles.id, lockedUser.roleId));

      await auditLog(tx, {
        userId: validID(session.user.id),
        userEmail: session.user.email,
        action: 'DELETE',
        tableName: 'roles',
        recordId: lockedUser.roleId,
        oldData: { scope: 'custom', permissions: oldCustomPerms },
        meta: auditMeta,
      });
    }

    const roleChanged = lockedUser.roleId !== assignedRoleId;
    const shouldDeleteAllSessions =
      !!password || (lockedUser.isActive && validatedData.isActive === false);
    const shouldRefreshSessions =
      !shouldDeleteAllSessions && (roleChanged || customPermsChanged);

    if (password) {
      const [updated] = await tx
        .update(accounts)
        .set({
          password: hashedPassword,
        })
        .where(
          and(
            eq(accounts.userId, userId),
            eq(accounts.providerId, CREDENTIAL_PROVIDER_ID)
          )
        )
        .returning({ id: accounts.id });

      if (!updated?.id)
        throw new CustomError(
          userMsg.ssoCannotModifyPassword,
          HTTP_STATUS.BAD_REQUEST
        );
    }

    await auditLog(tx, {
      userId: validID(session.user.id),
      userEmail: session.user.email,
      action: 'UPDATE',
      tableName: 'users',
      recordId: userId,
      oldData: {
        name: lockedUser.name,
        email: lockedUser.email,
        roleId: lockedUser.roleId,
        isActive: lockedUser.isActive,
      },
      newData: {
        name: validatedData.name,
        email: validatedData.email,
        roleId: assignedRoleId,
        isActive: validatedData.isActive,
        ...(password ? { passwordChanged: true } : {}),
      },
      meta: auditMeta,
    });

    if (shouldDeleteAllSessions) {
      await tx.delete(sessions).where(eq(sessions.userId, userId));
    } else if (shouldRefreshSessions) {
      await refreshUserSessions(userId, tx);
    }

    if (emailChanged || shouldDeleteAllSessions) {
      await tx
        .delete(verificationSessions)
        .where(eq(verificationSessions.userId, userId));
    }
  });
}

export const PUT: Handler = async (ctx) => {
  try {
    const {
      session,
      allowed,
      permissions: actorPermissions,
    } = await requirePermission(ctx, {
      resource: 'users',
      action: 'edit',
      throwError: false,
    });

    await enforceRateLimit({
      scope: 'users.id.put',
      identifier: userIdentifier(session!.user.id),
      limit: 20,
    });

    const body = requireJsonBody(ctx.body);
    const auditMeta = getAuditMeta(ctx);

    const targetId = validID(ctx.params.id);
    const userId = validID(session?.user.id);
    if (!targetId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);

    if (userId === targetId && !!session?.user.id) {
      await handleSelfEdit(session, targetId, body, auditMeta);
      return apiSuccess({ message: MSG_UPDATED });
    }

    if (!allowed)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    await handleAdminEdit(session!, actorPermissions, targetId, body, auditMeta);
    return apiSuccess({ message: MSG_UPDATED });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return handleApiError(
        new CustomError(resolveUserUniqueViolation(error), HTTP_STATUS.CONFLICT)
      );
    }
    if (isForeignKeyViolation(error)) {
      const constraint = getConstraintName(error);
      if (constraint.includes('role_id')) {
        return handleApiError(
          new CustomError(userMsg.roleNotFound, HTTP_STATUS.BAD_REQUEST)
        );
      }
    }
    return handleApiError(error, MSG_UPDATE_ERROR);
  }
};

export const DELETE: Handler = async (ctx) => {
  try {
    const { session, permissions: actorPermissions } = await requirePermission(
      ctx,
      { resource: 'users', action: 'delete' }
    );

    await enforceRateLimit({
      scope: 'users.id.delete',
      identifier: userIdentifier(session!.user.id),
      limit: 10,
    });

    const userId = validID(ctx.params.id);
    const sessionUserId = validID(session?.user.id);
    if (!userId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);

    if (sessionUserId === userId)
      throw new CustomError(userMsg.cannotDeleteSelf, HTTP_STATUS.BAD_REQUEST);

    const auditMeta = getAuditMeta(ctx);

    await withTransaction(async (tx) => {
      const [lockedUser] = await tx
        .select({ id: users.id, roleId: users.roleId, email: users.email })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .for('update');

      if (!lockedUser?.roleId)
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

      const [userRole] = await tx
        .select({ roleName: roles.roleName, scope: roles.scope })
        .from(roles)
        .where(and(eq(roles.id, lockedUser.roleId), nonSystemRoleFilter()));

      if (!userRole)
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

      if (actorPermissions) {
        await validateRolePermissionScope(
          actorPermissions,
          lockedUser.roleId,
          tx
        );
      }

      const DELETED_SUFFIX_LEN = 46;
      await tx
        .update(users)
        .set({
          email: sql`LEFT(email, ${EMAIL_MAX - DELETED_SUFFIX_LEN}) || '_del_' || gen_random_uuid()`,
          phoneNumber: null,
          deletedAt: sql`now()`,
          updatedAt: sql`now()`,
          isActive: false,
          roleId: null,
          failedLoginAttempts: 0,
          lockedUntil: null,
        })
        .where(eq(users.id, userId));

      await tx.delete(sessions).where(eq(sessions.userId, userId));
      await tx.delete(accounts).where(eq(accounts.userId, userId));
      await tx
        .delete(verificationSessions)
        .where(eq(verificationSessions.userId, userId));
      if (userRole.scope === CUSTOM_ROLE_VALUE) {
        await tx.delete(roles).where(eq(roles.id, lockedUser.roleId));
      }

      await auditLog(tx, {
        userId: sessionUserId,
        userEmail: session!.user.email,
        action: 'DELETE',
        tableName: 'users',
        recordId: userId,
        oldData: {
          email: lockedUser.email,
          roleId: lockedUser.roleId,
          roleName: userRole.roleName,
          roleScope: userRole.scope,
        },
        meta: auditMeta,
      });
    });

    return apiSuccess({ message: MSG_DELETED });
  } catch (error) {
    return handleApiError(error, MSG_DELETE_ERROR);
  }
};
