import { headers } from 'next/headers';
import { and, eq, inArray } from 'drizzle-orm';

import { sessions, users } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { validID } from '@/utils';
import * as z from 'zod';
import { auditLog } from '@/lib/audit';
import { checkUserPermission } from '@/lib/permissions/checker';
import { validateRolePermissionScope } from '@/lib/permissions/utils';

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
  parseJsonBody,
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

export async function DELETE(
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

    const { id: _id } = await params;
    const targetId = validID(_id);
    if (!targetId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);

    const currentUserId = validID(session?.user.id);
    const isSelf = currentUserId === targetId;

    // Non-self requires users.edit permission
    if (!isSelf && !allowed)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    // Self requires an active role (dashboard user)
    if (isSelf && !session?.user.roleId)
      throw new CustomError(
        MSG_INSUFFICIENT_PERMISSIONS,
        HTTP_STATUS.FORBIDDEN
      );

    const body = await parseJsonBody(request);
    const parsed = deleteSessionsSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        parsed.error.issues[0].message,
        HTTP_STATUS.UNPROCESSABLE
      );

    // Always protect the current session
    const currentSessionId = validID(session?.session.id);
    const idsToDelete = parsed.data.sessionIds.filter(
      (id) => id !== currentSessionId
    );

    if (idsToDelete.length === 0) return apiSuccess({ message: MSG_DELETED });

    await withTransaction(async (tx) => {
      // Non-self: validate target user exists and actor has scope
      if (!isSelf) {
        const [targetUser] = await tx
          .select({
            id: users.id,
            roleId: users.roleId,
          })
          .from(users)
          .where(and(eq(users.id, targetId), eq(users.isActive, true)))
          .for('share');

        if (!targetUser?.roleId)
          throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

        if (actorPermissions) {
          await validateRolePermissionScope(
            actorPermissions,
            targetUser.roleId,
            tx
          );
        }
      }

      // Delete only sessions that belong to the target user AND are in the requested list
      const deleted = await tx
        .delete(sessions)
        .where(
          and(eq(sessions.userId, targetId), inArray(sessions.id, idsToDelete))
        )
        .returning({ id: sessions.id });

      if (deleted.length > 0) {
        await auditLog(tx, {
          userId: currentUserId,
          userEmail: session!.user.email,
          action: 'DELETE',
          tableName: 'sessions',
          recordId: targetId,
          oldData: { sessionIds: deleted.map((s) => s.id) },
          newData: {},
          request,
        });
      }
    });

    return apiSuccess({ message: MSG_DELETED });
  } catch (error) {
    return handleApiError(error, MSG_DELETE_ERROR);
  }
}
