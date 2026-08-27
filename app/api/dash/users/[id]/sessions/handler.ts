import type { Tx } from '@/db';
import type { Handler, HandlerInput } from '@/lib/http/contract';
import type { PermissionObject } from '@/lib/permissions/constants';
import type { EntityID } from '@/types';

import { and, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { roles, sessions, users } from '@/db/schema';
import { validID } from '@/utils';
import * as z from 'zod';
import { auditLog, getAuditMeta } from '@/lib/audit';
import { requirePermission } from '@/lib/http/session';
import { validateRolePermissionScope } from '@/lib/permissions/utils';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import {
  HTTP_STATUS,
  MSG_DELETE_ERROR,
  MSG_DELETED,
  MSG_FETCH_ERROR,
  MSG_FETCHED,
  MSG_INSUFFICIENT_PERMISSIONS,
  MSG_NOT_FOUND,
} from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  requireJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { IDS_ARRAY_MAX } from '@/utils/validation/constants';
import {
  idRequired,
  idSchema,
  zodIssueMessage,
} from '@/utils/validation/rules';

import { assertTargetUserVisible } from '../target-user';
import { formatCursor, parseCursor, parseLimit } from './pagination';

// Re-exported for the parent user GET, which renders the first page inline.
export { SESSIONS_PAGE_SIZE } from './pagination';

/**
 * Exported so `lib/http/openapi.ts` can describe this body. The route declares
 * `body: 'json'`, and a contract that omits the shape of a body it says exists
 * is worse than one that admits it does not know.
 */
export const deleteSessionsSchema = z.union([
  z
    .object({
      sessionIds: z
        .array(idSchema, { message: idRequired })
        .min(1, 'يجب تحديد جلسة واحدة على الأقل')
        .max(IDS_ARRAY_MAX),
    })
    .strict(),
  // Emergency path: end every other session in one transaction, without
  // having to enumerate ids that pagination may not even have surfaced yet.
  z.object({ revokeAll: z.literal(true) }).strict(),
]);

/**
 * Shared authorization for the sessions sub-resource: the owner, or an actor
 * with `users.edit` whose scope and role authority cover the target.
 * `assert` runs the parts that need a transaction/lock.
 */
async function authorizeSessionAccess(
  ctx: HandlerInput,
  limit: { scope: string; max: number }
) {
  const {
    session,
    userId: currentUserId,
    sessionId: currentSessionId,
    scope: editScope,
    permissions: actorPermissions,
  } = await requirePermission(ctx, {
    resource: 'users',
    action: 'edit',
    throwError: false,
  });

  await enforceRateLimit({
    scope: limit.scope,
    identifier: userIdentifier(currentUserId),
    limit: limit.max,
    failClosed: true,
  });

  const targetId = validID(ctx.params.id);
  if (!targetId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);

  const isSelf = currentUserId === targetId;

  if (!isSelf && !editScope)
    throw new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);

  if (isSelf && !session.user.roleId)
    throw new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);

  return {
    session,
    currentUserId,
    currentSessionId,
    targetId,
    isSelf,
    editScope,
    actorPermissions,
  };
}

/** Ownership + role-authority check on the target, under a shared lock. */
async function assertTargetReachable(
  executor: Tx | typeof db,
  opts: {
    targetId: EntityID;
    currentUserId: EntityID;
    editScope: 'all' | 'own' | null;
    actorPermissions: Partial<PermissionObject> | undefined;
    lock: boolean;
  }
): Promise<void> {
  // The role is joined in so the shared visibility predicate can run here: a
  // subresource inherits its parent's rules. `is_active` is deliberately NOT
  // required — the parent GET can return a deactivated user, so demanding it
  // here made page one succeed and page two 404 for the same target.
  const query = executor
    .select({
      id: users.id,
      roleId: users.roleId,
      createdBy: users.createdBy,
      roleName: roles.roleName,
      roleScope: roles.scope,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(users.id, opts.targetId), isNull(users.deletedAt)));

  const [targetUser] = await (opts.lock
    ? query.for('share', { of: users })
    : query);

  if (!targetUser?.roleId)
    throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

  assertTargetUserVisible({
    isSelf: false,
    roleId: targetUser.roleId,
    createdBy: targetUser.createdBy,
    role: { roleName: targetUser.roleName, scope: targetUser.roleScope },
    actorUserId: opts.currentUserId,
    scope: opts.editScope,
  });

  if (opts.actorPermissions)
    await validateRolePermissionScope(
      opts.actorPermissions,
      targetUser.roleId,
      executor,
      'reachability'
    );
}

