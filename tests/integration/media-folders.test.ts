/**
 * The folder half of the media library, through the real route table.
 *
 * Folders are pure organisation — no object-store counterpart — so every
 * assertion here is about the tree's invariants: names unique per parent
 * (case-insensitively), depth and fan-out caps enforced under lock, no cycles,
 * and a delete that refuses anything but an empty folder.
 *
 * Fixtures are SEEDED through the database, not posted: the create route has a
 * per-user budget of 30 a minute, and a suite that posts every fixture spends it
 * on setup and then reads its own 429s as failures of the thing under test. The
 * route is exercised where creating IS the subject.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';

import { eq, inArray, like, sql } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { auditLogs, folders } from '@/db/schema';
import { updateFolder } from '@/lib/media/folders';
import { mediaMsg } from '@/lib/media/messages';

import {
  HTTP_STATUS,
  MSG_INSUFFICIENT_PERMISSIONS,
} from '@/utils/api-messages';
import {
  FOLDER_MAX_CHILDREN,
  FOLDER_MAX_DEPTH,
} from '@/utils/validation/constants';
import { mediaValidationMsg } from '@/utils/validation/media';

import { resetTables } from '../helpers/database';
import { authedRequest, signedInUser } from '../helpers/session';

interface Answer {
  status: number;
  body: { success: boolean; message: string; data: unknown; meta?: unknown };
}

async function call(
  session: SignedInSession,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  json?: unknown
): Promise<Answer> {
  const response = await app.handle(
    authedRequest(session, path, {
      method,
      ...(json !== undefined && {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(json),
      }),
    })
  );
  return { status: response.status, body: await response.json() };
}

interface FolderData {
  id: string;
  name: string;
  parentId: string | null;
  createdBy: string | null;
}

function folderOf(answer: Answer): FolderData {
  if (answer.status !== HTTP_STATUS.CREATED && answer.status !== HTTP_STATUS.OK)
    throw new Error(
      `expected a folder, got ${answer.status}: ${answer.body.message}`
    );
  return answer.body.data as FolderData;
}

/** A fixture row, written directly so it costs no request budget. */
async function seedFolder(
  name: string,
  parentId: string | null = null,
  createdBy: string | null = null
): Promise<string> {
  const [row] = await db
    .insert(folders)
    .values({ name, parentId, createdBy })
    .returning({ id: folders.id });
  if (!row) throw new Error('seedFolder returned no row');
  return row.id;
}

const byText = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

const sessions: {
  admin?: SignedInSession;
  viewer?: SignedInSession;
  own?: SignedInSession;
} = {};

function admin() {
  if (!sessions.admin) throw new Error('admin not seeded');
  return sessions.admin;
}
function viewer() {
  if (!sessions.viewer) throw new Error('viewer not seeded');
  return sessions.viewer;
}
function own() {
  if (!sessions.own) throw new Error('own not seeded');
  return sessions.own;
}

beforeAll(async () => {
  await resetTables();
  sessions.admin = await signedInUser();
  sessions.viewer = await signedInUser({
    permissions: { media: { view: true } },
  });
  sessions.own = await signedInUser({
    permissions: {
      media: { view: true, create: true, editOwn: true, deleteOwn: true },
    },
  });
});

