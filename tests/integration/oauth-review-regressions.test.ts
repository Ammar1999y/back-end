import { beforeEach, expect, spyOn, test } from 'bun:test';

import { and, eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import {
  accounts,
  auditLogs,
  passkeys,
  sessions,
  twoFactorMethods,
  users,
} from '@/db/schema';
import { verifyGoogleIdToken } from 'better-auth/social-providers';
import * as z from 'zod';
import { auth } from '@/lib/auth';
import * as adminReauth from '@/lib/auth/admin-reauth';
import * as passkeyAssertion from '@/lib/auth/passkey-assertion';
import * as eligibility from '@/lib/auth/user-eligibility';
import { PUBLIC_ORIGIN } from '@/lib/env';

import {
  MSG_INVALID_CREDENTIALS,
  MSG_REAUTH_REQUIRED,
  REAUTH_REQUIRED_CODE,
} from '@/utils/api-messages';

import { resetTables } from '../helpers/database';
import { scriptEgress } from '../helpers/egress';
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

test('Google and password both admit a stale enrollment when the global 2FA feature is disabled', async () => {
  const child = Bun.spawn(
    [
      'bun',
      '--no-env-file',
      'tests/fixtures/_oauth-disabled-two-factor-child.ts',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NEXT_PUBLIC_ENABLED_2FA_METHODS: '',
        NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS: '',
        NEXT_PUBLIC_ENABLED_OTP_CHANNELS: 'email,sms',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(status).toBe(0);
  expect(JSON.parse(error)).toMatchObject({
    msg: 'twoFactor.disabled no method configured',
  });
  expect(output).toContain(
    'Google and password honor disabled two-factor configuration.'
  );
}, 20_000);

test('redirect and direct identity denials share the same 401 envelope', async () => {
  const claims = { sub: 'unknown-subject', email: 'unknown@gmail.com' };
  const directFlow = await startGoogle(claims);
  const direct = await directFlow.callback();
  expect(direct.status).toBe(401);
  const flow = await startGoogle(claims, { callbackURL: '/finish' });
  const redirected = await flow.callback();
  expect(redirected.status).toBe(302);
  const cookie = mergeCookies(flow.cookie, redirected.headers.getSetCookie());
  const result = await call('/api/auth/oauth/result', cookie);
  expect(result.status).toBe(401);
  expect(await result.json()).toEqual(await direct.json());
  await expect(call('/api/auth/oauth/result', cookie)).resolves.toHaveProperty(
    'status',
    401
  );
});

test('an unknown Google identity logs a controlled warning without identity claims', async () => {
  const claims = { sub: 'unknown-log-subject', email: 'unknown-log@gmail.com' };
  const flow = await startGoogle(claims);
  const warning = spyOn(console, 'warn').mockImplementation(() => {});
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await flow.callback();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      message: MSG_INVALID_CREDENTIALS,
    });
    expect(warning.mock.calls).toEqual([
      [
        {
          msg: 'oauth.signIn.failed',
          provider: 'google',
          stage: 'identity',
          reason: 'user_ineligible',
        },
      ],
    ]);
    expect(error).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
    error.mockRestore();
  }
});

test('a result-storage failure withdraws the session before returning a generic redirect denial', async () => {
  const owner = await seedUser();
  const flow = await startGoogle(
    { sub: 'result-storage-subject', email: owner.email },
    { callbackURL: '/finish' }
  );
  const context = await auth.$context;
  const create = context.internalAdapter.createVerificationValue;
  let failed = false;
  const unavailable = spyOn(
    context.internalAdapter,
    'createVerificationValue'
  ).mockImplementation(async (...args) => {
    if (!failed && args[0].identifier.startsWith('oauth-result-')) {
      failed = true;
      throw new Error('Result storage failed.');
    }
    return create(...args);
  });
  try {
    const response = await flow.callback();
    expect(response.status).toBe(302);
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, owner.userId))
    ).toHaveLength(0);
    const result = await call(
      '/api/auth/oauth/result',
      mergeCookies(flow.cookie, response.headers.getSetCookie())
    );
    expect(result.status).toBe(401);
  } finally {
    unavailable.mockRestore();
  }
});

