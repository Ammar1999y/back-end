import { beforeEach, expect, spyOn, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { accounts, passkeys, sessions, users } from '@/db/schema';
import * as z from 'zod';
import { auth } from '@/lib/auth';
import { hasAdminReauth } from '@/lib/auth/admin-reauth';
import * as passwords from '@/lib/auth/password';
import * as rotation from '@/lib/auth/rotation';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { resetTables, waitForUserLock } from '../helpers/database';
import { startGoogle } from '../helpers/google';
import { resetRateLimits } from '../helpers/rate-limit';
import {
  baseHeaders,
  mergeCookies,
  seedUser,
  signIn,
} from '../helpers/session';
import { syntheticAuthenticator } from '../helpers/webauthn';

beforeEach(resetTables);
beforeEach(resetRateLimits);

test('competing password changes serialize the user and credential locks without deadlocking', async () => {
  const owner = await seedUser();
  const { cookie } = await signIn(owner);
  await expect(
    call('/api/dash/auth/reauth', cookie, { password: owner.password })
  ).resolves.toHaveProperty('status', 200);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const hashed = Promise.withResolvers<void>();
  const revoke = rotation.revokePendingProofs;
  const hash = passwords.hashPassword;
  const paused = spyOn(rotation, 'revokePendingProofs').mockImplementation(
    async (...args) => {
      entered.resolve();
      await release.promise;
      return revoke(...args);
    }
  );
  const first = call('/api/dash/users/me/change-password', cookie, {
    newPassword: 'First!ChangedPassw0rd',
  });
  try {
    await entered.promise;
    const hashing = spyOn(passwords, 'hashPassword').mockImplementation(
      async (...args) => {
        const result = await hash(...args);
        hashed.resolve();
        return result;
      }
    );
    const second = call('/api/dash/users/me/change-password', cookie, {
      newPassword: 'Second!ChangedPassw0rd',
    });
    try {
      await hashed.promise;
      await waitForUserLock();
      release.resolve();
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.status)).toEqual([200, 400]);
      await signIn({ ...owner, password: 'First!ChangedPassw0rd' });
    } finally {
      release.resolve();
      hashing.mockRestore();
      await second;
    }
  } finally {
    release.resolve();
    paused.mockRestore();
    await first;
  }
});

