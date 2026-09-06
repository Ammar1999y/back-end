/**
 * The file half of the media library: upload, list, rename, move, publish,
 * unpublish, delete, claim and link — and the properties the design rests on,
 * asserted against the real database and the stateful object-store stub.
 *
 * - **No transaction across the object store.** Every saga leaves a marker; the
 *   tests drive each one through success, through an injected failure, and
 *   through the sweep that finishes or reverts what the failure left.
 * - **The composite FK is the deletion guard.** A referrer table with the
 *   `(file_id, file_status)` shape is created here (the starter kit ships no
 *   owner tables), and a referenced file's delete is refused by the DATABASE, not
 *   by a check the handler could forget.
 * - **The media API governs what no record holds.** A claimed entity upload
 *   still referenced by its record is that record's; the same file with its
 *   referrer gone is unfiled, listed, adoptable, and reaped after the window.
 * - **Linking is one boundary.** `linkFiles` promotes outside a transaction and
 *   re-checks under the row lock, so an unpublish that slips in between is
 *   refused instead of leaving a public record pointing at a private file.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import type { SignedInSession } from '../helpers/session';
import type { FileTypeSpec } from '@/lib/media/allowlist';

import { and, eq, sql } from 'drizzle-orm';

import { app } from '@/app';
import { db, withTransaction } from '@/db';
import { auditLogs, files } from '@/db/schema';
import { generateUuidV7 } from '@/lib/id';
import { FILE_TYPES } from '@/lib/media/allowlist';
import { claimFiles, sweepFiles } from '@/lib/media/lifecycle';
import { attachFiles, linkFiles, promoteForLink } from '@/lib/media/link';
import { mediaMsg } from '@/lib/media/messages';
import { retryTransitions, transitionFile } from '@/lib/media/visibility';
import * as r2 from '@/lib/r2/client';

import { HTTP_STATUS } from '@/utils/api-messages';
import { FOLDER_RECURSIVE_DELETE_MAX } from '@/utils/validation/constants';

import { resetTables } from '../helpers/database';
import {
  clearObjectStoreFailures,
  corruptNextCopy,
  failObjectStore,
  preconditionFailNextPut,
  storedObject,
  storeHas,
  storeOps,
  storeOpsOf,
} from '../helpers/object-store';
import { resetRateLimits } from '../helpers/rate-limit';
import { authedRequest, signedInUser } from '../helpers/session';
import {
  createReferrerTable,
  dropReferrerTable,
  PRIVATE_SOURCE,
  PUBLIC_SOURCE,
  refer,
  referrerCount,
  unrefer,
  withSource,
} from '../helpers/usage-registry';

const PUBLIC_BUCKET = process.env.R2_PUBLIC_BUCKET ?? '';
const PRIVATE_BUCKET = process.env.R2_PRIVATE_BUCKET ?? '';
const PUBLIC_URL = process.env.R2_PUBLIC_URL ?? '';

const byText = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

interface Answer {
  status: number;
  body: { success: boolean; message: string; data: unknown; meta?: unknown };
}

interface MediaFile {
  id: string;
  kind: 'image' | 'document';
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  bucketType: 'public' | 'private';
  transition: string | null;
  folderId: string | null;
  uploadedBy: string | null;
  unfiledAt: string | null;
  url: string;
}

async function call(
  session: SignedInSession,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown | FormData
): Promise<Answer> {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await app.handle(authedRequest(session, path, init));
  return { status: response.status, body: await response.json() };
}

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8">' +
  '<rect width="8" height="8" fill="#0000ff"/></svg>';

function svgForm(name = 'logo.svg', field = 'file'): FormData {
  const form = new FormData();
  form.append(field, new File([SVG], name, { type: 'image/svg+xml' }));
  return form;
}

function pdfForm(name = 'brochure.pdf'): FormData {
  const form = new FormData();
  form.append(
    'file',
    new File(['%PDF-1.4\n%harness brochure\n'], name, {
      type: 'application/pdf',
    })
  );
  return form;
}

async function upload(
  session: SignedInSession,
  folderId: string,
  form: FormData
) {
  const answer = await call(
    session,
    'POST',
    `/api/dash/media/files?folder=${folderId}`,
    form
  );
  expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.CREATED);
  return answer.body.data as MediaFile;
}

/** A pending entity upload for the `users` resource, as a form would make it. */
async function uploadForRecord(
  session: SignedInSession,
  name = 'avatar.svg'
): Promise<MediaFile> {
  const answer = await call(
    session,
    'POST',
    '/api/upload/file?resource=users',
    svgForm(name, 'files')
  );
  expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.CREATED);
  const [file] = answer.body.data as MediaFile[];
  if (!file) throw new Error('upload returned no file');
  return file;
}

async function createFolder(
  session: SignedInSession,
  name: string
): Promise<string> {
  const answer = await call(session, 'POST', '/api/dash/media/folders', {
    name,
  });
  expect(answer.status).toBe(HTTP_STATUS.CREATED);
  return (answer.body.data as { id: string }).id;
}

async function keyOf(id: string): Promise<string> {
  const row = await rowOf(id);
  return row?.r2Key ?? '';
}

async function rowOf(id: string) {
  const [row] = await db
    .select({
      r2Key: files.r2Key,
      status: files.status,
      bucketType: files.bucketType,
      transition: files.transition,
      folderId: files.folderId,
      displayName: files.displayName,
      sha256: files.sha256,
      unfiledAt: files.unfiledAt,
    })
    .from(files)
    .where(eq(files.id, id));
  return row ?? null;
}

/**
 * In the order they were written. Rows of one transaction share a timestamp, so
 * this is only a sequence where the events are separate transactions — which is
 * what every assertion on it means.
 */
async function auditActions(id: string): Promise<string[]> {
  const rows = await db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(and(eq(auditLogs.tableName, 'files'), eq(auditLogs.recordId, id)))
    .orderBy(auditLogs.createdAt);
  return rows.map((row) => row.action);
}

const sessions: { admin?: SignedInSession; viewer?: SignedInSession } = {};
function admin() {
  if (!sessions.admin) throw new Error('admin not seeded');
  return sessions.admin;
}
function viewer() {
  if (!sessions.viewer) throw new Error('viewer not seeded');
  return sessions.viewer;
}

function actorOf(session: SignedInSession) {
  return {
    userId: session.user.userId,
    email: session.user.email,
    scope: 'all' as const,
    meta: { ip: null, userAgent: null, apiPath: '/test' },
  };
}

beforeAll(async () => {
  await resetTables();
  await createReferrerTable();
  sessions.admin = await signedInUser();
  sessions.viewer = await signedInUser({
    permissions: { media: { view: true } },
  });
});

// Both upload routes share ONE per-user admission budget, and this suite posts
// more than a window's worth of them through one account: without this it reads
// its own 429s as failures of the thing under test. No test here asserts a limit.
beforeEach(() => {
  resetRateLimits();
});

afterAll(async () => {
  await dropReferrerTable();
});

