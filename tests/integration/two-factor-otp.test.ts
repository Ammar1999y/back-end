/**
 * The OTP second factor on this project's own OTP system, and the passwordless
 * sign-in that must not skip it.
 *
 * Two properties: a 2FA OTP runs under the `two_factor` purpose, so it gets its
 * own proof row, budgets and block window; and passwordless sign-in issues the
 * same challenge, which the plugin's own hook never would.
 *
 * Codes are written into the row directly with a known value, as the OTP budget
 * tests do: the send path is deferred, the provider stubbed, and the stored code
 * hashed.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SeededUser } from '../helpers/session';

import { and, eq, like, sql } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import {
  auditLogs,
  sessions,
  twoFactorMethods,
  users,
  verificationCodes,
  verifications,
  verificationSessions,
} from '@/db/schema';
import { TWO_FACTOR_ALLOWED_ATTEMPTS } from '@/lib/auth/two-factor-challenge';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { HTTP_STATUS } from '@/utils/api-messages';
import { hashOtpCode } from '@/utils/otp';

import { resetTables } from '../helpers/database';
import { scriptEgress } from '../helpers/egress';
import { baseHeaders, seedUser, uniquePhone } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const TURNSTILE_HOST = 'challenges.cloudflare.com';
const RIGHT_CODE = '424242';

const fixture: { user: SeededUser | null; phone: string } = {
  user: null,
  phone: '',
};

function actor(): SeededUser {
  if (!fixture.user) throw new Error('fixture not seeded');
  return fixture.user;
}

function cookieHeader(setCookie: string[]): string {
  return setCookie
    .map((value) => value.split(';', 1)[0] ?? '')
    .filter((pair) => pair.length > 0 && !pair.endsWith('='))
    .join('; ');
}

function post(url: string, body: unknown, cookie?: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${url}`, {
      method: 'POST',
      headers: baseHeaders({
        'content-type': 'application/json',
        origin: PUBLIC_ORIGIN,
        ...(cookie && { cookie }),
      }),
      body: JSON.stringify(body),
    })
  );
}

/**
 * Replaces whatever the send path stored with a code this file knows.
 *
 * The proof ROW has to already exist — it carries the purpose binding and the
 * attempt counters this test is about — so the send is performed for real and
 * only the code is overwritten.
 */
