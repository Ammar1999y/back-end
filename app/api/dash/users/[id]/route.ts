import type { PermissionAction } from '@/lib/permissions/constants';

import { headers } from 'next/headers';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';

import { db } from '@/db';
import { accounts, rolePermissions, roles, sessions, users } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { isForeignKeyViolation, isUniqueViolation, validID } from '@/utils';
import { EMAIL_MAX } from '@/utils/validation/constants';
import { hashPassword } from '@/lib/auth';
import { checkUserPermission } from '@/lib/permissions/checker';
import { CUSTOM_ROLE_VALUE } from '@/lib/permissions/constants';
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

import { auditLog } from '@/lib/audit';

import {
  CREDENTIAL_PROVIDER_ID,
  HTTP_STATUS,
  MSG_DELETE_ERROR,
  MSG_DELETED,
  MSG_FETCH_ERROR,
  MSG_FETCHED,
  MSG_INSUFFICIENT_PERMISSIONS,
  MSG_LOGIN_REQUIRED,
  MSG_NOT_FOUND,
  MSG_UPDATE_ERROR,
  MSG_UPDATED,
} from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  parseJsonBody,
  resolveUserUniqueViolation,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import {
  selfUpdateUserSchema,
  updateUserSchema,
} from '@/utils/validation/auth';
import { idRequired } from '@/utils/validation/rules';

import { userMsg } from '../messages';
import { EntityID } from '@/types';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await checkUserPermission({
      headers: await headers(),
      resource: 'users',
      action: 'view',
    });

    const { id: _id } = await params;
    const userId = validID(_id);
    if (!userId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);

    const userData = await db.query.users.findFirst({
      where: (users, { eq, and, isNull }) =>
        and(eq(users.id, userId), isNull(users.deletedAt)),
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
      },
    });
  } catch (error) {
    return handleApiError(error, MSG_FETCH_ERROR);
  }
}

// Self-edit: only name, email, password (no role/permission/isActive changes)
async function handleSelfEdit(
  session: NonNullable<
    Awaited<ReturnType<typeof checkUserPermission>>['session']
  >,
  targetId: EntityID,
  body: Record<string, unknown>,
  request: Request
) {
  // Dashboard self-edit requires an active role
  if (!session.user.roleId)
    throw new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);

  const parsed = selfUpdateUserSchema.safeParse({ ...body, id: targetId });
  if (!parsed.success)
    throw new CustomError(
      parsed.error.issues[0].message,
      HTTP_STATUS.UNPROCESSABLE
    );

  const hashedPassword = parsed.data.password
    ? await hashPassword(parsed.data.password)
    : null;

  await withTransaction(async (tx) => {
    // Verify user is still active inside the transaction (eliminates TOCTOU race)
    const [activeUser] = await tx
      .select({ id: users.id, email: users.email })
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
      throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);

    const emailChanged = parsed.data.email !== activeUser.email;

    const [updated] = await tx
      .update(users)
      .set({
        name: parsed.data.name,
        ...(emailChanged ? { email: parsed.data.email } : {}),
      })
      .where(and(eq(users.id, targetId), isNull(users.deletedAt)))
      .returning({ id: users.id });

    if (!updated) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    if (hashedPassword) {
      const [pwUpdated] = await tx
        .update(accounts)
        .set({ password: hashedPassword })
        .where(
          and(
            eq(accounts.userId, targetId),
            eq(accounts.providerId, CREDENTIAL_PROVIDER_ID)
          )
        )
        .returning({ id: accounts.id });

      if (!pwUpdated?.id)
        throw new CustomError(
          userMsg.passwordUpdateFailed,
          HTTP_STATUS.BAD_REQUEST
        );

      // Invalidate all other sessions (keep current)
      const currentSessionId = session.session.id;
      if (currentSessionId)
        await tx
          .delete(sessions)
          .where(
            and(
              eq(sessions.userId, targetId),
              ne(sessions.id, currentSessionId)
            )
          );
    }

    await auditLog(tx, {
      userId: session.user.id,
      userEmail: session.user.email,
      action: 'UPDATE',
      tableName: 'users',
      recordId: targetId,
      oldData: { name: session.user.name, email: session.user.email },
      newData: {
        name: parsed.data.name,
        email: parsed.data.email,
        ...(hashedPassword ? { passwordChanged: true } : {}),
      },
      request,
    });
  });
}

