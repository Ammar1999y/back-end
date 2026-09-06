import type { Handler } from '@/lib/http/contract';

import { validID } from '@/utils';
import { getAuditMeta } from '@/lib/audit';
import { requirePermission } from '@/lib/http/session';
import { toMediaFile } from '@/lib/media/files';
import { mediaMsg } from '@/lib/media/messages';
import { transitionFile } from '@/lib/media/visibility';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import { HTTP_STATUS } from '@/utils/api-messages';
import { apiSuccess, handleApiError } from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';

/**
 * Public → private, the mirror of the sibling `publish` route. Same grant, same
 * budget (the two share one limiter scope), and the saga refuses while a public
 * owner still references the file.
 */
export const POST: Handler = async (ctx) => {
  try {
    const { session, userId } = await requirePermission(ctx, {
      resource: 'media',
      action: 'publish',
      forceDB: true,
    });

    await enforceRateLimit({
      scope: 'media.files.visibility',
      identifier: userIdentifier(userId),
      limit: 10,
      failClosed: true,
    });

    const id = validID(ctx.params.id);
    if (!id)
      throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND);

    const row = await transitionFile({
      id,
      to: 'private',
      actor: {
        userId,
        email: session.user.email,
        scope: 'all',
        meta: getAuditMeta(ctx),
      },
    });

    return apiSuccess({
      message: mediaMsg.unpublished,
      data: await toMediaFile(row),
    });
  } catch (error) {
    return handleApiError(error, mediaMsg.updateError);
  }
};