test('post-commit identity admission failure has its own abandonment audit reason', async () => {
  const owner = await seedUser();
  const flow = await startGoogle({
    sub: 'admission-subject',
    email: owner.email,
  });
  const context = await auth.$context;
  const find = context.internalAdapter.findUserById;
  const changed = spyOn(
    context.internalAdapter,
    'findUserById'
  ).mockImplementation(async (...args) => {
    const user = await find(...args);
    return user ? { ...user, email: 'changed@gmail.com' } : null;
  });
  try {
    await expect(flow.callback()).resolves.toHaveProperty('status', 401);
    const rows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.userId, owner.userId),
          eq(auditLogs.action, 'DELETE'),
          eq(auditLogs.tableName, 'sessions')
        )
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.newData).toMatchObject({
      sessionAbandoned: true,
      reason: 'post_commit_admission_failed',
    });
  } finally {
    changed.mockRestore();
  }
});

test('removing a link between identity lookup and user locking reaches the link-removed guard', async () => {
  const owner = await seedUser();
  const claims = { sub: 'removed-link-subject', email: owner.email };
  const initialFlow = await startGoogle(claims);
  await expect(initialFlow.callback()).resolves.toHaveProperty('status', 200);
  const flow = await startGoogle(claims);
  const lock = eligibility.lockEligibleAuthUser;
  const removed = spyOn(eligibility, 'lockEligibleAuthUser').mockImplementation(
    async (...args) => {
      await db
        .delete(accounts)
        .where(
          and(
            eq(accounts.userId, owner.userId),
            eq(accounts.providerId, 'google')
          )
        );
      return lock(...args);
    }
  );
  const log = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await expect(flow.callback()).resolves.toHaveProperty('status', 401);
    expect(JSON.stringify(log.mock.calls)).toContain('link_removed');
  } finally {
    removed.mockRestore();
    log.mockRestore();
  }
});

test('unexpected token exchange failures are observable without leaking the provider error', async () => {
  const owner = await seedUser();
  const flow = await startGoogle({
    sub: 'transport-subject',
    email: owner.email,
  });
  const secret = 'secret-provider-payload-must-not-be-logged';
  scriptEgress('oauth2.googleapis.com', () => {
    throw new Error(secret);
  });
  const log = spyOn(console, 'error').mockImplementation(() => {});
  const warning = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const response = await flow.callback();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      message: MSG_INVALID_CREDENTIALS,
    });
    expect(JSON.stringify(log.mock.calls)).toContain('oauth.signIn.failed');
    expect(JSON.stringify(log.mock.calls)).toContain('token_exchange');
    expect(JSON.stringify(log.mock.calls)).toContain('unexpected_failure');
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(warning).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    warning.mockRestore();
  }
});

test.each([
  [
    '/api/dash/users/me/change-password',
    { newPassword: 'Review!ChangedPassw0rd' },
  ],
  ['/api/dash/users/me/change-email', { newEmail: 'review-target@gmail.com' }],
  ['/api/auth/two-factor/disable', {}],
  ['/api/auth/two-factor/methods/disable', { method: 'passkey' }],
  ['/api/auth/two-factor/generate-backup-codes', {}],
  ['/api/auth/two-factor/passkey/grant', {}],
  ['/api/auth/two-factor/get-totp-uri', {}],
] as const)(
  'missing credential proof has one reauthentication code at %s',
  async (path, body) => {
    const owner = await seedUser();
    const { cookie } = await signIn(owner);
    const response = await call(path, cookie, body);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      message: MSG_REAUTH_REQUIRED,
      code: REAUTH_REQUIRED_CODE,
    });
  }
);

test('authorization URL explicitly requests signed MFA evidence and a nonce with minimal scopes', async () => {
  const flow = await startGoogle({
    sub: 'url-subject',
    email: 'url@gmail.com',
  });
  const params = flow.url.searchParams;
  expect(
    params
      .get('scope')
      ?.split(' ')
      .toSorted((a, b) => (a === b ? 0 : a < b ? -1 : 1))
  ).toEqual(['email', 'openid']);
  expect(params.get('nonce')).toMatch(/^[\w-]{43}$/);
  expect(params.get('state')).toBeTruthy();
  expect(params.get('code_challenge')).toBeTruthy();
  expect(params.get('code_challenge_method')).toBe('S256');
  expect(params.get('include_granted_scopes')).toBeNull();
  expect(params.get('access_type')).toBe('online');
  expect(JSON.parse(params.get('claims') ?? '{}')).toEqual({
    id_token: { amr: { essential: true } },
  });
});

