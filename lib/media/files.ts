import type { Actor } from './folders';
import type { Tx } from '@/db';
import type { File as FileRow } from '@/db/schema';
import type { ObjectHead } from '@/lib/r2/client';
import type { EntityID } from '@/types';
import type { SQL } from 'drizzle-orm';

import { and, eq, inArray, sql } from 'drizzle-orm';

import { withTransaction } from '@/db';
import { files } from '@/db/schema';
import { auditLog } from '@/lib/audit';
import {
  getContentDisposition,
  getPresignedUrl,
  getPublicUrl,
  hasPublicUrl,
} from '@/lib/r2/client';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

import { fileTypeFor } from './allowlist';
import { getFolder } from './folders';
import { mediaMsg } from './messages';
import { unreferenced } from './usages';

/** The select shape every media read uses, so no two routes disagree on it. */
export const FILE_COLUMNS = {
  id: files.id,
  r2Key: files.r2Key,
  bucketType: files.bucketType,
  status: files.status,
  kind: files.kind,
  transition: files.transition,
  folderId: files.folderId,
  displayName: files.displayName,
  mimeType: files.mimeType,
  sizeBytes: files.sizeBytes,
  sha256: files.sha256,
  width: files.width,
  height: files.height,
  blurhash: files.blurhash,
  uploadedBy: files.uploadedBy,
  unfiledAt: files.unfiledAt,
  createdAt: files.createdAt,
  updatedAt: files.updatedAt,
} as const;

/**
 * Whether the media API may act on the row: it sits in the library, or no
 * registered owner references it. An entity upload still held by its record is
 * reached through that record's routes, whatever media grant the caller holds.
 *
 * **Never in the target list of the statement that takes the row lock.** Under
 * Read Committed a blocked statement re-evaluates its quals against the updated
 * tuple, but the correlated sub-plan inside it still runs under the statement's
 * original snapshot, so it describes the tree as it was before the blocking
 * transaction committed — a claim that commits during the lock wait is invisible
 * to it (measured, both in the target list and in a WHERE clause). Lock the row
 * first, then evaluate this in `governedIds` as a separate statement of the same
 * transaction: a new command snapshot sees everything committed before it began,
 * and the row is already locked, so nothing can change underneath it.
 */
export function mediaGoverned(): SQL<boolean> {
  return sql<boolean>`(${files.folderId} is not null or (${unreferenced()}))`;
}

/**
 * Which of `ids` the media API governs, read in the caller's transaction AFTER
 * the rows are locked. Owner code inserting a referrer takes `FOR KEY SHARE` on
 * the referenced row through the composite foreign key, which conflicts with
 * `FOR UPDATE`, so no owner link can commit between this and the write.
 */
export async function governedIds(
  tx: Tx,
  ids: readonly EntityID[]
): Promise<Set<EntityID>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: files.id })
    .from(files)
    .where(and(inArray(files.id, ids), mediaGoverned()));
  return new Set(rows.map((row) => row.id));
}

/**
 * Locks every id and hands back the rows, or refuses the whole set.
 *
 * The one gate the two edits below share: the lock is taken FIRST and ownership
 * evaluated after it (`mediaGoverned`), the row has to be an active library
 * file, and an `own` scope narrows to the caller's uploads. A missing, foreign
 * or record-held id answers exactly like an absent one, so a batch is all or
 * nothing and a caller learns nothing about what it may not see.
 */
async function lockFilesForEdit(
  tx: Tx,
  ids: readonly EntityID[],
  actor: Pick<Actor, 'userId' | 'scope'>
): Promise<MediaFileRow[]> {
  const wanted = [...new Set(ids)];
  const rows = await tx
    .select(FILE_COLUMNS)
    .from(files)
    .where(inArray(files.id, wanted))
    .for('update');
  const governed = await governedIds(tx, wanted);
  const editable = rows.filter(
    (row) =>
      row.status === 'active' &&
      governed.has(row.id) &&
      (actor.scope !== 'own' || row.uploadedBy === actor.userId)
  );
  if (editable.length !== wanted.length)
    throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND);
  return editable;
}

/**
 * Filing a file is also how an unfiled one — a former entity upload no record
 * references any more — enters the library and leaves the retention clock. One
 * definition for both routes that file files: a rule kept in two places is a
 * rule that drifts.
 */
const filedInto = (folderId: EntityID) =>
  ({ folderId, unfiledAt: null }) as const;

/**
 * Rename and/or move ONE file. `folderId` is optional but never null, and that
 * is the design: a file lives in a folder or belongs to a record, so adoption
 * into the library is one-way and the way out is `DELETE`.
 */
export async function updateFile(params: {
  id: EntityID;
  displayName?: string;
  folderId?: EntityID;
  actor: Actor;
}): Promise<MediaFileRow> {
  const { id, displayName, folderId, actor } = params;
  return withTransaction(async (tx) => {
    const [current] = await lockFilesForEdit(tx, [id], actor);
    if (!current)
      throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND);
    if (folderId !== undefined && !(await getFolder(folderId, tx)))
      throw new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND);

    const [row] = await tx
      .update(files)
      .set({
        ...(displayName !== undefined && { displayName }),
        ...(folderId !== undefined && filedInto(folderId)),
      })
      .where(eq(files.id, id))
      .returning(FILE_COLUMNS);
    if (!row)
      throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND);

    await auditLog(tx, {
      userId: actor.userId,
      userEmail: actor.email,
      action: 'UPDATE',
      tableName: 'files',
      recordId: id,
      oldData: {
        displayName: current.displayName,
        folderId: current.folderId,
      },
      newData: { displayName: row.displayName, folderId: row.folderId },
      skipIfUnchanged: true,
      meta: actor.meta,
    });
    return row;
  });
}

