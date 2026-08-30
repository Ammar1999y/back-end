import type { Handler } from '@/lib/http/contract';
import type { DashboardPage } from '@/lib/permissions/constants';
import type { UploadImageInput } from '@/lib/r2/upload-helper';

import { requireAnyPermission, requireSession } from '@/lib/http/session';
import { DASHBOARD_PAGES } from '@/lib/permissions/constants';
import { measureEncodeCost } from '@/lib/r2/optimize-image';
import {
  isAllowedImageType,
  uploadImagesToR2,
  validateMagicBytes,
  validateSvgUpload,
} from '@/lib/r2/upload-helper';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import { HTTP_STATUS } from '@/utils/api-messages';
import { apiSuccess, handleApiError } from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { sanitizeFilename } from '@/utils/sanitize-filename';
import { MAX_IMAGE_PIXELS, MAX_IMAGE_SIZE } from '@/utils/validation/constants';

import { uploadMsg } from './messages';

/**
 * The per-user upload budget, in MEGAPIXELS of decode work rather than requests.
 *
 * A request count was the wrong unit here, and the two numbers were never sized
 * against each other: the encoder is process-global and serialized, `MAX_IMAGE_PIXELS`
 * admits 25 MP, and 20 such files per minute is ~91 s of exclusive encoder demand
 * per 60-second window from one account — so every other uploader queues behind
 * at most four others or is refused with `processingBusy`.
 *
 * Sized so the worst case the constants admit lands at four per window — about
 * 18 s of encoder demand, not 91.
 */
export const UPLOAD_MEGAPIXEL_BUDGET = 100;

/**
 * The floor charge for ONE request, whatever its pixels — and it is what keeps
 * the per-request ceiling where it was.
 *
 * At 1 unit the budget above silently quintupled the request rate, from 20/min
 * to 100/min, because a request's cost is `max(unit, megapixels)` and most
 * uploads are far under a megapixel. That is not a pixel question: every
 * admitted request costs a multipart parse, a metadata decode, two R2 PUTs and a
 * database insert regardless of size, and an SVG never reaches
 * `measureEncodeCost` at all — its cost is jsdom plus svgo, both synchronous and
 * neither behind `acquireEncoder` (measured: 419-605 ms for documents inside
 * every sanitiser ceiling). `BUDGET / UNIT` is the request ceiling, so this is
 * the number to move when that is what is meant.
 *
 * Exported with the budget so `tests/unit/upload-validation.test.ts` can state
 * both derived ceilings — requests per window and megapixels per window —
 * against the real values rather than against a copy.
 */
export const UPLOAD_REQUEST_UNIT = 5;

/**
 * A single legal maximum-size image must still fit in one window's budget, or
 * `MAX_IMAGE_PIXELS` would admit a file the limiter can never charge — and
 * `rateLimit` refuses `cost > limit` without a write, so it would be a permanent
 * 429 rather than a slow path. Asserted at load rather than stated in prose,
 * because the two constants live in different files and nothing else connects
 * them.
 */
const MAX_UPLOAD_COST = Math.max(
  UPLOAD_REQUEST_UNIT,
  Math.ceil(MAX_IMAGE_PIXELS / 1_000_000)
);
if (MAX_UPLOAD_COST > UPLOAD_MEGAPIXEL_BUDGET)
  throw new Error(
    `UPLOAD_MEGAPIXEL_BUDGET (${UPLOAD_MEGAPIXEL_BUDGET}) is below the cost of one ` +
      `maximum-size upload (${MAX_UPLOAD_COST}); every such upload would answer 429 forever.`
  );

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
      limit: UPLOAD_MEGAPIXEL_BUDGET,
      cost: UPLOAD_REQUEST_UNIT,
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

    const files: UploadImageInput[] = [];
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

      // The rest of this file's decode cost, charged against the SAME budget the
      // admission unit above already spent `UPLOAD_REQUEST_UNIT` of — so a file
      // costs `max(UPLOAD_REQUEST_UNIT, megapixels)`.
      //
      // An SVG is metered too, and by the same unit. It carries no raster of its
      // OWN, but `<image href="data:image/png;…">` makes a viewer decode exactly
      // the pixels the direct path meters — so the floor alone priced a document
      // embedding 25 MP the same as a 2 KB icon. The sanitiser refuses any single
      // embedded raster over the pixel ceiling; this prices the ones it admits.
      //
      // Charged after the bytes are in hand and before `uploadImagesToR2` takes
      // the encoder slot, so an over-budget request pays a header decode and
      // nothing more.
      const validatedSvg =
        entry.type === 'image/svg+xml'
          ? validateSvgUpload(buffer, entry.name)
          : undefined;
      const cost =
        validatedSvg?.embeddedRasterMegapixels ??
        (await measureEncodeCost(buffer));
      if (cost > UPLOAD_REQUEST_UNIT)
        await enforceRateLimit({
          scope: 'upload.image.post',
          identifier: userIdentifier(userId),
          limit: UPLOAD_MEGAPIXEL_BUDGET,
          cost: cost - UPLOAD_REQUEST_UNIT,
          failClosed: true,
        });

      files.push({ file: entry, buffer, validatedSvg });
    }

    if (files.length === 0) {
      throw new CustomError(uploadMsg.noValidFiles, HTTP_STATUS.BAD_REQUEST);
    }

    const r2Keys = await uploadImagesToR2({
      images: files,
      uploadedBy: userId,
    });

    return apiSuccess({ message: uploadMsg.uploaded, data: r2Keys });
  } catch (error) {
    return handleApiError(error, uploadMsg.uploadFailed);
  }
};
