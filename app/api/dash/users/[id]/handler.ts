import type { Handler } from '@/lib/http/contract';
import type { checkUserPermission } from '@/lib/permissions/checker';
import type { EntityID } from '@/types';

import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { accounts, rolePermissions, roles, sessions, users } from '@/db/schema';
import { validID } from '@/utils';
import { auditLog, getAuditMeta } from '@/lib/audit';
import { checkPasswordCompromise } from '@/lib/auth/check-password';
import { hashPassword } from '@/lib/auth/password';
import { revokeOtherSessions, revokePendingProofs } from '@/lib/auth/rotation';
import { requirePermission } from '@/lib/http/session';
import { CUSTOM_ROLE_VALUE, ROLE_SCOPE } from '@/lib/permissions/constants';
import {
  auditCustomRolePermissions,
  createCustomRole,
  isProtectedSystemRole,
  PERMISSION_AUDIT_VERSION,
  permissionsEqual,
  refreshUserSessions,
  validateAssignableRole,
  validatePermissionScope,
  validateRolePermissionScope,
} from '@/lib/permissions/utils';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

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
  handleUserForeignKeyViolation,
  handleUserUniqueViolation,
  requireJsonBody,
} from '@/utils/api-response';
import { PHONE_ENABLED, PHONE_REQUIRED } from '@/utils/config';
import { CustomError } from '@/utils/error-class';
import {
  adminUpdateUserSchema,
  selfUpdateUserSchema,
} from '@/utils/validation/auth';
import { EMAIL_MAX } from '@/utils/validation/constants';
import { idRequired, zodIssueMessage } from '@/utils/validation/rules';