test('administrative reauthentication-required errors retain their machine code through response serialization', async () => {
  const administrator = await seedUser({ roleScope: 'system' });
  const target = await seedUser();
  const { cookie } = await signIn(administrator);
  const response = await app.handle(
    new Request(`${PUBLIC_ORIGIN}/api/dash/users/${target.userId}`, {
      method: 'DELETE',
      headers: baseHeaders({ cookie, origin: PUBLIC_ORIGIN }),
    })
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    message: MSG_REAUTH_REQUIRED,
    code: REAUTH_REQUIRED_CODE,
  });
});

test('the installed Google verifier accepts a token without exp, so the callback must require it', async () => {
  const owner = await seedUser();
  const flow = await startGoogle({
    sub: 'missing-exp-subject',
    email: owner.email,
    exp: undefined,
  });
  const claims = await verifyGoogleIdToken({
    token: flow.token,
    audience: 'harness.apps.googleusercontent.com',
    nonce: flow.url.searchParams.get('nonce') ?? '',
  });
  expect(claims).toBeTruthy();
  expect(claims?.exp).toBeUndefined();
  await expect(flow.callback()).resolves.toHaveProperty('status', 401);
});

test.each([
  { code: null, error: 'access_denied' },
  { iss: 'https://untrusted.example' },
])(
  'callback rejects provider cancellation or issuer mismatch: %j',
  async (query) => {
    const owner = await seedUser();
    const flow = await startGoogle({
      sub: 'callback-subject',
      email: owner.email,
    });
    await expect(flow.callback(query)).resolves.toHaveProperty('status', 401);
    expect(
      await db.select().from(accounts).where(eq(accounts.providerId, 'google'))
    ).toHaveLength(0);
    expect(await db.select().from(sessions)).toHaveLength(0);
  }
);

test('a browser session belonging to someone else cannot change which Google identity is admitted', async () => {
  const other = await seedUser();
  const owner = await seedUser();
  const { cookie } = await signIn(other);
  const flow = await startGoogle(
    { sub: 'different-browser-subject', email: owner.email },
    { cookie }
  );
  const response = await flow.callback();
  expect(response.status).toBe(200);
  const live = await auth.api.getSession({
    headers: new Headers({
      cookie: mergeCookies(flow.cookie, response.headers.getSetCookie()),
    }),
  });
  expect(live?.user.id).toBe(owner.userId);
  const linked = await db
    .select()
    .from(accounts)
    .where(eq(accounts.providerId, 'google'));
  expect(linked.map((entry) => entry.userId)).toEqual([owner.userId]);
});

test.each([false, true])(
  'signed Workspace hd syntax does not impose an extra email-domain equality policy (matching=%s)',
  async (matching) => {
    const owner = await seedUser();
    owner.email = `hosted-${matching}@outlook.com`;
    await db
      .update(users)
      .set({ email: owner.email })
      .where(eq(users.id, owner.userId));
    const flow = await startGoogle({
      sub: `hosted-${matching}`,
      email: owner.email,
      hd: matching ? 'outlook.com' : 'workspace.example',
    });
    await expect(flow.callback()).resolves.toHaveProperty('status', 200);
  }
);

test.each([
  { amr: ['mfa', 'pwd', 'swk'], bypass: true },
  { amr: ['hwk'], bypass: false },
  { amr: ['swk'], bypass: false },
])('only exact signed mfa bypasses local 2FA: %j', async ({ amr, bypass }) => {
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
  await db
    .insert(twoFactorMethods)
    .values({ userId: owner.userId, method: 'passkey', isDefault: true });
  await db
    .update(users)
    .set({ twoFactorEnabled: true })
    .where(eq(users.id, owner.userId));
  const flow = await startGoogle({
    sub: 'amr-review-subject',
    email: owner.email,
    amr,
  });
  const response = await flow.callback();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject(
    bypass ? { data: { loggedIn: true } } : { twoFactorRedirect: true }
  );
  if (bypass) {
    const events = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.userId, owner.userId));
    expect(events).toContainEqual(
      expect.objectContaining({
        newData: expect.objectContaining({
          reason: 'two_factor_skipped_google_mfa',
        }),
      })
    );
  }
});