describe('creating folders', () => {
  test('a root folder, then a child, each with an audit row', async () => {
    const root = await call(admin(), 'POST', '/api/dash/media/folders', {
      name: '  Brand   Assets ',
    });
    expect(root.status).toBe(HTTP_STATUS.CREATED);
    expect(folderOf(root)).toMatchObject({
      name: 'Brand Assets',
      parentId: null,
      createdBy: admin().user.userId,
    });

    const child = await call(admin(), 'POST', '/api/dash/media/folders', {
      name: 'Logos',
      parentId: folderOf(root).id,
    });
    expect(child.status).toBe(HTTP_STATUS.CREATED);
    expect(folderOf(child).parentId).toBe(folderOf(root).id);

    const audits = await db
      .select({ recordId: auditLogs.recordId, action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.tableName, 'folders'));
    expect(audits).toEqual(
      expect.arrayContaining([
        { recordId: folderOf(root).id, action: 'INSERT' },
        { recordId: folderOf(child).id, action: 'INSERT' },
      ])
    );
  });

  test('names are unique per parent, case-insensitively, and answer 409', async () => {
    const parent = await seedFolder('Unique');
    await seedFolder('Photos', parent);

    const duplicate = await call(admin(), 'POST', '/api/dash/media/folders', {
      name: 'PHOTOS',
      parentId: parent,
    });
    expect(duplicate.status).toBe(HTTP_STATUS.CONFLICT);
    expect(duplicate.body.message).toBe(mediaMsg.folderNameExists);

    // The same name under a DIFFERENT parent is fine.
    const elsewhere = await call(admin(), 'POST', '/api/dash/media/folders', {
      name: 'photos',
    });
    expect(elsewhere.status).toBe(HTTP_STATUS.CREATED);

    // And the root has its own uniqueness.
    const rootDuplicate = await call(
      admin(),
      'POST',
      '/api/dash/media/folders',
      {
        name: 'Photos',
      }
    );
    expect(rootDuplicate.status).toBe(HTTP_STATUS.CONFLICT);
  });

  test('an unknown parent is 404, a bad name is 422, a bad body is 400', async () => {
    const missing = await call(admin(), 'POST', '/api/dash/media/folders', {
      name: 'Orphan',
      parentId: '0192b4b6-6f1a-7c3e-9a1f-2b3c4d5e6f70',
    });
    expect(missing.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(missing.body.message).toBe(mediaMsg.folderNotFound);

    const slash = await call(admin(), 'POST', '/api/dash/media/folders', {
      name: 'a/b',
    });
    expect(slash.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(slash.body.message).toBe(mediaValidationMsg.folderNameInvalid);

    const empty = await call(admin(), 'POST', '/api/dash/media/folders');
    expect(empty.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });

  test('the depth cap is enforced on create', async () => {
    // FOLDER_MAX_DEPTH - 1 levels seeded; the route creates the last legal one
    // and refuses the one after.
    let parentId: string | null = null;
    for (let level = 1; level < FOLDER_MAX_DEPTH; level++)
      parentId = await seedFolder(`Level ${level}`, parentId);

    const last = await call(admin(), 'POST', '/api/dash/media/folders', {
      name: `Level ${FOLDER_MAX_DEPTH}`,
      parentId,
    });
    expect(last.status).toBe(HTTP_STATUS.CREATED);

    const tooDeep = await call(admin(), 'POST', '/api/dash/media/folders', {
      name: 'Too deep',
      parentId: folderOf(last).id,
    });
    expect(tooDeep.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(tooDeep.body.message).toBe(mediaMsg.folderTooDeep);
  });

  test('a view-only session cannot create', async () => {
    const answer = await call(viewer(), 'POST', '/api/dash/media/folders', {
      name: 'Nope',
    });
    expect(answer.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(answer.body.message).toBe(MSG_INSUFFICIENT_PERMISSIONS);
  });
});

describe('renaming and moving folders', () => {
  test('rename, move, and refuse a move into the folder itself or a descendant', async () => {
    const a = await seedFolder('A');
    const b = await seedFolder('B', a);
    const c = await seedFolder('C', b);

    const renamed = await call(admin(), 'PUT', `/api/dash/media/folders/${a}`, {
      name: 'A renamed',
    });
    expect(renamed.status).toBe(HTTP_STATUS.OK);
    expect(folderOf(renamed).name).toBe('A renamed');

    const self = await call(admin(), 'PUT', `/api/dash/media/folders/${a}`, {
      parentId: a,
    });
    expect(self.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(self.body.message).toBe(mediaMsg.folderCycle);

    const intoDescendant = await call(
      admin(),
      'PUT',
      `/api/dash/media/folders/${a}`,
      {
        parentId: c,
      }
    );
    expect(intoDescendant.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(intoDescendant.body.message).toBe(mediaMsg.folderCycle);

    // C moves up to the root: `parentId: null` is "the root", not "unchanged".
    const toRoot = await call(admin(), 'PUT', `/api/dash/media/folders/${c}`, {
      parentId: null,
    });
    expect(toRoot.status).toBe(HTTP_STATUS.OK);
    expect(folderOf(toRoot).parentId).toBeNull();

    // An empty body is a 422, not a silent 200.
    const nothing = await call(
      admin(),
      'PUT',
      `/api/dash/media/folders/${c}`,
      {}
    );
    expect(nothing.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(nothing.body.message).toBe(mediaValidationMsg.nothingToUpdate);
  });

  test('a subtree cannot be moved to where it would exceed the depth cap', async () => {
    // A chain of FOLDER_MAX_DEPTH - 1 under the root, and a two-level subtree.
    let deepest: string | null = null;
    for (let level = 1; level < FOLDER_MAX_DEPTH; level++)
      deepest = await seedFolder(`Deep ${level}`, deepest);
    const top = await seedFolder('Sub');
    await seedFolder('Leaf', top);

    // Depth FOLDER_MAX_DEPTH - 1 plus a subtree of height 2 → one too many.
    const refused = await call(
      admin(),
      'PUT',
      `/api/dash/media/folders/${top}`,
      {
        parentId: deepest,
      }
    );
    expect(refused.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(refused.body.message).toBe(mediaMsg.folderTooDeep);
  });

  test('editOwn reaches only the folders the actor created, and everything else is 404', async () => {
    const mine = await seedFolder('Mine', null, own().user.userId);
    const theirs = await seedFolder('Theirs', null, admin().user.userId);

    const okay = await call(own(), 'PUT', `/api/dash/media/folders/${mine}`, {
      name: 'Still mine',
    });
    expect(okay.status).toBe(HTTP_STATUS.OK);

    // Out of scope answers exactly like absent — no oracle for "exists but not
    // yours".
    const refused = await call(
      own(),
      'PUT',
      `/api/dash/media/folders/${theirs}`,
      {
        name: 'Hijacked',
      }
    );
    expect(refused.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(refused.body.message).toBe(mediaMsg.folderNotFound);
    const [row] = await db
      .select({ name: folders.name })
      .from(folders)
      .where(eq(folders.id, theirs));
    expect(row?.name).toBe('Theirs');
  });
});

describe('deleting folders', () => {
  test('an empty folder goes; a folder with a subfolder is refused with 409', async () => {
    const parent = await seedFolder('To delete');
    const child = await seedFolder('Inside', parent);

    const refused = await call(
      admin(),
      'DELETE',
      `/api/dash/media/folders/${parent}`
    );
    expect(refused.status).toBe(HTTP_STATUS.CONFLICT);
    expect(refused.body.message).toBe(mediaMsg.folderNotEmpty);

    const childGone = await call(
      admin(),
      'DELETE',
      `/api/dash/media/folders/${child}`
    );
    expect(childGone.status).toBe(HTTP_STATUS.OK);
    const parentGone = await call(
      admin(),
      'DELETE',
      `/api/dash/media/folders/${parent}`
    );
    expect(parentGone.status).toBe(HTTP_STATUS.OK);

    const rows = await db
      .select({ id: folders.id })
      .from(folders)
      .where(eq(folders.id, parent));
    expect(rows).toEqual([]);

    const again = await call(
      admin(),
      'DELETE',
      `/api/dash/media/folders/${parent}`
    );
    expect(again.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  test('a view-only session cannot delete', async () => {
    const target = await seedFolder('Guarded');
    const answer = await call(
      viewer(),
      'DELETE',
      `/api/dash/media/folders/${target}`
    );
    expect(answer.status).toBe(HTTP_STATUS.FORBIDDEN);
  });
});

/**
 * The tree's structural invariants under concurrency. Row locks on the moved
 * folder and its destination were not enough: two disjoint moves validated
 * against the tree the other was about to change and committed a cycle
 * (reproduced). One advisory lock per structural change serializes them.
 */
describe('the tree under concurrency', () => {
  /** Parent chain from `id` upward, bounded; a cycle shows as a repeat. */
  async function ancestry(id: string): Promise<string[]> {
    const seen: string[] = [];
    let current: string | null = id;
    while (current && seen.length <= FOLDER_MAX_DEPTH + 1) {
      if (seen.includes(current)) return [...seen, current];
      seen.push(current);
      const [row] = await db
        .select({ parentId: folders.parentId })
        .from(folders)
        .where(eq(folders.id, current));
      current = row?.parentId ?? null;
    }
    return seen;
  }

  test('two disjoint moves cannot commit a cycle: the second waits for the first and is refused', async () => {
    const a = await seedFolder('cycle-A');
    const b = await seedFolder('cycle-B');
    const a1 = await seedFolder('cycle-A1', a);
    const b1 = await seedFolder('cycle-B1', b);
    const actor = {
      userId: admin().user.userId,
      email: admin().user.email,
      scope: 'all' as const,
      meta: { ip: null, userAgent: null, apiPath: '/test' },
    };

    // A delay after validation, so both moves have checked the tree before
    // either has changed it — the window the row locks left open.
    await db.execute(
      sql`create function _folder_move_delay() returns trigger language plpgsql as $$ begin perform pg_sleep(1); return new; end $$`
    );
    await db.execute(
      sql`create trigger _folder_move_delay before update of parent_id on folders for each row execute function _folder_move_delay()`
    );
    try {
      const outcomes = await Promise.allSettled([
        updateFolder({ folderId: a, parentId: b1, actor }),
        updateFolder({ folderId: b, parentId: a1, actor }),
      ]);
      const refused = outcomes.filter(
        (outcome) => outcome.status === 'rejected'
      );
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.reason).toMatchObject({
        message: mediaMsg.folderCycle,
      });

      // Whichever won, every chain still ends at the root.
      for (const id of [a, b, a1, b1]) {
        const chain = await ancestry(id);
        expect(new Set(chain).size, `cycle through ${id}`).toBe(chain.length);
      }
    } finally {
      await db.execute(sql`drop trigger _folder_move_delay on folders`);
      await db.execute(sql`drop function _folder_move_delay()`);
    }
  }, 20_000);

  test('the root has the same fan-out cap as a folder, on create and on move', async () => {
    const seeded = await db
      .insert(folders)
      .values(
        Array.from({ length: FOLDER_MAX_CHILDREN }, (_, index) => ({
          name: `cap-${String(index).padStart(4, '0')}`,
        }))
      )
      .returning({ id: folders.id });
    const nested = await seedFolder('cap-nested', seeded[0]?.id ?? null);
    try {
      const created = await call(admin(), 'POST', '/api/dash/media/folders', {
        name: 'cap-one-more',
      });
      expect(created.status).toBe(HTTP_STATUS.UNPROCESSABLE);
      expect(created.body.message).toBe(mediaMsg.folderTooManyChildren);

      const moved = await call(
        admin(),
        'PUT',
        `/api/dash/media/folders/${nested}`,
        { parentId: null }
      );
      expect(moved.status).toBe(HTTP_STATUS.UNPROCESSABLE);
      expect(moved.body.message).toBe(mediaMsg.folderTooManyChildren);
    } finally {
      await db.delete(folders).where(eq(folders.id, nested));
      await db.delete(folders).where(
        inArray(
          folders.id,
          seeded.map((row) => row.id)
        )
      );
      await db.delete(folders).where(like(folders.name, 'cap-%'));
    }
  });
});

describe('listing', () => {
  test('the root lists root folders only; a folder lists its breadcrumbs, children and no files', async () => {
    const root = await call(admin(), 'GET', '/api/dash/media');
    expect(root.status).toBe(HTTP_STATUS.OK);
    const rootData = root.body.data as {
      breadcrumbs: unknown[];
      folders: FolderData[];
      files: unknown[];
      visibilities: string[];
      canPublish: boolean;
    };
    expect(rootData.breadcrumbs).toEqual([]);
    expect(rootData.files).toEqual([]);
    expect(rootData.folders.every((folder) => folder.parentId === null)).toBe(
      true
    );
    expect(rootData.visibilities.toSorted(byText)).toEqual([
      'private',
      'public',
    ]);
    expect(rootData.canPublish).toBe(true);

    const parent = await seedFolder('Trail');
    const child = await seedFolder('Crumb', parent);
    const listed = await call(
      admin(),
      'GET',
      `/api/dash/media?folder=${child}`
    );
    expect(listed.status).toBe(HTTP_STATUS.OK);
    expect(
      (listed.body.data as { breadcrumbs: unknown[] }).breadcrumbs
    ).toEqual([
      { id: parent, name: 'Trail' },
      { id: child, name: 'Crumb' },
    ]);
    expect(listed.body.meta).toEqual({
      page: 1,
      perPage: 10,
      total: 0,
      pageCount: 1,
    });

    // The viewer sees the tree but not the publish affordance.
    const asViewer = await call(viewer(), 'GET', '/api/dash/media');
    expect((asViewer.body.data as { canPublish: boolean }).canPublish).toBe(
      false
    );
  });

  test('an unknown folder is 404, a malformed id or scope is 422', async () => {
    const missing = await call(
      admin(),
      'GET',
      '/api/dash/media?folder=0192b4b6-6f1a-7c3e-9a1f-2b3c4d5e6f70'
    );
    expect(missing.status).toBe(HTTP_STATUS.NOT_FOUND);
    const malformed = await call(admin(), 'GET', '/api/dash/media?folder=nope');
    expect(malformed.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    const scope = await call(
      admin(),
      'GET',
      '/api/dash/media?scope=everything'
    );
    expect(scope.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(scope.body.message).toBe(mediaMsg.invalidScope);
  });
});
