import type { Handler } from '@/lib/http/contract';
import type { DashboardPage } from '@/lib/permissions/constants';

import { getAuditMeta } from '@/lib/audit';
import { requireAnyPermission, requireSession } from '@/lib/http/session';
import { toMediaFile } from '@/lib/media/files';
import { mediaMsg } from '@/lib/media/messages';
import { resolveUploadPurpose } from '@/lib/media/policy';
import {
  admitUpload,
  chargeUploadBudget,
  storeUpload,
  takeSingleFile,
  UPLOAD_ADMISSION_LIMIT,
  UPLOAD_ADMISSION_SCOPE,
} from '@/lib/media/upload';
import { DASHBOARD_PAGES } from '@/lib/permissions/constants';
import { isVisibilityEnabled } from '@/lib/r2/client';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import { HTTP_STATUS } from '@/utils/api-messages';
import { apiSuccess, handleApiError } from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';

import { uploadMsg } from './messages';

/**
 * The upload is authorised against the resource the file is FOR, not against a
 * permission of its own: this endpoint owns no data, and a standalone
 * "may upload" grant would let anyone holding it attach files to a resource
 * they cannot otherwise touch. Either write action qualifies — a file is
 * attached while creating a record or while editing one.
 */
const UPLOAD_ACTIONS = ['create', 'edit'] as const;

/**
 * Resolved from the QUERY STRING, not a form field, and that is load-bearing:
 * the permission check has to run before `readFormData()`, and a form field is
 * only readable by parsing the multipart body this route exists to guard.
 *
 * `Object.hasOwn` against the page map, so the value is one of the enum's own
 * keys — a bare `in` would accept `__proto__` and `toString`.
 *
 * **Runs AFTER a session check.** Parsing it before any authentication made the
 * route an enumeration oracle: an unauthenticated caller got 400 for an unknown
 * resource and 401 for a real page name (measured). The unauthenticated path
 * answers 401 for every value of `resource`, valid or not.
 */
function requireUploadResource(query: URLSearchParams): DashboardPage {
  const requested = query.get('resource');
  if (!requested || !Object.hasOwn(DASHBOARD_PAGES, requested))
    throw new CustomError(uploadMsg.invalidResource, HTTP_STATUS.BAD_REQUEST);
  return requested as DashboardPage;
}

export const POST: Handler = async (ctx) => {
  try {
    await requireSession(ctx);

    const resource = requireUploadResource(ctx.query);
    const { session, userId } = await requireAnyPermission(ctx, {
      resource,
      actions: UPLOAD_ACTIONS,
    });

    // The purpose decides the bucket and the admitted kinds. Read AFTER the
    // permission check for the same reason `resource` is: an unauthorised
    // caller must not learn which purposes exist.
    const purpose = resolveUploadPurpose(resource, ctx.query.get('purpose'));
    if (!purpose)
      throw new CustomError(mediaMsg.invalidPurpose, HTTP_STATUS.BAD_REQUEST);
    if (!isVisibilityEnabled(purpose.visibility))
      throw new CustomError(
        mediaMsg.visibilityDisabled,
        HTTP_STATUS.UNPROCESSABLE
      );

    // Per USER, not per IP: the identity is known, and an IP bucket would let
    // one account spend every colleague's budget from a shared NAT egress. The
    // coarse per-IP bound still runs ahead of this, in the adapter. Fail-closed:
    // each admitted request costs a multipart parse and, below, real work.
    await enforceRateLimit({
      scope: UPLOAD_ADMISSION_SCOPE,
      identifier: userIdentifier(userId),
      limit: UPLOAD_ADMISSION_LIMIT,
      failClosed: true,
    });

    // Read AFTER the limiter, never before: `readFormData` is a function
    // precisely so the multipart body stays unbuffered until this request has
    // been admitted.
    const entry = takeSingleFile(await ctx.readFormData(), 'files');
    const admitted = await admitUpload(entry, purpose);
    await chargeUploadBudget(userId, admitted);

    const row = await storeUpload({
      admitted,
      target: {
        visibility: purpose.visibility,
        kinds: purpose.kinds,
        folderId: null,
        activate: false,
      },
      actor: {
        userId,
        email: session.user.email,
        meta: getAuditMeta(ctx),
      },
    });

    return apiSuccess({
      message: mediaMsg.uploaded,
      data: [await toMediaFile(row)],
      status: HTTP_STATUS.CREATED,
    });
  } catch (error) {
    return handleApiError(error, mediaMsg.uploadFailed);
  }
};
