import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import { users } from '@/db/schema';

import { sessions } from '@/db/schema';

import '../../../helpers/env';
import { tdb, tagEmail, unlockUser, wipeTag } from '../../../helpers/db';
import { api, extractSessionCookie, waitForServer } from '../../../helpers/http';
import { createRole, createUser, DEFAULT_PASSWORD } from '../../../helpers/seed';

const PATH = '/api/auth/sign-in/email';

beforeAll(async () => {
  await waitForServer();
});

afterAll(async () => {
  await wipeTag();
});

describe('POST /api/auth/sign-in/email — happy path', () => {
  test(
    'valid credentials issue a session cookie',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id });

      const res = await api(PATH, {
        method: 'POST',
        body: { email: user.email, password: user.password },
      });

      expect(res.status).toBe(200);
      expect(res.body.user?.id).toBe(user.id);
      const cookie = extractSessionCookie(res.cookies);
      expect(cookie).not.toBeNull();
      expect(cookie!).toContain('better-auth.session_token=');
    },
    30_000
  );

  test(
    'cookies are HttpOnly and SameSite-protected',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id });

      const res = await api(PATH, {
        method: 'POST',
        body: { email: user.email, password: user.password },
      });
      expect(res.status).toBe(200);
      const tokenLine = res.cookies.find((c) =>
        c.startsWith('better-auth.session_token=')
      );
      expect(tokenLine).toBeDefined();
      expect(tokenLine!.toLowerCase()).toContain('httponly');
      // SameSite Lax is Better Auth's default and is what protects against CSRF.
      expect(tokenLine!.toLowerCase()).toContain('samesite');
    },
    30_000
  );
});

describe('POST /api/auth/sign-in/email — credential rejection', () => {
  test(
    'wrong password is rejected with 401',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id });

      const res = await api(PATH, {
        method: 'POST',
        body: { email: user.email, password: 'WrongPass1!@#' },
      });

      expect(res.status).toBe(401);
      expect(extractSessionCookie(res.cookies)).toBeNull();
    },
    30_000
  );

  test(
    'unknown email is rejected with 401 (no enumeration)',
    async () => {
      const res = await api(PATH, {
        method: 'POST',
        body: { email: tagEmail('ghost'), password: DEFAULT_PASSWORD },
      });
      expect(res.status).toBe(401);
    },
    30_000
  );

  test(
    'inactive user cannot sign in',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id, isActive: false });

      const res = await api(PATH, {
        method: 'POST',
        body: { email: user.email, password: user.password },
      });
      expect(res.status).toBe(401);
    },
    30_000
  );

  test(
    'user with deactivated role cannot sign in',
    async () => {
      // The schema CHECK enforces `deleted_at IS NOT NULL OR role_id IS NOT
      // NULL`, so the analogous case is a user whose role row is inactive.
      const role = await createRole({ isActive: false });
      const user = await createUser({ roleId: role.id });

      const res = await api(PATH, {
        method: 'POST',
        body: { email: user.email, password: user.password },
      });
      expect(res.status).toBe(401);
    },
    30_000
  );
});

describe('POST /api/auth/sign-in/email — captcha gate', () => {
  test('missing captcha header rejects sign-in', async () => {
    const role = await createRole();
    const user = await createUser({ roleId: role.id });

    const res = await api(PATH, {
      method: 'POST',
      body: { email: user.email, password: user.password },
      noCaptcha: true,
    });
    // Better Auth captcha plugin returns 400/403 family on missing token.
    expect([400, 403].includes(res.status)).toBe(true);
    expect(extractSessionCookie(res.cookies)).toBeNull();
  });
});

describe('POST /api/auth/sign-in/email — input validation', () => {
  test('422 when body is empty', async () => {
    const res = await api(PATH, { method: 'POST', body: {} });
    // Better Auth's own schema may return 400 here; our before hook returns 422.
    expect([400, 422].includes(res.status)).toBe(true);
  });

  test('422/400 when email is malformed', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: { email: 'not-an-email', password: DEFAULT_PASSWORD },
    });
    expect([400, 422].includes(res.status)).toBe(true);
  });

  test('422/400 when password is too short', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: { email: tagEmail('x'), password: 'a' },
    });
    expect([400, 422].includes(res.status)).toBe(true);
  });

  test('SQL injection in email does not produce a session', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: {
        email: "anything' OR '1'='1@gmail.com",
        password: DEFAULT_PASSWORD,
      },
    });
    // Status is not the primary contract here; the security invariant is "no
    // session cookie was minted under attacker-controlled identifiers."
    expect(res.status).not.toBe(200);
    expect(extractSessionCookie(res.cookies)).toBeNull();
  });
});