test.each([0, 60_000])(
  'rotation rejects an already-proven password even when the app clock is ahead by %d ms',
  async (skew) => {
    const owner = await seedUser();
    const { cookie } = await signIn(owner);
    const live = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    if (!live) throw new Error('Missing fixture session.');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const mint = adminReauth.mintAdminReauth;
    const paused = spyOn(adminReauth, 'mintAdminReauth').mockImplementation(
      async (...args) => {
        entered.resolve();
        await release.promise;
        return mint(...args);
      }
    );
    const now = Date.now;
    const clock = spyOn(Date, 'now').mockImplementation(() => now() + skew);
    const pending = call('/api/dash/auth/reauth', cookie, {
      password: owner.password,
    });
    try {
      await entered.promise;
      clock.mockRestore();
      const rotated = await call('/api/dash/users/me/change-password', cookie, {
        currentPassword: owner.password,
        newPassword: 'Rotated!Password123',
      });
      expect(rotated.status).toBe(200);
      expect(
        await db.select().from(sessions).where(eq(sessions.id, live.session.id))
      ).toHaveLength(1);
      release.resolve();
      await expect(pending).resolves.toHaveProperty('status', 401);
      expect(
        await adminReauth.hasAdminReauth(live.session.id, owner.userId)
      ).toBe(false);
    } finally {
      clock.mockRestore();
      release.resolve();
      await pending;
      paused.mockRestore();
    }
  }
);

test.each(['reauth', 'two-factor'])(
  'concurrent verified assertions preserve the highest counter in %s',
  async (mode) => {
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
    let cookie: string;
    if (mode === 'reauth') ({ cookie } = await signIn(owner));
    else {
      await db
        .insert(twoFactorMethods)
        .values({ userId: owner.userId, method: 'passkey', isDefault: true });
      await db
        .update(users)
        .set({ twoFactorEnabled: true })
        .where(eq(users.id, owner.userId));
      const flow = await startGoogle({
        sub: 'counter-subject',
        email: owner.email,
      });
      const response = await flow.callback();
      cookie = mergeCookies(flow.cookie, response.headers.getSetCookie());
    }
    const options = await call(`/api/auth/${mode}/passkey/options`, cookie, {});
    const { data } = z
      .object({ data: z.object({ challenge: z.string() }) })
      .parse(await options.json());
    const verify = passkeyAssertion.verifyUserPasskey;
    const concurrent = spyOn(
      passkeyAssertion,
      'verifyUserPasskey'
    ).mockImplementation(async (...args) => {
      const result = await verify(...args);
      await db
        .update(passkeys)
        .set({ counter: 9 })
        .where(eq(passkeys.id, result.credential.id));
      return result;
    });
    try {
      const response = await call(`/api/auth/${mode}/passkey/verify`, cookie, {
        response: device.assertion({
          challenge: data.challenge,
          origin: PUBLIC_ORIGIN,
          rpId: new URL(PUBLIC_ORIGIN).hostname,
          counter: 4,
        }),
      });
      expect(response.status).toBe(200);
      const [credential] = await db
        .select()
        .from(passkeys)
        .where(eq(passkeys.userId, owner.userId));
      expect(credential?.counter).toBe(9);
    } finally {
      concurrent.mockRestore();
    }
  }
);

test('a passkey removed after challenge resolution keeps the established 2FA options status', async () => {
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
  await db
    .insert(twoFactorMethods)
    .values({ userId: owner.userId, method: 'passkey', isDefault: true });
  await db
    .update(users)
    .set({ twoFactorEnabled: true })
    .where(eq(users.id, owner.userId));
  const flow = await startGoogle({
    sub: 'removed-passkey-subject',
    email: owner.email,
  });
  const challenged = await flow.callback();
  const cookie = mergeCookies(flow.cookie, challenged.headers.getSetCookie());
  const options = passkeyAssertion.passkeyOptions;
  const removed = spyOn(passkeyAssertion, 'passkeyOptions').mockImplementation(
    async (...args) => {
      await db.delete(passkeys).where(eq(passkeys.userId, owner.userId));
      return options(...args);
    }
  );
  try {
    await expect(
      call('/api/auth/two-factor/passkey/options', cookie, {})
    ).resolves.toHaveProperty('status', 400);
  } finally {
    removed.mockRestore();
  }
});
