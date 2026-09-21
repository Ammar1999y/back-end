/**
 * `GET` and `PUT /api/dash/users/me/preferences`, end to end. Anonymous refusals
 * are covered by `mutating-route-authorization.test.ts`, which walks the route
 * table.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';
import type { StoredPreferences } from '@/utils/validation/preferences';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { userPreferences } from '@/db/schema';
import { getConstraintName } from '@/utils';

import { HTTP_STATUS } from '@/utils/api-messages';
import { DEFAULT_PREFERENCES } from '@/utils/validation/preferences';

import { resetTables } from '../helpers/database';
import { authedRequest, signedInUser } from '../helpers/session';

const PREFERENCES_PATH = '/api/dash/users/me/preferences';

const CHOSEN: StoredPreferences = {
  preset: 'modern-minimal',
  colorMode: 'dark',
  themeLayout: 'mini',
  fontScale: 1.05,
  containerStretch: true,
};

const actors: { owner: SignedInSession | null; other: SignedInSession | null } =
  { owner: null, other: null };

function owner(): SignedInSession {
  if (!actors.owner) throw new Error('fixture not seeded');
  return actors.owner;
}

function other(): SignedInSession {
  if (!actors.other) throw new Error('fixture not seeded');
  return actors.other;
}

interface PreferencesEnvelope {
  data: { preferences: StoredPreferences; updatedAt: string | null };
}

async function readPreferences(session: SignedInSession) {
  const response = await app.handle(
    authedRequest(session, PREFERENCES_PATH, { method: 'GET' })
  );
  return {
    status: response.status,
    body: (await response.json()) as PreferencesEnvelope,
  };
}

async function writePreferences(session: SignedInSession, body: unknown) {
  const response = await app.handle(
    authedRequest(session, PREFERENCES_PATH, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
  return {
    status: response.status,
    body: (await response.json()) as PreferencesEnvelope,
  };
}

/** What the column actually holds, past the sanitizer the route reads through. */
async function storedRow(userId: string) {
  const [row] = await db
    .select({ ui: userPreferences.ui, updatedAt: userPreferences.updatedAt })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId));
  return row;
}

beforeAll(async () => {
  await resetTables();
  actors.owner = await signedInUser();
  // Holds no page permissions at all: the route is self-service, so a grant must
  // not be what admits it.
  actors.other = await signedInUser({ permissions: {} });
});

describe('reading', () => {
  test('a user who has never saved gets the defaults and a null updatedAt, not a 404', async () => {
    const { status, body } = await readPreferences(owner());
    expect(status).toBe(HTTP_STATUS.OK);
    expect(body.data.preferences).toEqual(DEFAULT_PREFERENCES);
    expect(body.data.updatedAt).toBeNull();
    expect(await storedRow(owner().user.userId)).toBeUndefined();
  });

  test('a user with no grants at all can still read their own', async () => {
    const { status, body } = await readPreferences(other());
    expect(status).toBe(HTTP_STATUS.OK);
    expect(body.data.preferences).toEqual(DEFAULT_PREFERENCES);
  });
});

describe('writing', () => {
  test('a valid document round-trips through the column', async () => {
    const written = await writePreferences(owner(), CHOSEN);
    expect(written.status).toBe(HTTP_STATUS.OK);
    expect(written.body.data.preferences).toEqual(CHOSEN);

    const { body } = await readPreferences(owner());
    expect(body.data.preferences).toEqual(CHOSEN);
    expect(body.data.updatedAt).toBe(written.body.data.updatedAt);
    const stored = await storedRow(owner().user.userId);
    if (!stored) throw new Error('write left no row');
    expect(body.data.updatedAt).toBe(stored.updatedAt.toISOString());
  });

  test('a second write updates the row instead of adding one', async () => {
    const before = await storedRow(owner().user.userId);
    if (!before) throw new Error('first write left no row');

    // Past the column's centisecond precision, so an unchanged `updated_at`
    // cannot hide behind an equal timestamp.
    await Bun.sleep(20);

    const next: StoredPreferences = { ...CHOSEN, fontScale: 0.9 };
    const written = await writePreferences(owner(), next);
    expect(written.status).toBe(HTTP_STATUS.OK);

    const rows = await db
      .select({ id: userPreferences.id })
      .from(userPreferences)
      .where(eq(userPreferences.userId, owner().user.userId));
    expect(rows).toHaveLength(1);

    const after = await storedRow(owner().user.userId);
    if (!after) throw new Error('second write left no row');
    expect(after.ui).toEqual(next);
    expect(after.updatedAt.getTime()).toBeGreaterThan(
      before.updatedAt.getTime()
    );
    expect(written.body.data.updatedAt).toBe(after.updatedAt.toISOString());
  });

  test("one user's write does not reach another's row", async () => {
    const { body } = await readPreferences(other());
    expect(body.data.preferences).toEqual(DEFAULT_PREFERENCES);
    expect(body.data.updatedAt).toBeNull();
    expect(await storedRow(other().user.userId)).toBeUndefined();
  });
});

describe('refusals leave the column untouched', () => {
  test.each([
    ['an unknown key', { ...CHOSEN, styles: { light: {} } }],
    ['a partial document', { preset: 'blue' }],
    ['a preset carrying CSS', { ...CHOSEN, preset: 'var(--x); color: red' }],
    ['a fontScale past the ceiling', { ...CHOSEN, fontScale: 4 }],
    ['a colorMode outside its set', { ...CHOSEN, colorMode: 'sepia' }],
  ])('%s is a 422 and writes nothing', async (_label, body) => {
    const before = await storedRow(owner().user.userId);

    const { status } = await writePreferences(owner(), body);
    expect(status).toBe(HTTP_STATUS.UNPROCESSABLE);

    expect(await storedRow(owner().user.userId)).toEqual(before);
  });
});

describe('the database bound', () => {
  test('a direct insert past the CHECK is refused', async () => {
    // Direct insert: the one writer `preferencesSchema` cannot reach.
    const oversized: StoredPreferences = {
      ...CHOSEN,
      preset: 'a'.repeat(5000),
    };

    let thrown: unknown;
    try {
      await db
        .insert(userPreferences)
        .values({ userId: other().user.userId, ui: oversized });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(getConstraintName(thrown)).toBe('chk_user_preferences_ui_size');

    expect(await storedRow(other().user.userId)).toBeUndefined();
  });
});

describe('lifecycle', () => {
  test('a soft-deleted user loses their row, which no cascade would do', async () => {
    const victim = await signedInUser({ permissions: {} });
    const written = await writePreferences(victim, CHOSEN);
    expect(written.status).toBe(HTTP_STATUS.OK);
    expect(await storedRow(victim.user.userId)).toBeDefined();

    const deleted = await app.handle(
      authedRequest(owner(), `/api/dash/users/${victim.user.userId}`, {
        method: 'DELETE',
      })
    );
    expect(deleted.status).toBe(HTTP_STATUS.OK);

    expect(await storedRow(victim.user.userId)).toBeUndefined();
  });
});
