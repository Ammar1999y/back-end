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
import { CUSTOM_ROLE_VALUE, ROLE_SCOPE } from '@/lib/permissions/constants';
import type { checkUserPermission } from '@/lib/permissions/checker';
import {
  createCustomRole,
  isProtectedSystemRole,
  permissionsEqual,
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
  getErrorHeaders,
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
      userId,
      sessionId,
      scope: viewScope,
      permissions: actorViewPermissions,
    } = await requirePermission(ctx, {
      resource: 'users',
      action: 'view',
      throwError: false,
    });

    await enforceRateLimit({
      scope: 'users.id.get',
      identifier: userIdentifier(userId),
      limit: 60,
    });

    const targetId = validID(ctx.params.id);
    if (!targetId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);

    const isSelf = userId === targetId;

    if (!isSelf && !viewScope)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    if (isSelf && !session.user.roleId)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    const editAll = actorViewPermissions?.users?.edit === true;
    const editOwn = actorViewPermissions?.users?.editOwn === true;
    // Sessions are fetched optimistically when the actor *might* be allowed to
    // see them. Final visibility is decided after we know target.createdBy.
    const canFetchSessions = isSelf || editAll || editOwn;

    const userDataPromise = db.query.users.findFirst({
      where: (users, { eq, and, isNull }) =>
        and(eq(users.id, targetId), isNull(users.deletedAt)),
      columns: {
        id: true,
        name: true,
        email: true,
        isActive: true,
        roleId: true,
        createdBy: true,
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

    const sessionsPromise = canFetchSessions
      ? db
          .select({
            id: sessions.id,
            ipAddress: sessions.ipAddress,
            userAgent: sessions.userAgent,
            createdAt: sessions.createdAt,
          })
          .from(sessions)
          .where(
            and(
              eq(sessions.userId, targetId),
              gt(sessions.expiresAt, sql`now()`)
            )
          )
          .orderBy(desc(sessions.createdAt))
          .limit(50)
      : Promise.resolve(null);

    const [userData, sessionRows] = await Promise.all([
      userDataPromise,
      sessionsPromise,
    ]);

    if (!userData) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    // System-scoped owner can read their own profile; hide from others.
    if (!isSelf && isProtectedSystemRole(userData.role))
      throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    if (!userData.roleId)
      throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    if (!isSelf && viewScope === 'own' && userData.createdBy !== userId)
      throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    const showSessions =
      isSelf || editAll || (editOwn && userData.createdBy === userId);

    const permissions =
      userData.role?.rolePermissions?.map((p) => ({
        name: p.pageName,
        permissions: p.permissions,
      })) || [];

    const userSessions =
      showSessions && sessionRows
        ? sessionRows.map((s) => ({
            ...s,
            isCurrent: s.id === sessionId,
          }))
        : undefined;

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
  actor: { userId: EntityID; userEmail: string; hasRole: boolean },
  targetId: EntityID,
  body: Record<string, unknown>,
  auditMeta: AuditMeta
) {
  if (!actor.hasRole)
    throw new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);

  const parsed = selfUpdateUserSchema.safeParse({ ...body, id: targetId });
  if (!parsed.success)
    throw new CustomError(
      parsed.error.issues[0].message,
      HTTP_STATUS.UNPROCESSABLE
    );

  await withTransaction(async (tx) => {
    // Single-round-trip self-edit: capture the old name via a CTE so the
    // UPDATE ... RETURNING has both the new value (for audit parity) and
    // the pre-update value. FOR UPDATE is unnecessary — a user can't race
    // themselves meaningfully, and the WHERE filter blocks updates against
    // a concurrently deactivated/soft-deleted row.
    const updated = await tx.execute<{ old_name: string }>(sql`
      WITH prev AS (
        SELECT id, name FROM users WHERE id = ${targetId}
      )
      UPDATE users u
      SET name = ${parsed.data.name}, updated_at = now()
      FROM prev
      WHERE u.id = prev.id
        AND u.deleted_at IS NULL
        AND u.is_active = true
      RETURNING prev.name AS old_name
    `);

    const row = updated.rows[0];
    if (!row) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    await auditLog(tx, {
      userId: actor.userId,
      userEmail: actor.userEmail,
      action: 'UPDATE',
      tableName: 'users',
      recordId: targetId,
      oldData: { name: row.old_name },
      newData: { name: parsed.data.name },
      meta: auditMeta,
    });
  });
}

async function handleAdminEdit(
  actor: { userId: EntityID; userEmail: string },
  actorPermissions: Awaited<
    ReturnType<typeof checkUserPermission>
  >['permissions'],
  editScope: 'all' | 'own',
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
        createdBy: users.createdBy,
        roleName: roles.roleName,
        roleScope: roles.scope,
        roleCreatedBy: roles.createdBy,
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

    if (editScope === 'own' && lockedUser.createdBy !== actor.userId)
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
      if (isCurrentlyCustom) {
        const hasEditAll =
          actorPermissions?.['permissions']?.['edit'] === true;
        const hasEditOwn =
          actorPermissions?.['permissions']?.['editOwn'] === true &&
          lockedUser.roleCreatedBy === actor.userId;
        if (!hasEditAll && !hasEditOwn)
          throw new CustomError(
            MSG_INSUFFICIENT_PERMISSIONS,
            HTTP_STATUS.FORBIDDEN
          );
      } else if (actorPermissions?.['permissions']?.['create'] !== true) {
        throw new CustomError(
          MSG_INSUFFICIENT_PERMISSIONS,
          HTTP_STATUS.FORBIDDEN
        );
      }
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

        customPermsChanged = !permissionsEqual(
          oldPerms.map((p) => ({
            pageName: p.pageName,
            permissions: p.permissions,
          })),
          validatedData.permissions.map((p) => ({
            pageName: p.name,
            permissions: p.permissions,
          }))
        );

        // Skip rewriting role_permissions rows when nothing changed — avoids
        // a useless DELETE/INSERT cycle that resets created_at and briefly
        // leaves the role with zero permission rows.
        assignedRoleId = customPermsChanged
          ? await createCustomRole(
              tx,
              validatedData.permissions,
              lockedUser.roleId
            )
          : lockedUser.roleId;
      } else {
        assignedRoleId = await createCustomRole(
          tx,
          validatedData.permissions,
          null,
          actor.userId
        );
      }
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
        // Admin-issued password reset is the supported recovery path for a
        // locked-out user; clear the brute-force counters atomically with the
        // password change so the user can sign in immediately.
        ...(password ? { failedLoginAttempts: 0, lockedUntil: null } : {}),
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
        userId: actor.userId,
        userEmail: actor.userEmail,
        action: 'DELETE',
        tableName: 'roles',
        recordId: lockedUser.roleId,
        oldData: { scope: 'custom', permissions: oldCustomPerms },
        meta: auditMeta,
      });
    }

    const roleChanged = lockedUser.roleId !== assignedRoleId;
    // Email mutation is an identity change — invalidate other sessions so the
    // victim can't keep using stale identity in cached cookies.
    const shouldDeleteAllSessions =
      !!password ||
      emailChanged ||
      (lockedUser.isActive && validatedData.isActive === false);
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

    // After the main UPDATE the audit insert, session housekeeping, and
    // verification-session cleanup are independent of each other — fan them
    // out so they don't pay sequential round-trip latency.
    const sessionWork: Promise<unknown> = shouldDeleteAllSessions
      ? tx.delete(sessions).where(eq(sessions.userId, userId))
      : shouldRefreshSessions
        ? refreshUserSessions(userId, tx)
        : Promise.resolve();

    const verificationCleanup: Promise<unknown> =
      emailChanged || shouldDeleteAllSessions
        ? tx
            .delete(verificationSessions)
            .where(eq(verificationSessions.userId, userId))
        : Promise.resolve();

    await Promise.all([
      auditLog(tx, {
        userId: actor.userId,
        userEmail: actor.userEmail,
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
      }),
      sessionWork,
      verificationCleanup,
    ]);
  });
}