async function plantCode(
  userId: string,
  purpose: 'two_factor' | 'passwordless_login',
  contactKind: 'email' | 'phone'
): Promise<void> {
  const [proof] = await db
    .select({ id: verificationSessions.id })
    .from(verificationSessions)
    .where(
      and(
        eq(verificationSessions.userId, userId),
        eq(verificationSessions.purpose, purpose),
        eq(verificationSessions.contactKind, contactKind)
      )
    );
  if (!proof) throw new Error(`no ${purpose}/${contactKind} proof row`);

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

async function signIn(user: SeededUser): Promise<{
  status: number;
  body: unknown;
  cookie: string;
}> {
  const response = await post('/api/auth/sign-in/email', {
    email: user.email,
    password: user.password,
  });
  return {
    status: response.status,
    body: await response.json(),
    cookie: cookieHeader(response.headers.getSetCookie()),
  };
}

async function sessionCount(userId: string): Promise<number> {
  const rows = await db.query.sessions.findMany({
    where: (session, { eq: is }) => is(session.userId, userId),
  });
  return rows.length;
}

async function enrolledMethods(userId: string) {
  return db
    .select({
      method: twoFactorMethods.method,
      channel: twoFactorMethods.channel,
    })
    .from(twoFactorMethods)
    .where(eq(twoFactorMethods.userId, userId));
}

beforeAll(async () => {
  await resetTables();
  await resetSqliteStores();
  scriptEgress(TURNSTILE_HOST, () => Response.json({ success: true }));
  // The SMS provider. 2FA codes go to the phone in this configuration, so the
  // send path would otherwise reach a real host.
  scriptEgress('apis.deewan.sa', () => Response.json({ success: true }));

  fixture.phone = uniquePhone();
  fixture.user = await seedUser({
    phoneNumber: fixture.phone,
    phoneNumberVerified: true,
  });
});

describe('enrolling the OTP second factor', () => {
  test('a code proven on the chosen channel is what turns the method on', async () => {
    const session = await signIn(actor());
    expect(session.status).toBe(HTTP_STATUS.OK);
    // A second device, signed in before the enrolment: adding a method evicts
    // it and keeps the caller's own session.
    const otherDevice = await signIn(actor());
    expect(otherDevice.status).toBe(HTTP_STATUS.OK);
    expect(await sessionCount(actor().userId)).toBe(2);

    // ⚠️ The password is required on the ENROLMENT branch and on that branch
    // only: adding a second factor is a security-state change, and a session
    // alone used to be enough for it. The sign-in branch below sends none — the
    // caller holds a challenge cookie, which follows a verified password.
    const sent = await post(
      '/api/auth/two-factor/otp/send',
      { channel: 'sms', password: actor().password },
      session.cookie
    );
    expect(sent.status).toBe(HTTP_STATUS.OK);

    // Sending alone must NOT enrol: a user who abandons setup here has not
    // chosen a second factor and must not be challenged for one at next login.
    expect(await enrolledMethods(actor().userId)).toEqual([]);
    const [beforeUser] = await db
      .select({ twoFactorEnabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, actor().userId));
    expect(beforeUser?.twoFactorEnabled).toBe(false);

    await plantCode(actor().userId, 'two_factor', 'phone');

    const confirmed = await post(
      '/api/auth/two-factor/otp/verify',
      { channel: 'sms', code: RIGHT_CODE },
      session.cookie
    );
    expect(confirmed.status).toBe(HTTP_STATUS.OK);

    // The channel is recorded, not just the method: it is what the contact-kind
    // comparison reads when a passwordless login has to decide what to ask for.
    expect(await enrolledMethods(actor().userId)).toEqual([
      { method: 'otp', channel: 'sms' },
    ]);
    const [afterUser] = await db
      .select({ twoFactorEnabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, actor().userId));
    expect(afterUser?.twoFactorEnabled).toBe(true);
    // The other device is gone; the enrolling session survives and still works.
    expect(await sessionCount(actor().userId)).toBe(1);
    const stillSignedIn = await app.handle(
      new Request('http://localhost/api/auth/two-factor/methods', {
        headers: baseHeaders({ origin: PUBLIC_ORIGIN, cookie: session.cookie }),
      })
    );
    expect(stillSignedIn.status).toBe(HTTP_STATUS.OK);

    // Attributable, inside the transaction that enrolled: "who added this
    // factor, and when" has to be answerable for every method, not only the ones
    // the lifecycle module serves itself.
    const added = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.userId, actor().userId),
          sql`${auditLogs.newData} ->> 'twoFactorMethodAdded' = 'otp:phone'`
        )
      );
    expect(added).toHaveLength(1);
  });
});

