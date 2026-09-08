import { beforeEach, describe, expect, test } from 'bun:test';

import { and, eq } from 'drizzle-orm';

import { app } from '@/app';
import { db, withTransaction } from '@/db';
import {
  accounts,
  auditLogs,
  roles,
  sessions,
  twoFactorMethods,
  users,
} from '@/db/schema';
import { ROUTES } from '@/routes';
import { auth } from '@/lib/auth';
import { hasAdminReauth } from '@/lib/auth/admin-reauth';
import {
  revokeOtherSessions,
  revokePendingProofs,
  unlinkGoogle,
} from '@/lib/auth/rotation';
import { PUBLIC_ORIGIN } from '@/lib/env';
import { openApiDocument } from '@/lib/http/openapi';
import { toPublishedManifest } from '@/lib/http/route-manifest';

import { REQUIRE_EMAIL_VERIFICATION } from '@/utils/config';

import { resetTables } from '../helpers/database';
import { startGoogle } from '../helpers/google';
import { seedOtpProof } from '../helpers/otp';
import { resetRateLimits } from '../helpers/rate-limit';
import {
  baseHeaders,
  mergeCookies,
  seedUser,
  signIn,
  uniquePhone,
} from '../helpers/session';

beforeEach(resetTables);
beforeEach(resetRateLimits);

async function userState(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return {
    user,
    accounts: await db
      .select()
      .from(accounts)
      .where(eq(accounts.userId, userId)),
    sessions: await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId)),
  };
}

