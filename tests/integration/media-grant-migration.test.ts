/**
 * `db/migrations/003_grant_media_to_system_roles.sql` against a session that
 * predates it.
 *
 * Read routes check the permission copy a session carries in its metadata, so a
 * grant that only reaches `role_permissions` leaves an administrator signed in
 * before the migration locked out until they sign in again (reproduced). The
 * file patches that copy the way the dashboard's own permission edits do, so
 * the grant reaches them when their cookie cache next refreshes — minutes, not
 * a sign-in. This runs the file exactly as `scripts/migrate.ts` would, twice,
 * against such a session.
 */
import { beforeAll, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SignedInSession } from '../helpers/session';

import { eq, sql } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { sessions } from '@/db/schema';

import { HTTP_STATUS } from '@/utils/api-messages';

import { resetTables } from '../helpers/database';
import { authedRequest, mergeCookies, signedInUser } from '../helpers/session';

const MIGRATION = path.join(
  import.meta.dir,
  '..',
  '..',
  'db',
  'migrations',
  '003_grant_media_to_system_roles.sql'
);

/** The file's statements, as the migration runner sends them: whole, in order. */
async function applyMigration(): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed path inside this repository
  const text = await readFile(MIGRATION, 'utf8');
  const statements = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await db.execute(sql.raw(statement));
}

const state: { admin: SignedInSession | null } = { admin: null };

beforeAll(async () => {
  await resetTables();
  // A system-scoped role that holds another page and nothing on `media`: the
  // state of every pre-migration super-admin.
  state.admin = await signedInUser({
    permissions: { users: { view: true } },
    roleScope: 'system',
  });
});

test('a session signed in before the grant sees the media page right after it, and re-running changes nothing', async () => {
  const admin = state.admin;
  if (!admin) throw new Error('fixture not seeded');

  const before = await app.handle(authedRequest(admin, '/api/dash/media'));
  expect(before.status).toBe(HTTP_STATUS.FORBIDDEN);

  await applyMigration();

  const [row] = await db
    .select({ metadata: sessions.metadata })
    .from(sessions)
    .where(eq(sessions.userId, admin.user.userId));
  const metadata = row?.metadata as {
    permissions?: Record<string, Record<string, boolean>>;
  };
  expect(metadata.permissions?.['media']).toMatchObject({
    view: true,
    publish: true,
  });
  // The other page the role held is untouched by the patch.
  expect(metadata.permissions?.['users']).toMatchObject({ view: true });

  // The session row is patched; the browser still holds the five-minute cookie
  // cache of the old copy. This is that cache expiring, without a sign-in.
  const refreshed = await app.handle(
    authedRequest(admin, '/api/auth/get-session?disableCookieCache=true')
  );
  admin.cookie = mergeCookies(admin.cookie, refreshed.headers.getSetCookie());
  const after = await app.handle(authedRequest(admin, '/api/dash/media'));
  expect(after.status).toBe(HTTP_STATUS.OK);

  await applyMigration();
  const again = await app.handle(authedRequest(admin, '/api/dash/media'));
  expect(again.status).toBe(HTTP_STATUS.OK);
});
