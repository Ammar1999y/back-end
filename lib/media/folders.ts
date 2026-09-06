import type { Tx } from '@/db';
import type { EntityID } from '@/types';

import { asc, eq, isNull, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { files, folders } from '@/db/schema';
import { getConstraintName, isUniqueViolation } from '@/utils';
import { auditLog } from '@/lib/audit';
import { escapeLike } from '@/lib/data-table/filter-columns';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import {
  FOLDER_MAX_CHILDREN,
  FOLDER_MAX_DEPTH,
} from '@/utils/validation/constants';

import { mediaMsg } from './messages';

export interface Actor {
  userId: EntityID;
  email: string;
  /** `own` narrows every write to folders the actor created. */
  scope: 'all' | 'own';
  meta: { ip: string | null; userAgent: string | null; apiPath: string };
}

/** What an audit row needs about the caller; the scope is the route's business. */
export type AuditActor = Pick<Actor, 'userId' | 'email' | 'meta'>;

export interface FolderSummary {
  id: string;
  name: string;
  parentId: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * What a folder delete removed. One shape for both modes, so a client reads the
 * same answer whether it asked for one folder or a subtree: `folders` is how
 * many folder rows went, and the file half mirrors `DELETE /api/dash/media/files`
 * — `deleted` is gone from both stores, `pending` is committed to deletion and
 * invisible with its object still to remove.
 *
 * `folders: 0` with files in `deleted` is the honest report of a recursive
 * delete whose files went but whose folders could not: something was still in
 * the tree when the folders were about to go (`pending` rows the sweep has yet
 * to finish, or an upload that arrived in the window between the two halves).
 */
export interface FolderDeleteOutcome {
  folders: number;
  deleted: EntityID[];
  pending: EntityID[];
}

export interface Breadcrumb {
  id: string;
  name: string;
}

export interface FolderHit extends FolderSummary {
  /** Root → the folder itself. */
  breadcrumbs: Breadcrumb[];
}

/**
 * Name matches returned by `scope=all`. A navigation aid beside a paginated
 * file list, not a list of its own, so it is capped rather than paged — and the
 * cap is reported, because a search that silently drops the folder someone is
 * looking for is worse than one that says there are more.
 */
const FOLDER_SEARCH_LIMIT = 20;

const FOLDER_UNIQUE_CONSTRAINTS = new Set([
  'ux_folders_parent_name',
  'ux_folders_root_name',
]);

/** A duplicate name is the one constraint a client can correct; anything else is a bug. */
function folderNameConflict(error: unknown): CustomError | null {
  if (!isUniqueViolation(error)) return null;
  return FOLDER_UNIQUE_CONSTRAINTS.has(getConstraintName(error))
    ? new CustomError(mediaMsg.folderNameExists, HTTP_STATUS.CONFLICT)
    : null;
}

/**
 * One tree, one lock. Row locks on the moved folder and its destination are not
 * enough: two disjoint moves (`A` under `B1`, `B` under `A1`) each validate
 * against the tree the other is about to change and both commit a cycle
 * (reproduced against PostgreSQL). Every structural change takes this
 * transaction-scoped advisory lock FIRST, before any row lock, so two of them
 * serialize instead of deadlocking on each other's rows. Folder mutations are
 * rare administrative actions; one lock is the right size.
 */
/**
 * Exported for `deleteFolderTree` (`./lifecycle.ts`), which deletes the files
 * of a subtree and then its folders. The dependency points that way on purpose:
 * this module must not import the file lifecycle, or the two would form a cycle.
 */
export async function lockTree(tx: Tx): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('media.folders'))`
  );
}

/**
 * Root → leaf. Bounded by the depth cap plus one so a cycle that somehow got
 * into the table terminates the query rather than the server.
 */
export async function breadcrumbs(
  folderId: EntityID,
  executor: typeof db | Tx = db
): Promise<Breadcrumb[]> {
  const rows = await executor.execute<{ id: string; name: string }>(sql`
    with recursive up as (
      select id, parent_id, name, 1 as depth
      from folders where id = ${folderId}::uuid
      union all
      select f.id, f.parent_id, f.name, up.depth + 1
      from folders f join up on f.id = up.parent_id
      where up.depth <= ${FOLDER_MAX_DEPTH}
    )
    select id::text as id, name from up order by depth desc
  `);
  return rows.map((row) => ({ id: row.id, name: row.name }));
}

/** 1 for a root folder. `null` when the folder does not exist. */
async function depthOf(
  executor: Tx,
  folderId: EntityID
): Promise<number | null> {
  const rows = await executor.execute<{ depth: number | string }>(sql`
    with recursive up as (
      select id, parent_id, 1 as depth from folders where id = ${folderId}::uuid
      union all
      select f.id, f.parent_id, up.depth + 1
      from folders f join up on f.id = up.parent_id
      where up.depth <= ${FOLDER_MAX_DEPTH}
    )
    select max(depth) as depth from up
  `);
  const depth = rows[0]?.depth;
  return depth == null ? null : Number(depth);
}

/** Every folder under `folderId`, itself included, with the subtree's height. */
/**
 * The folder and everything under it, DEEPEST FIRST — the order a delete has to
 * use, and the shape a cycle check and a recursive delete both need. Bounded by
 * the depth cap plus one so a cycle that somehow got into the table terminates
 * the query rather than the server.
 */
export async function subtreeFolders(
  executor: Tx,
  folderId: EntityID
): Promise<Array<FolderSummary & { level: number }>> {
  const rows = await executor.execute<{
    id: string;
    name: string;
    parent_id: string | null;
    created_by: string | null;
    created_at: Date;
    updated_at: Date;
    level: number | string;
  }>(sql`
    with recursive down as (
      select id, 1 as level from folders where id = ${folderId}::uuid
      union all
      select f.id, down.level + 1
      from folders f join down on f.parent_id = down.id
      where down.level <= ${FOLDER_MAX_DEPTH}
    )
    select f.id::text as id,
           f.name,
           f.parent_id::text as parent_id,
           f.created_by::text as created_by,
           f.created_at,
           f.updated_at,
           down.level
    from down join folders f on f.id = down.id
    order by down.level desc, f.id
  `);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    level: Number(row.level),
  }));
}

async function subtreeOf(
  executor: Tx,
  folderId: EntityID
): Promise<{ ids: Set<string>; height: number }> {
  const rows = await subtreeFolders(executor, folderId);
  return {
    ids: new Set(rows.map((row) => row.id)),
    height: rows[0]?.level ?? 0,
  };
}

/** The fan-out cap on one parent; `null` is the root. Runs under `lockTree`. */
async function assertRoomUnder(
  tx: Tx,
  parentId: EntityID | null
): Promise<void> {
  const [count] = await tx
    .select({ children: sql<number>`count(*)::int` })
    .from(folders)
    .where(
      parentId === null
        ? isNull(folders.parentId)
        : eq(folders.parentId, parentId)
    );
  if ((count?.children ?? 0) >= FOLDER_MAX_CHILDREN)
    throw new CustomError(
      mediaMsg.folderTooManyChildren,
      HTTP_STATUS.UNPROCESSABLE
    );
}

/** The prospective parent's depth, with the fan-out cap checked under it. */
async function lockParent(
  tx: Tx,
  parentId: EntityID
): Promise<{ depth: number }> {
  const [parent] = await tx
    .select({ id: folders.id })
    .from(folders)
    .where(eq(folders.id, parentId))
    .for('update');
  if (!parent)
    throw new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND);

  const depth = await depthOf(tx, parentId);
  if (depth === null)
    throw new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND);

  await assertRoomUnder(tx, parentId);
  return { depth };
}

/** Exported for `deleteFolderTree`, like `lockTree`. */
export async function lockFolderFor(
  tx: Tx,
  folderId: EntityID,
  actor: Actor
): Promise<FolderSummary> {
  const [folder] = await tx
    .select({
      id: folders.id,
      name: folders.name,
      parentId: folders.parentId,
      createdBy: folders.createdBy,
      createdAt: folders.createdAt,
      updatedAt: folders.updatedAt,
    })
    .from(folders)
    .where(eq(folders.id, folderId))
    .for('update');
  // Out of scope answers exactly like absent, the way every `own`-scoped gate in
  // this codebase does.
  if (!folder || (actor.scope === 'own' && folder.createdBy !== actor.userId))
    throw new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND);
  return folder;
}

export async function getFolder(
  folderId: EntityID,
  executor: typeof db | Tx = db
): Promise<FolderSummary | null> {
  const [folder] = await executor
    .select({
      id: folders.id,
      name: folders.name,
      parentId: folders.parentId,
      createdBy: folders.createdBy,
      createdAt: folders.createdAt,
      updatedAt: folders.updatedAt,
    })
    .from(folders)
    .where(eq(folders.id, folderId));
  return folder ?? null;
}

/** Direct children, by name. Bounded by the cap, which the root shares, so never paginated. */
export async function listSubfolders(
  parentId: EntityID | null
): Promise<FolderSummary[]> {
  return db
    .select({
      id: folders.id,
      name: folders.name,
      parentId: folders.parentId,
      createdBy: folders.createdBy,
      createdAt: folders.createdAt,
      updatedAt: folders.updatedAt,
    })
    .from(folders)
    .where(
      parentId === null
        ? isNull(folders.parentId)
        : eq(folders.parentId, parentId)
    )
    .orderBy(asc(sql`lower(${folders.name})`), asc(folders.id))
    .limit(FOLDER_MAX_CHILDREN);
}

/**
 * Folders whose name contains `term`, by name, each with its path from the
 * root — one statement, so twenty hits do not cost twenty recursive queries.
 * `term` is already normalised by the data-table parser. One row beyond the cap
 * is fetched and dropped, which is what `truncated` reports.
 */
export async function searchFolders(
  term: string
): Promise<{ folders: FolderHit[]; truncated: boolean }> {
  const pattern = `%${escapeLike(term)}%`;
  const rows = await db.execute<{
    id: string;
    name: string;
    parent_id: string | null;
    created_by: string | null;
    created_at: Date;
    updated_at: Date;
    breadcrumbs: Breadcrumb[];
  }>(sql`
    with recursive hits as (
      select id, name, parent_id, created_by, created_at, updated_at
      from folders
      where name ilike ${pattern}
      order by lower(name), id
      limit ${FOLDER_SEARCH_LIMIT + 1}
    ), up as (
      select h.id as hit, f.id, f.parent_id, f.name, 1 as depth
      from hits h join folders f on f.id = h.id
      union all
      select up.hit, f.id, f.parent_id, f.name, up.depth + 1
      from folders f join up on f.id = up.parent_id
      where up.depth <= ${FOLDER_MAX_DEPTH}
    )
    select h.id::text as id,
           h.name,
           h.parent_id::text as parent_id,
           h.created_by::text as created_by,
           h.created_at,
           h.updated_at,
           coalesce(
             (select json_agg(json_build_object('id', up.id::text, 'name', up.name) order by up.depth desc)
              from up where up.hit = h.id),
             '[]'::json
           ) as breadcrumbs
    from hits h
    order by lower(h.name), h.id
  `);
  return {
    folders: rows.slice(0, FOLDER_SEARCH_LIMIT).map((row) => ({
      id: row.id,
      name: row.name,
      parentId: row.parent_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      breadcrumbs: row.breadcrumbs,
    })),
    truncated: rows.length > FOLDER_SEARCH_LIMIT,
  };
}

export async function createFolder(params: {
  parentId: EntityID | null;
  name: string;
  actor: Actor;
}): Promise<FolderSummary> {
  const { parentId, name, actor } = params;
  try {
    return await withTransaction(async (tx) => {
      await lockTree(tx);
      if (parentId === null) await assertRoomUnder(tx, null);
      else {
        const { depth } = await lockParent(tx, parentId);
        if (depth + 1 > FOLDER_MAX_DEPTH)
          throw new CustomError(
            mediaMsg.folderTooDeep,
            HTTP_STATUS.UNPROCESSABLE
          );
      }

      const [created] = await tx
        .insert(folders)
        .values({ parentId, name, createdBy: actor.userId })
        .returning({
          id: folders.id,
          name: folders.name,
          parentId: folders.parentId,
          createdBy: folders.createdBy,
          createdAt: folders.createdAt,
          updatedAt: folders.updatedAt,
        });
      if (!created)
        throw new CustomError(mediaMsg.updateError, HTTP_STATUS.INTERNAL_ERROR);

      await auditLog(tx, {
        userId: actor.userId,
        userEmail: actor.email,
        action: 'INSERT',
        tableName: 'folders',
        recordId: created.id,
        newData: { name, parentId },
        meta: actor.meta,
      });
      return created;
    });
  } catch (error) {
    throw folderNameConflict(error) ?? error;
  }
}

export async function updateFolder(params: {
  folderId: EntityID;
  name?: string;
  /** `null` moves to the root; `undefined` leaves the parent alone. */
  parentId?: EntityID | null;
  actor: Actor;
}): Promise<FolderSummary> {
  const { folderId, name, parentId, actor } = params;
  try {
    return await withTransaction(async (tx) => {
      await lockTree(tx);
      const current = await lockFolderFor(tx, folderId, actor);

      const moving = parentId !== undefined && parentId !== current.parentId;
      if (moving && parentId === null) await assertRoomUnder(tx, null);
      if (moving && parentId !== null) {
        const { ids, height } = await subtreeOf(tx, folderId);
        if (ids.has(parentId))
          throw new CustomError(
            mediaMsg.folderCycle,
            HTTP_STATUS.UNPROCESSABLE
          );
        const { depth } = await lockParent(tx, parentId);
        if (depth + height > FOLDER_MAX_DEPTH)
          throw new CustomError(
            mediaMsg.folderTooDeep,
            HTTP_STATUS.UNPROCESSABLE
          );
      }

      const [updated] = await tx
        .update(folders)
        .set({
          ...(name !== undefined && { name }),
          ...(moving && { parentId }),
        })
        .where(eq(folders.id, folderId))
        .returning({
          id: folders.id,
          name: folders.name,
          parentId: folders.parentId,
          createdBy: folders.createdBy,
          createdAt: folders.createdAt,
          updatedAt: folders.updatedAt,
        });
      if (!updated)
        throw new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND);

      await auditLog(tx, {
        userId: actor.userId,
        userEmail: actor.email,
        action: 'UPDATE',
        tableName: 'folders',
        recordId: folderId,
        oldData: { name: current.name, parentId: current.parentId },
        newData: { name: updated.name, parentId: updated.parentId },
        skipIfUnchanged: true,
        meta: actor.meta,
      });
      return updated;
    });
  } catch (error) {
    throw folderNameConflict(error) ?? error;
  }
}

/**
 * Empty folders only. A recursive delete would have to remove objects for every
 * file underneath, which is a job, not a request; refusing keeps every request
 * bounded and keeps "delete" from ever meaning "delete a thousand things".
 */
export async function deleteFolder(params: {
  folderId: EntityID;
  actor: Actor;
}): Promise<FolderDeleteOutcome> {
  const { folderId, actor } = params;
  await withTransaction(async (tx) => {
    await lockTree(tx);
    const current = await lockFolderFor(tx, folderId, actor);

    const [children] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(folders)
      .where(eq(folders.parentId, folderId));
    // Any row, whatever its status: a pending upload or a half-deleted file in
    // here is still an object the folder is responsible for.
    const [contents] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(files)
      .where(eq(files.folderId, folderId));
    if ((children?.count ?? 0) > 0 || (contents?.count ?? 0) > 0)
      throw new CustomError(mediaMsg.folderNotEmpty, HTTP_STATUS.CONFLICT);

    await tx.delete(folders).where(eq(folders.id, folderId));

    await auditLog(tx, {
      userId: actor.userId,
      userEmail: actor.email,
      action: 'DELETE',
      tableName: 'folders',
      recordId: folderId,
      oldData: { name: current.name, parentId: current.parentId },
      meta: actor.meta,
    });
  });
  return { folders: 1, deleted: [], pending: [] };
}
