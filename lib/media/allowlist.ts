import type { DetectResult } from './detect-result';
import type { FileKind } from '@/db/schema';

import { matchesMagicBytes } from '@/utils/images/raster-bytes';

import { detectCompoundFile } from './cfb';
import { detectOoxml } from './ooxml';

/**
 * One admitted type: what it is, how it is stored, and how its bytes prove it.
 *
 * `detect` is REQUIRED. The image list already lives under this rule (every
 * admitted raster has a magic-byte signature, SVG is exempt only because the
 * sanitiser parses it in full), and `tests/unit/media-allowlist.test.ts` walks
 * this table so an entry added without a check fails the suite rather than
 * admitting whatever a client labels with that type.
 */
export interface FileTypeSpec {
  kind: FileKind;
  extension: string;
  detect: (bytes: Uint8Array) => DetectResult;
}

export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const DOC_MIME_TYPE = 'application/msword';
export const XLS_MIME_TYPE = 'application/vnd.ms-excel';

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // `%PDF-`

function signatureDetect(check: (bytes: Uint8Array) => boolean) {
  return (bytes: Uint8Array): DetectResult =>
    check(bytes) ? { ok: true } : { ok: false, reason: 'signature' };
}

/**
 * Every type this application knows how to prove. Anything not here is refused
 * by name; anything here is refused when its bytes disagree with its label.
 *
 * Images keep the existing pipeline (`lib/r2/upload-helper.ts`): the check here
 * is the signature only, animation and decode caps are enforced there. SVG has
 * no signature — the sanitiser is its check, and `processImage` refuses what it
 * does not parse.
 */
export const FILE_TYPE_TABLE: ReadonlyMap<string, FileTypeSpec> = new Map<
  string,
  FileTypeSpec
>([
  [
    'image/png',
    {
      kind: 'image',
      extension: 'png',
      detect: signatureDetect((bytes) => matchesMagicBytes(bytes, 'image/png')),
    },
  ],
  [
    'image/webp',
    {
      kind: 'image',
      extension: 'webp',
      detect: signatureDetect((bytes) =>
        matchesMagicBytes(bytes, 'image/webp')
      ),
    },
  ],
  [
    'image/svg+xml',
    { kind: 'image', extension: 'svg', detect: () => ({ ok: true }) },
  ],
  [
    'application/pdf',
    {
      kind: 'document',
      extension: 'pdf',
      detect: signatureDetect((bytes) =>
        PDF_SIGNATURE.every((byte, index) => bytes[index] === byte)
      ),
    },
  ],
  [
    DOCX_MIME_TYPE,
    {
      kind: 'document',
      extension: 'docx',
      detect: (bytes) => detectOoxml(bytes, 'word'),
    },
  ],
  [
    XLSX_MIME_TYPE,
    {
      kind: 'document',
      extension: 'xlsx',
      detect: (bytes) => detectOoxml(bytes, 'excel'),
    },
  ],
  [
    DOC_MIME_TYPE,
    {
      kind: 'document',
      extension: 'doc',
      detect: (bytes) => detectCompoundFile(bytes, 'word'),
    },
  ],
  [
    XLS_MIME_TYPE,
    {
      kind: 'document',
      extension: 'xls',
      detect: (bytes) => detectCompoundFile(bytes, 'excel'),
    },
  ],
]);

/**
 * Known types held back from the allowlist: uploads of these are refused, and
 * rows that already carry one keep working. Legacy `.doc`/`.xls` are held back
 * by the owner's decision while their inspector (`lib/media/cfb.ts`) stays
 * complete and tested. Re-enabling one is deleting it from this set; nothing
 * else changes.
 */
export const DISABLED_FILE_TYPES: ReadonlySet<string> = new Set([
  DOC_MIME_TYPE,
  XLS_MIME_TYPE,
]);

function enabledTypes(): Map<string, FileTypeSpec> {
  const enabled = new Map<string, FileTypeSpec>();
  for (const [mime, spec] of FILE_TYPE_TABLE)
    if (!DISABLED_FILE_TYPES.has(mime)) enabled.set(mime, spec);
  return enabled;
}

/** The allowlist: the table minus what is held back. */
export const FILE_TYPES: ReadonlyMap<string, FileTypeSpec> = enabledTypes();

function keysOfKind(kind?: FileKind): string[] {
  const mimeTypes: string[] = [];
  for (const [mime, spec] of FILE_TYPES)
    if (kind === undefined || spec.kind === kind) mimeTypes.push(mime);
  return mimeTypes;
}

/** What may be UPLOADED. The upload contract's question, and only that. */
export const ALLOWED_MIME_TYPES: readonly string[] = keysOfKind();

/**
 * What may EXIST. Holding a type back is documented as adding it to
 * `DISABLED_FILE_TYPES`, which says nothing about rows already stored, so the
 * published response schema and the list filter are closed over the whole table
 * — otherwise disabling a type after files of it exist makes every one of those
 * rows violate the schema this application publishes, and filtering for the
 * type answers 422 while the rows are still listed.
 */
export const KNOWN_MIME_TYPES: readonly string[] =
  FILE_TYPE_TABLE.keys().toArray();

/** Type/subtype only, lowercased: `Application/PDF; charset=x` → `application/pdf`. */
export function normalizeMimeType(declared: string): string {
  const [essence] = declared.split(';', 1);
  return (essence ?? '').trim().toLowerCase();
}

export function fileTypeFor(declared: string): FileTypeSpec | undefined {
  return FILE_TYPES.get(normalizeMimeType(declared));
}

export function mimeTypesOfKind(kind: FileKind): string[] {
  return keysOfKind(kind);
}
