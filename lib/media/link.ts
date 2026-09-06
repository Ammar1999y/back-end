import type { MediaFileRow } from './files';
import type { Actor } from './folders';
import type { UploadPurpose } from './policy';
import type { Tx } from '@/db';
import type { BucketType } from '@/lib/r2/client';
import type { EntityID } from '@/types';

import { and, inArray, isNotNull } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { files } from '@/db/schema';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

import { FILE_COLUMNS } from './files';
import { claimFiles } from './lifecycle';
import { mediaMsg } from './messages';
import { usageVisibilities } from './usages';
import { transitionFile } from './visibility';

interface LinkParams {
  ids: readonly EntityID[];
  purpose: UploadPurpose;
  actor: Actor;
}

type LinkRow = Pick<
  MediaFileRow,
  | 'id'
  | 'status'
  | 'kind'
  | 'bucketType'
  | 'transition'
  | 'folderId'
  | 'uploadedBy'
>;

/**
 * Which files this purpose may attach, and it is NOT "every active id".
 *
 * A grant to write the destination record authorises the destination, not the
 * source: without this a `users.create` holder could publish another record's
 * private file through here, a file the media routes answer 403 for
 * (reproduced). Three cases, and nothing else:
 *
 * - a LIBRARY file (in a folder): visible to every media grant already, and
 *   promoting it for a public purpose is the "public by linkage" rule of the
 *   plan's section 1, not an escalation;
 * - the caller's OWN pending upload: the form that uploaded it is saving now,
 *   and `claimFiles` checks the uploader again under the lock;
 * - a file only PUBLIC sources reference, for a public purpose: world-readable
 *   already, so a second public reference exposes nothing.
 *
 * Refused: an unfiled orphan — adoption through the media routes is the
 * sanctioned path and needs a media grant — and any file a PRIVATE source
 * references, whatever resource it belongs to.
 */
function eligible(
  row: LinkRow,
  purpose: UploadPurpose,
  actor: Actor,
  held: ReadonlySet<BucketType>
): boolean {
  if (row.status === 'pending') return row.uploadedBy === actor.userId;
  if (row.folderId !== null) return true;
  return (
    purpose.visibility === 'public' &&
    held.has('public') &&
    !held.has('private')
  );
}

/**
 * The rules both halves apply, in one place because they must not drift.
 *
 * `afterPromotion` is the only difference, and it is not a relaxation: before
 * the promotion a private file under a public purpose is about to become
 * public, so only an already-public file under a PRIVATE purpose can be decided
 * — no promotion ever demotes. After it, the bucket has to match exactly.
 */
function assertLinkable(
  rows: readonly LinkRow[],
  params: LinkParams,
  held: ReadonlyMap<EntityID, Set<BucketType>>,
  afterPromotion: boolean
): void {
  const { purpose, actor } = params;
  for (const row of rows) {
    if (!eligible(row, purpose, actor, held.get(row.id) ?? new Set()))
      throw new CustomError(mediaMsg.linkNotAllowed, HTTP_STATUS.FORBIDDEN);
    if (!purpose.kinds.includes(row.kind))
      throw new CustomError(
        mediaMsg.kindNotAllowedHere,
        HTTP_STATUS.UNPROCESSABLE
      );
    if (row.status === 'deleting' || row.transition)
      throw new CustomError(mediaMsg.fileBusy, HTTP_STATUS.CONFLICT);
    const mismatched = afterPromotion
      ? row.bucketType !== purpose.visibility
      : purpose.visibility === 'private' && row.bucketType === 'public';
    if (mismatched)
      throw new CustomError(
        mediaMsg.linkVisibilityMismatch,
        HTTP_STATUS.CONFLICT
      );
  }
}

/**
 * Everything about the id set that can be decided before any object moves:
 * existence, eligibility, kind, status and a transition in flight. It runs
 * before `promoteForLink` because a rejected link that has already published a
 * private document is a rejected link with a permanent public URL (reproduced).
 *
 * Not a substitute for the locked re-check in `attachFiles`: this reads without
 * a lock, so it settles authorisation, and the lock settles races.
 */
