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
 * Private → public. `publish` has no `Own` variant, so `resolveActionScope`
 * answers `scope: 'all'` and the uploader narrowing never applies — publishing
 * is an editorial decision about the file, not about who uploaded it. The
 * sibling `unpublish` route is the mirror image.
 */
export const POST: Handler = async (ctx) => {
  try {
    const { session, userId } = await requirePermission(ctx, {
      resource: 'media',
      action: 'publish',
      // Not the cookie cache: this changes who on the internet can read the
      // object, so the grant behind it has to be the current one.
      forceDB: true,
    });

    // Two R2 calls and a HeadObject per file.
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
      to: 'public',
      actor: {
        userId,
        email: session.user.email,
        scope: 'all',
        meta: getAuditMeta(ctx),
      },
    });

    return apiSuccess({
      message: mediaMsg.published,
      data: await toMediaFile(row),
    });
  } catch (error) {
    return handleApiError(error, mediaMsg.updateError);
  }
};