import { userMsg } from '../messages';
import { SESSIONS_PAGE_SIZE } from './sessions/handler';
import { formatCursor } from './sessions/pagination';
import { actorCoversTargetRole, assertTargetUserVisible } from './target-user';

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

    const userData = await db.query.users.findFirst({
      where: (users, { eq, and, isNull }) =>
        and(eq(users.id, targetId), isNull(users.deletedAt)),
      columns: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        phoneNumber: true,
        phoneNumberVerified: true,
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

    if (!userData) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    // Shared with the sessions subresource so parent and child can't drift:
    // protected-system, role presence, and ownership are one predicate.
    const targetRoleId = assertTargetUserVisible({
      isSelf,
      roleId: userData.roleId,
      createdBy: userData.createdBy,
      role: userData.role,
      actorUserId: userId,
      scope: viewScope,
    });

    // Session metadata (IP, user-agent) is gated by the same role authority the
    // sessions endpoints require. Without it the child route's check was
    // bypassable: page one arrived here, only page two was refused.
    const showSessions =
      (isSelf || editAll || (editOwn && userData.createdBy === userId)) &&
      (isSelf ||
        (await actorCoversTargetRole(actorViewPermissions, targetRoleId, db)));

    const permissions =
      userData.role?.rolePermissions?.map((p) => ({
        name: p.pageName,
        permissions: p.permissions,
      })) || [];

    // Fetched only after every visibility gate above has passed — the sessions
    // of a target the actor may not reach must not be read at all, and the
    // ownership gate needs `createdBy`, which is only known once the user row
    // is in hand. Sequential by necessity, not an oversight.
    // First page only: older sessions are reachable through the cursor-paginated
    // GET /dash/users/:id/sessions, and `sessionsHasMore` tells the client when
    // it must go there instead of assuming this list is complete.
    const sessionRows = showSessions
      ? await db
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
          .orderBy(desc(sessions.createdAt), desc(sessions.id))
          .limit(SESSIONS_PAGE_SIZE + 1)
      : null;

    const sessionsHasMore =
      !!sessionRows && sessionRows.length > SESSIONS_PAGE_SIZE;

    const userSessions = sessionRows
      ? sessionRows.slice(0, SESSIONS_PAGE_SIZE).map((s) => ({
          ...s,
          isCurrent: s.id === sessionId,
        }))
      : undefined;

    // The cursor for page two, in the child route's exact format. Sending only
    // `hasMore` forced the client to call the child endpoint with no cursor,
    // which re-serves page one — the duplicate the keyset design exists to
    // avoid.
    const lastSession = userSessions?.at(-1);
    const sessionsNextCursor =
      sessionsHasMore && lastSession
        ? formatCursor(lastSession.createdAt, lastSession.id)
        : null;

    return apiSuccess({
      message: MSG_FETCHED,
      data: {
        id: userData.id,
        name: userData.name,
        email: userData.email,
        emailVerified: userData.emailVerified,
        phoneNumber: userData.phoneNumber,
        phoneNumberVerified: userData.phoneNumberVerified,
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
        ...(userSessions && {
          sessions: userSessions,
          sessionsHasMore,
          sessionsNextCursor,
        }),
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
): Promise<{ updatedAt: string }> {
  if (!actor.hasRole)
    throw new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);

  const parsed = selfUpdateUserSchema.safeParse({ ...body, id: targetId });
  if (!parsed.success)
    throw new CustomError(
      zodIssueMessage(parsed.error),
      HTTP_STATUS.UNPROCESSABLE
    );

  return withTransaction(async (tx) => {
    // Single-round-trip self-edit: capture the old name via a CTE so the
    // UPDATE ... RETURNING has both the new value (for audit parity) and
    // the pre-update value. FOR UPDATE is unnecessary — a user can't race
    // themselves meaningfully, and the WHERE filter blocks updates against
    // a concurrently deactivated/soft-deleted row.
    const updated = await tx.execute<{
      old_name: string;
      updated_at: string;
    }>(sql`
      WITH prev AS (
        SELECT id, name FROM users WHERE id = ${targetId}
      )
      UPDATE users u
      SET name = ${parsed.data.name}, updated_at = now()
      FROM prev
      WHERE u.id = prev.id
        AND u.deleted_at IS NULL
        AND u.is_active = true
      RETURNING prev.name AS old_name, u.updated_at AS updated_at
    `);

    const row = updated[0];
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

    return { updatedAt: row.updated_at };
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
): Promise<{ updatedAt: string }> {
  // Strict server contract: unknown keys are rejected (422) instead of
  // stripped, so a misspelled `phone_number` / `passwrod` can't be read as
  // "field not supplied" and return a misleading 200.
  const validatedDataParsed = adminUpdateUserSchema.safeParse({
    ...body,
    id: targetId,
  });

  if (!validatedDataParsed.success)
    throw new CustomError(
      zodIssueMessage(validatedDataParsed.error),
      HTTP_STATUS.UNPROCESSABLE
    );

  const userId = validatedDataParsed.data.id;
  const validatedData = validatedDataParsed.data;
  const isCustomRole = validatedData.roleId === CUSTOM_ROLE_VALUE;

  const password = validatedDataParsed.data.password;
  if (password) await checkPasswordCompromise(password);
  const hashedPassword = password ? await hashPassword(password) : null;

  return withTransaction(async (tx) => {
    const [lockedUser] = await tx
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        emailVerified: users.emailVerified,
        phoneNumber: users.phoneNumber,
        phoneNumberVerified: users.phoneNumberVerified,
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

    // The matrix diff is computed BEFORE the authority gate below, because the
    // gate depends on it. A supplied matrix is only a permission mutation if it
    // differs from the stored one — renaming a custom-role user changes no
    // permissions and must not require `permissions.edit`. Authorize the actual
    // mutation, not the shape of the requested object.
    const suppliedMatrix = validatedData.permissions?.length
      ? validatedData.permissions
      : null;
    const newPermsForAudit =
      isCustomRole && suppliedMatrix
        ? suppliedMatrix.map((p) => ({
            pageName: p.name as string,
            permissions: p.permissions as unknown,
          }))
        : null;

    let oldPermsForAudit: Array<{
      pageName: string;
      permissions: unknown;
    }> | null = null;
    let customPermsChanged = false;

    if (newPermsForAudit && isCurrentlyCustom) {
      const oldPerms = await tx
        .select({
          pageName: rolePermissions.pageName,
          permissions: rolePermissions.permissions,
        })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, lockedUser.roleId));

      oldPermsForAudit = oldPerms.map((p) => ({
        pageName: p.pageName as string,
        permissions: p.permissions as unknown,
      }));

      customPermsChanged = !permissionsEqual(
        oldPermsForAudit,
        newPermsForAudit
      );
    }

    if (isCustomRole) {
      if (!isCurrentlyCustom) {
        // Switching TO custom mints a role.
        if (actorPermissions?.['permissions']?.['create'] !== true)
          throw new CustomError(
            MSG_INSUFFICIENT_PERMISSIONS,
            HTTP_STATUS.FORBIDDEN
          );
      } else if (customPermsChanged) {
        const hasEditAll = actorPermissions?.['permissions']?.['edit'] === true;
        const hasEditOwn =
          actorPermissions?.['permissions']?.['editOwn'] === true &&
          lockedUser.roleCreatedBy === actor.userId;
        if (!hasEditAll && !hasEditOwn)
          throw new CustomError(
            MSG_INSUFFICIENT_PERMISSIONS,
            HTTP_STATUS.FORBIDDEN
          );
      }
    }

    let assignedRoleId: EntityID;
    // Deferred so the dedicated permission-matrix audit row is written after
    // the user UPDATE succeeds, alongside the other audit work.
    let customRoleAudit: (() => Promise<void>) | null = null;

    if (newPermsForAudit && suppliedMatrix) {
      if (isCurrentlyCustom) {
        // Skip rewriting role_permissions rows when nothing changed — avoids
        // a useless DELETE/INSERT cycle that resets created_at and briefly
        // leaves the role with zero permission rows.
        assignedRoleId = customPermsChanged
          ? await createCustomRole(tx, suppliedMatrix, lockedUser.roleId)
          : lockedUser.roleId;

        // An in-place custom edit keeps the same role_id, so the user audit
        // row below shows no change at all. Record the matrix separately.
        if (customPermsChanged) {
          const roleIdForAudit = assignedRoleId;
          const oldPermissions = oldPermsForAudit ?? [];
          customRoleAudit = () =>
            auditCustomRolePermissions(tx, {
              actorUserId: actor.userId,
              actorEmail: actor.userEmail,
              roleId: roleIdForAudit,
              oldPermissions,
              newPermissions: newPermsForAudit,
              targetUserId: userId,
              meta: auditMeta,
            });
        }
      } else {
        assignedRoleId = await createCustomRole(
          tx,
          suppliedMatrix,
          null,
          actor.userId
        );

        const roleIdForAudit = assignedRoleId;
        customRoleAudit = () =>
          auditCustomRolePermissions(tx, {
            actorUserId: actor.userId,
            actorEmail: actor.userEmail,
            roleId: roleIdForAudit,
            newPermissions: newPermsForAudit,
            targetUserId: userId,
            meta: auditMeta,
          });
      }
    } else if (isCustomRole) {
      // Custom role with no matrix in the payload = "keep the current one".
      // The client only sends `permissions` when it changed, so requiring it
      // made every other edit to a custom-role user fail. Switching TO custom
      // still needs one — there is nothing to keep.
      if (!isCurrentlyCustom)
        throw new CustomError(
          userMsg.customRoleNeedsPermissions,
          HTTP_STATUS.UNPROCESSABLE
        );
      assignedRoleId = lockedUser.roleId;
    } else {
      assignedRoleId = validatedData.roleId as EntityID;
    }

    const emailChanged = lockedUser.email !== validatedData.email;
    // Phone is only persisted when enabled. An omitted key means "keep current"
    // — only an explicit null/'' clears it — so a partial update can't silently
    // wipe the number. Presence comes from the PARSED value (`undefined` only
    // when the key was absent): reading the raw body let a stripped typo look
    // like "not supplied". An admin-set number is unproven, so the verified
    // flag resets to false on any change.
    const phoneProvided = validatedData.phoneNumber !== undefined;
    const newPhoneNumber = validatedData.phoneNumber ?? null;
    const phoneChanged =
      PHONE_ENABLED &&
      phoneProvided &&
      lockedUser.phoneNumber !== newPhoneNumber;

    const [userUpdated] = await tx
      .update(users)
      .set({
        name: validatedData.name,
        email: validatedData.email,
        isActive: validatedData.isActive,
        roleId: assignedRoleId,
        // An admin edit must never flip the account onto a verified-but-unproven
        // address. The address changes by admin authority, but
        // the verified flag resets to false so nothing trusts it until the
        // owner re-proves it via OTP. emailVerified is never set true here.
        ...(emailChanged && { emailVerified: false }),
        ...(phoneChanged && {
          phoneNumber: newPhoneNumber,
          phoneNumberVerified: false,
        }),
        // Admin-issued password reset is the supported recovery path for a
        // locked-out user; clear the brute-force counters atomically with the
        // password change so the user can sign in immediately.
        ...(password && { failedLoginAttempts: 0, lockedUntil: null }),
      })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning({ id: users.id, updatedAt: users.updatedAt });

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
        oldData: {
          auditVersion: PERMISSION_AUDIT_VERSION,
          scope: CUSTOM_ROLE_VALUE,
          // The user this role existed for. Every other custom-role event
          // records it; without it this one cannot be tied back to the user
          // whose edit destroyed the role.
          forUserId: userId,
          permissions: oldCustomPerms,
        },
        metadataFields: ['auditVersion', 'scope', 'forUserId'],
        meta: auditMeta,
      });
    }

    const roleChanged = lockedUser.roleId !== assignedRoleId;
    // Any credential/identity mutation invalidates existing sessions. Phone is
    // included for the same reason the self-service flow revokes on phone
    // change: it is a passwordless login factor, so a session obtained through
    // the old number must not outlive it. Leaving it out here was exactly the
    // policy drift the shared rotation helper exists to prevent.
    const shouldDeleteAllSessions =
      !!password ||
      emailChanged ||
      phoneChanged ||
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

    // Sequential, not `Promise.all`. These four statements are logically
    // independent, but they all run on the transaction's single connection, so
    // the driver serializes them anyway — the previous fan-out bought no
    // round-trip saving and only made it arbitrary which of several failures
    // surfaced. Explicit order is what actually helps when one of them throws.
    await auditLog(tx, {
      userId: actor.userId,
      userEmail: actor.userEmail,
      action: 'UPDATE',
      tableName: 'users',
      recordId: userId,
      // Every mutated field records both sides: an identity change must be
      // reconstructable from this event alone, without a second lookup.
      oldData: {
        name: lockedUser.name,
        email: lockedUser.email,
        roleId: lockedUser.roleId,
        isActive: lockedUser.isActive,
        ...(emailChanged && { emailVerified: lockedUser.emailVerified }),
        ...(phoneChanged && {
          phoneNumber: lockedUser.phoneNumber,
          phoneNumberVerified: lockedUser.phoneNumberVerified,
        }),
      },
      newData: {
        name: validatedData.name,
        email: validatedData.email,
        roleId: assignedRoleId,
        isActive: validatedData.isActive,
        ...(emailChanged && { emailVerified: false }),
        ...(phoneChanged && {
          phoneNumber: newPhoneNumber,
          phoneNumberVerified: false,
        }),
        ...(password && { passwordChanged: true }),
      },
      // A custom-permissions-only edit changes nothing on the user row: the real
      // change is the roles event below. Without this the pair was a users
      // UPDATE with `changedFields: []` sitting next to it, which during an
      // investigation is indistinguishable from a genuine no-change write.
      skipIfUnchanged: true,
      meta: auditMeta,
    });

    if (customRoleAudit) await customRoleAudit();

    // Shared rotation helpers, not inline deletes — one definition of the
    // policy. No session kept: the actor is an admin, not the target.
    if (shouldDeleteAllSessions) await revokeOtherSessions(tx, userId);
    else if (shouldRefreshSessions) await refreshUserSessions(userId, tx);

    // A stale change_* proof must not commit over the admin's change.
    if (emailChanged || phoneChanged || shouldDeleteAllSessions)
      await revokePendingProofs(tx, userId);

    return { updatedAt: userUpdated.updatedAt };
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

    const body = requireJsonBody(await ctx.readJson());
    const auditMeta = getAuditMeta(ctx);

    const targetId = validID(ctx.params.id);
    if (!targetId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);

    const actor = {
      userId,
      userEmail: session.user.email,
      hasRole: !!session.user.roleId,
    };

    if (userId === targetId) {
      const selfResult = await handleSelfEdit(actor, targetId, body, auditMeta);
      return apiSuccess({ message: MSG_UPDATED, data: selfResult });
    }

    if (!editScope)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    const adminResult = await handleAdminEdit(
      actor,
      actorPermissions,
      editScope,
      targetId,
      body,
      auditMeta
    );
    return apiSuccess({ message: MSG_UPDATED, data: adminResult });
  } catch (error) {
    // Only a KNOWN constraint becomes a 409; an unrecognized one falls
    // through to the 500 path so the schema/code mismatch is visible.
    const conflict = handleUserUniqueViolation(error);
    if (conflict) return conflict;
    const badRole = handleUserForeignKeyViolation(error, {
      roleNotFound: userMsg.roleNotFound,
    });
    if (badRole) return badRole;
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

      const lockedUser = locked[0];
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

      // Anonymize the email on soft-delete while staying within EMAIL_MAX.
      // gen_random_uuid()::text is always 36 chars; the '_del_' marker is 5.
      // Deriving the length from the marker keeps the two in sync.
      const DELETED_EMAIL_SUFFIX = '_del_';
      const UUID_TEXT_LENGTH = 36;
      const DELETED_SUFFIX_LEN = DELETED_EMAIL_SUFFIX.length + UUID_TEXT_LENGTH;
      await tx
        .update(users)
        .set({
          email: sql`LEFT(email, ${EMAIL_MAX - DELETED_SUFFIX_LEN}) || ${DELETED_EMAIL_SUFFIX} || gen_random_uuid()`,
          // In 'required' mode the column is NOT NULL, so nulling it would make
          // every soft-delete fail. Anonymize to a format-valid dummy instead;
          // the partial unique index excludes soft-deleted rows so it can't
          // collide. In other modes a NULL is the clean wipe.
          phoneNumber: PHONE_REQUIRED
            ? sql`'9665' || LPAD((FLOOR(RANDOM() * 100000000))::bigint::text, 8, '0')`
            : null,
          // The anonymized email is not a proven address, and clearing the
          // phone would otherwise violate chk_phone_verified_requires_phone —
          // reset both verified flags alongside the contact wipe.
          emailVerified: false,
          phoneNumberVerified: false,
          deletedAt: sql`now()`,
          updatedAt: sql`now()`,
          isActive: false,
          roleId: null,
          failedLoginAttempts: 0,
          lockedUntil: null,
        })
        .where(eq(users.id, userId));

      // Soft-delete is the most total rotation there is; same policy.
      await revokeOtherSessions(tx, userId);
      await revokePendingProofs(tx, userId);
      await tx.delete(accounts).where(eq(accounts.userId, userId));
      if (lockedUser.role_scope === CUSTOM_ROLE_VALUE) {
        // Capture the matrix before the role disappears. Deleting a user also
        // destroys their custom role, and the user event below records only
        // the role id — so without this the permissions that role carried are
        // unrecoverable, and this deletion is the one custom-role removal with
        // no versioned `roles` event of its own.
        const deletedRolePerms = await tx
          .select({
            pageName: rolePermissions.pageName,
            permissions: rolePermissions.permissions,
          })
          .from(rolePermissions)
          .where(eq(rolePermissions.roleId, lockedUser.role_id));

        await tx.delete(roles).where(eq(roles.id, lockedUser.role_id));

        await auditLog(tx, {
          userId: actorUserId,
          userEmail: session.user.email,
          action: 'DELETE',
          tableName: 'roles',
          recordId: lockedUser.role_id,
          oldData: {
            auditVersion: PERMISSION_AUDIT_VERSION,
            scope: CUSTOM_ROLE_VALUE,
            forUserId: userId,
            permissions: deletedRolePerms,
          },
          meta: auditMeta,
        });
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