describe('signing in with the OTP second factor', () => {
  test('the password alone is refused, and the code completes it', async () => {
    const attempt = await signIn(actor());
    expect(attempt.body).toMatchObject({
      twoFactorRedirect: true,
      twoFactorMethods: ['otp'],
    });
    const before = await sessionCount(actor().userId);

    const sent = await post(
      '/api/auth/two-factor/otp/send',
      {},
      attempt.cookie
    );
    expect(sent.status).toBe(HTTP_STATUS.OK);

    await plantCode(actor().userId, 'two_factor', 'phone');

    const verified = await post(
      '/api/auth/two-factor/otp/verify',
      { code: RIGHT_CODE },
      attempt.cookie
    );

    expect(verified.status).toBe(HTTP_STATUS.OK);
    expect(await sessionCount(actor().userId)).toBe(before + 1);
  });

  test('a wrong code issues no session', async () => {
    const attempt = await signIn(actor());
    const before = await sessionCount(actor().userId);

    await post('/api/auth/two-factor/otp/send', {}, attempt.cookie);
    await plantCode(actor().userId, 'two_factor', 'phone');

    const verified = await post(
      '/api/auth/two-factor/otp/verify',
      { code: '000000' },
      attempt.cookie
    );

    expect(verified.status).not.toBe(HTTP_STATUS.OK);
    expect(await sessionCount(actor().userId)).toBe(before);
  });

  test('a request that never reached a code does not spend the challenge budget', async () => {
    // The budget is five GUESSES. `processOtpVerify` also throws when no proof
    // row exists — a user who submits before pressing send — and charging that
    // exhausted the challenge without a single code ever being compared. Five
    // of them, then a correct code, which must still be accepted.
    const user = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    await db
      .insert(twoFactorMethods)
      .values({ userId: user.userId, method: 'otp', channel: 'sms' });
    await db
      .update(users)
      .set({ twoFactorEnabled: true })
      .where(eq(users.id, user.userId));

    const attempt = await signIn(user);
    expect(attempt.body).toMatchObject({ twoFactorMethods: ['otp'] });

    for (let i = 0; i < TWO_FACTOR_ALLOWED_ATTEMPTS; i++) {
      const early = await post(
        '/api/auth/two-factor/otp/verify',
        { code: '000000' },
        attempt.cookie
      );
      expect(early.status).not.toBe(HTTP_STATUS.OK);
    }

    const sent = await post(
      '/api/auth/two-factor/otp/send',
      {},
      attempt.cookie
    );
    expect(sent.status).toBe(HTTP_STATUS.OK);
    await plantCode(user.userId, 'two_factor', 'phone');

    const verified = await post(
      '/api/auth/two-factor/otp/verify',
      { code: RIGHT_CODE },
      attempt.cookie
    );
    expect(verified.status).toBe(HTTP_STATUS.OK);
  });

  test('the challenge tells the client how long the OTP send is throttled for', async () => {
    // `D9`: a client auto-routing to an `otp` default needs to know whether to
    // send or to wait, without a round trip that answers 429. The hint is the
    // proof row's `next_allowed_at`, and only OTP options carry one. A fresh
    // user, so the first send is inside the destination budget and the hint it
    // leaves behind is the 30 s backoff of a first send, not this file's history.
    const user = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    await db
      .insert(twoFactorMethods)
      .values({ userId: user.userId, method: 'otp', channel: 'sms' });
    await db
      .update(users)
      .set({ twoFactorEnabled: true })
      .where(eq(users.id, user.userId));

    type Hinted = {
      twoFactorOptions?: { id: string; nextAllowedIn?: number }[];
    };
    const first = await signIn(user);
    const untouched = (first.body as Hinted).twoFactorOptions?.find(
      (option) => option.id === 'otp:phone'
    );
    expect(untouched?.nextAllowedIn).toBe(0);

    const sent = await post('/api/auth/two-factor/otp/send', {}, first.cookie);
    expect(sent.status).toBe(HTTP_STATUS.OK);

    const second = await signIn(user);
    const throttled = (second.body as Hinted).twoFactorOptions?.find(
      (option) => option.id === 'otp:phone'
    );
    expect(throttled?.nextAllowedIn).toBeGreaterThan(0);
  });

  test('the second factor cannot be reached without a challenge', async () => {
    // Jumping straight to the second factor is the attack the whole design
    // exists to refuse. With no challenge cookie and no session there is
    // nothing to enrol and nothing to complete.
    const verified = await post('/api/auth/two-factor/otp/verify', {
      code: RIGHT_CODE,
    });
    expect(verified.status).not.toBe(HTTP_STATUS.OK);
  });
});

