import type { Handler } from '@/lib/http/contract';

import { isForeignKeyViolation, validID } from '@/utils';
import { getAuditMeta } from '@/lib/audit';
import { requirePermission } from '@/lib/http/session';
import { moveFiles, toMediaFile, toMediaFiles } from '@/lib/media/files';
import { getFolder } from '@/lib/media/folders';
import { deleteFiles } from '@/lib/media/lifecycle';
import { mediaMsg } from '@/lib/media/messages';
import { DEFAULT_UPLOAD_PURPOSE } from '@/lib/media/policy';
import {
  admitUpload,
  chargeUploadBudget,
  storeUpload,
  takeSingleFile,
  UPLOAD_ADMISSION_LIMIT,
  UPLOAD_ADMISSION_SCOPE,
} from '@/lib/media/upload';
import { viewablePages } from '@/lib/media/usages';
import { isVisibilityEnabled } from '@/lib/r2/client';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import { HTTP_STATUS } from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  requireJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { deleteFilesSchema, moveFilesSchema } from '@/utils/validation/media';
import { idRequired, zodIssueMessage } from '@/utils/validation/rules';

/**
 * Library uploads land PRIVATE, and only there: nothing a user does at upload
 * time makes a file public (`reports/file-manager-plan.md`, section 1), and a
 * deployment with no private bucket has nowhere private to put them, so it
 * answers 422 rather than publishing what `media.create` alone was never
 * allowed to publish.
 */
const LIBRARY_UPLOAD_VISIBILITY = 'private';

export const POST: Handler = async (ctx) => {
  try {
    const { session, userId } = await requirePermission(ctx, {
      resource: 'media',
      action: 'create',
    });

    // Query, not form field: it has to be checked before the body is parsed,
    // for the reason `resource` is a query parameter on `/api/upload/file`.
    const folderId = validID(ctx.query.get('folder'));
    if (!folderId) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);
    if (!(await getFolder(folderId)))
      throw new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND);

    if (!isVisibilityEnabled(LIBRARY_UPLOAD_VISIBILITY))
      throw new CustomError(
        mediaMsg.visibilityDisabled,
        HTTP_STATUS.UNPROCESSABLE
      );

    await enforceRateLimit({
      scope: UPLOAD_ADMISSION_SCOPE,
      identifier: userIdentifier(userId),
      limit: UPLOAD_ADMISSION_LIMIT,
      failClosed: true,
    });

    const entry = takeSingleFile(await ctx.readFormData(), 'file');
    const admitted = await admitUpload(entry, DEFAULT_UPLOAD_PURPOSE);
    await chargeUploadBudget(userId, admitted);

    const row = await storeUpload({
      admitted,
      target: {
        visibility: LIBRARY_UPLOAD_VISIBILITY,
        kinds: DEFAULT_UPLOAD_PURPOSE.kinds,
        folderId,
        activate: true,
      },
      actor: { userId, email: session.user.email, meta: getAuditMeta(ctx) },
    });

    return apiSuccess({
      message: mediaMsg.uploaded,
      data: await toMediaFile(row),
      status: HTTP_STATUS.CREATED,
    });
  } catch (error) {
    return handleApiError(error, mediaMsg.uploadFailed);
  }
};

export const PUT: Handler = async (ctx) => {
  try {
    const { session, userId, scope } = await requirePermission(ctx, {
      resource: 'media',
      action: 'edit',
    });

    await enforceRateLimit({
      scope: 'media.files.put',
      identifier: userIdentifier(userId),
      limit: 30,
      failClosed: true,
    });

    const parsed = moveFilesSchema.safeParse(
      requireJsonBody(await ctx.readJson())
    );
    if (!parsed.success)
      throw new CustomError(
        zodIssueMessage(parsed.error),
        HTTP_STATUS.UNPROCESSABLE
      );

    const moved = await moveFiles({
      ids: parsed.data.ids,
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
      data: await toMediaFiles(moved),
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

export const DELETE: Handler = async (ctx) => {
  try {
    const { session, userId, scope, permissions } = await requirePermission(
      ctx,
      { resource: 'media', action: 'delete' }
    );

    await enforceRateLimit({
      scope: 'media.files.delete',
      identifier: userIdentifier(userId),
      limit: 30,
      failClosed: true,
    });

    const parsed = deleteFilesSchema.safeParse(
      requireJsonBody(await ctx.readJson())
    );
    if (!parsed.success)
      throw new CustomError(
        zodIssueMessage(parsed.error),
        HTTP_STATUS.UNPROCESSABLE
      );

    const { deleted, pending } = await deleteFiles({
      ids: parsed.data.ids,
      actor: {
        userId,
        email: session.user.email,
        scope: scope ?? 'all',
        meta: getAuditMeta(ctx),
      },
      viewable: viewablePages(permissions),
    });

    return apiSuccess({
      message: mediaMsg.deleted,
      data: { deleted, pending },
    });
  } catch (error) {
    return handleApiError(error, mediaMsg.deleteError);
  }
};
