import { beforeEach, expect, spyOn, test } from 'bun:test';

import { and, eq, like } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import {
  accounts,
  auditLogs,
  passkeys,
  sessions,
  trustedDevices,
  twoFactorCredentials,
  twoFactorMethods,
  users,
  verificationCodes,
  verifications,
  verificationSessions,
} from '@/db/schema';
import { symmetricEncrypt } from 'better-auth/crypto';
import * as z from 'zod';
import { auth } from '@/lib/auth';
import { hasAdminReauth } from '@/lib/auth/admin-reauth';
import * as challenges from '@/lib/auth/two-factor-challenge';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { hashOtpCode } from '@/utils/otp';

import { resetTables, waitForUserLock } from '../helpers/database';
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
import { syntheticAuthenticator } from '../helpers/webauthn';

beforeEach(resetTables);
beforeEach(resetRateLimits);

function call(path: string, cookie: string, body: object, method = 'POST') {
  return app.handle(
    new Request(`${PUBLIC_ORIGIN}${path}`, {
      method,
      headers: baseHeaders({
        cookie,
        origin: PUBLIC_ORIGIN,
        'content-type': 'application/json',
      }),
      body: JSON.stringify(body),
    })
  );
}

test.each(['self-service', 'administrator'])(
  '%s email change unlinks Google and revokes sessions, reauthentication and pending exchanges',
  async (mode) => {
    const owner = await seedUser();
    const first = await startGoogle({ sub: 'email-owner', email: owner.email });
    const signedIn = await first.callback();
    expect(signedIn.status).toBe(200);
    const cookie = mergeCookies(first.cookie, signedIn.headers.getSetCookie());
    const live = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });

    if (!live) throw new Error('Missing Google session.');
    await signIn(owner);
    await expect(
      call('/api/dash/auth/reauth', cookie, { password: owner.password })
    ).resolves.toHaveProperty('status', 200);
    expect(await hasAdminReauth(live.session.id, owner.userId)).toBe(true);
    await db.insert(trustedDevices).values({
      userId: owner.userId,
      trustIdentifier: 'email-rotation-test',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const pending = await startGoogle({
      sub: 'email-owner',
      email: owner.email,
    });
    const newEmail = `changed.${owner.email}`;
    const pendingNewEmail = await startGoogle({
      sub: 'new-email-owner',
      email: newEmail,
    });
    if (mode === 'self-service') {
      await expect(
        call('/api/dash/users/me/change-email', cookie, { newEmail })
      ).resolves.toHaveProperty('status', 200);
      const [proof] = await db
        .select()
        .from(verificationSessions)
        .where(
          and(
            eq(verificationSessions.userId, owner.userId),
            eq(verificationSessions.purpose, 'change_email')
          )
        );
      if (!proof) throw new Error('Email change did not issue a proof.');
      await db
        .update(verificationCodes)
        .set({ code: hashOtpCode('424242') })
        .where(eq(verificationCodes.sessionId, proof.id));
      await expect(
        call('/api/dash/users/me/change-email/verify', cookie, {
          newEmail,
          code: '424242',
        })
      ).resolves.toHaveProperty('status', 200);
    } else {
      const administrator = await seedUser({ roleScope: 'system' });
      const admin = await signIn(administrator);
      await expect(
        call('/api/dash/auth/reauth', admin.cookie, {
          password: administrator.password,
        })
      ).resolves.toHaveProperty('status', 200);
      await expect(
        call(
          `/api/dash/users/${owner.userId}`,
          admin.cookie,
          {
            name: 'Email owner',
            email: newEmail,
            roleId: owner.roleId,
            isActive: true,
          },
          'PUT'
        )
      ).resolves.toHaveProperty('status', 200);
    }
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, owner.userId));
    expect(user?.email).toBe(newEmail);
    expect(user?.authRevokedAt).toBeInstanceOf(Date);
    const unlinks = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.userId, owner.userId),
          eq(auditLogs.tableName, 'accounts'),
          eq(auditLogs.action, 'DELETE')
        )
      );
    expect(unlinks).toHaveLength(1);
    expect(unlinks[0]?.newData).toMatchObject({
      identityLinked: false,
      reason: 'google_identity_unlinked',
    });
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
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, owner.userId))
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(trustedDevices)
        .where(eq(trustedDevices.userId, owner.userId))
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(verifications)
        .where(eq(verifications.value, owner.userId))
    ).toHaveLength(0);
    expect(await hasAdminReauth(live.session.id, owner.userId)).toBe(false);
    await expect(pending.callback()).resolves.toHaveProperty('status', 401);
    await expect(pendingNewEmail.callback()).resolves.toHaveProperty(
      'status',
      401
    );
    await expect(
      call('/api/auth/reauth/passkey/options', cookie, {})
    ).resolves.toHaveProperty('status', 401);
    await signIn({ ...owner, email: newEmail });
    const fresh = await startGoogle({
      sub: 'new-email-owner',
      email: newEmail,
    });
    await expect(fresh.callback()).resolves.toHaveProperty('status', 200);
  }
);

