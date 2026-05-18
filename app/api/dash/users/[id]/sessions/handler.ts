import { and, eq, inArray, isNull } from 'drizzle-orm';

import { sessions, users } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { validID } from '@/utils';
import * as z from 'zod';
import { auditLog, getAuditMeta } from '@/lib/audit';
import { requirePermission } from '@/lib/http/session';
import { validateRolePermissionScope } from '@/lib/permissions/utils';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import type { Handler } from '@/lib/http/contract';

import {
  HTTP_STATUS,
  MSG_DELETE_ERROR,
  MSG_DELETED,
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
import { idRequired, idSchema } from '@/utils/validation/rules';

const deleteSessionsSchema = z.object({
  sessionIds: z
    .array(idSchema, { message: idRequired })
    .min(1, 'يجب تحديد جلسة واحدة على الأقل')
    .max(IDS_ARRAY_MAX),
});

export const DELETE: Handler = async (ctx) => {
  try {
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
      scope: 'users.id.sessions.delete',
      identifier: userIdentifier(currentUserId),
      limit: 15,
      failClosed: true,
    });

    const targetId = validID(ctx.params.id);
    if (!targetId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);

    const isSelf = currentUserId === targetId;

    if (!isSelf && !editScope)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    if (isSelf && !session.user.roleId)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    const body = requireJsonBody(ctx.body);
    const parsed = deleteSessionsSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        parsed.error.issues[0].message,
        HTTP_STATUS.UNPROCESSABLE
      );

    const idsToDelete = parsed.data.sessionIds.filter(
      (id) => id !== currentSessionId
    );

    if (idsToDelete.length === 0) return apiSuccess({ message: MSG_DELETED });

    const auditMeta = getAuditMeta(ctx);

    await withTransaction(async (tx) => {
      if (!isSelf) {
        const [targetUser] = await tx
          .select({
            id: users.id,
            roleId: users.roleId,
            createdBy: users.createdBy,
          })
          .from(users)
          .where(
            and(
              eq(users.id, targetId),
              isNull(users.deletedAt),
              eq(users.isActive, true)
            )
          )
          .for('share');

        if (!targetUser?.roleId)
          throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

        if (editScope === 'own' && targetUser.createdBy !== currentUserId)
          throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

        if (actorPermissions) {
          await validateRolePermissionScope(
            actorPermissions,
            targetUser.roleId,
            tx
          );
        }
      }

      const deleted = await tx
        .delete(sessions)
        .where(
          and(eq(sessions.userId, targetId), inArray(sessions.id, idsToDelete))
        )
        .returning({ id: sessions.id });

      if (deleted.length > 0) {
        await auditLog(tx, {
          userId: currentUserId,
          userEmail: session.user.email,
          action: 'DELETE',
          tableName: 'sessions',
          recordId: targetId,
          oldData: { sessionIds: deleted.map((s) => s.id) },
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