// Admin edit: full user modification with role/permissions/isActive changes
async function handleAdminEdit(
  session: NonNullable<
    Awaited<ReturnType<typeof checkUserPermission>>['session']
  >,
  actorPermissions: Awaited<
    ReturnType<typeof checkUserPermission>
  >['permissions'],
  targetId: string,
  body: Record<string, unknown>,
  request: Request
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
  const hashedPassword = password ? await hashPassword(password) : null;

  await withTransaction(async (tx) => {
    // Single JOIN instead of two sequential queries
    const [lockedUser] = await tx
      .select({
        id: users.id,
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

    // Validate standard role is active and assignable (fail fast)
    if (!isCustomRole) {
      await validateAssignableRole(validatedData.roleId, tx);
    }

    // Always validate actor scope against the target user's current role
    if (actorPermissions) {
      await validateRolePermissionScope(
        actorPermissions,
        lockedUser.roleId,
        tx
      );

      // Also check the new role/permissions being assigned (skip if role unchanged)
      if (isCustomRole && validatedData.permissions?.length) {
        validatePermissionScope(actorPermissions, validatedData.permissions);
      } else if (!isCustomRole && validatedData.roleId !== lockedUser.roleId) {
        await validateRolePermissionScope(
          actorPermissions,
          validatedData.roleId,
          tx
        );
      }
    }

    // Verify actor has permission to manage custom roles (no extra query)
    if (isCustomRole) {
      const required: PermissionAction = isCurrentlyCustom ? 'edit' : 'create';
      if (actorPermissions?.['permissions']?.[required] !== true)
        throw new CustomError(
          MSG_INSUFFICIENT_PERMISSIONS,
          HTTP_STATUS.FORBIDDEN
        );
    }

    let assignedRoleId: string;
    let customPermsChanged = false;

    if (isCustomRole && validatedData.permissions?.length) {
      // Fetch old permissions before createCustomRole replaces them
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

      // Use shared helper
      assignedRoleId = await createCustomRole(
        tx,
        validatedData.permissions,
        isCurrentlyCustom ? lockedUser.roleId : null
      );
    } else {
      assignedRoleId = validatedData.roleId;
    }

    // Update user FIRST, then delete orphaned custom role
    const [userUpdated] = await tx
      .update(users)
      .set({
        name: validatedData.name,
        email: validatedData.email,
        isActive: validatedData.isActive,
        roleId: assignedRoleId,
      })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning({ id: users.id });

    if (!userUpdated)
      throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    // Delete orphaned custom role after user row is updated
    if (isCurrentlyCustom && lockedUser.roleId !== assignedRoleId) {
      await tx.delete(roles).where(eq(roles.id, lockedUser.roleId));
    }

    // Determine final session action upfront to avoid redundant operations
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
          userMsg.passwordUpdateFailed,
          HTTP_STATUS.BAD_REQUEST
        );
    }

    await auditLog(tx, {
      userId: session.user.id,
      userEmail: session.user.email,
      action: 'UPDATE',
      tableName: 'users',
      recordId: userId,
      oldData: {
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
      request,
    });

    if (shouldDeleteAllSessions) {
      await tx.delete(sessions).where(eq(sessions.userId, userId));
    } else if (shouldRefreshSessions) {
      await refreshUserSessions(userId, tx);
    }
  });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const reqHeaders = await headers();

    const {
      session,
      allowed,
      permissions: actorPermissions,
    } = await checkUserPermission({
      headers: reqHeaders,
      resource: 'users',
      action: 'edit',
      throwError: false,
    });
    const { id } = await params;

    const body = await parseJsonBody(request);

    const targetId = validID(id);
    if (!targetId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);

    if (session?.user.id === targetId) {
      await handleSelfEdit(session, targetId, body, request);
      return apiSuccess({ message: MSG_UPDATED });
    }

    // Non-self edit: require users.edit permission
    if (!allowed)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    await handleAdminEdit(
      session!,
      actorPermissions,
      targetId,
      body,
      request
    );
    return apiSuccess({ message: MSG_UPDATED });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return handleApiError(
        new CustomError(resolveUserUniqueViolation(error), HTTP_STATUS.CONFLICT)
      );
    }
    if (isForeignKeyViolation(error)) {
      return handleApiError(
        new CustomError(userMsg.roleNotFound, HTTP_STATUS.BAD_REQUEST)
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
        resource: 'users',
        action: 'delete',
      });

    const { id: _id } = await params;
    const userId = validID(_id);
    if (!userId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);

    if (session?.user.id === userId)
      throw new CustomError(userMsg.cannotDeleteSelf, HTTP_STATUS.BAD_REQUEST);

    await withTransaction(async (tx) => {
      // Lock only the user row to avoid contention on shared roles
      const [lockedUser] = await tx
        .select({ id: users.id, roleId: users.roleId, email: users.email })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .for('update');

      if (!lockedUser?.roleId)
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

      // Read role info separately (no lock needed)
      const [userRole] = await tx
        .select({ roleName: roles.roleName, scope: roles.scope })
        .from(roles)
        .where(
          and(
            eq(roles.id, lockedUser.roleId),
            nonSystemRoleFilter()
          )
        );

      if (!userRole)
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

      // Verify actor has scope over target user's role
      if (actorPermissions) {
        await validateRolePermissionScope(
          actorPermissions,
          lockedUser.roleId,
          tx
        );
      }

      // Mangle email to prevent Better Auth from matching soft-deleted rows on login
      // Truncation-safe: LEFT() ensures result fits EMAIL_MAX, UUID ensures uniqueness
      const DELETED_SUFFIX_LEN = 46; // '_del_' (5) + UUID (36) + margin (5)
      await tx
        .update(users)
        .set({
          email: sql`LEFT(email, ${EMAIL_MAX - DELETED_SUFFIX_LEN}) || '_del_' || gen_random_uuid()`,
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
      if (userRole.scope === CUSTOM_ROLE_VALUE) {
        await tx.delete(roles).where(eq(roles.id, lockedUser.roleId));
      }

      await auditLog(tx, {
        userId: session!.user.id,
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
        request,
      });
    });

    return apiSuccess({ message: MSG_DELETED });
  } catch (error) {
    return handleApiError(error, MSG_DELETE_ERROR);
  }
}