async function checkLinkable(params: LinkParams): Promise<LinkRow[]> {
  const ids = [...new Set(params.ids)];
  const rows = await db
    .select({
      id: files.id,
      status: files.status,
      kind: files.kind,
      bucketType: files.bucketType,
      transition: files.transition,
      folderId: files.folderId,
      uploadedBy: files.uploadedBy,
    })
    .from(files)
    .where(inArray(files.id, ids));
  if (rows.length !== ids.length)
    throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.UNPROCESSABLE);

  assertLinkable(rows, { ...params, ids }, await usageVisibilities(ids), false);
  return rows;
}

/**
 * Attaching files to an owner record — active library files from the picker,
 * pending uploads from `POST /api/upload/file` — in two halves, because a
 * bucket copy must not run inside a transaction (`db/limits.ts`):
 *
 * - `promoteForLink`, outside any transaction, checks the whole batch and then
 *   moves private active files to the public bucket when the purpose is public.
 * - `attachFiles`, inside the owner's transaction and under `FOR UPDATE`,
 *   claims pending uploads, re-checks that every file still has the purpose's
 *   visibility and is not mid-transition, and clears `unfiled_at`. The caller
 *   inserts its referrer rows after it in the same transaction; the composite
 *   FK does the rest.
 *
 * The re-check under the lock is the point. An unpublish can complete between
 * the promotion and the owner's commit (reproduced), and the FK alone would
 * still accept the referrer because it checks `status`, not the bucket. The
 * unpublish's first step locks the same row and sets `transition`, so whichever
 * of the two takes the lock first, the other refuses with 409.
 *
 * A promotion that succeeds and is then followed by a failed owner write leaves
 * a public library file with no referrer — the "public, unused" state the plan's
 * section 1 declares acceptable and one click from unpublish. Demoting it here
 * is what that section forbids, and a concurrent second link may already depend
 * on the public copy.
 *
 * `linkFiles` runs both halves for a caller with no transaction of its own.
 */
export async function promoteForLink(params: LinkParams): Promise<void> {
  const ids = [...new Set(params.ids)];
  if (ids.length === 0) return;
  const rows = await checkLinkable({ ...params, ids });
  if (params.purpose.visibility !== 'public') return;
  for (const row of rows)
    if (row.status === 'active' && row.bucketType === 'private')
      // Authorised by the owner's write grant, not by a media scope, so the
      // uploader narrowing does not apply.
      await transitionFile({
        id: row.id,
        to: 'public',
        actor: { ...params.actor, scope: 'all' },
        authorizedByOwner: true,
      });
}

export async function attachFiles(tx: Tx, params: LinkParams): Promise<void> {
  const ids = [...new Set(params.ids)];
  if (ids.length === 0) return;

  const rows = await tx
    .select(FILE_COLUMNS)
    .from(files)
    .where(inArray(files.id, ids))
    .for('update');
  if (rows.length !== ids.length)
    throw new CustomError(mediaMsg.fileNotFound, HTTP_STATUS.UNPROCESSABLE);
  assertLinkable(
    rows,
    { ...params, ids },
    await usageVisibilities(ids, tx),
    true
  );

  await claimFiles(tx, {
    ids: rows.filter((row) => row.status === 'pending').map((row) => row.id),
    actor: params.actor,
  });
  await tx
    .update(files)
    .set({ unfiledAt: null })
    .where(and(inArray(files.id, ids), isNotNull(files.unfiledAt)));
}

export async function linkFiles(
  params: LinkParams & { write: (tx: Tx) => Promise<void> }
): Promise<void> {
  await promoteForLink(params);
  await withTransaction(async (tx) => {
    await attachFiles(tx, params);
    await params.write(tx);
  });
}
