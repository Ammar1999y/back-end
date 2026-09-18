import * as z from 'zod';

import { UUID_V7_REGEX, validID } from '..';
import {
  FOLDER_NAME_MAX,
  IDS_ARRAY_MAX,
  MEDIA_DISPLAY_NAME_MAX,
} from './constants';
import {
  ID_DESCRIPTION,
  ID_INPUT_PATTERN,
  idRequired,
  idSchema,
  strictTextMaximum,
} from './rules';

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

/**
 * The refinement above, as far as an ECMA-262 `pattern` can carry it — and
 * written against the RAW value, not the normalised one.
 *
 * A JSON Schema pattern has no `u` flag, so `\p{Cf}` cannot be expressed and the
 * format characters are left to the description. What it does carry is the part
 * a client can act on: no ASCII control character, no `/`, no `\`, and — for a
 * folder — not `.` or `..`. Published because `z.toJSONSchema` sees neither the
 * refinement nor the normalisation, so the document accepted `"a/b"` for a
 * server that answers 422.
 *
 * Whitespace is admitted inside the value, not only around it, and that is not a
 * relaxation of the refinement either — a name with a line break in it arrives
 * at the check as one with a space. The floor rides here too: at least one
 * non-space character, where `minLength: 1` passed an all-whitespace name the
 * server answers 422.
 *
 * ⚠️ The floor is written as ONE mandatory character followed by a free mix,
 * not as a repeated `\s+(?=CHAR)` alternative, and the difference is quadratic:
 * the lookahead form re-scans the same whitespace suffix from every position when
 * no non-space character follows it, and a consumer compiling this pattern spent
 * 1.06 s rejecting 32 000 spaces where this shape spends 0.07 ms. Both accept the
 * same language.
 *
 * ⚠️ The LENGTH does not, and no pattern and no `maxLength` can carry it. NFC
 * runs before the bound is measured and it is not length-preserving in either
 * direction: a combining acute after `e` composes two characters into one,
 * so 200 raw characters are a legal 100-character name, and a
 * composition-excluded singleton decomposes one into two. Whitespace collapse
 * then removes an unbounded amount on top. So the maximum travels as prose,
 * like every other leaf whose normalisation can change a length
 * (`strictTextMaximum`), and the request stays bounded by the body ceiling in
 * `app.ts`.
 */
const NAME_CHARACTER_CLASS = String.raw`[^\s\u0000-\u001F\u007F/\\]`;
const NAMED = String.raw`\s*${NAME_CHARACTER_CLASS}(?:${NAME_CHARACTER_CLASS}|\s)*`;
const NAME_PATTERN = `^${NAMED}$`;
const FOLDER_NAME_PATTERN = String.raw`^(?!\s*\.{1,2}\s*$)${NAMED}$`;
const NAME_DESCRIPTION =
  'Unicode-normalised (NFC), inner whitespace collapsed to single spaces and trimmed before validation, so it may be sent as typed, and the length rule measures what is left. Control and format characters, `/` and `\\` are rejected';

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
    .meta({
      minLength: undefined,
      maxLength: undefined,
      pattern: FOLDER_NAME_PATTERN,
      description: `${NAME_DESCRIPTION}, as are the names \`.\` and \`..\`. ${strictTextMaximum(FOLDER_NAME_MAX)}`,
    })
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
    .meta({
      minLength: undefined,
      maxLength: undefined,
      pattern: NAME_PATTERN,
      description: `${NAME_DESCRIPTION}. ${strictTextMaximum(MEDIA_DISPLAY_NAME_MAX)}`,
    })
);

/** `null` means the root; a missing key means "unchanged" where that applies. */
const nullableIdSchema = z.preprocess(
  (value) => (value == null ? null : validID(value) || 0),
  z
    .string(idRequired)
    .regex(UUID_V7_REGEX, idRequired)
    .meta({ pattern: ID_INPUT_PATTERN, description: ID_DESCRIPTION })
    .nullable()
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