describe('Google sign-in through the routed OAuth exchange', () => {
  test('enabled capabilities and OpenAPI describe the routed callback without credentials', async () => {
    const response = await app.handle(
      new Request(`${PUBLIC_ORIGIN}/api/auth/capabilities`, {
        headers: baseHeaders(),
      })
    );
    expect(await response.json()).toEqual({
      success: true,
      data: { oauthProviders: ['google'] },
    });
    const document = openApiDocument(toPublishedManifest(ROUTES, true));
    expect(document).toMatchObject({
      paths: {
        '/api/auth/oauth/google/start': {
          post: { requestBody: { required: true } },
        },
        '/api/auth/oauth/google/callback': {
          get: {
            responses: {
              '302': { headers: { Location: { schema: { type: 'string' } } } },
            },
          },
        },
        '/api/auth/oauth/result': { get: { responses: { '200': {} } } },
        '/api/auth/reauth/methods': {
          get: { security: [{ sessionCookie: [] }] },
        },
      },
    });
    expect(JSON.stringify(document)).not.toContain(
      'harness-google-client-secret'
    );
    expect(JSON.stringify(document)).not.toContain(
      'harness.apps.googleusercontent.com'
    );
  });
  test('Google honors test-only required-email-verification without changing the shipped default', async () => {
    const child = Bun.spawn(
      ['bun', '--no-env-file', 'tests/fixtures/_oauth-required-email-child.ts'],
      {
        cwd: process.cwd(),
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect([await child.exited, error]).toEqual([0, '']);
    expect(output).toContain('Required-email-verification Google flow passed.');
  }, 20_000);

  test('Google first factor completes through the existing local OTP verifier', async () => {
    const phone = uniquePhone();
    const owner = await seedUser({
      emailVerified: false,
      phoneNumber: phone,
      phoneNumberVerified: true,
    });
    await db.insert(twoFactorMethods).values({
      userId: owner.userId,
      method: 'otp',
      channel: 'sms',
      isDefault: true,
    });
    await db
      .update(users)
      .set({ twoFactorEnabled: true })
      .where(eq(users.id, owner.userId));
    const flow = await startGoogle({
      sub: 'local-otp-subject',
      email: owner.email,
    });
    const response = await flow.callback();
    const cookie = mergeCookies(flow.cookie, response.headers.getSetCookie());
    await seedOtpProof({
      userId: owner.userId,
      identifier: phone,
      purpose: 'two_factor',
      channel: 'sms',
      code: '424242',
    });
    const verified = await app.handle(
      new Request(`${PUBLIC_ORIGIN}/api/auth/two-factor/otp/verify`, {
        method: 'POST',
        headers: baseHeaders({
          cookie,
          origin: PUBLIC_ORIGIN,
          'content-type': 'application/json',
        }),
        body: JSON.stringify({ code: '424242', option: 'otp:phone' }),
      })
    );
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ data: { loggedIn: true } });
    const live = await auth.api.getSession({
      headers: new Headers({
        cookie: mergeCookies(cookie, verified.headers.getSetCookie()),
      }),
    });
    expect(live?.user.id).toBe(owner.userId);
    const verifiedCookie = mergeCookies(
      cookie,
      verified.headers.getSetCookie()
    );
    const trusted = await app.handle(
      new Request(`${PUBLIC_ORIGIN}/api/auth/two-factor/trust-device`, {
        method: 'POST',
        headers: baseHeaders({
          cookie: verifiedCookie,
          origin: PUBLIC_ORIGIN,
          'content-type': 'application/json',
        }),
        body: '{}',
      })
    );
    expect(trusted.status).toBe(200);
    const next = await startGoogle(
      { sub: 'local-otp-subject', email: owner.email },
      { cookie: mergeCookies(verifiedCookie, trusted.headers.getSetCookie()) }
    );
    const challenged = await next.callback();
    expect(await challenged.json()).toMatchObject({ twoFactorRedirect: true });
    const events = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.userId, owner.userId));
    expect(
      events.some((event) =>
        JSON.stringify(event.newData).includes('"firstFactor":"google"')
      )
    ).toBe(true);
  });
  test('first exact match links and verifies without replacing administrator fields; password still works', async () => {
    expect(REQUIRE_EMAIL_VERIFICATION).toBe(false);
    const owner = await seedUser({ emailVerified: false });
    await signIn(owner);
    const before = await userState(owner.userId);
    const flow = await startGoogle({
      sub: 'first-subject',
      email: ` ${owner.email.toUpperCase()} `,
      name: 'Provider name',
      picture: 'https://example.invalid/image',
    });
    expect(
      flow.url.searchParams
        .get('scope')
        ?.split(' ')
        .toSorted((a, b) => (a === b ? 0 : a < b ? -1 : 1))
    ).toEqual(['email', 'openid']);
    expect(flow.url.searchParams.get('access_type')).toBe('online');
    expect(flow.url.searchParams.get('nonce')).toBeTruthy();
    const response = await flow.callback();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { loggedIn: true } });
    const after = await userState(owner.userId);
    expect(after.user).toMatchObject({
      name: before.user?.name,
      roleId: owner.roleId,
      email: owner.email,
      emailVerified: true,
    });
    expect(
      after.accounts.filter((account) => account.providerId === 'google')
    ).toHaveLength(1);
    expect(
      after.accounts.find((account) => account.providerId === 'google')
    ).toMatchObject({
      accountId: 'first-subject',
      issuer: 'https://accounts.google.com',
      password: null,
    });
    const cookie = mergeCookies(flow.cookie, response.headers.getSetCookie());
    const live = await auth.api.getSession({
      headers: new Headers({ cookie }),
      query: { disableCookieCache: true },
    });
    expect(live?.user.id).toBe(owner.userId);
    await signIn(owner);
  });

  test('unknown identities cannot register through the plugin or lower library routes', async () => {
    const flow = await startGoogle({
      sub: 'unknown-subject',
      email: 'unknown@gmail.com',
    });
    const response = await flow.callback();
    expect(response.status).toBe(401);
    expect(await db.select().from(users)).toHaveLength(0);
    expect(await db.select().from(accounts)).toHaveLength(0);
    expect(await db.select().from(sessions)).toHaveLength(0);
    for (const path of [
      '/sign-in/social',
      '/callback/google',
      '/link-social',
      '/sign-up/email',
    ]) {
      const lower = await auth.handler(
        new Request(`${PUBLIC_ORIGIN}/api/auth${path}`, {
          method: 'POST',
          headers: baseHeaders({
            'content-type': 'application/json',
            origin: PUBLIC_ORIGIN,
          }),
          body: JSON.stringify({
            provider: 'google',
            email: 'unknown@gmail.com',
          }),
        })
      );
      expect(lower.status).toBe(404);
    }
  });

  test.each([
    'outlook.com',
    'hotmail.com',
    'live.com',
    'yahoo.com',
    'workspace.example',
  ])('rejects %s without mutation', async (domain) => {
    const owner = await seedUser({ emailVerified: false });
    if (domain !== 'workspace.example')
      await db
        .update(users)
        .set({ email: `eligible@${domain}` })
        .where(eq(users.id, owner.userId));
    const before = await userState(owner.userId);
    const flow = await startGoogle({
      sub: `subject-${domain}`,
      email: `eligible@${domain}`,
      ...(domain === 'workspace.example' && { hd: domain }),
    });
    await expect(flow.callback()).resolves.toHaveProperty('status', 401);
    expect(await userState(owner.userId)).toEqual(before);
  });

  test.each(['inactive', 'deleted', 'inactive-role'])(
    'refuses an %s identity before linking or verification',
    async (condition) => {
      const owner = await seedUser({ emailVerified: false });
      if (condition === 'inactive-role')
        await db
          .update(roles)
          .set({ isActive: false })
          .where(eq(roles.id, owner.roleId));
      else
        await db
          .update(users)
          .set(
            condition === 'inactive'
              ? { isActive: false }
              : { deletedAt: new Date(), isActive: false }
          )
          .where(eq(users.id, owner.userId));
      const before = await userState(owner.userId);
      const flow = await startGoogle({
        sub: 'ineligible-subject',
        email: owner.email,
      });
      await expect(flow.callback()).resolves.toHaveProperty('status', 401);
      expect(await userState(owner.userId)).toEqual(before);
    }
  );

  test('returning subject cannot follow a changed email, even to another local user', async () => {
    const first = await seedUser({ emailVerified: false });
    const second = await seedUser({ emailVerified: false });
    const initial = await startGoogle({
      sub: 'stable-subject',
      email: first.email,
    });
    await expect(initial.callback()).resolves.toHaveProperty('status', 200);
    const before = [
      await userState(first.userId),
      await userState(second.userId),
    ] as const;
    for (const email of ['changed@gmail.com', second.email]) {
      const flow = await startGoogle({ sub: 'stable-subject', email });
      await expect(flow.callback()).resolves.toHaveProperty('status', 401);
      expect([
        await userState(first.userId),
        await userState(second.userId),
      ]).toEqual([...before]);
    }
    const collision = await startGoogle({
      sub: 'second-subject',
      email: first.email,
    });
    await expect(collision.callback()).resolves.toHaveProperty('status', 401);
    expect(await userState(first.userId)).toEqual(before[0]);
  });

  test('concurrent callback replay produces one link and one verification transition', async () => {
    const owner = await seedUser({ emailVerified: false });
    const flow = await startGoogle({
      sub: 'concurrent-subject',
      email: owner.email,
    });
    const responses = await Promise.all([flow.callback(), flow.callback()]);
    expect(
      responses.map((response) => response.status).toSorted((a, b) => a - b)
    ).toEqual([200, 401]);
    const state = await userState(owner.userId);
    expect(
      state.accounts.filter((account) => account.providerId === 'google')
    ).toHaveLength(1);
    expect(state.sessions).toHaveLength(1);
    await expect(flow.callback()).resolves.toHaveProperty('status', 401);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.recordId, owner.userId));
    expect(
      audits.filter((audit) =>
        JSON.stringify(audit.newData).includes('emailVerified')
      )
    ).toHaveLength(1);
  });

  test('failed session admission rolls back a first link and email verification', async () => {
    const owner = await seedUser({ emailVerified: false });
    await db
      .update(users)
      .set({ twoFactorEnabled: true })
      .where(eq(users.id, owner.userId));
    const before = await userState(owner.userId);
    const flow = await startGoogle({
      sub: 'no-usable-factor',
      email: owner.email,
    });
    await expect(flow.callback()).resolves.toHaveProperty('status', 401);
    expect(await userState(owner.userId)).toEqual(before);
  });

  test.each([undefined, ['pwd'], 'mfa', ['mfa', 1]])(
    'no exact verified MFA evidence (%j) reaches local 2FA',
    async (amr) => {
      const owner = await seedUser({
        emailVerified: false,
        phoneNumber: uniquePhone(),
        phoneNumberVerified: true,
      });
      await db.insert(twoFactorMethods).values({
        userId: owner.userId,
        method: 'otp',
        channel: 'sms',
        isDefault: true,
      });
      await db
        .update(users)
        .set({ twoFactorEnabled: true })
        .where(eq(users.id, owner.userId));
      const flow = await startGoogle({
        sub: 'two-factor-subject',
        email: owner.email,
        amr,
      });
      const response = await flow.callback();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        twoFactorRedirect: true,
        twoFactorMethods: ['otp'],
      });
      const after = await userState(owner.userId);
      expect(after.sessions).toHaveLength(0);
    }
  );

  test('current signed amr=mfa bypasses local 2FA and is audited', async () => {
    const owner = await seedUser({ emailVerified: false });
    await db
      .update(users)
      .set({ twoFactorEnabled: true })
      .where(eq(users.id, owner.userId));
    const flow = await startGoogle({
      sub: 'mfa-subject',
      email: owner.email,
      amr: ['pwd', 'mfa'],
    });
    const response = await flow.callback();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { loggedIn: true } });
    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.userId, owner.userId));
    expect(
      audits.some((audit) =>
        JSON.stringify(audit.newData).includes('google_mfa')
      )
    ).toBe(true);
    const next = await startGoogle({ sub: 'mfa-subject', email: owner.email });
    await expect(next.callback()).resolves.toHaveProperty('status', 401);
  });

  test.each([
    { email_verified: false },
    { email_verified: 'true' },
    { nonce: 'wrong' },
    { iss: 'https://attacker.example' },
    { aud: 'another-client' },
    { exp: 1 },
    { exp: undefined },
    { azp: 'other.apps.googleusercontent.com' },
    { sub: '' },
  ])('rejects invalid claims %j', async (override) => {
    const owner = await seedUser({ emailVerified: false });
    const before = await userState(owner.userId);
    const flow = await startGoogle({
      sub: 'invalid-subject',
      email: owner.email,
      ...override,
    });
    await expect(flow.callback()).resolves.toHaveProperty('status', 401);
    expect(await userState(owner.userId)).toEqual(before);
  });

  test('a forged signature cannot create any durable authentication state', async () => {
    const owner = await seedUser({ emailVerified: false });
    const before = await userState(owner.userId);
    const legitimate = await startGoogle({
      sub: 'forged-subject',
      email: owner.email,
    });
    const parts = legitimate.token.split('.');
    const token = `${parts[0]}.${parts[1]}.${Buffer.alloc(256, 7).toString('base64url')}`;
    const forged = await startGoogle(
      { sub: 'forged-subject', email: owner.email },
      { token }
    );
    await expect(forged.callback()).resolves.toHaveProperty('status', 401);
    expect(await userState(owner.userId)).toEqual(before);
  });

  test.each([false, true])(
    'independent first-link callbacks serialize when subjects differ=%s',
    async (different) => {
      const owner = await seedUser({ emailVerified: false });
      const first = await startGoogle({
        sub: 'race-first',
        email: owner.email,
      });
      const second = await startGoogle({
        sub: different ? 'race-second' : 'race-first',
        email: owner.email,
      });
      const responses = await Promise.all([
        first.callback(),
        second.callback(),
      ]);
      expect(
        responses.map((response) => response.status).toSorted((a, b) => a - b)
      ).toEqual(different ? [200, 401] : [200, 200]);
      const after = await userState(owner.userId);
      expect(
        after.accounts.filter((account) => account.providerId === 'google')
      ).toHaveLength(1);
      const audits = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.recordId, owner.userId));
      expect(
        audits.filter((audit) =>
          JSON.stringify(audit.newData).includes('emailVerified')
        )
      ).toHaveLength(1);
    }
  );

  test('callback state binds the browser; off-origin return URLs and forged client profiles fail', async () => {
    const owner = await seedUser();
    const flow = await startGoogle({
      sub: 'state-subject',
      email: owner.email,
    });
    const noCookie = await app.handle(
      new Request(
        `${PUBLIC_ORIGIN}/api/auth/oauth/google/callback?state=${flow.url.searchParams.get('state')}&code=harness-code`,
        { headers: baseHeaders() }
      )
    );
    expect(noCookie.status).toBe(401);
    for (const body of [
      { callbackURL: 'https://attacker.example' },
      { email: owner.email, sub: 'forged' },
    ]) {
      const response = await app.handle(
        new Request(`${PUBLIC_ORIGIN}/api/auth/oauth/google/start`, {
          method: 'POST',
          headers: baseHeaders({
            'content-type': 'application/json',
            origin: PUBLIC_ORIGIN,
          }),
          body: JSON.stringify(body),
        })
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
  });

  test('Google sign-in never grants reauthentication, even with a new authentication timestamp', async () => {
    const owner = await seedUser();
    const first = await startGoogle({
      sub: 'reauth-subject',
      email: owner.email,
      auth_time: Math.floor(Date.now() / 1000),
    });
    const response = await first.callback();
    const cookie = mergeCookies(first.cookie, response.headers.getSetCookie());
    const live = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(live?.session.id).toBeTruthy();
    const result = await app.handle(
      new Request(`${PUBLIC_ORIGIN}/api/auth/oauth/google/start`, {
        method: 'POST',
        headers: baseHeaders({
          cookie,
          origin: PUBLIC_ORIGIN,
          'content-type': 'application/json',
        }),
        body: JSON.stringify({ mode: 'reauth' }),
      })
    );
    expect(result.status).toBe(400);
    expect(first.url.searchParams.has('max_age')).toBe(false);
    expect(await hasAdminReauth(live?.session.id ?? '', owner.userId)).toBe(
      false
    );
  });

  test('email rotation unlinks and invalidates a pending Google exchange', async () => {
    const owner = await seedUser();
    const initial = await startGoogle({
      sub: 'rotated-subject',
      email: owner.email,
    });
    await expect(initial.callback()).resolves.toHaveProperty('status', 200);
    const pending = await startGoogle({
      sub: 'rotated-subject',
      email: owner.email,
    });
    await withTransaction(async (tx) => {
      await tx
        .select()
        .from(users)
        .where(eq(users.id, owner.userId))
        .for('update');
      await tx
        .update(users)
        .set({ email: `changed.${owner.email}` })
        .where(eq(users.id, owner.userId));
      await unlinkGoogle(tx, owner.userId, {
        ip: null,
        userAgent: null,
        apiPath: '/test/email-change',
      });
      await revokePendingProofs(tx, owner.userId);
      await revokeOtherSessions(tx, owner.userId);
    });
    await expect(pending.callback()).resolves.toHaveProperty('status', 401);
    expect(
      await db
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.userId, owner.userId),
            eq(accounts.providerId, 'google')
          )
        )
    ).toHaveLength(0);
    const after = await userState(owner.userId);
    expect(after.sessions).toHaveLength(0);
  });
});