describe('upload into a folder', () => {
  test('an image lands PRIVATE and ACTIVE, with the object written under If-None-Match and an audit row', async () => {
    const folderId = await createFolder(admin(), 'Uploads');
    const file = await upload(admin(), folderId, svgForm('Brand Logo.svg'));

    expect(file).toMatchObject({
      kind: 'image',
      mimeType: 'image/svg+xml',
      bucketType: 'private',
      transition: null,
      folderId,
      uploadedBy: admin().user.userId,
      displayName: 'Brand Logo.svg',
      unfiledAt: null,
    });
    // Private objects are reached through a signed URL, never a bare key.
    expect(file.url).toContain('signed.example.invalid');
    expect(file.url).not.toContain(PUBLIC_URL);

    const row = await rowOf(file.id);
    expect(row).toMatchObject({
      status: 'active',
      bucketType: 'private',
      folderId,
    });
    expect(row?.r2Key).toMatch(/^m\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.svg$/);
    expect(row?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(storeHas(PRIVATE_BUCKET, row?.r2Key ?? '')).toBe(true);
    expect(storeHas(PUBLIC_BUCKET, row?.r2Key ?? '')).toBe(false);

    const [put] = storeOpsOf('PutObject');
    expect(put).toMatchObject({ bucket: PRIVATE_BUCKET, ifNoneMatch: '*' });
    const stored = storedObject(PRIVATE_BUCKET, row?.r2Key ?? '');
    expect(stored?.contentDisposition).toContain('inline');
    // The checksum travels with the write, so the object can later vouch for
    // itself before a copy.
    expect(stored?.checksumSha256).toBe(
      Buffer.from(row?.sha256 ?? '', 'hex').toString('base64')
    );

    expect(await auditActions(file.id)).toEqual(['INSERT']);
  });

  test('a document is stored as an attachment with the canonical type', async () => {
    const folderId = await createFolder(admin(), 'Documents');
    const file = await upload(admin(), folderId, pdfForm('Q3 report.pdf'));
    expect(file).toMatchObject({
      kind: 'document',
      mimeType: 'application/pdf',
    });
    const row = await rowOf(file.id);
    expect(storedObject(PRIVATE_BUCKET, row?.r2Key ?? '')).toMatchObject({
      contentType: 'application/pdf',
    });
    expect(
      storedObject(PRIVATE_BUCKET, row?.r2Key ?? '')?.contentDisposition
    ).toContain('attachment');
  });

  test('a failed object write keeps the pending row, and the sweep later removes the row with whatever the store holds', async () => {
    const folderId = await createFolder(admin(), 'Failing');
    failObjectStore('PutObject');
    const answer = await call(
      admin(),
      'POST',
      `/api/dash/media/files?folder=${folderId}`,
      svgForm()
    );
    expect(answer.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
    expect(answer.body.message).toBe(mediaMsg.storeFailed);

    // A lost response does not prove the object was not written, so the row
    // — the only record of the key — survives as `pending` for the sweep.
    const [row] = await db
      .select({ id: files.id, status: files.status, r2Key: files.r2Key })
      .from(files)
      .where(eq(files.folderId, folderId));
    expect(row).toMatchObject({ status: 'pending' });
    const listed = await call(
      admin(),
      'GET',
      `/api/dash/media?folder=${folderId}`
    );
    expect((listed.body.data as { files: MediaFile[] }).files).toEqual([]);

    clearObjectStoreFailures();
    await db
      .update(files)
      .set({ createdAt: sql`now() - interval '2 days'` })
      .where(eq(files.id, row?.id ?? ''));
    const swept = await sweepFiles();
    expect(swept.removed).toBe(1);
    expect(await rowOf(row?.id ?? '')).toBeNull();
    expect(storeOpsOf('DeleteObjects').flatMap((op) => op.keys ?? [])).toEqual([
      row?.r2Key ?? '',
    ]);
  });

  test('a 412 is resolved by looking: our own retried write succeeds, a foreign object removes the row, an empty key keeps it', async () => {
    // The SDK retries (`maxAttempts: 3`), so a first attempt that committed and
    // lost its response comes back as a 412 against our OWN object. Reported as
    // a 500 with the row deleted, that turned a successful upload into an
    // unreachable, unsweepable object nobody pays attention to but the bill.
    const own = await createFolder(admin(), 'Retried');
    preconditionFailNextPut('own');
    const retried = await call(
      admin(),
      'POST',
      `/api/dash/media/files?folder=${own}`,
      svgForm('retried.svg')
    );
    expect(retried.status, JSON.stringify(retried.body)).toBe(
      HTTP_STATUS.CREATED
    );
    const stored = retried.body.data as MediaFile;
    expect(await rowOf(stored.id)).toMatchObject({ status: 'active' });
    expect(storeHas(PRIVATE_BUCKET, await keyOf(stored.id))).toBe(true);
    expect(storeOps().map((op) => op.kind)).toEqual([
      'PutObject',
      'HeadObject',
    ]);

    // A foreign object at the key: the row goes, and NOTHING at the key is
    // touched, because whatever is there is someone else's.
    resetObjectStoreOps();
    const foreign = await createFolder(admin(), 'Collision');
    preconditionFailNextPut('foreign');
    const collided = await call(
      admin(),
      'POST',
      `/api/dash/media/files?folder=${foreign}`,
      svgForm()
    );
    expect(collided.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
    expect(storeOps().map((op) => op.kind)).toEqual([
      'PutObject',
      'HeadObject',
    ]);
    expect(
      await db
        .select({ id: files.id })
        .from(files)
        .where(eq(files.folderId, foreign))
    ).toEqual([]);

    // A 412 with nothing at the key proves neither, so the row is kept for the
    // sweep — the rule every other ambiguous write here follows.
    resetObjectStoreOps();
    const empty = await createFolder(admin(), 'Contradiction');
    preconditionFailNextPut('empty');
    const nothing = await call(
      admin(),
      'POST',
      `/api/dash/media/files?folder=${empty}`,
      svgForm()
    );
    expect(nothing.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
    expect(
      await db
        .select({ status: files.status })
        .from(files)
        .where(eq(files.folderId, empty))
    ).toEqual([{ status: 'pending' }]);
  });

  test('a detector that throws is a refusal, not a 500', async () => {
    // The allowlist's contract is that a `detect` ANSWERS. One entry's bug
    // reaching `handleApiError` as an unknown error made hostile bytes a 500 on
    // both upload routes, and a cheap way to fill the error log.
    const folderId = await createFolder(admin(), 'Throwing detector');
    const table = FILE_TYPES as Map<string, FileTypeSpec>;
    const pdf = table.get('application/pdf');
    if (!pdf) throw new Error('the allowlist has no PDF entry');
    table.set('application/pdf', {
      ...pdf,
      detect: () => {
        throw new Error('detector bug');
      },
    });
    try {
      const answer = await call(
        admin(),
        'POST',
        `/api/dash/media/files?folder=${folderId}`,
        pdfForm()
      );
      expect(answer.status).toBe(HTTP_STATUS.BAD_REQUEST);
    } finally {
      table.set('application/pdf', pdf);
    }
    expect(
      await db
        .select({ id: files.id })
        .from(files)
        .where(eq(files.folderId, folderId))
    ).toEqual([]);
  });

  test('the folder must exist and the caller must hold create', async () => {
    const missing = await call(
      admin(),
      'POST',
      '/api/dash/media/files?folder=0192b4b6-6f1a-7c3e-9a1f-2b3c4d5e6f70',
      svgForm()
    );
    expect(missing.status).toBe(HTTP_STATUS.NOT_FOUND);
    const malformed = await call(
      admin(),
      'POST',
      '/api/dash/media/files?folder=x',
      svgForm()
    );
    expect(malformed.status).toBe(HTTP_STATUS.UNPROCESSABLE);

    const folderId = await createFolder(admin(), 'Viewer target');
    const forbidden = await call(
      viewer(),
      'POST',
      `/api/dash/media/files?folder=${folderId}`,
      svgForm()
    );
    expect(forbidden.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(storeOps()).toEqual([]);
  });

  test('a deployment without the private bucket refuses library uploads rather than publishing them', async () => {
    const creator = await signedInUser({
      permissions: { media: { view: true, create: true } },
    });
    const folderId = await createFolder(admin(), 'Public only');
    const enabled = spyOn(r2, 'isVisibilityEnabled').mockImplementation(
      (bucket) => bucket === 'public'
    );
    try {
      const answer = await call(
        creator,
        'POST',
        `/api/dash/media/files?folder=${folderId}`,
        pdfForm('private-intent.pdf')
      );
      expect(answer.status).toBe(HTTP_STATUS.UNPROCESSABLE);
      expect(answer.body.message).toBe(mediaMsg.visibilityDisabled);
      expect(storeOps()).toEqual([]);
    } finally {
      enabled.mockRestore();
    }
  });
});

describe('listing, renaming, moving', () => {
  test('a folder view pages its files; the library search crosses folders and names folders too', async () => {
    const a = await createFolder(admin(), 'List A');
    const b = await createFolder(admin(), 'List B');
    const gamma = await createFolder(admin(), 'Gamma Assets');
    const one = await upload(admin(), a, svgForm('alpha.svg'));
    await upload(admin(), a, svgForm('beta.svg'));
    await upload(admin(), b, svgForm('gamma.svg'));

    const inA = await call(admin(), 'GET', `/api/dash/media?folder=${a}`);
    expect(inA.status).toBe(HTTP_STATUS.OK);
    const dataA = inA.body.data as {
      files: MediaFile[];
      breadcrumbs: unknown[];
    };
    expect(
      dataA.files.map((file) => file.displayName).toSorted(byText)
    ).toEqual(['alpha.svg', 'beta.svg']);
    expect(inA.body.meta).toMatchObject({ total: 2 });

    const search = await call(
      admin(),
      'GET',
      '/api/dash/media?scope=all&search=gam'
    );
    expect(search.status).toBe(HTTP_STATUS.OK);
    const found = search.body.data as {
      files: MediaFile[];
      folders: Array<{ id: string; name: string; breadcrumbs: unknown[] }>;
      foldersTruncated: boolean;
    };
    expect(found.files.map((file) => file.displayName)).toEqual(['gamma.svg']);
    expect(found.folders).toEqual([
      expect.objectContaining({
        id: gamma,
        name: 'Gamma Assets',
        breadcrumbs: [{ id: gamma, name: 'Gamma Assets' }],
      }),
    ]);
    // The hits are capped at twenty and say so, rather than dropping the
    // twenty-first silently beside a file list that IS fully paginated.
    expect(found.foldersTruncated).toBe(false);

    // Without a term the search names no folders: the list is files.
    const plain = await call(admin(), 'GET', '/api/dash/media?scope=all');
    expect((plain.body.data as { folders: unknown[] }).folders).toEqual([]);

    const details = await call(
      admin(),
      'GET',
      `/api/dash/media/files/${one.id}`
    );
    expect(details.status).toBe(HTTP_STATUS.OK);
    expect(details.body.data).toMatchObject({
      id: one.id,
      usedBy: [],
      hiddenUsages: 0,
      unfiledAt: null,
    });
    const download = (details.body.data as { downloadUrl: string }).downloadUrl;
    expect(download).toContain('attachment');
    expect(download).toContain('alpha.svg');
  });

  test('rename and move are database-only, and a rename follows into the download name', async () => {
    const from = await createFolder(admin(), 'Move from');
    const to = await createFolder(admin(), 'Move to');
    const file = await upload(admin(), from, svgForm('old-name.svg'));
    const before = storeOps().length;

    const renamed = await call(
      admin(),
      'PUT',
      `/api/dash/media/files/${file.id}`,
      {
        displayName: 'New name',
      }
    );
    expect(renamed.status).toBe(HTTP_STATUS.OK);
    expect((renamed.body.data as MediaFile).displayName).toBe('New name');

    const moved = await call(
      admin(),
      'PUT',
      `/api/dash/media/files/${file.id}`,
      {
        folderId: to,
      }
    );
    expect(moved.status).toBe(HTTP_STATUS.OK);
    expect((moved.body.data as MediaFile).folderId).toBe(to);

    // Neither touched the object store: the key is immutable.
    expect(storeOps().length).toBe(before);
    expect(await keyOf(file.id)).toMatch(/\.svg$/);

    const details = await call(
      admin(),
      'GET',
      `/api/dash/media/files/${file.id}`
    );
    const disposition = new URL(
      (details.body.data as { downloadUrl: string }).downloadUrl
    ).searchParams.get('response-content-disposition');
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('filename="New name.svg"');

    const badFolder = await call(
      admin(),
      'PUT',
      `/api/dash/media/files/${file.id}`,
      {
        folderId: '0192b4b6-6f1a-7c3e-9a1f-2b3c4d5e6f70',
      }
    );
    expect(badFolder.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(badFolder.body.message).toBe(mediaMsg.folderNotFound);
  });

  test('filters over the enum columns are checked before SQL: an unknown member is 422, emptiness is NULL', async () => {
    const filtered = (
      id: string,
      operator: string,
      value: string | string[],
      variant: 'select' | 'multiSelect' = 'select'
    ) =>
      call(
        admin(),
        'GET',
        `/api/dash/media?${new URLSearchParams({
          scope: 'all',
          filters: JSON.stringify([
            { id, operator, value, variant, filterId: 'f1' },
          ]),
        }).toString()}`
      );

    const audio = await filtered('kind', 'eq', 'audio');
    expect(audio.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    const internal = await filtered('bucketType', 'eq', 'internal');
    expect(internal.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    const mixed = await filtered(
      'kind',
      'inArray',
      ['image', 'audio'],
      'multiSelect'
    );
    expect(mixed.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    const executable = await filtered(
      'mimeType',
      'eq',
      'application/x-msdownload'
    );
    expect(executable.status).toBe(HTTP_STATUS.UNPROCESSABLE);

    const images = await filtered('kind', 'eq', 'image');
    expect(images.status).toBe(HTTP_STATUS.OK);
    expect(
      (images.body.data as { files: MediaFile[] }).files.length
    ).toBeGreaterThan(0);
    const empty = await filtered('kind', 'isEmpty', '');
    expect(empty.status).toBe(HTTP_STATUS.OK);
    expect((empty.body.data as { files: MediaFile[] }).files).toEqual([]);
    const present = await filtered('bucketType', 'isNotEmpty', '');
    expect(present.status).toBe(HTTP_STATUS.OK);
  });
});

describe('publish and unpublish', () => {
  test('publish verifies the source, copies to the public bucket under the same key, verifies the copy, flips the row, cleans the private copy, and audits', async () => {
    const folderId = await createFolder(admin(), 'Publish');
    const file = await upload(admin(), folderId, svgForm('hero.svg'));
    const key = await keyOf(file.id);
    resetObjectStoreOps();

    const published = await call(
      admin(),
      'POST',
      `/api/dash/media/files/${file.id}/publish`
    );
    expect(published.status, JSON.stringify(published.body)).toBe(
      HTTP_STATUS.OK
    );
    expect(published.body.message).toBe(mediaMsg.published);
    expect(published.body.data).toMatchObject({
      id: file.id,
      bucketType: 'public',
      transition: null,
      url: `${PUBLIC_URL}/${key}`,
    });

    expect(await rowOf(file.id)).toMatchObject({
      r2Key: key,
      bucketType: 'public',
      transition: null,
    });
    expect(storeHas(PUBLIC_BUCKET, key)).toBe(true);
    expect(storeHas(PRIVATE_BUCKET, key)).toBe(false);
    // Head the source, copy with the TARGET's headers, head the copy, then
    // remove the stale source.
    expect(storeOps().map((op) => op.kind)).toEqual([
      'HeadObject',
      'CopyObject',
      'HeadObject',
      'DeleteObject',
    ]);
    const [copy] = storeOpsOf('CopyObject');
    expect(copy).toMatchObject({
      bucket: PUBLIC_BUCKET,
      copySource: `${PRIVATE_BUCKET}/${key}`,
      metadataDirective: 'REPLACE',
    });
    expect(storedObject(PUBLIC_BUCKET, key)?.cacheControl).toContain('public');
    expect(storeOpsOf('DeleteObject')[0]?.bucket).toBe(PRIVATE_BUCKET);

    const audits = await db
      .select({ action: auditLogs.action, newData: auditLogs.newData })
      .from(auditLogs)
      .where(
        and(eq(auditLogs.tableName, 'files'), eq(auditLogs.recordId, file.id))
      );
    expect(audits).toEqual(
      expect.arrayContaining([
        { action: 'UPDATE', newData: { bucketType: 'public' } },
      ])
    );

    // Idempotent: publishing a public file is a 200 with no store traffic.
    resetObjectStoreOps();
    const again = await call(
      admin(),
      'POST',
      `/api/dash/media/files/${file.id}/publish`
    );
    expect(again.status).toBe(HTTP_STATUS.OK);
    expect(storeOps()).toEqual([]);

    // And back.
    const unpublished = await call(
      admin(),
      'POST',
      `/api/dash/media/files/${file.id}/unpublish`
    );
    expect(unpublished.status).toBe(HTTP_STATUS.OK);
    expect(unpublished.body.message).toBe(mediaMsg.unpublished);
    expect(await rowOf(file.id)).toMatchObject({
      bucketType: 'private',
      transition: null,
    });
    expect(storeHas(PRIVATE_BUCKET, key)).toBe(true);
    expect(storeHas(PUBLIC_BUCKET, key)).toBe(false);
  });

  test('a failed copy reverts: the row stays private and settled, the target copy is removed', async () => {
    const folderId = await createFolder(admin(), 'Publish fails');
    const file = await upload(admin(), folderId, svgForm('stuck.svg'));
    const key = await keyOf(file.id);
    resetObjectStoreOps();
    failObjectStore('CopyObject');

    const answer = await call(
      admin(),
      'POST',
      `/api/dash/media/files/${file.id}/publish`
    );
    expect(answer.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
    expect(answer.body.message).toBe(mediaMsg.storeFailed);

    expect(await rowOf(file.id)).toMatchObject({
      bucketType: 'private',
      transition: null,
    });
    expect(storeHas(PRIVATE_BUCKET, key)).toBe(true);
    expect(storeHas(PUBLIC_BUCKET, key)).toBe(false);
    // The revert removes whatever may sit at the target — a delete of a missing
    // key is a 204, so the revert is unconditional.
    expect(storeOps().map((op) => op.kind)).toEqual([
      'HeadObject',
      'CopyObject',
      'DeleteObject',
    ]);
    expect(storeOpsOf('DeleteObject')[0]?.bucket).toBe(PUBLIC_BUCKET);
  });

  test('a copy of the right length with the wrong bytes is refused: the ETag is the content MD5, not the size', async () => {
    const folderId = await createFolder(admin(), 'Publish corrupts');
    const file = await upload(admin(), folderId, svgForm('corrupt.svg'));
    const key = await keyOf(file.id);
    resetObjectStoreOps();
    corruptNextCopy();

    const answer = await call(
      admin(),
      'POST',
      `/api/dash/media/files/${file.id}/publish`
    );
    expect(answer.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
    expect(answer.body.message).toBe(mediaMsg.storeFailed);
    expect(await rowOf(file.id)).toMatchObject({
      bucketType: 'private',
      transition: null,
    });
    expect(storeHas(PRIVATE_BUCKET, key)).toBe(true);
    expect(storeHas(PUBLIC_BUCKET, key)).toBe(false);
  });

  test('a publish that lost its marker to a second publish never deletes the live object', async () => {
    // A marker is a VALUE, not an identity: the sweep can clear one and a second
    // publish can set the same value again. The loser's flip then matches no
    // row, and cleaning up "its" copy would delete the winner's object — which
    // by then is the only one, the private source having been removed.
    const folderId = await createFolder(admin(), 'Marker takeover');
    const file = await upload(admin(), folderId, svgForm('takeover.svg'));
    const key = await keyOf(file.id);

    const gate = Promise.withResolvers<void>();
    const real = r2.headObjectInR2;
    const heads = { count: 0 };
    const spy = spyOn(r2, 'headObjectInR2').mockImplementation(
      async (params) => {
        heads.count += 1;
        // The second HEAD is the target verification: the copy has landed and the
        // row still says `to_public`.
        if (heads.count === 2) await gate.promise;
        return real(params);
      }
    );

    try {
      const stalled = transitionFile({
        id: file.id,
        to: 'public',
        actor: actorOf(admin()),
      });
      await until(
        () => heads.count >= 2 && storeHas(PUBLIC_BUCKET, key),
        'the first publish to block on its target HEAD'
      );

      // The sweep gives up on it and takes the copy back.
      await db
        .update(files)
        .set({ updatedAt: sql`now() - interval '11 minutes'` })
        .where(eq(files.id, file.id));
      await retryTransitions();
      expect(await rowOf(file.id)).toMatchObject({
        bucketType: 'private',
        transition: null,
      });
      expect(storeHas(PUBLIC_BUCKET, key)).toBe(false);

      // The user retries, and this one completes.
      const second = await call(
        admin(),
        'POST',
        `/api/dash/media/files/${file.id}/publish`
      );
      expect(second.status, JSON.stringify(second.body)).toBe(HTTP_STATUS.OK);
      expect(storeHas(PUBLIC_BUCKET, key)).toBe(true);
      expect(storeHas(PRIVATE_BUCKET, key)).toBe(false);

      gate.resolve();
      await expect(stalled).rejects.toThrow(mediaMsg.fileBusy);
    } finally {
      gate.resolve();
      spy.mockRestore();
    }

    // The whole point: the file still exists.
    expect(await rowOf(file.id)).toMatchObject({
      bucketType: 'public',
      transition: null,
    });
    expect(storeHas(PUBLIC_BUCKET, key)).toBe(true);
  });

  test('a revert that cannot remove the target keeps its marker, and the sweep reverts it later', async () => {
    const folderId = await createFolder(admin(), 'Revert deferred');
    const file = await upload(admin(), folderId, svgForm('deferred.svg'));
    failObjectStore('CopyObject');
    failObjectStore('DeleteObject');

    const answer = await call(
      admin(),
      'POST',
      `/api/dash/media/files/${file.id}/publish`
    );
    expect(answer.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
    // The marker is the sweep's instruction; clearing it here would have left
    // whatever the copy wrote with nothing pointing at it.
    expect(await rowOf(file.id)).toMatchObject({
      bucketType: 'private',
      transition: 'to_public',
    });
    // Busy until then, rather than a second attempt on top of the first.
    const again = await call(
      admin(),
      'POST',
      `/api/dash/media/files/${file.id}/publish`
    );
    expect(again.status).toBe(HTTP_STATUS.CONFLICT);
    expect(again.body.message).toBe(mediaMsg.fileBusy);

    clearObjectStoreFailures();
    await db
      .update(files)
      .set({ updatedAt: sql`now() - interval '11 minutes'` })
      .where(eq(files.id, file.id));
    expect(await retryTransitions()).toEqual({
      reverted: 1,
      finished: 0,
      failed: 0,
    });
    expect(await rowOf(file.id)).toMatchObject({
      bucketType: 'private',
      transition: null,
    });
  });

  test('an unpublish whose source delete fails answers with the persisted state, and the sweep finishes it', async () => {
    const folderId = await createFolder(admin(), 'Unpublish pending');
    const file = await upload(admin(), folderId, svgForm('linger.svg'));
    const key = await keyOf(file.id);
    const published = await call(
      admin(),
      'POST',
      `/api/dash/media/files/${file.id}/publish`
    );
    expect(published.status).toBe(HTTP_STATUS.OK);

    failObjectStore('DeleteObject');
    const unpublished = await call(
      admin(),
      'POST',
      `/api/dash/media/files/${file.id}/unpublish`
    );
    expect(unpublished.status).toBe(HTTP_STATUS.OK);
    // The row HAS flipped — the URL is private from here — but the public
    // object is still there, and the response says so.
    expect(unpublished.body.data).toMatchObject({
      bucketType: 'private',
      transition: 'cleanup',
    });
    expect(await rowOf(file.id)).toMatchObject({
      bucketType: 'private',
      transition: 'cleanup',
    });
    expect(storeHas(PUBLIC_BUCKET, key)).toBe(true);

    clearObjectStoreFailures();
    await db
      .update(files)
      .set({ updatedAt: sql`now() - interval '11 minutes'` })
      .where(eq(files.id, file.id));
    expect(await retryTransitions()).toEqual({
      reverted: 0,
      finished: 1,
      failed: 0,
    });
    expect(await rowOf(file.id)).toMatchObject({ transition: null });
    expect(storeHas(PUBLIC_BUCKET, key)).toBe(false);
    expect(storeHas(PRIVATE_BUCKET, key)).toBe(true);
  });

  test('publish needs the publish grant; a view-only session is refused', async () => {
    const folderId = await createFolder(admin(), 'Publish grant');
    const file = await upload(admin(), folderId, svgForm());
    const answer = await call(
      viewer(),
      'POST',
      `/api/dash/media/files/${file.id}/publish`
    );
    expect(answer.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(await rowOf(file.id)).toMatchObject({ bucketType: 'private' });
  });
});

describe('deletion and the composite foreign key', () => {
  test('a referenced file cannot be deleted — the database refuses before any object is touched', async () => {
    const folderId = await createFolder(admin(), 'Referenced');
    const file = await upload(admin(), folderId, svgForm('cover.svg'));
    const key = await keyOf(file.id);
    await refer(file.id);
    resetObjectStoreOps();

    const refused = await call(admin(), 'DELETE', '/api/dash/media/files', {
      ids: [file.id],
    });
    expect(refused.status).toBe(HTTP_STATUS.CONFLICT);
    expect(refused.body.message).toBe(mediaMsg.fileInUse);
    expect(await rowOf(file.id)).toMatchObject({ status: 'active' });
    expect(storeHas(PRIVATE_BUCKET, key)).toBe(true);
    expect(storeOps()).toEqual([]);

    // A referrer cannot be created on a pending file either.
    const pending = await withTransaction(async (tx) => {
      const [row] = await tx
        .insert(files)
        .values({
          r2Key: 'm/2026/09/pending-fixture.svg',
          bucketType: 'private',
          status: 'pending',
          kind: 'image',
          displayName: 'pending.svg',
          mimeType: 'image/svg+xml',
          uploadedBy: admin().user.userId,
        })
        .returning({ id: files.id });
      return row?.id ?? '';
    });
    // `db.execute` returns a lazy query, so it is awaited inside a real promise.
    await expect(
      (async () => {
        await refer(pending);
      })()
    ).rejects.toThrow();

    // Released, the delete goes through: row marked, object removed, row gone.
    await unrefer(file.id);
    const deleted = await call(admin(), 'DELETE', '/api/dash/media/files', {
      ids: [file.id],
    });
    expect(deleted.status).toBe(HTTP_STATUS.OK);
    expect(deleted.body.data).toEqual({ deleted: [file.id], pending: [] });
    expect(await rowOf(file.id)).toBeNull();
    expect(storeHas(PRIVATE_BUCKET, key)).toBe(false);
    expect(storeOps().map((op) => op.kind)).toEqual(['DeleteObjects']);
    expect(await auditActions(file.id)).toContain('DELETE');
  });

  test('a delete whose object store fails reports the file as pending, invisible already; the sweep finishes it', async () => {
    const folderId = await createFolder(admin(), 'Deleting');
    const file = await upload(admin(), folderId, svgForm('half.svg'));
    const key = await keyOf(file.id);
    failObjectStore('DeleteObjects');

    const answer = await call(admin(), 'DELETE', '/api/dash/media/files', {
      ids: [file.id],
    });
    // Phase A committed: the row is gone from every listing and will never come
    // back, but the object is still there — and the answer says which is which.
    expect(answer.status).toBe(HTTP_STATUS.OK);
    expect(answer.body.data).toEqual({ deleted: [], pending: [file.id] });
    expect(await rowOf(file.id)).toMatchObject({ status: 'deleting' });
    expect(storeHas(PRIVATE_BUCKET, key)).toBe(true);

    const listed = await call(
      admin(),
      'GET',
      `/api/dash/media?folder=${folderId}`
    );
    expect((listed.body.data as { files: MediaFile[] }).files).toEqual([]);
    const details = await call(
      admin(),
      'GET',
      `/api/dash/media/files/${file.id}`
    );
    expect(details.status).toBe(HTTP_STATUS.NOT_FOUND);

    // A second request for the same file is a 409, not a second phase A.
    const again = await call(admin(), 'DELETE', '/api/dash/media/files', {
      ids: [file.id],
    });
    expect(again.status).toBe(HTTP_STATUS.CONFLICT);
    expect(again.body.message).toBe(mediaMsg.fileBusy);

    clearObjectStoreFailures();
    const swept = await sweepFiles();
    expect(swept.removed).toBe(1);
    expect(await rowOf(file.id)).toBeNull();
    expect(storeHas(PRIVATE_BUCKET, key)).toBe(false);
  });

  test('a missing id is 404 and nothing in the batch is touched', async () => {
    const folderId = await createFolder(admin(), 'Batch');
    const file = await upload(admin(), folderId, svgForm());
    const answer = await call(admin(), 'DELETE', '/api/dash/media/files', {
      ids: [file.id, '0192b4b6-6f1a-7c3e-9a1f-2b3c4d5e6f70'],
    });
    expect(answer.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(await rowOf(file.id)).toMatchObject({ status: 'active' });
  });
});

describe('entity uploads: claiming, governance, unfiled', () => {
  test('claim flips pending to active for the uploader only, with an audit event for the upload and for the claim', async () => {
    const file = await uploadForRecord(admin());
    expect(file.folderId).toBeNull();
    expect(await rowOf(file.id)).toMatchObject({ status: 'pending' });
    expect(await auditActions(file.id)).toEqual(['INSERT']);

    // Someone else cannot claim it.
    await expect(
      withTransaction((tx) =>
        claimFiles(tx, { ids: [file.id], actor: actorOf(viewer()) })
      )
    ).rejects.toThrow(mediaMsg.fileNotFound);
    expect(await rowOf(file.id)).toMatchObject({ status: 'pending' });

    const claimed = await withTransaction((tx) =>
      claimFiles(tx, { ids: [file.id], actor: actorOf(admin()) })
    );
    expect(claimed).toEqual([file.id]);
    expect(await rowOf(file.id)).toMatchObject({
      status: 'active',
      folderId: null,
    });
    expect(await auditActions(file.id)).toEqual(['INSERT', 'UPDATE']);

    // Claimed, but not in the library: no folder means not in the search.
    const search = await call(
      admin(),
      'GET',
      '/api/dash/media?scope=all&search=avatar'
    );
    expect((search.body.data as { files: MediaFile[] }).files).toEqual([]);

    // A second claim finds nothing pending.
    await expect(
      withTransaction((tx) =>
        claimFiles(tx, { ids: [file.id], actor: actorOf(admin()) })
      )
    ).rejects.toThrow(mediaMsg.fileNotFound);
  });

  test('a file a record holds is not the library’s; once the record lets go it is unfiled, listed, and adoptable', async () => {
    await withSource(PUBLIC_SOURCE, async () => {
      const file = await uploadForRecord(admin(), 'held.svg');
      await withTransaction(async (tx) => {
        await claimFiles(tx, { ids: [file.id], actor: actorOf(admin()) });
        await refer(file.id, tx);
      });

      // Every media route answers as if the file did not exist: the record's
      // routes are the way to it, whatever media grant the caller holds.
      const details = await call(
        viewer(),
        'GET',
        `/api/dash/media/files/${file.id}`
      );
      expect(details.status).toBe(HTTP_STATUS.NOT_FOUND);
      const renamed = await call(
        admin(),
        'PUT',
        `/api/dash/media/files/${file.id}`,
        { displayName: 'Hijacked' }
      );
      expect(renamed.status).toBe(HTTP_STATUS.NOT_FOUND);
      const published = await call(
        admin(),
        'POST',
        `/api/dash/media/files/${file.id}/publish`
      );
      expect(published.status).toBe(HTTP_STATUS.NOT_FOUND);
      const deleted = await call(admin(), 'DELETE', '/api/dash/media/files', {
        ids: [file.id],
      });
      expect(deleted.status).toBe(HTTP_STATUS.NOT_FOUND);
      expect(await rowOf(file.id)).toMatchObject({
        status: 'active',
        displayName: 'held.svg',
        bucketType: 'private',
      });
      const unfiledBefore = await call(
        admin(),
        'GET',
        '/api/dash/media?scope=unfiled'
      );
      expect(
        (unfiledBefore.body.data as { files: MediaFile[] }).files.map(
          (row) => row.id
        )
      ).not.toContain(file.id);

      // The record lets go: the file is nobody's, so it is the library's.
      await unrefer(file.id);
      const visible = await call(
        viewer(),
        'GET',
        `/api/dash/media/files/${file.id}`
      );
      expect(visible.status).toBe(HTTP_STATUS.OK);
      const unfiled = await call(
        admin(),
        'GET',
        '/api/dash/media?scope=unfiled'
      );
      expect(unfiled.status).toBe(HTTP_STATUS.OK);
      const listing = unfiled.body.data as {
        files: MediaFile[];
        retentionDays: number;
      };
      expect(listing.retentionDays).toBe(7);
      expect(listing.files.map((row) => row.id)).toContain(file.id);
      // The stamp comes from the nightly pass, and the sweep would reap it a week
      // after that; filing it takes it off that clock.
      const folderId = await createFolder(admin(), 'Adopted');
      const adopted = await call(
        admin(),
        'PUT',
        `/api/dash/media/files/${file.id}`,
        { folderId }
      );
      expect(adopted.status).toBe(HTTP_STATUS.OK);
      expect(adopted.body.data).toMatchObject({ folderId, unfiledAt: null });
      const inFolder = await call(
        admin(),
        'GET',
        `/api/dash/media?folder=${folderId}`
      );
      expect(
        (inFolder.body.data as { files: MediaFile[] }).files.map(
          (row) => row.id
        )
      ).toEqual([file.id]);
      const unfiledAfter = await call(
        admin(),
        'GET',
        '/api/dash/media?scope=unfiled'
      );
      expect(
        (unfiledAfter.body.data as { files: MediaFile[] }).files.map(
          (row) => row.id
        )
      ).not.toContain(file.id);
    });
  });

  test('with no owner table registered the guards fail closed: nothing is unfiled, nothing is reaped, and the media API keeps to the library', async () => {
    // The shipped state of the kit. `unreferenced()` answering "true" here made
    // `mediaGoverned` always true — the entity boundary inert — and put every
    // claimed entity upload on the reaper's clock.
    const file = await uploadForRecord(admin(), 'ungoverned.svg');
    await withTransaction((tx) =>
      claimFiles(tx, { ids: [file.id], actor: actorOf(admin()) })
    );
    expect(await rowOf(file.id)).toMatchObject({
      status: 'active',
      folderId: null,
    });

    const details = await call(
      admin(),
      'GET',
      `/api/dash/media/files/${file.id}`
    );
    expect(details.status).toBe(HTTP_STATUS.NOT_FOUND);
    const unfiled = await call(admin(), 'GET', '/api/dash/media?scope=unfiled');
    expect(
      (unfiled.body.data as { files: MediaFile[] }).files.map((row) => row.id)
    ).not.toContain(file.id);

    const swept = await sweepFiles();
    expect(swept.unfiled).toEqual({ stamped: 0, reaped: 0 });
    expect(await rowOf(file.id)).toMatchObject({ unfiledAt: null });
  });

  test('linkFiles authorises the SOURCE files, and validates the whole batch before anything is published', async () => {
    const publicPurpose = {
      visibility: 'public' as const,
      kinds: ['image' as const],
    };

    // A file a PRIVATE record holds is that record's. A grant to write some
    // other record is not authorisation to reach it, and `linkFiles` used to
    // accept every active id and publish it.
    await withSource(PRIVATE_SOURCE, async () => {
      const held = await uploadForRecord(admin(), 'held-private.svg');
      await withTransaction(async (tx) => {
        await claimFiles(tx, { ids: [held.id], actor: actorOf(admin()) });
        await refer(held.id, tx);
      });

      await expect(
        linkFiles({
          ids: [held.id],
          purpose: publicPurpose,
          actor: actorOf(admin()),
          write: async () => {},
        })
      ).rejects.toThrow(mediaMsg.linkNotAllowed);
      expect(await rowOf(held.id)).toMatchObject({
        bucketType: 'private',
        transition: null,
      });
      expect(storeHas(PUBLIC_BUCKET, await keyOf(held.id))).toBe(false);
    });

    await withSource(PUBLIC_SOURCE, async () => {
      // An unfiled orphan is adopted through the media routes, which need a
      // media grant; a link is not a second way in.
      const orphan = await uploadForRecord(admin(), 'orphan.svg');
      await withTransaction((tx) =>
        claimFiles(tx, { ids: [orphan.id], actor: actorOf(admin()) })
      );
      await expect(
        linkFiles({
          ids: [orphan.id],
          purpose: publicPurpose,
          actor: actorOf(admin()),
          write: async () => {},
        })
      ).rejects.toThrow(mediaMsg.linkNotAllowed);
      expect(await rowOf(orphan.id)).toMatchObject({ bucketType: 'private' });
      expect(storeHas(PUBLIC_BUCKET, await keyOf(orphan.id))).toBe(false);

      // A rejected link must not leave a published document behind: the batch
      // is read once before the first external call, so the kind refusal lands
      // before the promotion rather than after it.
      const folderId = await createFolder(admin(), 'Rejected link');
      const document = await upload(admin(), folderId, pdfForm('rejected.pdf'));
      await expect(
        linkFiles({
          ids: [document.id],
          purpose: publicPurpose,
          actor: actorOf(admin()),
          write: async () => {},
        })
      ).rejects.toThrow(mediaMsg.kindNotAllowedHere);
      expect(await rowOf(document.id)).toMatchObject({
        bucketType: 'private',
        transition: null,
      });
      expect(storeHas(PUBLIC_BUCKET, await keyOf(document.id))).toBe(false);
    });
  });

  test('linkFiles promotes, attaches under the lock, and refuses a file an unpublish took back in between', async () => {
    await withSource(PUBLIC_SOURCE, async () => {
      const purpose = {
        visibility: 'public' as const,
        kinds: ['image' as const],
      };
      const folderId = await createFolder(admin(), 'Linked');

      // The picker's case: a private library file linked to a public record.
      const picked = await upload(admin(), folderId, svgForm('picked.svg'));
      await linkFiles({
        ids: [picked.id],
        purpose,
        actor: actorOf(admin()),
        write: async (tx) => {
          await refer(picked.id, tx);
        },
      });
      expect(await rowOf(picked.id)).toMatchObject({
        bucketType: 'public',
        transition: null,
      });
      expect(storeHas(PUBLIC_BUCKET, await keyOf(picked.id))).toBe(true);
      expect(await referrerCount(picked.id)).toBe(1);
      const unpublish = await call(
        admin(),
        'POST',
        `/api/dash/media/files/${picked.id}/unpublish`
      );
      expect(unpublish.status).toBe(HTTP_STATUS.CONFLICT);
      expect(unpublish.body.message).toBe(mediaMsg.unpublishInUse);

      // The race: promoted, then unpublished by someone else before the owner's
      // transaction — the attach sees a private file and refuses, so no public
      // record ever points at a private object.
      const raced = await upload(admin(), folderId, svgForm('raced.svg'));
      await promoteForLink({
        ids: [raced.id],
        purpose,
        actor: actorOf(admin()),
      });
      expect(await rowOf(raced.id)).toMatchObject({ bucketType: 'public' });
      await transitionFile({
        id: raced.id,
        to: 'private',
        actor: actorOf(admin()),
      });
      await expect(
        withTransaction(async (tx) => {
          await attachFiles(tx, {
            ids: [raced.id],
            purpose,
            actor: actorOf(admin()),
          });
          await refer(raced.id, tx);
        })
      ).rejects.toThrow(mediaMsg.linkVisibilityMismatch);
      expect(await referrerCount(raced.id)).toBe(0);

      // A pending upload made for a private purpose cannot be attached to a
      // public one: the upload route decided its bucket, and a link is not the
      // place to change it.
      const pendingPrivate = await uploadForRecord(admin(), 'pending.svg');
      await expect(
        withTransaction((tx) =>
          attachFiles(tx, {
            ids: [pendingPrivate.id],
            purpose,
            actor: actorOf(admin()),
          })
        )
      ).rejects.toThrow(mediaMsg.linkVisibilityMismatch);
      expect(await rowOf(pendingPrivate.id)).toMatchObject({
        status: 'pending',
      });

      // The form's case with a matching purpose: claimed and attached in one
      // transaction with the owner's own row.
      const privatePurpose = {
        visibility: 'private' as const,
        kinds: ['image' as const],
      };
      await linkFiles({
        ids: [pendingPrivate.id],
        purpose: privatePurpose,
        actor: actorOf(admin()),
        write: async (tx) => {
          await refer(pendingPrivate.id, tx);
        },
      });
      expect(await rowOf(pendingPrivate.id)).toMatchObject({
        status: 'active',
        bucketType: 'private',
      });
      expect(await referrerCount(pendingPrivate.id)).toBe(1);
    });
  });
});

/**
 * The lock-wait protocol, which is the whole of the entity boundary's safety.
 *
 * Every media mutation takes a plain `SELECT … FOR UPDATE` and evaluates
 * `mediaGoverned` in a SECOND statement of the same transaction. Selecting it
 * inside the locking statement reads a pre-lock snapshot — the correlated
 * subquery runs under the statement's original snapshot even though the row
 * itself is re-read — so a claim that commits during the wait is invisible, and
 * a media grant renames, publishes or moves a file an owner record now holds
 * (reproduced against the pre-fix tree). Nothing else in the suite would notice
 * an edit that folded the check back into the locking statement.
 */
describe('a media mutation that waited for an owner transaction', () => {
  /**
   * Claims `fileId` and inserts its referrer, then HOLDS the row lock until the
   * returned `release` is called. Resolves once the claim has actually run, so
   * a caller that fires a request afterwards is guaranteed to queue behind it.
   */
  async function claimHeldOpen(
    fileId: string
  ): Promise<{ release: () => Promise<void> }> {
    const claimed = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const held = withTransaction(async (tx) => {
      await claimFiles(tx, { ids: [fileId], actor: actorOf(admin()) });
      await refer(fileId, tx);
      claimed.resolve();
      await gate.promise;
    });
    await claimed.promise;
    return {
      release: async () => {
        gate.resolve();
        await held;
      },
    };
  }

  /** Is some backend blocked on a row lock taken by `SELECT … FOR UPDATE`? */
  async function blockedOnRowLock(): Promise<boolean> {
    const rows = await db.execute(sql`
      select 1 from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and query ilike '%for update%'
      limit 1
    `);
    return rows.length > 0;
  }

  /**
   * Fires `request`, waits until it is blocked on the owner's row lock, lets the
   * owner commit, and answers with the response.
   */
  async function afterTheLockWait(
    fileId: string,
    request: () => Promise<Answer>
  ): Promise<Answer> {
    const holder = await claimHeldOpen(fileId);
    const pending = request();
    try {
      await until(
        blockedOnRowLock,
        'the media request to block on the row lock'
      );
    } finally {
      await holder.release();
    }
    return pending;
  }

  test('a rename waits, then answers 404 for the file the owner claimed', async () => {
    await withSource(PRIVATE_SOURCE, async () => {
      const file = await uploadForRecord(admin(), 'raced-rename.svg');
      const answer = await afterTheLockWait(file.id, () =>
        call(admin(), 'PUT', `/api/dash/media/files/${file.id}`, {
          displayName: 'Hijacked',
        })
      );
      expect(answer.status).toBe(HTTP_STATUS.NOT_FOUND);
      expect(await rowOf(file.id)).toMatchObject({
        displayName: 'raced-rename.svg',
        folderId: null,
      });
      await unrefer(file.id);
    });
  });

  test('a publish waits, then answers 404 and puts nothing in the public bucket', async () => {
    await withSource(PRIVATE_SOURCE, async () => {
      const file = await uploadForRecord(admin(), 'raced-publish.svg');
      const answer = await afterTheLockWait(file.id, () =>
        call(admin(), 'POST', `/api/dash/media/files/${file.id}/publish`)
      );
      expect(answer.status).toBe(HTTP_STATUS.NOT_FOUND);
      expect(await rowOf(file.id)).toMatchObject({
        bucketType: 'private',
        transition: null,
      });
      expect(storeHas(PUBLIC_BUCKET, await keyOf(file.id))).toBe(false);
      await unrefer(file.id);
    });
  });

  test('a batch move waits, then answers 404 and moves nothing', async () => {
    await withSource(PRIVATE_SOURCE, async () => {
      const folderId = await createFolder(admin(), 'Raced move');
      const file = await uploadForRecord(admin(), 'raced-move.svg');
      const answer = await afterTheLockWait(file.id, () =>
        call(admin(), 'PUT', '/api/dash/media/files', {
          ids: [file.id],
          folderId,
        })
      );
      expect(answer.status).toBe(HTTP_STATUS.NOT_FOUND);
      expect(await rowOf(file.id)).toMatchObject({ folderId: null });
      await unrefer(file.id);
    });
  });
});

describe('moving a batch of files', () => {
  test('one transaction for the whole selection: every file lands in the folder, an unfiled one is adopted, and each move is audited', async () => {
    await withSource(PUBLIC_SOURCE, async () => {
      const from = await createFolder(admin(), 'Batch source');
      const to = await createFolder(admin(), 'Batch destination');
      const one = await upload(admin(), from, svgForm('batch-one.svg'));
      const two = await upload(admin(), from, svgForm('batch-two.svg'));

      // A former entity upload nobody holds: the sweep has stamped it, and
      // filing it here is the adoption the unfiled listing offers.
      const orphan = await uploadForRecord(admin(), 'batch-orphan.svg');
      await withTransaction((tx) =>
        claimFiles(tx, { ids: [orphan.id], actor: actorOf(admin()) })
      );
      await sweepFiles();
      const stamped = await rowOf(orphan.id);
      expect(stamped?.unfiledAt).toBeInstanceOf(Date);

      const answer = await call(admin(), 'PUT', '/api/dash/media/files', {
        ids: [one.id, two.id, orphan.id],
        folderId: to,
      });
      expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
      const moved = answer.body.data as MediaFile[];
      expect(moved.map((file) => file.folderId)).toEqual([to, to, to]);
      expect(moved.every((file) => file.unfiledAt === null)).toBe(true);

      for (const id of [one.id, two.id, orphan.id])
        expect(await rowOf(id)).toMatchObject({
          folderId: to,
          unfiledAt: null,
        });
      const inFolder = await call(
        admin(),
        'GET',
        `/api/dash/media?folder=${to}`
      );
      expect((inFolder.body.data as { files: MediaFile[] }).files.length).toBe(
        3
      );
      // Database only: moving a file never touches its object.
      expect(storeOpsOf('CopyObject')).toEqual([]);
      expect(await auditActions(one.id)).toEqual(['INSERT', 'UPDATE']);
    });
  });

  test('an id the caller may not move moves nothing, and the destination has to exist', async () => {
    const from = await createFolder(admin(), 'Batch refusals');
    const to = await createFolder(admin(), 'Batch refusals target');
    const mine = await upload(admin(), from, svgForm('kept.svg'));

    const missing = await call(admin(), 'PUT', '/api/dash/media/files', {
      ids: [mine.id, generateUuidV7()],
      folderId: to,
    });
    expect(missing.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(await rowOf(mine.id)).toMatchObject({ folderId: from });

    const gone = await call(admin(), 'PUT', '/api/dash/media/files', {
      ids: [mine.id],
      folderId: generateUuidV7(),
    });
    expect(gone.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(gone.body.message).toBe(mediaMsg.folderNotFound);
    expect(await rowOf(mine.id)).toMatchObject({ folderId: from });

    // `editOwn` narrows the batch the same way it narrows one file: someone
    // else's upload is not there to be moved.
    const owner = await signedInUser({
      permissions: { media: { view: true, editOwn: true } },
    });
    const refused = await call(owner, 'PUT', '/api/dash/media/files', {
      ids: [mine.id],
      folderId: to,
    });
    expect(refused.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(await rowOf(mine.id)).toMatchObject({ folderId: from });
  });
});

describe('recursive folder delete', () => {
  test('the subtree goes in one request: files first through the three-phase delete, then the folders, deepest first', async () => {
    const parent = await createFolder(admin(), 'Tree parent');
    const child = await createFolderUnder(admin(), 'Tree child', parent);
    const top = await upload(admin(), parent, svgForm('top.svg'));
    const deep = await upload(admin(), child, svgForm('deep.svg'));
    const keys = [await keyOf(top.id), await keyOf(deep.id)];

    const answer = await call(
      admin(),
      'DELETE',
      `/api/dash/media/folders/${parent}?recursive=true`
    );
    expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.OK);
    const outcome = answer.body.data as {
      folders: number;
      deleted: string[];
      pending: string[];
    };
    expect(outcome.folders).toBe(2);
    expect(outcome.deleted.toSorted(byText)).toEqual(
      [top.id, deep.id].toSorted(byText)
    );
    expect(outcome.pending).toEqual([]);

    expect(await rowOf(top.id)).toBeNull();
    expect(await rowOf(deep.id)).toBeNull();
    for (const key of keys) expect(storeHas(PRIVATE_BUCKET, key)).toBe(false);
    for (const id of [parent, child]) {
      const listed = await call(admin(), 'GET', `/api/dash/media?folder=${id}`);
      expect(listed.status).toBe(HTTP_STATUS.NOT_FOUND);
    }
    // Both halves are audited: the files by the deletion, the folders here.
    expect(await auditActions(top.id)).toContain('DELETE');
    expect(await folderAuditActions(child)).toEqual(['INSERT', 'DELETE']);
  });

  test('a file a record holds refuses the whole tree, and nothing is deleted', async () => {
    await withSource(PUBLIC_SOURCE, async () => {
      const parent = await createFolder(admin(), 'Tree held');
      const held = await upload(admin(), parent, svgForm('held-in-tree.svg'));
      await refer(held.id);

      const answer = await call(
        admin(),
        'DELETE',
        `/api/dash/media/folders/${parent}?recursive=true`
      );
      expect(answer.status).toBe(HTTP_STATUS.CONFLICT);
      expect(await rowOf(held.id)).toMatchObject({ status: 'active' });
      expect(storeHas(PRIVATE_BUCKET, await keyOf(held.id))).toBe(true);
      const listed = await call(
        admin(),
        'GET',
        `/api/dash/media?folder=${parent}`
      );
      expect(listed.status).toBe(HTTP_STATUS.OK);
      await unrefer(held.id);
    });
  });

  test('an upload still in flight refuses before anything is deleted', async () => {
    const parent = await createFolder(admin(), 'Tree busy');
    const settled = await upload(admin(), parent, svgForm('settled.svg'));
    // A row the upload route has written but not activated: its object may not
    // even exist yet, and it is not this request's to remove.
    await db.insert(files).values({
      r2Key: 'm/2026/09/in-flight.webp',
      bucketType: 'private',
      status: 'pending',
      kind: 'image',
      folderId: parent,
      displayName: 'in-flight.webp',
      mimeType: 'image/webp',
      sizeBytes: 10,
      uploadedBy: admin().user.userId,
    });

    const answer = await call(
      admin(),
      'DELETE',
      `/api/dash/media/folders/${parent}?recursive=true`
    );
    expect(answer.status).toBe(HTTP_STATUS.CONFLICT);
    expect(answer.body.message).toBe(mediaMsg.folderBusy);
    expect(await rowOf(settled.id)).toMatchObject({ status: 'active' });
  });

  test('one descendant over the cap is refused whole; exactly the cap goes, and an unknown recursive value is a 422', async () => {
    const parent = await createFolder(admin(), 'Tree oversized');
    const seed = (folderId: string, count: number, tag: string) =>
      db.insert(files).values(
        Array.from({ length: count }, (_, index) => ({
          r2Key: `m/2026/09/${tag}-${index}.webp`,
          bucketType: 'private' as const,
          status: 'active' as const,
          kind: 'image' as const,
          folderId,
          displayName: `${tag}-${index}.webp`,
          mimeType: 'image/webp',
          sizeBytes: 10,
          uploadedBy: admin().user.userId,
        }))
      );
    // One MORE than the cap allows: the folder itself is what is being deleted,
    // so it is not one of the descendants the bound counts.
    await seed(parent, FOLDER_RECURSIVE_DELETE_MAX + 1, 'cap');

    const tooBig = await call(
      admin(),
      'DELETE',
      `/api/dash/media/folders/${parent}?recursive=true`
    );
    expect(tooBig.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(tooBig.body.message).toBe(mediaMsg.folderTooLarge);
    expect(await filesInFolder(parent)).toBe(FOLDER_RECURSIVE_DELETE_MAX + 1);

    // Anything but `true` is a refusal rather than a quieter delete.
    const unknown = await call(
      admin(),
      'DELETE',
      `/api/dash/media/folders/${parent}?recursive=please`
    );
    expect(unknown.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(unknown.body.message).toBe(mediaMsg.invalidRecursive);

    // And without the flag a folder with anything in it is still a 409.
    const notEmpty = await call(
      admin(),
      'DELETE',
      `/api/dash/media/folders/${parent}`
    );
    expect(notEmpty.status).toBe(HTTP_STATUS.CONFLICT);
    expect(notEmpty.body.message).toBe(mediaMsg.folderNotEmpty);

    // The partner assertion: a tree of exactly the cap is inside it and goes.
    const atCap = await createFolder(admin(), 'Tree at the cap');
    await seed(atCap, FOLDER_RECURSIVE_DELETE_MAX, 'at-cap');
    const allowed = await call(
      admin(),
      'DELETE',
      `/api/dash/media/folders/${atCap}?recursive=true`
    );
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(HTTP_STATUS.OK);
    expect((allowed.body.data as { folders: number }).folders).toBe(1);
    expect(await filesInFolder(atCap)).toBe(0);
  });

  test('an `own` scope reaches the files too: a tree holding someone else’s upload is refused before anything is deleted', async () => {
    const parent = await createFolder(admin(), 'Tree shared');
    const mine = await upload(admin(), parent, svgForm('mine-in-tree.svg'));
    const owner = await signedInUser({
      permissions: { media: { view: true, deleteOwn: true } },
    });

    const refused = await call(
      owner,
      'DELETE',
      `/api/dash/media/folders/${parent}?recursive=true`
    );
    expect(refused.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(await rowOf(mine.id)).toMatchObject({ status: 'active' });
    expect(storeHas(PRIVATE_BUCKET, await keyOf(mine.id))).toBe(true);
    const listed = await call(
      admin(),
      'GET',
      `/api/dash/media?folder=${parent}`
    );
    expect(listed.status).toBe(HTTP_STATUS.OK);
  });
});

/** A subfolder, which the folder route takes as `parentId`. */
async function createFolderUnder(
  session: SignedInSession,
  name: string,
  parentId: string
): Promise<string> {
  const answer = await call(session, 'POST', '/api/dash/media/folders', {
    name,
    parentId,
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(HTTP_STATUS.CREATED);
  return (answer.body.data as { id: string }).id;
}

async function folderAuditActions(id: string): Promise<string[]> {
  const rows = await db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(and(eq(auditLogs.tableName, 'folders'), eq(auditLogs.recordId, id)))
    .orderBy(auditLogs.createdAt);
  return rows.map((row) => row.action);
}

async function filesInFolder(folderId: string): Promise<number> {
  const rows = await db
    .select({ id: files.id })
    .from(files)
    .where(eq(files.folderId, folderId));
  return rows.length;
}

/** Polls `condition` rather than sleeping a fixed time, and fails loudly instead of hanging the tier. */
async function until(
  condition: () => boolean | Promise<boolean>,
  label: string
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await condition()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Drops the recorded operations but keeps the objects — the objects ARE the fixture. */
function resetObjectStoreOps(): void {
  const kept = storeOps().length;
  // `storeOps()` is the live array; splicing it clears the recording without
  // touching the object map, which `resetObjectStore()` would also empty.
  (storeOps() as unknown as unknown[]).splice(0, kept);
}
