import * as z from 'zod';

import { UUID_V7_REGEX, validID } from '..';
import {
  FOLDER_NAME_MAX,
  IDS_ARRAY_MAX,
  MEDIA_DISPLAY_NAME_MAX,
} from './constants';
import { idRequired, idSchema } from './rules';

export const mediaValidationMsg = {
  folderNameRequired: 'اسم المجلد مطلوب',
  folderNameTooLong: `اسم المجلد يجب أن لا يتجاوز ${FOLDER_NAME_MAX} حرفاً`,
  folderNameInvalid: 'اسم المجلد يحتوي على أحرف غير مسموحة',
  displayNameRequired: 'اسم الملف مطلوب',
  displayNameTooLong: `اسم الملف يجب أن لا يتجاوز ${MEDIA_DISPLAY_NAME_MAX} حرفاً`,
  idsRequired: 'يجب تحديد ملف واحد على الأقل',
  idsTooMany: `يمكن تحديد ${IDS_ARRAY_MAX} ملفاً كحد أقصى في الطلب الواحد`,
  nothingToUpdate: 'لا يوجد ما يتم تحديثه',
};

/**
 * Path separators and every control or format character. A name is a display
 * string, never a path segment, but `/` is refused anyway so a name can never
 * READ as a path — and because `chk_folders_name` in the schema refuses it too.
 */
const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\p{Cf}/\\]/u;

/**
 * NFC first, then whitespace collapse, then trim — in that order. Unicode
 * normalisation can change what counts as whitespace-adjacent, and the unique
 * index compares `lower(name)`, so two names that differ only in normalisation
 * form must arrive as one string.
 */
const normalizeName = (value: unknown) =>
  typeof value === 'string'
    ? value.normalize('NFC').replaceAll(/\s+/g, ' ').trim()
    : value;

export const folderNameSchema = z.preprocess(
  normalizeName,
  z
    .string(mediaValidationMsg.folderNameRequired)
    .min(1, mediaValidationMsg.folderNameRequired)
    .max(FOLDER_NAME_MAX, mediaValidationMsg.folderNameTooLong)
    .refine(
      (name) =>
        !FORBIDDEN_NAME_CHARACTERS.test(name) && name !== '.' && name !== '..',
      mediaValidationMsg.folderNameInvalid
    )
);

export const displayNameSchema = z.preprocess(
  normalizeName,
  z
    .string(mediaValidationMsg.displayNameRequired)
    .min(1, mediaValidationMsg.displayNameRequired)
    .max(MEDIA_DISPLAY_NAME_MAX, mediaValidationMsg.displayNameTooLong)
    .refine(
      (name) => !FORBIDDEN_NAME_CHARACTERS.test(name),
      mediaValidationMsg.folderNameInvalid
    )
);

/** `null` means the root; a missing key means "unchanged" where that applies. */
const nullableIdSchema = z.preprocess(
  (value) => (value == null ? null : validID(value) || 0),
  z.string(idRequired).regex(UUID_V7_REGEX, idRequired).nullable()
);

export const createFolderSchema = z
  .object({
    parentId: nullableIdSchema.optional(),
    name: folderNameSchema,
  })
  .strict();

/**
 * `.strict()` like every update schema here: a misspelled `nmae` must be a 422,
 * not a 200 that changed nothing.
 */
export const updateFolderSchema = z
  .object({
    name: folderNameSchema.optional(),
    parentId: nullableIdSchema.optional(),
  })
  .strict()
  .refine(
    (body) => body.name !== undefined || body.parentId !== undefined,
    mediaValidationMsg.nothingToUpdate
  );

export const updateFileSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    folderId: idSchema.optional(),
  })
  .strict()
  .refine(
    (body) => body.displayName !== undefined || body.folderId !== undefined,
    mediaValidationMsg.nothingToUpdate
  );

const idsSchema = z
  .array(idSchema)
  .min(1, mediaValidationMsg.idsRequired)
  .max(IDS_ARRAY_MAX, mediaValidationMsg.idsTooMany);

export const deleteFilesSchema = z.object({ ids: idsSchema }).strict();

/**
 * The batch move: the delete route's body plus the destination. `folderId` is
 * required and never null for the reason `updateFileSchema`'s is — a file lives
 * in a folder or belongs to a record, and the way out of the library is DELETE.
 */
export const moveFilesSchema = z
  .object({ ids: idsSchema, folderId: idSchema })
  .strict();
