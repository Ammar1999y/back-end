import type { MediaFileRow } from './files';
import type { Actor } from './folders';
import type { FileTransition } from '@/db/schema';
import type { BucketType } from '@/lib/r2/client';
import type { EntityID } from '@/types';

import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { files } from '@/db/schema';
import { sanitizeForLog } from '@/utils';
import { auditLog } from '@/lib/audit';
import { purgeUrls } from '@/lib/cloudflare/purge';
import {
  copyFileInR2,
  deleteFromR2,
  getCacheControlHeader,
  getContentDisposition,
  getPublicUrl,
  hasPublicUrl,
  headObjectInR2,
  isVisibilityEnabled,
} from '@/lib/r2/client';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

import {
  downloadFilename,
  FILE_COLUMNS,
  governedIds,
  matchesRow,
} from './files';
import { mediaMsg } from './messages';
import { hasPublicUsage } from './usages';

/**
 * A transition older than this with its marker still set was abandoned by the
 * request that started it; the sweep finishes or reverts it. Generous against a
 * slow copy, short against a stale `to_public` that keeps a file unpublishable.
 */
const TRANSITION_STALE_AFTER = '10 minutes';

const other = (bucket: BucketType): BucketType =>
  bucket === 'public' ? 'private' : 'public';

const towards = (bucket: BucketType): FileTransition =>
  bucket === 'public' ? 'to_public' : 'to_private';

function targetHeaders(
  row: Pick<MediaFileRow, 'mimeType' | 'kind' | 'displayName'>,
  to: BucketType
) {
  return {
    contentType: row.mimeType,
    cacheControl: getCacheControlHeader({
      mimeType: row.mimeType,
      isPublic: to === 'public',
    }),
    contentDisposition: getContentDisposition({
      filename: downloadFilename(row),
      inline: row.kind === 'image',
    }),
  };
}

/**
 * Removes one object and, for a public one with the purge configured, its edge
 * copy. `false` when either failed, and the caller then leaves its marker so
 * the sweep repeats both: an object gone from the origin but still served from
 * the edge is not gone. Never throws — the caller is already handling a failure.
 *
 * **Never the live object.** Every caller here removes the copy in the bucket
 * the row does NOT name, so the row is the check — and it has to be re-read,
 * because a marker is a value and not an identity: `retryTransitions` clears a
 * stalled saga's marker, a second publish sets the same value again, and the
 * loser's cleanup would then delete the winner's object, which by then is the
 * only copy (reproduced). Skipping counts as a failed cleanup, so the caller
 * keeps its marker for a sweep that will re-read the row too.
 */
async function tryDelete(
  fileId: EntityID,
  key: string,
  bucketType: BucketType
): Promise<boolean> {
  const [live] = await db
    .select({ bucketType: files.bucketType })
    .from(files)
    .where(eq(files.id, fileId));
  if (live?.bucketType === bucketType) {
    console.error(
      sanitizeForLog({
        msg: 'media.transition cleanup skipped: the object is the live one',
        id: fileId,
      })
    );
    return false;
  }
  try {
    await deleteFromR2({ key, bucketType });
    if (bucketType === 'public' && hasPublicUrl()) {
      const purge = await purgeUrls([getPublicUrl(key)]);
      if (purge.failed.length > 0) return false;
    }
    return true;
  } catch (error) {
    console.error(
      sanitizeForLog({
        msg: 'media.transition cleanup failed',
        errorClass: error instanceof Error ? error.name : typeof error,
      })
    );
    return false;
  }
}

/**
 * Move a file's object to the other bucket under the same key, and flip the row
 * once the copy is verified. Five steps, three of them transactions, none of
 * them open across the object store:
 *
 * 1. mark `transition` (refused if another saga owns the row, if the target is
 *    disabled, if the media API may not touch the row (`mediaGoverned`), or —
 *    for `to_private` — if a public owner still references it);
 * 2. `HeadObject` the source and check it against the row; copy with the
 *    target's headers; `HeadObject` the target and require the source's length
 *    and ETag — R2's single-part ETag is the content MD5 (measured), so equal
 *    ETags are equal bytes;
 * 3. flip `bucket_type`, mark `cleanup`, audit — from here URLs point at the
 *    target;
 * 4. delete the stale source object (and purge its public URL if it had one);
 * 5. clear the marker.
 *
 * A failure at 2 reverts: the target copy is removed and, only once that
 * removal succeeded, the marker cleared; otherwise the marker stays and
 * `retryTransitions` reverts later. A flip at 3 that matches no row means the
 * sweep cleared the marker while the copy was still in flight, so the copy that
 * has since landed is removed here — nothing else would ever look at it again.
 * A failure at 4 leaves `cleanup` for the same sweep. The row returned is the
 * PERSISTED state, so a caller sees `transition: 'cleanup'` when the stale copy
 * is still there.
 */