/**
 * Cursor-paginated active sessions, newest first.
 *
 * Keyset on `(createdAt, id)` rather than OFFSET: session rows are deleted
 * concurrently by every revocation path, and OFFSET would skip or repeat rows
 * as the set shifts underneath the pages.
 */
export const GET: Handler = async (ctx) => {
  try {
    const {
      currentSessionId,
      targetId,
      isSelf,
      currentUserId,
      editScope,
      actorPermissions,
    } = await authorizeSessionAccess(ctx, {
      scope: 'users.id.sessions.get',
      max: 60,
    });

    if (!isSelf)
      await assertTargetReachable(db, {
        targetId,
        currentUserId,
        editScope,
        actorPermissions,
        lock: false,
      });

    const limit = parseLimit(ctx.query.get('limit'));
    const cursor = parseCursor(ctx.query.get('cursor'));

    const rows = await db
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
          gt(sessions.expiresAt, sql`now()`),
          cursor
            ? sql`(${sessions.createdAt}, ${sessions.id}) < (${cursor.createdAt}, ${cursor.id}::uuid)`
            : undefined
        )
      )
      .orderBy(desc(sessions.createdAt), desc(sessions.id))
      // One extra row is the cheapest reliable "is there another page" probe.
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return apiSuccess({
      message: MSG_FETCHED,
      data: {
        sessions: page.map((s) => ({
          ...s,
          isCurrent: s.id === currentSessionId,
        })),
        nextCursor:
          hasMore && last ? formatCursor(last.createdAt, last.id) : null,
      },
    });
  } catch (error) {
    return handleApiError(error, MSG_FETCH_ERROR);
  }
};

export const DELETE: Handler = async (ctx) => {
  try {
    const {
      session,
      currentUserId,
      currentSessionId,
      targetId,
      isSelf,
      editScope,
      actorPermissions,
    } = await authorizeSessionAccess(ctx, {
      scope: 'users.id.sessions.delete',
      max: 15,
    });

    const body = requireJsonBody(await ctx.readJson());
    const parsed = deleteSessionsSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        zodIssueMessage(parsed.error),
        HTTP_STATUS.UNPROCESSABLE
      );

    const request = parsed.data;
    const revokeAll = 'revokeAll' in request;
    const idsToDelete = revokeAll
      ? []
      : request.sessionIds.filter((id) => id !== currentSessionId);

    if (!revokeAll && idsToDelete.length === 0)
      return apiSuccess({ message: MSG_DELETED });

    const auditMeta = getAuditMeta(ctx);

    await withTransaction(async (tx) => {
      if (!isSelf)
        await assertTargetReachable(tx, {
          targetId,
          currentUserId,
          editScope,
          actorPermissions,
          lock: true,
        });

      const deleted = await tx
        .delete(sessions)
        .where(
          and(
            eq(sessions.userId, targetId),
            // The acting session is always preserved: "revoke all except
            // current" must not log the operator out mid-remediation.
            currentSessionId ? ne(sessions.id, currentSessionId) : undefined,
            revokeAll ? undefined : inArray(sessions.id, idsToDelete)
          )
        )
        .returning({ id: sessions.id });

      if (deleted.length > 0) {
        await auditLog(tx, {
          userId: currentUserId,
          userEmail: session.user.email,
          action: 'DELETE',
          tableName: 'sessions',
          recordId: targetId,
          oldData: {
            sessionIds: deleted.map((s) => s.id),
            count: deleted.length,
            ...(revokeAll && { revokedAll: true }),
          },
          newData: {},
          meta: auditMeta,
        });
      }
    });

    return apiSuccess({ message: MSG_DELETED });
  } catch (error) {
    return handleApiError(error, MSG_DELETE_ERROR);
  }
};