test('an email commit racing Google challenge issuance cannot leave a usable pending login', async () => {
  const owner = await seedUser({
    phoneNumber: uniquePhone(),
    phoneNumberVerified: true,
  });
  const signedIn = await signIn(owner);
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
  const newEmail = `racing.${owner.email}`;
  await seedOtpProof({
    userId: owner.userId,
    identifier: newEmail,
    targetIdentifier: newEmail,
    purpose: 'change_email',
    code: '535353',
  });
  const flow = await startGoogle({
    sub: 'racing-email-owner',
    email: owner.email,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const issue = challenges.issueTwoFactorChallenge;
  const paused = spyOn(
    challenges,
    'issueTwoFactorChallenge'
  ).mockImplementation(async (ctx, params) => {
    entered.resolve();
    await release.promise;
    return issue(ctx, params);
  });
  const callback = flow.callback();
  try {
    await entered.promise;
    const changed = call(
      '/api/dash/users/me/change-email/verify',
      signedIn.cookie,
      { newEmail, code: '535353' }
    );
    await waitForUserLock();
    release.resolve();
    const [response, committed] = await Promise.all([callback, changed]);
    expect(committed.status).toBe(200);
    expect(await response.json()).toMatchObject({
      twoFactorRedirect: true,
    });
    expect(
      await db
        .select()
        .from(verifications)
        .where(eq(verifications.value, owner.userId))
    ).toHaveLength(0);
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, owner.userId))
    ).toHaveLength(0);
    const challengeCookie = mergeCookies(
      flow.cookie,
      response.headers.getSetCookie()
    );
    await expect(
      call('/api/auth/two-factor/otp/send', challengeCookie, {
        option: 'otp:phone',
      })
    ).resolves.toHaveProperty('status', 401);
  } finally {
    release.resolve();
    paused.mockRestore();
    await callback;
  }
});