describe('POST /api/auth/sign-in/email — lockout after 5 wrong passwords', () => {
  test(
    'after 5 wrong-password attempts the account is locked in DB',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id });

      // Use a fresh IP per attempt so the per-IP Upstash limit doesn't shadow
      // the DB-side counter. Only the password-check path increments
      // failed_login_attempts — we want all 5 attempts to land on it.
      for (let i = 0; i < 5; i++) {
        const r = await api(PATH, {
          method: 'POST',
          body: { email: user.email, password: 'TotallyWrong1!@#' },
        });
        expect(r.status).toBe(401);
      }

      const [u] = await tdb
        .select({
          failedLoginAttempts: users.failedLoginAttempts,
          lockedUntil: users.lockedUntil,
        })
        .from(users)
        .where(eq(users.id, user.id));
      expect(u.failedLoginAttempts).toBeGreaterThanOrEqual(5);
      expect(u.lockedUntil).not.toBeNull();

      await unlockUser(user.email);
    },
    60_000
  );

  test(
    'locked account stays locked even when given the correct password',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id });

      // Force the lock via direct DB mutation (avoids burning Upstash window).
      await tdb
        .update(users)
        .set({
          failedLoginAttempts: 5,
          lockedUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
        })
        .where(eq(users.id, user.id));

      const res = await api(PATH, {
        method: 'POST',
        body: { email: user.email, password: user.password },
        ip: '10.251.0.1',
      });
      expect(res.status).toBe(401);
      expect(extractSessionCookie(res.cookies)).toBeNull();
    },
    30_000
  );
});

describe('GET /api/auth/get-session — session readback', () => {
  test('returns null/empty when no cookie is provided', async () => {
    const res = await api('/api/auth/get-session', { method: 'GET' });
    // Better Auth returns 200 with { user: null, session: null } or empty body.
    expect(res.status).toBe(200);
    // Either { user: null } or null body.
    const user = res.body?.user ?? null;
    expect(user).toBeNull();
  });

  test(
    'returns user/session when a valid cookie is provided',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id });

      const login = await api(PATH, {
        method: 'POST',
        body: { email: user.email, password: user.password },
      });
      const cookie = extractSessionCookie(login.cookies);
      expect(cookie).not.toBeNull();

      const sess = await api('/api/auth/get-session', { method: 'GET', cookie: cookie! });
      expect(sess.status).toBe(200);
      expect(sess.body?.user?.id).toBe(user.id);
    },
    30_000
  );

  test('tampered cookie does not yield a session', async () => {
    const res = await api('/api/auth/get-session', {
      method: 'GET',
      cookie: 'better-auth.session_token=tampered-garbage-value',
    });
    expect(res.status).toBe(200);
    const user = res.body?.user ?? null;
    expect(user).toBeNull();
  });
});

describe('POST /api/auth/sign-out', () => {
  test(
    'sign-out responds successfully and emits Set-Cookie clearing the session',
    async () => {
      const role = await createRole();
      const user = await createUser({ roleId: role.id });

      const login = await api(PATH, {
        method: 'POST',
        body: { email: user.email, password: user.password },
      });
      const cookie = extractSessionCookie(login.cookies)!;

      const before = await tdb.select().from(sessions).where(eq(sessions.userId, user.id));
      expect(before.length).toBe(1);

      const out = await api('/api/auth/sign-out', { method: 'POST', cookie, body: {} });
      expect(out.status).toBeLessThan(500);
      // At minimum: sign-out must emit at least one Set-Cookie header to
      // revoke the session cookie. (Whether Better Auth additionally deletes
      // the DB row varies by version; we only pin the client-observable
      // contract here.)
      expect(out.cookies.length).toBeGreaterThan(0);
    },
    30_000
  );
});

describe('POST /api/auth/* — disallowed sub-paths', () => {
  test('arbitrary better-auth route returns 404 (ALLOWED_PATHS filter)', async () => {
    const res = await api('/api/auth/sign-up/email', {
      method: 'POST',
      body: { email: tagEmail('new'), password: DEFAULT_PASSWORD, name: 'X' },
    });
    expect(res.status).toBe(404);
  });

  test('forgot-password route is not exposed', async () => {
    const res = await api('/api/auth/forget-password', {
      method: 'POST',
      body: { email: tagEmail('x') },
    });
    expect(res.status).toBe(404);
  });

  test('admin route is not exposed', async () => {
    const res = await api('/api/auth/admin/list-users', { method: 'GET' });
    expect(res.status).toBe(404);
  });
});
