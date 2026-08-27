import { beforeAll, describe, expect, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { users } from '@/db/schema';

import { HTTP_STATUS } from '@/utils/api-messages';

import { resetTables } from '../helpers/database';
import { authedRequest, baseHeaders, signedInUser } from '../helpers/session';

const URL_PATH = '/openapi.json';

const state: { admin: SignedInSession | null } = { admin: null };

function admin(): SignedInSession {
  if (!state.admin) throw new Error('fixture not seeded');
  return state.admin;
}

beforeAll(async () => {
  await resetTables();
  state.admin = await signedInUser();
});

async function bodyOf(response: Response): Promise<string> {
  return response.text();
}

describe('access', () => {
  test('an anonymous caller is refused and receives no path names', async () => {
    const response = await app.handle(
      new Request(`http://localhost${URL_PATH}`, { headers: baseHeaders() })
    );

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await bodyOf(response)).not.toContain('"paths"');
  });

  test('a caller holding dashboard access receives the document', async () => {
    const response = await app.handle(authedRequest(admin(), URL_PATH));
    const document = (await response.json()) as {
      openapi?: string;
      paths?: Record<string, unknown>;
    };

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(document.openapi).toBeString();
    expect(Object.keys(document.paths ?? {}).length).toBeGreaterThan(0);
  });

  test('a signed-in caller with no view grant anywhere is refused', async () => {
    // The distinction the gate has to make: authenticated is not the same as
    // holding dashboard access. A role with every grant switched off must not
    // receive the map.
    const noGrants = await signedInUser({
      permissions: { home: {}, users: {}, permissions: {} },
    });
    const response = await app.handle(authedRequest(noGrants, URL_PATH));

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(await bodyOf(response)).not.toContain('"paths"');
  });

  test('a caller deactivated after signing in is refused', async () => {
    // Signed in first, then suspended with the session row left intact — a
    // deactivated user cannot sign in at all, so seeding one inactive would
    // prove nothing about this gate.
    const session = await signedInUser();
    await db
      .update(users)
      .set({ isActive: false })
      .where(eq(users.id, session.user.userId));

    const response = await app.handle(authedRequest(session, URL_PATH));

    expect(response.status).not.toBe(HTTP_STATUS.OK);
    expect(await bodyOf(response)).not.toContain('"paths"');
  });
});

describe('cost', () => {
  test('the response is byte-identical across requests', async () => {
    // The document is frozen after the first build, so this is the observable
    // half of the memoisation. The deterministic half — that the manifest getter
    // is invoked exactly once — is asserted in
    // `tests/unit/openapi-contract.test.ts`, where it needs no timing.
    const a = await bodyOf(await app.handle(authedRequest(admin(), URL_PATH)));
    const b = await bodyOf(await app.handle(authedRequest(admin(), URL_PATH)));

    expect(a).toBe(b);
  });
});

describe('what the document names', () => {
  test('it does not name the routes that no longer exist', async () => {
    const body = await bodyOf(
      await app.handle(authedRequest(admin(), URL_PATH))
    );

    expect(body).not.toContain('/api/internal/sqlite-sweep');
    expect(body).not.toContain('/api/internal/db-sweep');
  });

  test('the upload route it names cannot be used to enumerate page names', async () => {
    // The coupling this route has with `POST /api/upload/image`, asserted from
    // this side: closing the document is only safe because the upload route no
    // longer answers differently for a real page name than for an unknown one.
    const unknown = await app.handle(
      new Request('http://localhost/api/upload/image?resource=nope', {
        method: 'POST',
        headers: baseHeaders(),
      })
    );
    const real = await app.handle(
      new Request('http://localhost/api/upload/image?resource=users', {
        method: 'POST',
        headers: baseHeaders(),
      })
    );

    expect(unknown.status).toBe(real.status);
    expect(await bodyOf(unknown)).toBe(await bodyOf(real));
  });
});