test.each(['otp', 'passkey', 'totp', 'backup_code'] as const)(
  'an email commit racing %s completion revokes the newly completed Google login',
  async (method) => {
    const phone = uniquePhone();
    const owner = await seedUser({
      phoneNumber: phone,
      phoneNumberVerified: true,
    });
    const signedIn = await signIn(owner);
    const device = syntheticAuthenticator();
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const backupCode = 'race-proof-backup';
    await db.insert(twoFactorMethods).values({
      userId: owner.userId,
      method,
      channel: method === 'otp' ? 'sms' : null,
      isDefault: true,
    });
    if (method === 'passkey')
      await db.insert(passkeys).values({
        userId: owner.userId,
        credentialID: device.credentialID,
        publicKey: device.publicKey,
        counter: 0,
        deviceType: 'singleDevice',
        backedUp: false,
      });
    else if (method === 'totp' || method === 'backup_code')
      await db.insert(twoFactorCredentials).values({
        userId: owner.userId,
        secret: await symmetricEncrypt({
          key: process.env.BETTER_AUTH_SECRET ?? '',
          data: secret,
        }),
        backupCodes: await symmetricEncrypt({
          key: process.env.BETTER_AUTH_SECRET ?? '',
          data: JSON.stringify([backupCode]),
        }),
        verified: true,
        backupCodesAcknowledgedAt: new Date(),
        backupCodesAcknowledgedVersion: 0,
        backupCodesRemaining: 1,
      });
    await db
      .update(users)
      .set({ twoFactorEnabled: true })
      .where(eq(users.id, owner.userId));
    const newEmail = `completed.${owner.email}`;
    await seedOtpProof({
      userId: owner.userId,
      identifier: newEmail,
      targetIdentifier: newEmail,
      purpose: 'change_email',
      code: '535353',
    });
    const flow = await startGoogle({
      sub: 'racing-completion-owner',
      email: owner.email,
    });
    const pending = await flow.callback();
    expect(pending.status).toBe(200);
    const cookie = mergeCookies(flow.cookie, pending.headers.getSetCookie());
    let verify: () => Promise<Response>;
    if (method === 'otp') {
      await seedOtpProof({
        userId: owner.userId,
        identifier: phone,
        purpose: 'two_factor',
        channel: 'sms',
        code: '424242',
      });
      verify = () =>
        call('/api/auth/two-factor/otp/verify', cookie, {
          option: 'otp:phone',
          code: '424242',
        });
    } else if (method === 'passkey') {
      const response = await call(
        '/api/auth/two-factor/passkey/options',
        cookie,
        {}
      );
      const options = z
        .object({ data: z.object({ challenge: z.string() }) })
        .parse(await response.json());
      const assertion = device.assertion({
        challenge: options.data.challenge,
        origin: PUBLIC_ORIGIN,
        rpId: new URL(PUBLIC_ORIGIN).hostname,
      });
      verify = () =>
        call('/api/auth/two-factor/passkey/verify', cookie, {
          response: assertion,
        });
    } else {
      const generated =
        method === 'totp'
          ? await auth.api.generateTOTP({ body: { secret } })
          : null;
      const code = generated?.code ?? backupCode;
      const path = method === 'totp' ? 'verify-totp' : 'verify-backup-code';
      const invalid = await call(`/api/auth/two-factor/${path}`, cookie, {
        code: code === '000000' ? '111111' : '000000',
      });
      expect(invalid.status).toBe(401);
      const attempts = await db
        .select({ value: verifications.value })
        .from(verifications)
        .where(like(verifications.identifier, '2fa-attempts-%'));
      expect(attempts).toEqual([{ value: '1' }]);
      verify = () => call(`/api/auth/two-factor/${path}`, cookie, { code });
    }
    const context = await auth.$context;
    const create = context.internalAdapter.createSession;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const paused = spyOn(
      context.internalAdapter,
      'createSession'
    ).mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return create(...args);
    });
    const completing = verify();
    try {
      await entered.promise;
      const changed = call(
        '/api/dash/users/me/change-email/verify',
        signedIn.cookie,
        { newEmail, code: '535353' }
      );
      await waitForUserLock();
      release.resolve();
      const [completed, committed] = await Promise.all([completing, changed]);
      expect(completed.status).toBe(200);
      expect(committed.status).toBe(200);
      expect(
        await db
          .select()
          .from(sessions)
          .where(eq(sessions.userId, owner.userId))
      ).toHaveLength(0);
      const completedCookie = mergeCookies(
        cookie,
        completed.headers.getSetCookie()
      );
      await expect(
        call('/api/auth/reauth/passkey/options', completedCookie, {})
      ).resolves.toHaveProperty('status', 401);
    } finally {
      release.resolve();
      paused.mockRestore();
      await completing;
    }
  }
);