describe('passwordless sign-in for a user with a second factor', () => {
  test('issues a challenge instead of a session', async () => {
    const before = await sessionCount(actor().userId);

    const sent = await post('/api/auth/passwordless/send', {
      channel: 'email',
      email: actor().email,
    });
    expect(sent.status).toBe(HTTP_STATUS.OK);
    await plantCode(actor().userId, 'passwordless_login', 'email');

    const verified = await post('/api/auth/passwordless/verify', {
      channel: 'email',
      email: actor().email,
      code: RIGHT_CODE,
    });

    // The bypass, closed. Before the fix this answered 200 with a session
    // cookie and `{ loggedIn: true }`.
    expect(verified.status).toBe(HTTP_STATUS.OK);
    expect(await verified.json()).toMatchObject({
      twoFactorRedirect: true,
      // The user's OTP factor is on the PHONE and the login proved the EMAIL,
      // so it is a different possession and is still required. A comparison on
      // the method name rather than the contact kind would have dropped it and
      // signed the user straight in.
      twoFactorMethods: ['otp'],
    });
    expect(await sessionCount(actor().userId)).toBe(before);
    expect(cookieHeader(verified.headers.getSetCookie())).not.toContain(
      'session_token'
    );
  });

  test('a passwordless login with no second factor honours "do not remember"', async () => {
    // `D10` names every first-factor path. This one read the field only to carry
    // it into a challenge; a user with no second factor got the 28-day row
    // whatever they asked for.
    const plain = await seedUser();
    const sent = await post('/api/auth/passwordless/send', {
      channel: 'email',
      email: plain.email,
    });
    expect(sent.status).toBe(HTTP_STATUS.OK);
    await plantCode(plain.userId, 'passwordless_login', 'email');

    const verified = await post('/api/auth/passwordless/verify', {
      channel: 'email',
      email: plain.email,
      code: RIGHT_CODE,
      rememberMe: false,
    });
    expect(verified.status).toBe(HTTP_STATUS.OK);
    expect(cookieHeader(verified.headers.getSetCookie())).toContain(
      'dont_remember'
    );

    const [row] = await db
      .select({ createdAt: sessions.createdAt, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.userId, plain.userId));
    expect(row).toBeDefined();
    const lifetimeDays =
      ((row?.expiresAt.getTime() ?? 0) - (row?.createdAt.getTime() ?? 0)) /
      86_400_000;
    expect(lifetimeDays).toBeLessThan(2);
  });
});

describe('the enrol-versus-sign-in discriminator', () => {
  test('a stale challenge cookie does not hijack an authenticated send', async () => {
    // `send` used to branch on the raw signed cookie while `verify` branched on a
    // RESOLVED challenge, so for the ten minutes after an abandoned prompt a
    // caller holding a valid session was pushed down the sign-in path — which
    // resolved nothing and answered 401 — while `verify` on the same request
    // correctly took the enrolment branch.
    const abandoning = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    await db
      .insert(twoFactorMethods)
      .values({ userId: abandoning.userId, method: 'otp', channel: 'sms' });
    await db
      .update(users)
      .set({ twoFactorEnabled: true })
      .where(eq(users.id, abandoning.userId));

    const challenged = await signIn(abandoning);
    expect(challenged.body).toMatchObject({ twoFactorRedirect: true });

    // Abandon it: the row goes, the signed cookie stays in the jar exactly as it
    // would in a real browser.
    await db
      .delete(verifications)
      .where(like(verifications.identifier, '2fa-%'));

    // A different user with a verified phone and no 2FA signs in on the same jar,
    // so the request carries a live session AND the stale challenge cookie.
    const enrolling = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    const session = await signIn(enrolling);
    expect(session.status).toBe(HTTP_STATUS.OK);
    expect(session.body).not.toMatchObject({ twoFactorRedirect: true });

    const jar = [challenged.cookie, session.cookie].filter(Boolean).join('; ');
    const sent = await post(
      '/api/auth/two-factor/otp/send',
      { channel: 'sms', password: enrolling.password },
      jar
    );
    expect(sent.status).toBe(HTTP_STATUS.OK);
  });
});
