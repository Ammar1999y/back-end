import type { MediaFileRow } from './files';
import type { Actor, AuditActor, FolderDeleteOutcome } from './folders';
import type { Tx } from '@/db';
import type { DashboardPage } from '@/lib/permissions/constants';
import type { BucketType } from '@/lib/r2/client';
import type { EntityID } from '@/types';

import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { files, folders as foldersTable } from '@/db/schema';
import { isForeignKeyViolation, sanitizeForLog } from '@/utils';
import { auditLog } from '@/lib/audit';
import { purgeUrls } from '@/lib/cloudflare/purge';
import {
  deleteObjectsFromR2,
  getPublicUrl,
  hasPublicUrl,
} from '@/lib/r2/client';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import { FOLDER_RECURSIVE_DELETE_MAX } from '@/utils/validation/constants';

import { FILE_COLUMNS, governedIds, mediaGoverned } from './files';
import { lockFolderFor, lockTree, subtreeFolders } from './folders';
import { mediaMsg } from './messages';
import { unreferenced, usedBy } from './usages';

/**
 * How long an entity-form upload may stay unclaimed — the time between
 * uploading an image and saving the record that owns it. 24 hours covers
 * "started a form, came back the next morning"; lowering it deletes uploads out
 * from under an open form. Also the TTL of a library upload whose activation
 * never ran, and of one whose object write failed ambiguously (the row is kept
 * so the sweep can remove whatever the store may have committed).
 */
const PENDING_FILE_TTL = '24 hours';

const SWEEP_BATCH_SIZE = 1000;

/**
 * Days an unfiled file — active, in no folder, referenced by no registered
 * owner — survives before the sweep deletes it. Counted from the pass that
 * first saw it unfiled (`unfiled_at`), because the owner's deletion, which is
 * what orphans it, touches no row here. Filing it or linking it clears the
 * stamp; the `unfiled` listing exposes both the stamp and this number.
 */
export const UNFILED_RETENTION_DAYS = 7;
/** Reaped per pass: each one is a statement and an object delete. */
const UNFILED_REAP_BATCH = 100;

/**
 * What "unfiled" means, in one place: active, in no folder, held by no
 * registered owner. The listing, the stamp and the reaper share it so no two of
 * them can disagree about which rows are on the clock. `unreferenced()` fails
 * closed while the registry is empty, so this matches nothing until a project
 * declares its owner tables.
 */
export const unfiledNow = () =>
  and(eq(files.status, 'active'), isNull(files.folderId), unreferenced());

/**
 * Attach pending uploads to their owner, in the owner's transaction.
 *
 * Conditional on `status = 'pending'` and on the uploader, so a swept, already
 * claimed, or foreign upload is refused rather than silently attached — and so
 * the sweep and a claim racing on one row cannot both win (measured: the second
 * blocks on the row lock and then matches nothing). The caller inserts its
 * referrer rows AFTER this in the same transaction; the composite FK sees the
 * status flip. `attachFiles` in `./link.ts` is the usual way in.
 */
export async function claimFiles(
  tx: Tx,
  params: { ids: readonly EntityID[]; actor: AuditActor }
): Promise<EntityID[]> {
  const ids = [...new Set(params.ids)];
  if (ids.length === 0) return [];
  const { actor } = params;
  const claimed = await tx
    .update(files)
    .set({ status: 'active' })
    .where(
      and(
        inArray(files.id, ids),
        eq(files.status, 'pending'),
        eq(files.uploadedBy, actor.userId)
      )
    )
    .returning({ id: files.id });
  if (claimed.length !== ids.length)
    throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.UNPROCESSABLE);

  for (const row of claimed)
    await auditLog(tx, {
      userId: actor.userId,
      userEmail: actor.email,
      action: 'UPDATE',
      tableName: 'files',
      recordId: row.id,
      oldData: { status: 'pending' },
      newData: { status: 'active' },
      meta: actor.meta,
    });
  return claimed.map((row) => row.id);
}

