import {
  isAllowedImageType,
  uploadImagesToR2,
  validateMagicBytes,
} from '@/lib/r2/upload-helper';
import { enforceRateLimit, ipIdentifier } from '@/lib/rate-limit';

import type { Handler } from '@/lib/http/contract';

import { HTTP_STATUS } from '@/utils/api-messages';
import { apiSuccess, handleApiError } from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { sanitizeFilename } from '@/utils/sanitize-filename';
import { MAX_IMAGE_SIZE } from '@/utils/validation/constants';

import { uploadMsg } from './messages';

const MAX_FILE_SIZE = MAX_IMAGE_SIZE * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 1;

export const POST: Handler = async (ctx) => {
  try {
    // TODO: Add authentication check when auth is implemented
    await enforceRateLimit({
      scope: 'upload.image.post',
      identifier: ipIdentifier(ctx.headers),
      limit: 20,
    });

    // formData parsing stays on the raw Request — multipart is framework-specific
    const formData = await ctx.rawRequest.formData().catch(() => {
      throw new CustomError(uploadMsg.noFiles, HTTP_STATUS.BAD_REQUEST);
    });
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
          uploadMsg.contentMismatch(safeName),
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
    });

    return apiSuccess({ message: uploadMsg.uploaded, data: r2Keys });
  } catch (error) {
    return handleApiError(error, uploadMsg.uploadFailed);
  }
};