/**
 * Move a batch of files into one folder, in one transaction: reorganising a
 * library one request per file is seven minutes of requests for two hundred
 * files against the 30/min limiter, and a partly moved selection is a state
 * nobody asked for.
 */
export async function moveFiles(params: {
  ids: readonly EntityID[];
  folderId: EntityID;
  actor: Actor;
}): Promise<MediaFileRow[]> {
  const { actor, folderId } = params;
  const ids = [...new Set(params.ids)];
  return withTransaction(async (tx) => {
    const current = await lockFilesForEdit(tx, ids, actor);
    if (!(await getFolder(folderId, tx)))
      throw new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND);

    const moved = await tx
      .update(files)
      .set(filedInto(folderId))
      .where(inArray(files.id, ids))
      .returning(FILE_COLUMNS);

    for (const row of current)
      await auditLog(tx, {
        userId: actor.userId,
        userEmail: actor.email,
        action: 'UPDATE',
        tableName: 'files',
        recordId: row.id,
        oldData: { folderId: row.folderId },
        newData: { folderId },
        skipIfUnchanged: true,
        meta: actor.meta,
      });
    return moved;
  });
}

/**
 * Does the object match the row that describes it? Length always; the SHA-256
 * when R2 returns one, which it does for objects written with the checksum
 * (measured: kept on the source object, not carried across a copy).
 */
export function matchesRow(
  head: ObjectHead,
  row: Pick<MediaFileRow, 'sizeBytes' | 'sha256'>
): boolean {
  if (head.contentLength !== row.sizeBytes) return false;
  if (!head.checksumSha256 || !row.sha256) return true;
  return (
    head.checksumSha256 === Buffer.from(row.sha256, 'hex').toString('base64')
  );
}

/** How long a signed URL handed to the dashboard stays valid. */
const SIGNED_URL_TTL_SECONDS = 3600;

export type MediaFileRow = Pick<
  FileRow,
  | 'id'
  | 'r2Key'
  | 'bucketType'
  | 'status'
  | 'kind'
  | 'transition'
  | 'folderId'
  | 'displayName'
  | 'mimeType'
  | 'sizeBytes'
  | 'sha256'
  | 'width'
  | 'height'
  | 'blurhash'
  | 'uploadedBy'
  | 'unfiledAt'
  | 'createdAt'
  | 'updatedAt'
>;

/** The wire shape, shared by every route that returns a file. */
export interface MediaFile {
  id: string;
  kind: FileRow['kind'];
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  bucketType: FileRow['bucketType'];
  transition: FileRow['transition'];
  width: number | null;
  height: number | null;
  blurhash: string | null;
  folderId: string | null;
  uploadedBy: string | null;
  unfiledAt: Date | null;
  url: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The name a browser saves the file under. The display name is free text the
 * user may have renamed; the extension is the allowlist's, so a renamed
 * `report` still downloads as `report.pdf`.
 */
export function downloadFilename(
  row: Pick<MediaFileRow, 'displayName' | 'mimeType'>
): string {
  const extension = fileTypeFor(row.mimeType)?.extension;
  if (!extension) return row.displayName;
  return row.displayName.toLowerCase().endsWith(`.${extension}`)
    ? row.displayName
    : `${row.displayName}.${extension}`;
}

/**
 * How the object is reached. Public bucket with a public URL configured → the
 * permanent URL; anything else → a signed GET on the S3 endpoint. The row's
 * `bucket_type` alone decides: during a `to_public` transition it still says
 * `private`, and flips only once the copy is verified (`lib/media/visibility.ts`).
 */
async function fileUrl(
  row: Pick<MediaFileRow, 'r2Key' | 'bucketType'>
): Promise<string> {
  if (row.bucketType === 'public' && hasPublicUrl())
    return getPublicUrl(row.r2Key);
  return getPresignedUrl({
    key: row.r2Key,
    bucketType: row.bucketType,
    expiresIn: SIGNED_URL_TTL_SECONDS,
  });
}

/**
 * Always signed, always `attachment`, always named after the CURRENT display
 * name: the disposition baked into the object cannot follow a rename, and the
 * `download` attribute of a link is ignored cross-origin, so this is the only
 * way a rename reaches "save as".
 */
export function downloadUrl(
  row: Pick<MediaFileRow, 'r2Key' | 'bucketType' | 'displayName' | 'mimeType'>
): Promise<string> {
  return getPresignedUrl({
    key: row.r2Key,
    bucketType: row.bucketType,
    expiresIn: SIGNED_URL_TTL_SECONDS,
    responseContentDisposition: getContentDisposition({
      filename: downloadFilename(row),
    }),
  });
}

export async function toMediaFile(row: MediaFileRow): Promise<MediaFile> {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    bucketType: row.bucketType,
    transition: row.transition,
    width: row.width,
    height: row.height,
    blurhash: row.blurhash,
    folderId: row.folderId,
    uploadedBy: row.uploadedBy,
    unfiledAt: row.unfiledAt,
    url: await fileUrl(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toMediaFiles(
  rows: readonly MediaFileRow[]
): Promise<MediaFile[]> {
  return Promise.all(rows.map((row) => toMediaFile(row)));
}