interface DoomedRow {
  id: string;
  r2Key: string;
  bucketType: BucketType;
}

/**
 * Phases B and C for rows already marked `deleting`: objects first, then rows,
 * bucket by bucket. `DeleteObjects` reports a missing key as deleted, so a
 * re-run over a half-finished batch is clean. A row stays `deleting` — and is
 * reported as retained — while its object delete is refused, or while a
 * configured cache purge of its public URL has failed: an object gone from the
 * origin but still served from the edge is not gone.
 */
async function finishDeleting(
  rows: readonly DoomedRow[]
): Promise<{ removed: string[]; retained: string[] }> {
  const removed: string[] = [];
  const retained: string[] = [];
  const byBucket = new Map<BucketType, DoomedRow[]>();
  for (const row of rows) {
    const group = byBucket.get(row.bucketType) ?? [];
    group.push(row);
    byBucket.set(row.bucketType, group);
  }

  for (const [bucketType, group] of byBucket) {
    let deletedKeys: Set<string>;
    try {
      const outcome = await deleteObjectsFromR2({
        keys: group.map((row) => row.r2Key),
        bucketType,
      });
      deletedKeys = new Set(outcome.deleted);
    } catch {
      // Count only. A key is a row id, but the error text is provider-controlled.
      console.error(
        sanitizeForLog({
          msg: 'media.delete objects failed',
          count: group.length,
        })
      );
      for (const row of group) retained.push(row.id);
      continue;
    }

    for (const row of group)
      if (!deletedKeys.has(row.r2Key)) retained.push(row.id);
    let done = group.filter((row) => deletedKeys.has(row.r2Key));
    if (done.length === 0) continue;

    if (bucketType === 'public' && hasPublicUrl()) {
      const purge = await purgeUrls(done.map((row) => getPublicUrl(row.r2Key)));
      const unpurged = new Set(purge.failed);
      const held = done.filter((row) => unpurged.has(getPublicUrl(row.r2Key)));
      for (const row of held) retained.push(row.id);
      done = done.filter((row) => !unpurged.has(getPublicUrl(row.r2Key)));
      if (done.length === 0) continue;
    }

    const deletedRows = await db
      .delete(files)
      .where(
        and(
          inArray(
            files.id,
            done.map((row) => row.id)
          ),
          eq(files.status, 'deleting')
        )
      )
      .returning({ id: files.id });
    for (const row of deletedRows) removed.push(row.id);
  }
  return { removed, retained };
}

/**
 * Delete files on request: mark, then remove objects, then remove rows.
 *
 * Phase A is the only transaction, and the composite FK does the work in it: an
 * `UPDATE` to `deleting` on a referenced row is refused by the database before
 * any byte is lost, and a referrer racing this update blocks on the row lock and
 * then fails because `(id, 'active')` no longer exists. Phases B and C run with
 * no transaction open (`db/limits.ts`); a crash between them leaves `deleting`
 * rows, invisible to listings and finished by the sweep.
 *
 * `deleted` is what is gone from both stores; `pending` is what phase A
 * committed to but the object store (or a configured purge) has not yet
 * honoured — invisible already, finished by the sweep, never coming back.
 */