function call(path: string, cookie: string, body?: object) {
  return app.handle(
    new Request(`${PUBLIC_ORIGIN}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: baseHeaders({
        origin: PUBLIC_ORIGIN,
        cookie,
        'content-type': 'application/json',
      }),
      ...(body && { body: JSON.stringify(body) }),
    })
  );
}

async function fixture() {
  const owner = await seedUser();
  const device = syntheticAuthenticator();
  await db.insert(passkeys).values({
    userId: owner.userId,
    credentialID: device.credentialID,
    publicKey: device.publicKey,
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
  });
  const flow = await startGoogle({
    sub: 'all-methods-subject',
    email: owner.email,
  });
  const response = await flow.callback();
  expect(response.status).toBe(200);
  const cookie = mergeCookies(flow.cookie, response.headers.getSetCookie());
  const live = await auth.api.getSession({ headers: new Headers({ cookie }) });
  if (!live) throw new Error('Missing test session.');
  return { owner, device, cookie, sessionId: live.session.id };
}

test('the server offers password and passkey for a Google-linked account and a verified passkey opens the shared window', async () => {
  const { owner, device, cookie, sessionId } = await fixture();
  const methods = await call('/api/auth/reauth/methods', cookie);
  expect(await methods.json()).toMatchObject({
    data: { methods: ['password', 'passkey'] },
  });
  const started = await call('/api/auth/reauth/passkey/options', cookie, {});
  const options = z
    .object({
      data: z.object({
        challenge: z.string(),
        userVerification: z.string(),
        allowCredentials: z.array(z.object({ id: z.string() })),
      }),
    })
    .parse(await started.json());
  expect(options.data.userVerification).toBe('required');
  expect(options.data.allowCredentials.map((entry) => entry.id)).toEqual([
    device.credentialID,
  ]);
  const assertion = device.assertion({
    challenge: options.data.challenge,
    origin: PUBLIC_ORIGIN,
    rpId: new URL(PUBLIC_ORIGIN).hostname,
  });
  const verified = await call('/api/auth/reauth/passkey/verify', cookie, {
    response: assertion,
  });
  expect(verified.status).toBe(200);
  expect(await hasAdminReauth(sessionId, owner.userId)).toBe(true);
  await expect(
    call('/api/auth/reauth/passkey/verify', cookie, {
      response: assertion,
    })
  ).resolves.toHaveProperty('status', 401);
  const updated = await call('/api/dash/users/me/change-password', cookie, {
    newPassword: 'Changed!Passw0rd123',
  });
  expect(updated.status).toBe(200);
  await signIn({ ...owner, password: 'Changed!Passw0rd123' });
});

test('an unavailable method is not offered; a session alone cannot change a credential', async () => {
  const owner = await seedUser();
  const { cookie } = await signIn(owner);
  const methods = await call('/api/auth/reauth/methods', cookie);
  expect(await methods.json()).toMatchObject({
    data: { methods: ['password'] },
  });
  await expect(
    call('/api/auth/reauth/passkey/options', cookie, {})
  ).resolves.toHaveProperty('status', 401);
  await expect(
    call('/api/dash/users/me/change-password', cookie, {
      newPassword: 'Changed!Passw0rd123',
    })
  ).resolves.toHaveProperty('status', 401);
});

test.each(['wrong-user', 'wrong-session', 'no-uv', 'wrong-origin'])(
  'passkey reauthentication denies %s',
  async (mode) => {
    const { device, cookie, sessionId, owner } = await fixture();
    const started = await call('/api/auth/reauth/passkey/options', cookie, {});
    const options = z
      .object({ data: z.object({ challenge: z.string() }) })
      .parse(await started.json());
    const other = syntheticAuthenticator();
    const response = (mode === 'wrong-user' ? other : device).assertion({
      challenge: options.data.challenge,
      origin:
        mode === 'wrong-origin' ? 'https://attacker.example' : PUBLIC_ORIGIN,
      rpId: new URL(PUBLIC_ORIGIN).hostname,
      userVerified: mode !== 'no-uv',
    });
    const secondSession = mode === 'wrong-session' ? await signIn(owner) : null;
    const result = await call(
      '/api/auth/reauth/passkey/verify',
      secondSession?.cookie ?? cookie,
      { response }
    );
    expect(result.status).toBe(401);
    expect(await hasAdminReauth(sessionId, owner.userId)).toBe(false);
  }
);

test('Google redirect results are consumed once and password proof is still required for a sensitive grant', async () => {
  const { owner, cookie, sessionId } = await fixture();
  const before = await db
    .select()
    .from(accounts)
    .where(eq(accounts.userId, owner.userId));
  const flow = await startGoogle(
    {
      sub: 'all-methods-subject',
      email: owner.email,
    },
    {
      cookie,
      callbackURL: '/client/auth-complete',
    }
  );
  const response = await flow.callback();
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe(
    `${PUBLIC_ORIGIN}/client/auth-complete`
  );
  const resultCookie = mergeCookies(
    flow.cookie,
    response.headers.getSetCookie()
  );
  const result = await call('/api/auth/oauth/result', resultCookie);
  expect(await result.json()).toMatchObject({
    data: { loggedIn: true },
  });
  await expect(
    call('/api/auth/oauth/result', resultCookie)
  ).resolves.toHaveProperty('status', 401);
  expect(await hasAdminReauth(sessionId, owner.userId)).toBe(false);
  expect(
    await db.select().from(accounts).where(eq(accounts.userId, owner.userId))
  ).toEqual(before);
  await expect(
    call('/api/auth/two-factor/passkey/grant', resultCookie, {})
  ).resolves.toHaveProperty('status', 401);
  await expect(
    call('/api/dash/auth/reauth', resultCookie, { password: owner.password })
  ).resolves.toHaveProperty('status', 200);
  const grant = await call(
    '/api/auth/two-factor/passkey/grant',
    resultCookie,
    {}
  );
  expect(grant.status).toBe(200);
});

test('revocation prevents every reauthentication method and never creates a credential', async () => {
  const { owner, cookie } = await fixture();
  await db.delete(sessions).where(eq(sessions.userId, owner.userId));
  await expect(
    call('/api/auth/reauth/methods', cookie)
  ).resolves.toHaveProperty('status', 401);
  await expect(
    call('/api/auth/reauth/passkey/options', cookie, {})
  ).resolves.toHaveProperty('status', 401);
  await expect(
    call('/api/dash/auth/reauth', cookie, { password: owner.password })
  ).resolves.toHaveProperty('status', 401);
  const fresh = await signIn(owner);
  await db.delete(accounts).where(eq(accounts.userId, owner.userId));
  await expect(
    call('/api/dash/auth/reauth', fresh.cookie, {
      password: owner.password,
    })
  ).resolves.toHaveProperty('status', 401);
  expect(await db.select().from(accounts)).toHaveLength(0);
  expect(await db.select().from(users)).toHaveLength(1);
});