export async function transitionFile(params: {
  id: EntityID;
  to: BucketType;
  actor: Actor;
  /**
   * Owner code linking a file to a public purpose passes `true`. The media
   * routes leave it off, so an entity upload still held by its record cannot
   * be published or unpublished from the library.
   */
  authorizedByOwner?: boolean;
}): Promise<MediaFileRow> {
  const { id, to, actor } = params;
  if (!isVisibilityEnabled(to))
    throw new CustomError(
      mediaMsg.visibilityDisabled,
      HTTP_STATUS.UNPROCESSABLE
    );

  const marked = await withTransaction(async (tx) => {
    const [row] = await tx
      .select(FILE_COLUMNS)
      .from(files)
      .where(eq(files.id, id))
      .for('update');
    const governed =
      row && params.authorizedByOwner !== true
        ? await governedIds(tx, [id])
        : null;
    if (
      !row ||
      (actor.scope === 'own' && row.uploadedBy !== actor.userId) ||
      (governed !== null && !governed.has(id))
    )
      throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND);
    if (row.status !== 'active' || row.transition)
      throw new CustomError(mediaMsg.fileBusy, HTTP_STATUS.CONFLICT);
    if (row.bucketType === to) return { row, done: true as const };
    if (to === 'private' && (await hasPublicUsage(id, tx)))
      throw new CustomError(mediaMsg.unpublishInUse, HTTP_STATUS.CONFLICT);

    await tx
      .update(files)
      .set({ transition: towards(to) })
      .where(eq(files.id, id));
    return { row, done: false as const };
  });
  if (marked.done) return marked.row;
  const { row } = marked;
  const from = row.bucketType;

  try {
    const source = await headObjectInR2({ key: row.r2Key, bucketType: from });
    if (!source || !matchesRow(source, row))
      throw new Error('source object does not match the row');
    await copyFileInR2({
      sourceKey: row.r2Key,
      destinationKey: row.r2Key,
      sourceBucketType: from,
      bucketType: to,
      replace: targetHeaders(row, to),
    });
    const target = await headObjectInR2({ key: row.r2Key, bucketType: to });
    if (
      !target ||
      target.contentLength !== row.sizeBytes ||
      target.etag !== source.etag
    )
      throw new Error('copied object does not match its source');
  } catch (error) {
    console.error(
      sanitizeForLog({
        msg: 'media.transition copy failed',
        errorClass: error instanceof Error ? error.name : typeof error,
      })
    );
    if (await tryDelete(id, row.r2Key, to))
      await db
        .update(files)
        .set({ transition: null })
        .where(and(eq(files.id, id), eq(files.transition, towards(to))));
    else
      console.error(
        sanitizeForLog({
          msg: 'media.transition revert left to the sweep',
          id,
        })
      );
    throw new CustomError(mediaMsg.storeFailed, HTTP_STATUS.INTERNAL_ERROR);
  }

  const flipped = await withTransaction(async (tx) => {
    const [updated] = await tx
      .update(files)
      .set({ bucketType: to, transition: 'cleanup' })
      .where(and(eq(files.id, id), eq(files.transition, towards(to))))
      .returning(FILE_COLUMNS);
    if (!updated) return null;
    await auditLog(tx, {
      userId: actor.userId,
      userEmail: actor.email,
      action: 'UPDATE',
      tableName: 'files',
      recordId: id,
      oldData: { bucketType: from },
      newData: { bucketType: to },
      meta: actor.meta,
    });
    return updated;
  });

  // The marker was cleared under us — `retryTransitions` reverted this saga
  // while the copy was still in flight — so the copy that has since landed in
  // the target bucket is the one nothing will look at again.
  if (!flipped) {
    await tryDelete(id, row.r2Key, to);
    throw new CustomError(mediaMsg.fileBusy, HTTP_STATUS.CONFLICT);
  }

  if (!(await tryDelete(id, row.r2Key, from))) return flipped;
  const [settled] = await db
    .update(files)
    .set({ transition: null })
    .where(and(eq(files.id, id), eq(files.transition, 'cleanup')))
    .returning(FILE_COLUMNS);
  return settled ?? { ...flipped, transition: null };
}

/**
 * Finish or revert transitions a crashed request left behind.
 *
 * A row still at `to_public`/`to_private` never flipped, so nobody holds its
 * new URL: the copy in the target bucket is removed and the marker cleared. A
 * row at `cleanup` has flipped: the stale copy in the OTHER bucket is removed
 * and, for a public one, its edge copy purged. Every step is idempotent (a
 * missing key deletes as 204), so a second pass over the same row is harmless.
 */
export async function retryTransitions(): Promise<{
  reverted: number;
  finished: number;
  failed: number;
}> {
  const stuck = await db
    .select(FILE_COLUMNS)
    .from(files)
    .where(
      and(
        isNotNull(files.transition),
        lt(files.updatedAt, sql`now() - ${TRANSITION_STALE_AFTER}::interval`)
      )
    )
    .limit(1000);

  let reverted = 0;
  let finished = 0;
  let failed = 0;
  for (const row of stuck) {
    if (!row.transition) continue;
    // Either way the copy to remove is in the bucket the row does NOT name: a
    // `cleanup` row has flipped and the stale source sits opposite; a `to_*` row
    // has not, and the unverified target copy sits opposite.
    const ok = await tryDelete(row.id, row.r2Key, other(row.bucketType));
    if (!ok) {
      failed += 1;
      continue;
    }
    await db
      .update(files)
      .set({ transition: null })
      .where(and(eq(files.id, row.id), eq(files.transition, row.transition)));
    if (row.transition === 'cleanup') finished += 1;
    else reverted += 1;
  }
  return { reverted, finished, failed };
}