export async function deleteFiles(params: {
  ids: readonly EntityID[];
  actor: Actor;
  /** Pages the actor may `view`, for naming the owners in a refusal. */
  viewable: ReadonlySet<DashboardPage>;
  /**
   * Owner code removing its own record's files passes `true`. The media routes
   * leave it off, so a file an owner still holds is not theirs to delete
   * (`mediaGoverned`).
   */
  authorizedByOwner?: boolean;
}): Promise<{ deleted: EntityID[]; pending: EntityID[] }> {
  const ids = [...new Set(params.ids)];
  const { actor } = params;

  let doomed: DoomedRow[];
  try {
    doomed = await withTransaction(async (tx) => {
      const rows = await tx
        .select({
          id: files.id,
          r2Key: files.r2Key,
          bucketType: files.bucketType,
          status: files.status,
          transition: files.transition,
          uploadedBy: files.uploadedBy,
          displayName: files.displayName,
          folderId: files.folderId,
        })
        .from(files)
        .where(inArray(files.id, ids))
        .for('update');
      const governed = await governedIds(tx, ids);

      const visible = rows.filter(
        (row) =>
          (actor.scope !== 'own' || row.uploadedBy === actor.userId) &&
          (params.authorizedByOwner === true || governed.has(row.id))
      );
      if (visible.length !== ids.length)
        throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND);
      // A row mid-transition or already deleting: the two sagas must not
      // interleave, and a repeat of a delete in flight has nothing to add.
      if (visible.some((row) => row.status === 'deleting' || row.transition))
        throw new CustomError(mediaMsg.fileBusy, HTTP_STATUS.CONFLICT);

      await tx
        .update(files)
        .set({ status: 'deleting' })
        .where(inArray(files.id, ids));

      for (const row of visible)
        await auditLog(tx, {
          userId: actor.userId,
          userEmail: actor.email,
          action: 'DELETE',
          tableName: 'files',
          recordId: row.id,
          oldData: {
            displayName: row.displayName,
            folderId: row.folderId,
            bucketType: row.bucketType,
            key: row.r2Key,
          },
          meta: actor.meta,
        });

      return visible.map((row) => ({
        id: row.id,
        r2Key: row.r2Key,
        bucketType: row.bucketType,
      }));
    });
  } catch (error) {
    if (!isForeignKeyViolation(error)) throw error;
    // The transaction rolled back; ask the registry who the owners are so the
    // refusal can name the ones this caller may see.
    const summaries = await usedBy(ids, params.viewable);
    const labels = new Set<string>();
    let hidden = 0;
    for (const summary of summaries.values()) {
      for (const usage of summary.visible) labels.add(usage.label);
      hidden += summary.hidden;
    }
    throw new CustomError(
      labels.size > 0 || hidden > 0
        ? mediaMsg.fileInUseBy([...labels], hidden)
        : mediaMsg.fileInUse,
      HTTP_STATUS.CONFLICT
    );
  }

  const { removed, retained } = await finishDeleting(doomed);
  return { deleted: removed, pending: retained };
}

/**
 * Delete a folder and everything under it, bounded by
 * `FOLDER_RECURSIVE_DELETE_MAX` descendants.
 *
 * Three steps, because deleting files touches the object store and no
 * transaction may be open across it (`db/limits.ts`):
 *
 * 1. under the tree lock: resolve the subtree, refuse above the cap, refuse a
 *    file that is not settled (a pending upload, a half-deleted row), and — for
 *    an `own` scope — a folder someone else created;
 * 2. `deleteFiles` on the active files, the same three-phase path a request
 *    takes, so the composite FK still refuses a file a record holds and NOTHING
 *    is deleted when it does;
 * 3. under the tree lock again: delete the folders, deepest first.
 *
 * Step 3 refuses if the tree is not what step 1 saw — a file uploaded into it
 * in the window between the locks, or a row whose object phase B could not
 * remove. It reports that as `folders: 0` rather than throwing, because by then
 * the files ARE deleted and an error would say the opposite; the caller retries
 * once the sweep has finished, and the empty tree deletes on the second pass.
 *
 * It lives here rather than in `./folders.ts` because it is a file deletion
 * first: that module must not import this one, or the two would form a cycle.
 */
