import type { Handler } from '@/lib/http/contract';

import { getAuditMeta } from '@/lib/audit';
import { requirePermission } from '@/lib/http/session';
import { createFolder } from '@/lib/media/folders';
import { mediaMsg } from '@/lib/media/messages';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import { HTTP_STATUS } from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  requireJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { createFolderSchema } from '@/utils/validation/media';
import { zodIssueMessage } from '@/utils/validation/rules';

export const POST: Handler = async (ctx) => {
  try {
    const { session, userId } = await requirePermission(ctx, {
      resource: 'media',
      action: 'create',
    });

    await enforceRateLimit({
      scope: 'media.folders.post',
      identifier: userIdentifier(userId),
      limit: 30,
      failClosed: true,
    });

    const parsed = createFolderSchema.safeParse(
      requireJsonBody(await ctx.readJson())
    );
    if (!parsed.success)
      throw new CustomError(
        zodIssueMessage(parsed.error),
        HTTP_STATUS.UNPROCESSABLE
      );

    const folder = await createFolder({
      parentId: parsed.data.parentId ?? null,
      name: parsed.data.name,
      actor: {
        userId,
        email: session.user.email,
        scope: 'all',
        meta: getAuditMeta(ctx),
      },
    });

    return apiSuccess({
      message: mediaMsg.folderCreated,
      data: folder,
      status: HTTP_STATUS.CREATED,
    });
  } catch (error) {
    return handleApiError(error, mediaMsg.updateError);
  }
};
