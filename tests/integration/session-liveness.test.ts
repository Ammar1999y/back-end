import { beforeEach, describe, expect, test } from 'bun:test';

import { eq, inArray } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { sessions, users, verifications } from '@/db/schema';
import { PUBLIC_ORIGIN } from '@/lib/env';

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

describe('signing out takes the session artifacts with it', () => {
  /**
   * `revokeSessionArtifacts` says every path that deletes a session owes it the
   * call, and `/sign-out` is a path this codebase does not own: Better Auth
   * deletes the row through its own adapter. The three `verifications` rows keyed
   * by the SESSION id — the two-factor proof and both re-authentication windows —
   * store no user id, so a session deleted without them leaves rows nothing can
   * find again until they expire. The `session.delete.after` database hook in
   * `lib/auth.ts` is what makes the invariant true for the library's deletes.
   */
  test('the re-authentication window opened on it is gone', async () => {
    // `signedInUser` opens the window, which is what writes the rows: a fixture
    // that only signed in would make this vacuous.
    const session = await signedInUser();
    const [row] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, session.user.userId));
    const sessionId = row?.id;
    expect(sessionId).toBeString();

    const identifiers = [
      `2fa-proven-${sessionId}`,
      `reauth-method-${sessionId}`,
      `reauth-passkey-${sessionId}`,
    ];
    const artifacts = () =>
      db
        .select({ identifier: verifications.identifier })
        .from(verifications)
        .where(inArray(verifications.identifier, identifiers));

    expect(await artifacts()).not.toBeEmpty();

    const response = await app.handle(
      new Request('http://localhost/api/auth/sign-out', {
        method: 'POST',
        headers: baseHeaders({
          'content-type': 'application/json',
          cookie: session.cookie,
          // Better Auth's router-level origin check refuses a cookie-carrying
          // non-GET without one (403), before the endpoint runs at all.
          origin: PUBLIC_ORIGIN,
        }),
        body: '{}',
      })
    );
    expect(response.status).toBe(HTTP_STATUS.OK);

    expect(
      await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, sessionId as string))
    ).toBeEmpty();
    expect(await artifacts()).toBeEmpty();
  });
});
