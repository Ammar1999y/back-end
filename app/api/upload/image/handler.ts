import type { Handler } from '@/lib/http/contract';
import type { DashboardPage } from '@/lib/permissions/constants';

import { requireAnyPermission, requireSession } from '@/lib/http/session';
import { DASHBOARD_PAGES } from '@/lib/permissions/constants';
import {
  isAllowedImageType,
  uploadImagesToR2,
  validateMagicBytes,
} from '@/lib/r2/upload-helper';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import { HTTP_STATUS } from '@/utils/api-messages';
import { apiSuccess, handleApiError } from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { sanitizeFilename } from '@/utils/sanitize-filename';
import { MAX_IMAGE_SIZE } from '@/utils/validation/constants';

import { uploadMsg } from './messages';

const MAX_FILE_SIZE = MAX_IMAGE_SIZE * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 1;

/**
 * The upload is authorised against the resource the image is FOR, not against a
 * permission of its own: this endpoint owns no data, and a standalone
 * "may upload" grant would let anyone holding it attach images to a resource
 * they cannot otherwise touch. Either write action qualifies — an image is
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
 * **Runs AFTER a session check, unlike the naive ordering the shape suggests.**
 * The resource IS the subject of the permission check, so it must be parsed
 * before `requireAnyPermission` can be called — which used to mean parsing it
 * before ANY authentication, and that made the route an enumeration oracle: an
 * unauthenticated caller got 400 for an unknown resource and 401 for a real page
 * name (measured), which is an exact, unauthenticated test for membership of
 * `DASHBOARD_PAGES`.
 *
 * That was defensible only while `/openapi.json` published the same names to
 * anyone. It no longer does — the document is authenticated now — so the two are
 * coupled and had to move together: closing the document without this turns a
 * harmless divergence into a working oracle, and this without the document
 * closes nothing.
 *
 * The cost is a second session lookup on the authenticated path
 * (`requireSession` here, then `requireAnyPermission` below). Deliberate: the
 * unauthenticated path now answers 401 for every value of `resource`, valid or
 * not, and pays no parse at all.
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
    const { userId } = await requireAnyPermission(ctx, {
      resource,
      actions: UPLOAD_ACTIONS,
    });

    // Per USER, not per IP. The route is authenticated now, so the identity is
    // known and is the thing worth bounding; an IP bucket would let one account
    // spend every colleague's budget from a shared NAT egress. The coarse
    // per-IP bound still runs ahead of this, in the adapter (`preAuth:
    // 'ip-limit'` in routes.ts).
    //
    // Fail-closed: each admitted request costs image processing, two R2 writes
    // and a database insert. Losing the limiter on a paid-work path is a cost
    // event, which is exactly the case `failClosed` exists for.
    await enforceRateLimit({
      scope: 'upload.image.post',
      identifier: userIdentifier(userId),
      limit: 20,
      failClosed: true,
    });

    // Read AFTER the limiter, never before: `readFormData` is a function
    // precisely so the multipart body stays unbuffered until this request has
    // been admitted. Parsed by the adapter rather than from `rawRequest` — a web
    // Request body reads once, and Elysia's own parser drains it first, which
    // threw `Body has already been used` and the old `.catch` turned into a
    // generic "no files" 400.
    const formData = await ctx.readFormData();
    if (!formData)
      throw new CustomError(uploadMsg.noFiles, HTTP_STATUS.BAD_REQUEST);
    const entries = formData.getAll('files');

    if (entries.length === 0) {
      throw new CustomError(uploadMsg.noFiles, HTTP_STATUS.BAD_REQUEST);
    }

    if (entries.length > MAX_FILES_PER_REQUEST) {
      throw new CustomError(
        uploadMsg.maxFiles(MAX_FILES_PER_REQUEST),
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const files: { file: File; buffer: Buffer }[] = [];
    for (const entry of entries) {
      if (!(entry instanceof File)) continue;

      const safeName = sanitizeFilename(entry.name);

      if (entry.size > MAX_FILE_SIZE) {
        throw new CustomError(
          uploadMsg.fileTooLarge(safeName, MAX_IMAGE_SIZE),
          HTTP_STATUS.BAD_REQUEST
        );
      }

      if (!isAllowedImageType(entry.type)) {
        throw new CustomError(
          uploadMsg.invalidType(safeName),
          HTTP_STATUS.BAD_REQUEST
        );
      }

      const buffer = Buffer.from(await entry.arrayBuffer());
      const magicValidation = validateMagicBytes(buffer, entry.type);
      if (!magicValidation.valid) {
        throw new CustomError(
          magicValidation.animated
            ? uploadMsg.animatedNotAllowed(safeName)
            : uploadMsg.contentMismatch(safeName),
          HTTP_STATUS.BAD_REQUEST
        );
      }

      files.push({ file: entry, buffer });
    }

    if (files.length === 0) {
      throw new CustomError(uploadMsg.noValidFiles, HTTP_STATUS.BAD_REQUEST);
    }

    const r2Keys = await uploadImagesToR2({
      files: files.map((f) => f.file),
      preBuffers: files.map((f) => f.buffer),
      uploadedBy: userId,
    });

    return apiSuccess({ message: uploadMsg.uploaded, data: r2Keys });
  } catch (error) {
    return handleApiError(error, uploadMsg.uploadFailed);
  }
};
