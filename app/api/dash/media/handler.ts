import type { FilterColumnSpecs } from '@/lib/data-table/column-specs';
import type { Handler } from '@/lib/http/contract';

import { and, count, eq, isNotNull } from 'drizzle-orm';

import { db } from '@/db';
import { parseDataTableParams } from '@/db/queries/data-table';
import { bucketTypeEnum, fileKindEnum, files } from '@/db/schema';
import { validID } from '@/utils';
import { requirePermission } from '@/lib/http/session';
import { KNOWN_MIME_TYPES } from '@/lib/media/allowlist';
import { FILE_COLUMNS, toMediaFiles } from '@/lib/media/files';
import {
  breadcrumbs,
  getFolder,
  listSubfolders,
  searchFolders,
} from '@/lib/media/folders';
import { UNFILED_RETENTION_DAYS, unfiledNow } from '@/lib/media/lifecycle';
import { mediaMsg } from '@/lib/media/messages';
import { ENABLED_VISIBILITIES } from '@/lib/r2/client';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import { HTTP_STATUS } from '@/utils/api-messages';
import { apiSuccess, handleApiError } from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { idRequired } from '@/utils/validation/rules';

/**
 * Server-owned filter contract for the file list. Keys are the allowlist;
 * `displayName` carries a trigram index (`db/migrations/002_media_trgm_indexes.sql`).
 * The three closed sets are PostgreSQL enums or the type table, so their members
 * are checked before any SQL is built — an unknown member is a 422, not a cast
 * error. `mimeType` is closed over what may EXIST rather than what may be
 * uploaded, so holding a type back does not hide the rows that already carry it.
 */
const MEDIA_FILTER_COLUMNS: FilterColumnSpecs = {
  displayName: { type: 'text' },
  sizeBytes: { type: 'number' },
  mimeType: { type: 'select', values: KNOWN_MIME_TYPES },
  kind: { type: 'select', values: fileKindEnum },
  bucketType: { type: 'select', values: bucketTypeEnum },
  createdAt: { type: 'date' },
  updatedAt: { type: 'date' },
};

/** Parameters this route reads itself; the data-table parser rejects unknown keys. */
const OWN_PARAMS = new Set(['folder', 'scope']);

/**
 * `folder`: one folder's view. `all`: every library file, plus folders by name.
 * `unfiled`: active files in no folder that no record references — former
 * entity uploads whose owner is gone — which the sweep deletes after
 * `UNFILED_RETENTION_DAYS` unless they are filed.
 */
export const MEDIA_SCOPES = ['folder', 'all', 'unfiled'] as const;
type MediaScope = (typeof MEDIA_SCOPES)[number];

function requireScope(query: URLSearchParams): MediaScope {
  const raw = query.get('scope') ?? 'folder';
  if (!MEDIA_SCOPES.includes(raw as MediaScope))
    throw new CustomError(mediaMsg.invalidScope, HTTP_STATUS.UNPROCESSABLE);
  return raw as MediaScope;
}

/** `null` for the root; a malformed id is a 422, like every other id here. */
function requireFolderParam(query: URLSearchParams): string | null {
  const raw = query.get('folder');
  if (raw === null || raw === '') return null;
  const id = validID(raw);
  if (!id) throw new CustomError(idRequired, HTTP_STATUS.UNPROCESSABLE);
  return id;
}

function dataTableUrl(url: string): string {
  const parsed = new URL(url);
  for (const key of OWN_PARAMS) parsed.searchParams.delete(key);
  return parsed.href;
}

export const GET: Handler = async (ctx) => {
  try {
    const { userId, permissions } = await requirePermission(ctx, {
      resource: 'media',
      action: 'view',
    });

    await enforceRateLimit({
      scope: 'media.get',
      identifier: userIdentifier(userId),
      limit: 120,
    });

    const scope = requireScope(ctx.query);
    const folderId = requireFolderParam(ctx.query);

    const {
      where,
      orderBy,
      limit,
      offset,
      page,
      perPage,
      search,
      buildPageCount,
    } = parseDataTableParams(files, {
      url: dataTableUrl(ctx.url),
      filterableColumns: MEDIA_FILTER_COLUMNS,
      searchableColumns: ['displayName'],
      defaultSort: { id: 'createdAt', desc: true },
    });

    const common = {
      visibilities: [...ENABLED_VISIBILITIES],
      canPublish: permissions?.['media']?.['publish'] === true,
    };

    // The library is the ACTIVE files that sit in a folder. Pending uploads,
    // deleting rows and entity uploads a record holds are never listed; the
    // unfiled scope is the active files in no folder that nobody holds.
    const active = eq(files.status, 'active');
    const filter =
      scope === 'all'
        ? and(active, isNotNull(files.folderId), where)
        : scope === 'unfiled'
          ? and(unfiledNow(), where)
          : folderId === null
            ? null
            : and(active, eq(files.folderId, folderId), where);

    if (scope === 'folder' && folderId !== null) {
      const folder = await getFolder(folderId);
      if (!folder)
        throw new CustomError(mediaMsg.folderNotFound, HTTP_STATUS.NOT_FOUND);
    }

    const [rows, [totalRow]] = filter
      ? await Promise.all([
          db
            .select(FILE_COLUMNS)
            .from(files)
            .where(filter)
            .orderBy(...orderBy)
            .limit(limit)
            .offset(offset),
          db.select({ total: count() }).from(files).where(filter),
        ])
      : [[], [{ total: 0 }]];
    const total = totalRow?.total ?? 0;
    const meta = { page, perPage, total, pageCount: buildPageCount(total) };

    if (scope === 'all') {
      const hits = search
        ? await searchFolders(search)
        : { folders: [], truncated: false };
      return apiSuccess({
        message: mediaMsg.fetched,
        data: {
          ...common,
          files: await toMediaFiles(rows),
          folders: hits.folders,
          foldersTruncated: hits.truncated,
        },
        meta,
      });
    }

    if (scope === 'unfiled')
      return apiSuccess({
        message: mediaMsg.fetched,
        data: {
          ...common,
          files: await toMediaFiles(rows),
          retentionDays: UNFILED_RETENTION_DAYS,
        },
        meta,
      });

    const [trail, subfolders] = await Promise.all([
      folderId === null ? Promise.resolve([]) : breadcrumbs(folderId),
      listSubfolders(folderId),
    ]);

    return apiSuccess({
      message: mediaMsg.fetched,
      data: {
        ...common,
        breadcrumbs: trail,
        folders: subfolders,
        files: await toMediaFiles(rows),
      },
      meta,
    });
  } catch (error) {
    return handleApiError(error, mediaMsg.fetchError);
  }
};
