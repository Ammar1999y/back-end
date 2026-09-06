import type { Handler } from '@/lib/http/contract';

import { isForeignKeyViolation, validID } from '@/utils';
import { getAuditMeta } from '@/lib/audit';
import { requirePermission } from '@/lib/http/session';
import { downloadUrl, toMediaFile, updateFile } from '@/lib/media/files';
import { findFile } from '@/lib/media/lifecycle';
import { mediaMsg } from '@/lib/media/messages';
import { usedBy, viewablePages } from '@/lib/media/usages';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import { HTTP_STATUS } from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  requireJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { updateFileSchema } from '@/utils/validation/media';
import { zodIssueMessage } from '@/utils/validation/rules';

export const GET: Handler = async (ctx) => {
  try {
    const { userId, permissions } = await requirePermission(ctx, {
      resource: 'media',
      action: 'view',
    });

    await enforceRateLimit({
      scope: 'media.files.id.get',
      identifier: userIdentifier(userId),
      limit: 120,
    });

    const id = validID(ctx.params.id);
    if (!id)
      throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND);

    const row = await findFile(id);
    // A pending or deleting row is not a file the library has; one a record
    // still holds is that record's, not the library's.
    if (!row || row.status !== 'active' || !row.governed)
      throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND);

    const [file, download, usages] = await Promise.all([
      toMediaFile(row),
      downloadUrl(row),
      usedBy([id], viewablePages(permissions)),
    ]);
    const summary = usages.get(id) ?? { visible: [], hidden: 0 };

    return apiSuccess({
      message: mediaMsg.fetched,
      data: {
        ...file,
        downloadUrl: download,
        usedBy: summary.visible,
        hiddenUsages: summary.hidden,
      },
    });
  } catch (error) {
    return handleApiError(error, mediaMsg.fetchError);
  }
};

export const PUT: Handler = async (ctx) => {
  try {
    const { session, userId, scope } = await requirePermission(ctx, {
      resource: 'media',
      action: 'edit',
    });

    await enforceRateLimit({
      scope: 'media.files.id.put',
      identifier: userIdentifier(userId),
      limit: 30,
      failClosed: true,
    });

    const id = validID(ctx.params.id);
    if (!id)
      throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND);

    const parsed = updateFileSchema.safeParse(
      requireJsonBody(await ctx.readJson())
    );
    if (!parsed.success)
      throw new CustomError(
        zodIssueMessage(parsed.error),
        HTTP_STATUS.UNPROCESSABLE
      );
    const updated = await updateFile({
      id,
      displayName: parsed.data.displayName,
      folderId: parsed.data.folderId,
      actor: {
        userId,
        email: session.user.email,
        scope: scope ?? 'all',
        meta: getAuditMeta(ctx),
      },
    });

    return apiSuccess({
      message: mediaMsg.updated,
      data: await toMediaFile(updated),
    });
  } catch (error) {
    // The destination folder was deleted between the check and the write.
    return handleApiError(
      isForeignKeyViolation(error)
        ? new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND)
        : error,
      mediaMsg.updateError
    );
  }
};
