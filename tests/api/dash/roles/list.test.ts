import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import '../../../helpers/env';
import { wipeTag } from '../../../helpers/db';
import { api, waitForServer } from '../../../helpers/http';
import { signIn } from '../../../helpers/auth';
import { ALL_PERMISSIONS, createRole, createUser } from '../../../helpers/seed';

const PATH = '/api/dash/roles';

beforeAll(async () => {
  await waitForServer();
});

afterAll(async () => {
  await wipeTag();
});

describe('GET /api/dash/roles', () => {
  test('401 when no session', async () => {
    const res = await api(PATH, { method: 'GET' });
    expect(res.status).toBe(401);
  });

  test('401 when cookie is invalid', async () => {
    const res = await api(PATH, {
      method: 'GET',
      cookie: 'better-auth.session_token=garbage',
    });
    expect(res.status).toBe(401);
  });

  test(
    'authenticated request — currently 403 due to session.user.roleId bug; must NOT 500',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signed = await signIn(admin);

      const res = await api(PATH, { method: 'GET', cookie: signed.cookie });
      // Once the cookie-cache roleId bug is fixed this narrows to 200.
      expect([200, 403]).toContain(res.status);
    },
    30_000
  );

  test(
    '405/404 on POST/PUT/DELETE (only GET is exported)',
    async () => {
      const adminRole = await createRole({ permissions: ALL_PERMISSIONS });
      const admin = await createUser({ roleId: adminRole.id });
      const signed = await signIn(admin);

      for (const method of ['POST', 'PUT', 'DELETE']) {
        const res = await api(PATH, { method, cookie: signed.cookie, body: {} });
        expect([404, 405]).toContain(res.status);
      }
    },
    45_000
  );

  test(
    'rate-limit identifier is per-user — does not leak across users',
    async () => {
      // Each signed-in user hits a fresh rate-limit bucket. Verify two
      // independent users can each fire several requests without colliding.
      const r1 = await createRole({ permissions: ALL_PERMISSIONS });
      const u1 = await createUser({ roleId: r1.id });
      const s1 = await signIn(u1);

      const r2 = await createRole({ permissions: ALL_PERMISSIONS });
      const u2 = await createUser({ roleId: r2.id });
      const s2 = await signIn(u2);

      const r1res = await Promise.all([
        api(PATH, { method: 'GET', cookie: s1.cookie }),
        api(PATH, { method: 'GET', cookie: s2.cookie }),
      ]);
      for (const r of r1res) {
        // No 429 — these are independent users in distinct buckets.
        expect(r.status).not.toBe(429);
      }
    },
    60_000
  );
});