export async function deleteFolderTree(params: {
  folderId: EntityID;
  actor: Actor;
  viewable: ReadonlySet<DashboardPage>;
}): Promise<FolderDeleteOutcome> {
  const { folderId, actor } = params;

  const plan = await withTransaction(async (tx) => {
    await lockTree(tx);
    await lockFolderFor(tx, folderId, actor);
    const tree = await subtreeFolders(tx, folderId);
    // `own` narrows the whole subtree, not only its root: a folder someone else
    // created is not this caller's to remove because its parent is.
    if (
      actor.scope === 'own' &&
      tree.some((folder) => folder.createdBy !== actor.userId)
    )
      throw new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND);

    const contents = await tx
      .select({
        id: files.id,
        status: files.status,
        uploadedBy: files.uploadedBy,
      })
      .from(files)
      .where(
        inArray(
          files.folderId,
          tree.map((folder) => folder.id)
        )
      );
    // Descendants: the root folder is what is being deleted, not something
    // under it, so a folder holding exactly the cap in files is at the cap.
    if (tree.length - 1 + contents.length > FOLDER_RECURSIVE_DELETE_MAX)
      throw new CustomError(mediaMsg.folderTooLarge, HTTP_STATUS.UNPROCESSABLE);
    // Refused before anything is deleted rather than after: a row that is not
    // `active` cannot be deleted by `deleteFiles` and would only strand the
    // folders it sits in.
    if (contents.some((row) => row.status !== 'active'))
      throw new CustomError(mediaMsg.folderBusy, HTTP_STATUS.CONFLICT);
    // `own` reaches the files too, decided HERE so the refusal names the file
    // while the tree is still intact — `deleteFiles` would refuse the same set
    // one step later, after the caller has been told the delete began.
    if (
      actor.scope === 'own' &&
      contents.some((row) => row.uploadedBy !== actor.userId)
    )
      throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.NOT_FOUND);

    return { tree, fileIds: contents.map((row) => row.id) };
  });

  const removed =
    plan.fileIds.length === 0
      ? { deleted: [], pending: [] }
      : await deleteFiles({
          ids: plan.fileIds,
          actor,
          viewable: params.viewable,
        });

  const folders = await withTransaction(async (tx) => {
    await lockTree(tx);
    const ids = plan.tree.map((folder) => folder.id);
    // The same tree, not merely one of the same size: a folder created inside
    // it between the two locks is not covered by the plan, and deleting its
    // parent would be refused by the foreign key.
    const current = await subtreeFolders(tx, folderId);
    const tree = new Set(current.map((folder) => folder.id));
    const [remaining] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(files)
      .where(inArray(files.folderId, ids));
    if (
      tree.size !== ids.length ||
      ids.some((id) => !tree.has(id)) ||
      (remaining?.count ?? 0) > 0
    )
      return 0;

    // One statement over the whole subtree: `folders.parent_id` is NO ACTION,
    // so a parent and its children may go together.
    await tx.delete(foldersTable).where(inArray(foldersTable.id, ids));
    for (const folder of plan.tree)
      await auditLog(tx, {
        userId: actor.userId,
        userEmail: actor.email,
        action: 'DELETE',
        tableName: 'folders',
        recordId: folder.id,
        oldData: { name: folder.name, parentId: folder.parentId },
        meta: actor.meta,
      });
    return ids.length;
  });

  return { folders, ...removed };
}

export interface FileSweepCount {
  removed: number;
  unfiled: { stamped: number; reaped: number };
  hasMore: boolean;
  degraded: boolean;
}

/**
 * Stamps files that have just become unfiled and clears the stamp on any that
 * gained a folder or an owner since. Two statements, so the predicate is the
 * same one the `unfiled` listing and the reaper use.
 */
async function stampUnfiled(): Promise<number> {
  await db
    .update(files)
    .set({ unfiledAt: null })
    .where(
      sql`${files.unfiledAt} is not null and not (${files.folderId} is null and (${unreferenced()}))`
    );
  const stamped = await db
    .update(files)
    .set({ unfiledAt: sql`now()` })
    .where(and(unfiledNow(), isNull(files.unfiledAt)))
    .returning({ id: files.id });
  return stamped.length;
}

/**
 * Marks unfiled files past the retention window `deleting`, one statement per
 * row so that a refusal on one leaves its neighbours marked. The refusal that
 * can happen is the composite FK: a referrer the registry does not know about,
 * which `tests/integration/media-usages.test.ts` exists to prevent — the file
 * survives and the run reports degraded.
 */
