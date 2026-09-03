/**
 * The two-factor contract, per DEPLOYMENT.
 *
 * ⚠️ Every other tier runs one configuration. That is why an empty method list
 * removing enforcement from `/sign-in/email` while `/passwordless/verify` kept
 * refusing, an OTP channel the deployment had dropped still being offered, and
 * two configurations with no route to a first enable were all green: the suite
 * proved one deployment works.
 *
 * `tests/helpers/run.ts` runs this file once per row of its `matrix` tier, with
 * the row's configuration in the environment and its name in
 * `TWO_FACTOR_MATRIX`. The configuration is read at MODULE LOAD — the allow-list
 * and therefore the served path set are derived from it — so a row cannot be a
 * `test()`; it has to be a process.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SeededUser } from '../helpers/session';

import { and, eq, sql } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import {
  auditLogs,
  twoFactorMethods,
  users,
  verificationCodes,
  verificationSessions,
} from '@/db/schema';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { HTTP_STATUS } from '@/utils/api-messages';
import { hashOtpCode, otpSubjectFor, otpTextFor } from '@/utils/otp';
import { clearOutbox, readOutbox } from '@/utils/otp-outbox';
import {
  ENABLED_TWO_FACTOR_METHODS,
  TWO_FACTOR_ENABLED,
  TWO_FACTOR_OTP_CHANNELS,
} from '@/utils/validation/two-factor';

import { resetTables } from '../helpers/database';
import { scriptEgress } from '../helpers/egress';
import { settleDelivery } from '../helpers/mailbox';
import { baseHeaders, seedUser, uniquePhone } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const TURNSTILE_HOST = 'challenges.cloudflare.com';
const ROW = process.env.TWO_FACTOR_MATRIX ?? 'unnamed';
const RIGHT_CODE = '606060';

/**
 * Replaces whatever the send path stored with a code this file knows.
 *
 * The proof ROW has to already exist — it carries the purpose binding — so the
 * send runs for real and only the code is overwritten.
 */
