import type { Handler } from '@/lib/http/contract';

import { validID } from '@/utils';
import { getAuditMeta } from '@/lib/audit';
import { requirePermission } from '@/lib/http/session';
import { deleteFolder, updateFolder } from '@/lib/media/folders';
import { deleteFolderTree } from '@/lib/media/lifecycle';
import { mediaMsg } from '@/lib/media/messages';
import { viewablePages } from '@/lib/media/usages';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import { HTTP_STATUS } from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  requireJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { updateFolderSchema } from '@/utils/validation/media';
import { zodIssueMessage } from '@/utils/validation/rules';

/**
 * `recursive=true` deletes the subtree; anything else the client might have
 * meant by it is a 422, not a silently narrower delete. Absent is the default
 * and the safe one: empty folders only.
 */
const NOT_RECURSIVE = new Set([null, '', 'false']);

function requireRecursive(query: URLSearchParams): boolean {
  const raw = query.get('recursive');
  if (NOT_RECURSIVE.has(raw)) return false;
  if (raw !== 'true')
    throw new CustomError(mediaMsg.invalidRecursive, HTTP_STATUS.UNPROCESSABLE);
  return true;
}

export const PUT: Handler = async (ctx) => {
  try {
    const { session, userId, scope } = await requirePermission(ctx, {
      resource: 'media',
      action: 'edit',
    });

    await enforceRateLimit({
      scope: 'media.folders.id.put',
      identifier: userIdentifier(userId),
      limit: 30,
      failClosed: true,
    });

    const folderId = validID(ctx.params.id);
    if (!folderId)
      throw new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND);

    const parsed = updateFolderSchema.safeParse(
      requireJsonBody(await ctx.readJson())
    );
    if (!parsed.success)
      throw new CustomError(
        zodIssueMessage(parsed.error),
        HTTP_STATUS.UNPROCESSABLE
      );

    const folder = await updateFolder({
      folderId,
      name: parsed.data.name,
      parentId: parsed.data.parentId,
      actor: {
        userId,
        email: session.user.email,
        scope: scope ?? 'all',
        meta: getAuditMeta(ctx),
      },
    });

    return apiSuccess({ message: mediaMsg.updated, data: folder });
  } catch (error) {
    return handleApiError(error, mediaMsg.updateError);
  }
};

export const DELETE: Handler = async (ctx) => {
  try {
    const { session, userId, scope, permissions } = await requirePermission(
      ctx,
      { resource: 'media', action: 'delete' }
    );

    await enforceRateLimit({
      scope: 'media.folders.id.delete',
      identifier: userIdentifier(userId),
      limit: 30,
      failClosed: true,
    });

    const folderId = validID(ctx.params.id);
    if (!folderId)
      throw new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND);
    const recursive = requireRecursive(ctx.query);

    const actor = {
      userId,
      email: session.user.email,
      scope: scope ?? 'all',
      meta: getAuditMeta(ctx),
    };
    const outcome = recursive
      ? await deleteFolderTree({
          folderId,
          actor,
          viewable: viewablePages(permissions),
        })
      : await deleteFolder({ folderId, actor });

    return apiSuccess({ message: mediaMsg.deleted, data: outcome });
  } catch (error) {
    return handleApiError(error, mediaMsg.deleteError);
  }
};