async function reapUnfiled(): Promise<{
  reaped: number;
  refused: number;
  hasMore: boolean;
}> {
  const cutoff = sql`now() - ${`${UNFILED_RETENTION_DAYS} days`}::interval`;
  const due = await db
    .select({ id: files.id })
    .from(files)
    .where(
      and(unfiledNow(), isNull(files.transition), lt(files.unfiledAt, cutoff))
    )
    .limit(UNFILED_REAP_BATCH);

  let reaped = 0;
  let refused = 0;
  for (const { id } of due) {
    try {
      const marked = await db
        .update(files)
        .set({ status: 'deleting' })
        .where(
          and(
            eq(files.id, id),
            unfiledNow(),
            isNull(files.transition),
            lt(files.unfiledAt, cutoff)
          )
        )
        .returning({ id: files.id });
      reaped += marked.length;
    } catch (error) {
      if (!isForeignKeyViolation(error)) throw error;
      refused += 1;
    }
  }
  if (refused > 0)
    console.error(
      sanitizeForLog({
        msg: 'media.unfiled reap refused by an unregistered referrer',
        count: refused,
      })
    );
  return { reaped, refused, hasMore: due.length === UNFILED_REAP_BATCH };
}

/**
 * The retention half: pending uploads past the TTL and unfiled files past
 * theirs become `deleting`, and every `deleting` row — those plus the ones a
 * crashed request left — is finished.
 *
 * Marking an expired pending row cannot hit the composite FK: a `pending` row
 * can have no referrer. `hasMore` is true when a full batch was marked or when
 * something was retained; `degraded` only for a retained row or a refused reap,
 * so an ordinary backlog and a store outage stay distinguishable at the job
 * level.
 */
export async function sweepFiles(): Promise<FileSweepCount> {
  const expiredBefore = sql`now() - ${PENDING_FILE_TTL}::interval`;
  const expired = () =>
    and(
      eq(files.status, 'pending'),
      isNull(files.transition),
      lt(files.createdAt, expiredBefore)
    );
  const marked = await withTransaction(async (tx) => {
    const candidates = tx
      .select({ id: files.id })
      .from(files)
      .where(expired())
      .limit(SWEEP_BATCH_SIZE);
    // The predicate is repeated on the UPDATE itself. Under Read Committed the
    // subquery's snapshot can show a row as pending that a claim — holding its
    // lock until we are blocked on it — has just made active, and PostgreSQL
    // re-evaluates only the outer WHERE against the new row version. Without
    // the repeat the sweep marked a freshly claimed, referenced file and threw
    // on the FK (reproduced).
    return tx
      .update(files)
      .set({ status: 'deleting' })
      .where(and(inArray(files.id, candidates), expired()))
      .returning({ id: files.id });
  });

  const stamped = await stampUnfiled();
  const reap = await reapUnfiled();

  const doomed = await db
    .select({ id: files.id, r2Key: files.r2Key, bucketType: files.bucketType })
    .from(files)
    .where(eq(files.status, 'deleting'))
    .limit(SWEEP_BATCH_SIZE);

  const { removed, retained } = await finishDeleting(doomed);
  return {
    removed: removed.length,
    unfiled: { stamped, reaped: reap.reaped },
    hasMore:
      marked.length === SWEEP_BATCH_SIZE ||
      doomed.length === SWEEP_BATCH_SIZE ||
      reap.hasMore ||
      retained.length > 0,
    degraded: retained.length > 0 || reap.refused > 0,
  };
}

/** One row with every column the wire shape needs plus whether the media API may act on it, or `null`. */
export async function findFile(
  id: EntityID,
  executor: typeof db | Tx = db
): Promise<(MediaFileRow & { governed: boolean }) | null> {
  const [row] = await executor
    .select({ ...FILE_COLUMNS, governed: mediaGoverned() })
    .from(files)
    .where(eq(files.id, id));
  return row ?? null;
}