export const PUT: Handler = async (ctx) => {
  try {
    const {
      session,
      userId,
      scope: editScope,
      permissions: actorPermissions,
    } = await requirePermission(ctx, {
      resource: 'users',
      action: 'edit',
      throwError: false,
    });

    await enforceRateLimit({
      scope: 'users.id.put',
      identifier: userIdentifier(userId),
      limit: 10,
      failClosed: true,
    });

    const body = requireJsonBody(ctx.body);
    const auditMeta = getAuditMeta(ctx);

    const targetId = validID(ctx.params.id);
    if (!targetId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);

    const actor = {
      userId,
      userEmail: session.user.email,
      hasRole: !!session.user.roleId,
    };

    if (userId === targetId) {
      await handleSelfEdit(actor, targetId, body, auditMeta);
      return apiSuccess({ message: MSG_UPDATED });
    }

    if (!editScope)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    await handleAdminEdit(
      actor,
      actorPermissions,
      editScope,
      targetId,
      body,
      auditMeta
    );
    return apiSuccess({ message: MSG_UPDATED });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return handleApiError(
        new CustomError(
          resolveUserUniqueViolation(error),
          HTTP_STATUS.CONFLICT
        ),
        undefined,
        getErrorHeaders(error)
      );
    }
    if (isForeignKeyViolation(error)) {
      const constraint = getConstraintName(error);
      if (constraint.includes('role_id')) {
        return handleApiError(
          new CustomError(userMsg.roleNotFound, HTTP_STATUS.BAD_REQUEST),
          undefined,
          getErrorHeaders(error)
        );
      }
    }
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
    } = await requirePermission(ctx, { resource: 'users', action: 'delete' });

    await enforceRateLimit({
      scope: 'users.id.delete',
      identifier: userIdentifier(actorUserId),
      limit: 10,
      failClosed: true,
    });

    const userId = validID(ctx.params.id);
    if (!userId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);

    if (actorUserId === userId)
      throw new CustomError(userMsg.cannotDeleteSelf, HTTP_STATUS.BAD_REQUEST);

    const auditMeta = getAuditMeta(ctx);

    await withTransaction(async (tx) => {
      // Lock user + role together so another tx can't flip the role's
      // scope/name between selects.
      // TODO: test it if the FOR UPDATE OF u FOR SHARE OF r is not working as expected
      const locked = await tx.execute<{
        email: string;
        phone_number: string | null;
        role_id: EntityID;
        role_name: string;
        role_scope: string;
        created_by: EntityID | null;
      }>(sql`
        SELECT u.email, u.phone_number, u.role_id, u.created_by, r.role_name, r.scope AS role_scope
        FROM users u
        INNER JOIN roles r ON r.id = u.role_id
        WHERE u.id = ${userId}
          AND u.deleted_at IS NULL
          AND r.scope <> ${ROLE_SCOPE.SYSTEM}
        FOR UPDATE OF u
        FOR SHARE OF r
      `);

      const lockedUser = locked.rows[0];
      if (!lockedUser?.role_id)
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

      if (deleteScope === 'own' && lockedUser.created_by !== actorUserId)
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

      if (actorPermissions) {
        await validateRolePermissionScope(
          actorPermissions,
          lockedUser.role_id,
          tx
        );
      }

      const DELETED_SUFFIX_LEN = 41;
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
      if (lockedUser.role_scope === CUSTOM_ROLE_VALUE) {
        await tx.delete(roles).where(eq(roles.id, lockedUser.role_id));
      }

      await auditLog(tx, {
        userId: actorUserId,
        userEmail: session.user.email,
        action: 'DELETE',
        tableName: 'users',
        recordId: userId,
        oldData: {
          email: lockedUser.email,
          phoneNumber: lockedUser.phone_number,
          roleId: lockedUser.role_id,
          roleName: lockedUser.role_name,
          roleScope: lockedUser.role_scope,
        },
        meta: auditMeta,
      });
    });

    return apiSuccess({ message: MSG_DELETED });
  } catch (error) {
    return handleApiError(error, MSG_DELETE_ERROR);
  }
};