async function plantCode(userId: string): Promise<void> {
  const [proof] = await db
    .select({ id: verificationSessions.id })
    .from(verificationSessions)
    .where(
      and(
        eq(verificationSessions.userId, userId),
        eq(verificationSessions.purpose, 'passwordless_login')
      )
    );
  if (!proof) throw new Error('no passwordless proof row');
  await db
    .insert(verificationCodes)
    .values({
      sessionId: proof.id,
      code: hashOtpCode(RIGHT_CODE),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    })
    .onConflictDoUpdate({
      target: verificationCodes.sessionId,
      set: {
        code: hashOtpCode(RIGHT_CODE),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
}

function cookieHeader(setCookie: string[]): string {
  return setCookie
    .map((value) => value.split(';', 1)[0] ?? '')
    .filter((pair) => pair.length > 0 && !pair.endsWith('='))
    .join('; ');
}

function call(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  cookie?: string
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${url}`, {
      method,
      headers: baseHeaders({
        'content-type': 'application/json',
        origin: PUBLIC_ORIGIN,
        ...(cookie !== undefined && { cookie }),
      }),
      ...(method !== 'GET' && { body: JSON.stringify(body ?? {}) }),
    })
  );
}

/**
 * An account holding STORED two-factor state, whatever the current
 * configuration thinks of it.
 *
 * Written by SQL on purpose: the population this file is about is the one whose
 * rows were written under a configuration that has since changed, and no
 * endpoint can produce that.
 */
async function seedEnrolled(): Promise<SeededUser> {
  const user = await seedUser({
    phoneNumber: uniquePhone(),
    phoneNumberVerified: true,
  });
  await db
    .insert(twoFactorMethods)
    .values({ userId: user.userId, method: 'otp', channel: 'email' });
  await db
    .update(users)
    .set({ twoFactorEnabled: true })
    .where(eq(users.id, user.userId));
  return user;
}

beforeAll(async () => {
  await resetTables();
  await resetSqliteStores();
  scriptEgress(TURNSTILE_HOST, () => Response.json({ success: true }));
});

describe(`the ${ROW} configuration`, () => {
  test('the served surface matches the configured methods', async () => {
    // The allow-list is derived from the method list, and a disabled method's
    // paths answer 404 rather than being merely hidden.
    const expectations: Record<string, boolean> = {
      '/api/auth/two-factor/totp/start':
        ENABLED_TWO_FACTOR_METHODS.includes('totp'),
      '/api/auth/two-factor/generate-backup-codes':
        ENABLED_TWO_FACTOR_METHODS.includes('backup_code'),
      '/api/auth/two-factor/passkey/grant':
        ENABLED_TWO_FACTOR_METHODS.includes('passkey'),
      '/api/auth/two-factor/otp/send':
        ENABLED_TWO_FACTOR_METHODS.includes('otp'),
    };

    for (const [path, served] of Object.entries(expectations)) {
      const response = await call('POST', path, {});
      // Unauthenticated either way; what differs is whether the path EXISTS.
      expect([path, response.status === HTTP_STATUS.NOT_FOUND]).toEqual([
        path,
        !served,
      ]);
    }
  });

  test('/two-factor/enable is never served, in any configuration', async () => {
    // It can only produce TOTP here, and it writes the flag and the credential
    // outside the transaction that has to carry the intent row with them.
    const response = await call('POST', '/api/auth/two-factor/enable', {});
    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  test('the administrative reset is reachable whatever the method list says', async () => {
    // ⚠️ `D2`'s liveness half. Under an empty method list this is the ONLY exit
    // for an account still holding stored state, so gating it on the same list
    // removed the exit at exactly the moment it became the only one. A 404 here
    // would mean the route does not exist; 403/200 mean it does.
    const target = await seedEnrolled();
    const actor = await seedUser();
    const signedIn = await call('POST', '/api/auth/sign-in/email', {
      email: actor.email,
      password: actor.password,
    });
    const cookie = cookieHeader(signedIn.headers.getSetCookie());
    // The reset is in the `D12` re-authentication class, so the window has to be
    // open before the action — in every configuration, including the one where
    // no 2FA method is served at all.
    const reauth = await call(
      'POST',
      '/api/dash/auth/reauth',
      { password: actor.password },
      cookie
    );
    expect(reauth.status).toBe(HTTP_STATUS.OK);

    const reset = await call(
      'POST',
      `/api/dash/users/${target.userId}/two-factor/reset`,
      {},
      cookie
    );
    expect(reset.status).toBe(HTTP_STATUS.OK);
    const rows = await db
      .select({ id: twoFactorMethods.id })
      .from(twoFactorMethods)
      .where(eq(twoFactorMethods.userId, target.userId));
    expect(rows).toHaveLength(0);
  });

  test('both first-factor paths agree about one enrolled account', async () => {
    // ⚠️ The finding this whole file exists for. For ONE account holding stored
    // 2FA state, `/sign-in/email` and `/passwordless/verify` must answer the
    // same QUESTION. They used to disagree the moment the method list was
    // emptied: the password path minted a full session with no refusal recorded
    // while the passwordless path answered 403, because the issuer hook lived
    // inside a plugin that disappeared with the list.
    //
    // The two statuses are not required to be equal — a passwordless login by
    // email excludes an `otp/email` second factor and a password login does not,
    // which is the contact-kind rule doing its job. What is required is that
    // neither path issues a session WITHOUT a second factor while the feature is
    // on, and that both downgrade when it is off.
    const user = await seedEnrolled();

    const password = await call('POST', '/api/auth/sign-in/email', {
      email: user.email,
      password: user.password,
    });
    const passwordBody = (await password.json()) as {
      twoFactorRedirect?: boolean;
    };
    const passwordSession = cookieHeader(
      password.headers.getSetCookie()
    ).includes('session_token');

    await call('POST', '/api/auth/passwordless/send', {
      channel: 'email',
      email: user.email,
    });
    await plantCode(user.userId);
    const passwordless = await call('POST', '/api/auth/passwordless/verify', {
      channel: 'email',
      email: user.email,
      code: RIGHT_CODE,
    });
    const passwordlessBody = (await passwordless.json()) as {
      twoFactorRedirect?: boolean;
    };
    const passwordlessSession = cookieHeader(
      passwordless.headers.getSetCookie()
    ).includes('session_token');

    if (!TWO_FACTOR_ENABLED) {
      // Feature off: no method is configured, so there is no second factor to
      // enforce and the downgrade is the operator's intent — on EVERY path.
      expect([password.status, passwordless.status]).toEqual([
        HTTP_STATUS.OK,
        HTTP_STATUS.OK,
      ]);
      expect([passwordSession, passwordlessSession]).toEqual([true, true]);
      expect([
        passwordBody.twoFactorRedirect,
        passwordlessBody.twoFactorRedirect,
      ]).toEqual([undefined, undefined]);

      // ⚠️ And it is RECORDED. A downgrade nobody can see is how an operator
      // learns about it from a user. The issuer decides this, but it is only
      // ASKED because `twoFactorSignInGuard` is installed unconditionally —
      // it used to live inside a plugin that disappeared with the method list,
      // taking the audit row with it.
      // Scoped to the PASSWORD path. The passwordless endpoint calls the issuer
      // directly and always did, so an unscoped query passes with the guard
      // removed — which is the shape of test this repair pass exists to stop
      // writing.
      const downgrades = await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.userId, user.userId),
            eq(auditLogs.apiPath, '/sign-in/email'),
            sql`${auditLogs.newData} ->> 'reason' = 'two_factor_downgraded_feature_disabled'`
          )
        );
      expect(downgrades.length).toBeGreaterThan(0);
      return;
    }

    // Feature on: neither path may complete a login on the first factor alone.
    // Each is a challenge or a refusal, never a session.
    expect([passwordSession, passwordlessSession]).toEqual([false, false]);
    for (const [label, response, body] of [
      ['password', password, passwordBody],
      ['passwordless', passwordless, passwordlessBody],
    ] as const)
      expect([
        label,
        response.status === HTTP_STATUS.FORBIDDEN ||
          body.twoFactorRedirect === true,
      ]).toEqual([label, true]);
  });
});

/**
 * What would have been DELIVERED, per channel and per purpose, read back from
 * the outbox this tier runs with (`OTP_DELIVERY=outbox`). No provider account,
 * no stub of a provider's HTTP endpoint — the message the user would receive is
 * the thing asserted, and the `otp-whatsapp` row is the only place that channel
 * is exercised at all.
 */
describe(`delivery in the ${ROW} configuration`, () => {
  test('a code says which action it approves', async () => {
    // A login code, a recovery code and a contact-verification code used to be
    // byte-identical, which is what an attacker who triggers one and phishes
    // another relies on.
    clearOutbox();
    const user = await seedUser();
    await call('POST', '/api/auth/forgot-password/send', {
      channel: 'email',
      email: user.email,
    });
    await call('POST', '/api/auth/passwordless/send', {
      channel: 'email',
      email: user.email,
    });
    await settleDelivery();

    const [recovery] = readOutbox({
      destination: user.email,
      purpose: 'forgot_password',
    });
    const [login] = readOutbox({
      destination: user.email,
      purpose: 'passwordless_login',
    });
    expect(recovery).toBeDefined();
    expect(login).toBeDefined();
    if (!recovery || !login) return;

    expect(recovery.channel).toBe('email');
    expect(recovery.subject).toBe(otpSubjectFor('forgot_password'));
    expect(recovery.text).toBe(otpTextFor('forgot_password', recovery.code));
    expect(login.subject).toBe(otpSubjectFor('passwordless_login'));
    expect(login.text).toBe(otpTextFor('passwordless_login', login.code));
    expect(recovery.subject).not.toBe(login.subject);
  });

  test.if(TWO_FACTOR_OTP_CHANNELS.length > 0)(
    'a second-factor code reaches every enabled 2FA channel, labelled as one',
    async () => {
      for (const channel of TWO_FACTOR_OTP_CHANNELS) {
        clearOutbox();
        const user = await seedUser({
          phoneNumber: uniquePhone(),
          phoneNumberVerified: true,
        });
        await db
          .insert(twoFactorMethods)
          .values({ userId: user.userId, method: 'otp', channel });
        await db
          .update(users)
          .set({ twoFactorEnabled: true })
          .where(eq(users.id, user.userId));
        const [row] = await db
          .select({ email: users.email, phoneNumber: users.phoneNumber })
          .from(users)
          .where(eq(users.id, user.userId));
        const destination = channel === 'email' ? row?.email : row?.phoneNumber;
        expect(destination).toBeString();

        const challenged = await call('POST', '/api/auth/sign-in/email', {
          email: user.email,
          password: user.password,
        });
        expect(await challenged.json()).toMatchObject({
          twoFactorRedirect: true,
        });
        const sent = await call(
          'POST',
          '/api/auth/two-factor/otp/send',
          {},
          cookieHeader(challenged.headers.getSetCookie())
        );
        expect([channel, sent.status]).toEqual([channel, HTTP_STATUS.OK]);
        await settleDelivery();

        const delivered = readOutbox({
          channel,
          destination: destination ?? '',
          purpose: 'two_factor',
        });
        expect([channel, delivered.length]).toEqual([channel, 1]);
        const [message] = delivered;
        if (!message) continue;
        expect(message.text).toBe(otpTextFor('two_factor', message.code));
        expect(message.subject).toBe(
          channel === 'email' ? otpSubjectFor('two_factor') : null
        );
      }
    }
  );
});
