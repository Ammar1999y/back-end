import { beforeEach, describe, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { sessions, users } from '@/db/schema';

import { HTTP_STATUS } from '@/utils/api-messages';

import { resetTables } from '../helpers/database';
import { baseHeaders, signedInUser } from '../helpers/session';

const READ_URL = 'http://localhost/api/dash/roles';

interface Fixture {
  userId: string;
  tokenOnly: string;
}

async function fixture(): Promise<Fixture> {
  const session = await signedInUser();
  const token = session.cookie
    .split('; ')
    .find((cookie) => cookie.startsWith('better-auth.session_token='));
  if (!token) throw new Error('sign-in set no session token');
  return { userId: session.user.userId, tokenOnly: token };
}

function read(cookie: string): Promise<Response> {
  const headers = new Headers(baseHeaders());
  headers.set('cookie', cookie);
  return app.handle(new Request(READ_URL, { headers }));
}

beforeEach(async () => {
  await resetTables();
});

describe('a read with the cookie cache missed', () => {
  test('succeeds while the account is active', async () => {
    const { tokenOnly } = await fixture();
    const response = await read(tokenOnly);
    expect(response.status).toBe(HTTP_STATUS.OK);
  });

  test('is refused once the account is deactivated, session row intact', async () => {
    const { userId, tokenOnly } = await fixture();

    await db.update(users).set({ isActive: false }).where(eq(users.id, userId));

    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, userId));
    expect(rows).toHaveLength(1);

    const response = await read(tokenOnly);
    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  test('is refused once the account is soft-deleted, session row intact', async () => {
    const { userId, tokenOnly } = await fixture();

    await db
      .update(users)
      .set({ deletedAt: new Date(), isActive: false })
      .where(eq(users.id, userId));

    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, userId));
    expect(rows).toHaveLength(1);

    const response = await read(tokenOnly);
    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });
});

describe('a read with a valid cookie cache', () => {
  test('accepts the configured five-minute revocation window', async () => {
    const session = await signedInUser();
    await db.delete(sessions).where(eq(sessions.userId, session.user.userId));

    const response = await read(session.cookie);
    expect(response.status).toBe(HTTP_STATUS.OK);
  });
});
