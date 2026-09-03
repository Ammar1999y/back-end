/**
 * The rules that decide when a second factor may be taken away, and by whom:
 * the last-method refusal, the backup-code acknowledgement gate, the recovery
 * refusal, and the `resetTwoFactor` grant.
 *
 * Each is asserted with its opposite, which is what proves it is a rule rather
 * than a blanket refusal.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SeededUser } from '../helpers/session';

import { and, eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import {
  twoFactorCredentials,
  twoFactorMethods,
  users,
  verificationCodes,
  verifications,
  verificationSessions,
} from '@/db/schema';
import { symmetricEncrypt } from 'better-auth/crypto';
import { auth } from '@/lib/auth';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { HTTP_STATUS } from '@/utils/api-messages';
import { hashOtpCode } from '@/utils/otp';

import { resetTables } from '../helpers/database';
import { scriptEgress } from '../helpers/egress';
import { baseHeaders, seedUser, uniquePhone } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const TURNSTILE_HOST = 'challenges.cloudflare.com';
const RIGHT_CODE = '515151';
const NEW_PASSWORD = 'Recovered-Pass-1!';
const BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? '';

/**
 * A working TOTP enrolment written directly, and the secret to drive it.
 *
 * The enrolment ENDPOINTS are covered in `two-factor-totp.test.ts`; what this
 * file needs is the resulting state, and going through five requests per fixture
 * would spend the shared admission budget on setup.
 */
async function enrolTotpBySql(userId: string): Promise<string> {
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  await db
    .insert(twoFactorCredentials)
    .values({
      userId,
      secret: await symmetricEncrypt({ key: BETTER_AUTH_SECRET, data: secret }),
      backupCodes: await symmetricEncrypt({
        key: BETTER_AUTH_SECRET,
        data: '[]',
      }),
      verified: true,
    })
    .onConflictDoNothing();
  await enrol(userId, 'totp');
  return secret;
}

function cookieHeader(setCookie: string[]): string {
  return setCookie
    .map((value) => value.split(';', 1)[0] ?? '')
    .filter((pair) => pair.length > 0 && !pair.endsWith('='))
    .join('; ');
}

function call(
  method: 'GET' | 'POST' | 'PUT',
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
 * Signs in and opens the administrator re-authentication window.
 *
 * Every actor in this file goes on to perform an action in the `D12` class — the
 * administrative edit, the reset — and those require a FRESH password proof, not
 * merely a session. The window is bound to the session, so nothing has to be
 * threaded through the request afterwards.
 */
async function signInCookie(user: SeededUser): Promise<string> {
  const response = await call('POST', '/api/auth/sign-in/email', {
    email: user.email,
    password: user.password,
  });
  const cookie = cookieHeader(response.headers.getSetCookie());
  const reauth = await call(
    'POST',
    '/api/dash/auth/reauth',
    { password: user.password },
    cookie
  );
  if (reauth.status !== HTTP_STATUS.OK)
    throw new Error(`re-authentication returned ${reauth.status}`);
  return cookie;
}

async function enrol(
  userId: string,
  method: 'totp' | 'otp' | 'passkey' | 'backup_code',
  channel: 'sms' | 'email' | null = null
) {
  await db
    .insert(twoFactorMethods)
    .values({ userId, method, channel })
    .onConflictDoNothing();
  await db
    .update(users)
    .set({ twoFactorEnabled: true })
    .where(eq(users.id, userId));
}

async function methodsOf(userId: string) {
  const rows = await db
    .select({ method: twoFactorMethods.method })
    .from(twoFactorMethods)
    .where(eq(twoFactorMethods.userId, userId));
  // Explicit comparator: these are ASCII method names, so a locale-aware
  // collation would be the surprise. Same rule the other suites follow.
  return rows
    .map((row) => row.method)
    .toSorted((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}

beforeAll(async () => {
  await resetTables();
  await resetSqliteStores();
  scriptEgress(TURNSTILE_HOST, () => Response.json({ success: true }));
  // The recovery second factor is delivered by SMS here.
  scriptEgress('apis.deewan.sa', () => Response.json({ success: true }));
});

describe('removing one method', () => {
  test('is allowed while another remains, and refused for the last', async () => {
    const user = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    // Signed in FIRST: once a second factor is enrolled, a sign-in answers with
    // a challenge rather than a session, and these endpoints need a session.
    // A real user reaches them by completing their second factor; the fixture
    // reaches the same state by holding a session from before enrolment.
    const cookie = await signInCookie(user);
    // A VERIFIED TOTP, not an intent row alone: the removal below is allowed
    // only because a factor a challenge would offer survives it.
    await enrolTotpBySql(user.userId);
    await enrol(user.userId, 'otp', 'sms');

    // A session is not enough: removing a factor is a security-state change,
    // and without the password a hijacked session strips factors with no proof.
    const unproven = await call(
      'POST',
      '/api/auth/two-factor/methods/disable',
      { method: 'otp' },
      cookie
    );
    expect(unproven.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await methodsOf(user.userId)).toEqual(['otp', 'totp']);

    const removed = await call(
      'POST',
      '/api/auth/two-factor/methods/disable',
      { method: 'otp', password: user.password },
      cookie
    );
    expect(removed.status).toBe(HTTP_STATUS.OK);
    expect(await methodsOf(user.userId)).toEqual(['totp']);

    // The last one. Refused with 409, not silently accepted and not silently
    // turning 2FA off — either would leave the user believing something that is
    // no longer true.
    const last = await call(
      'POST',
      '/api/auth/two-factor/methods/disable',
      { method: 'totp', password: user.password },
      cookie
    );
    expect(last.status).toBe(HTTP_STATUS.CONFLICT);
    expect(await methodsOf(user.userId)).toEqual(['totp']);
  });

  test('is refused when the surviving row is not a factor a challenge would offer', async () => {
    // ⚠️ Counting intent rows let a user strand themselves through the
    // supported path: an `otp:email` row whose contact is no longer verified is
    // still a row, so removing the working TOTP passed the "not the last" check
    // and left the account 2FA-on with an empty offered set — the state the
    // administrative reset exists to exit, reached by doing the ordinary thing.
    const user = await seedUser();
    const cookie = await signInCookie(user);
    await enrolTotpBySql(user.userId);
    await enrol(user.userId, 'otp', 'email');
    await db
      .update(users)
      .set({ emailVerified: false })
      .where(eq(users.id, user.userId));

    const stranding = await call(
      'POST',
      '/api/auth/two-factor/methods/disable',
      { method: 'totp', password: user.password },
      cookie
    );
    expect(stranding.status).toBe(HTTP_STATUS.CONFLICT);
    expect(await methodsOf(user.userId)).toEqual(['otp', 'totp']);

    // Removing the row that is NOT a factor is cleanup, and is allowed.
    const cleanup = await call(
      'POST',
      '/api/auth/two-factor/methods/disable',
      { method: 'otp', contactKind: 'email', password: user.password },
      cookie
    );
    expect(cleanup.status).toBe(HTTP_STATUS.OK);
    expect(await methodsOf(user.userId)).toEqual(['totp']);
  });
});

describe('backup codes', () => {
  test('are not a usable method until the user acknowledges them', async () => {
    const user = await seedUser();
    const cookie = await signInCookie(user);

    const enabled = await call(
      'POST',
      '/api/auth/two-factor/generate-backup-codes',
      { password: user.password },
      cookie
    );
    expect(enabled.status).toBe(HTTP_STATUS.OK);

    // The set exists in the database...
    const [credential] = await db
      .select({
        backupCodes: twoFactorCredentials.backupCodes,
        acknowledgedAt: twoFactorCredentials.backupCodesAcknowledgedAt,
      })
      .from(twoFactorCredentials)
      .where(eq(twoFactorCredentials.userId, user.userId));
    expect(credential?.backupCodes).toBeTruthy();
    // ...and is deliberately not yet an enrolled method.
    expect(credential?.acknowledgedAt).toBeNull();
    expect(await methodsOf(user.userId)).toEqual([]);

    // Acknowledging flips the flag and evicts every other session, so a
    // session alone is not enough for it — a hijacked one could otherwise turn
    // the feature on and sign the owner out of every device in one call.
    const unproven = await call(
      'POST',
      '/api/auth/two-factor/backup-codes/acknowledge',
      {},
      cookie
    );
    expect(unproven.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await methodsOf(user.userId)).toEqual([]);

    const acknowledged = await call(
      'POST',
      '/api/auth/two-factor/backup-codes/acknowledge',
      { password: user.password },
      cookie
    );
    expect(acknowledged.status).toBe(HTTP_STATUS.OK);
    expect(await methodsOf(user.userId)).toEqual(['backup_code']);
  });
});

describe('password recovery against a second factor', () => {
  /** Drives recovery to the point of the reset, with a code this file knows. */
  async function attemptReset(user: SeededUser): Promise<Response> {
    await call('POST', '/api/auth/forgot-password/send', {
      channel: 'email',
      email: user.email,
    });
    const [proof] = await db
      .select({ id: verificationSessions.id })
      .from(verificationSessions)
      .where(
        and(
          eq(verificationSessions.userId, user.userId),
          eq(verificationSessions.purpose, 'forgot_password')
        )
      );
    if (!proof) throw new Error('no recovery proof row');
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

    return call('POST', '/api/auth/forgot-password/reset', {
      channel: 'email',
      email: user.email,
      code: RIGHT_CODE,
      newPassword: NEW_PASSWORD,
    });
  }

  test('is refused when every factor is an OTP to the recovery contact', async () => {
    const user = await seedUser();
    // The collapse: recovery reaches the mailbox, and so does the only second
    // factor. Whoever holds that mailbox holds both — and requiring the second
    // factor here would not help, because they can prove it too.
    await enrol(user.userId, 'otp', 'email');

    const response = await attemptReset(user);
    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

    // The password is UNCHANGED, which is the property: the refusal is what
    // keeps the account two-factor.
    const stillOld = await call('POST', '/api/auth/sign-in/email', {
      email: user.email,
      password: user.password,
    });
    expect(stillOld.status).toBe(HTTP_STATUS.OK);
  });

  test('does not write the password on the recovery code alone', async () => {
    // ⚠️ The finding. Recovery by email, second factor by SMS: the possessions
    // are disjoint, so the reset is not REFUSED — but it also may not proceed on
    // the mailbox alone. It answers a grant, and the password is untouched until
    // the surviving factor is proven against it.
    const user = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    await enrol(user.userId, 'otp', 'sms');

    const response = await attemptReset(user);
    expect(response.status).toBe(HTTP_STATUS.OK);
    const body = (await response.json()) as {
      data?: {
        reset?: boolean;
        twoFactorRequired?: boolean;
        grant?: string;
        options?: { id: string }[];
      };
    };
    expect(body.data?.reset).toBe(false);
    expect(body.data?.twoFactorRequired).toBe(true);
    expect(body.data?.grant).toBeString();
    expect(body.data?.options?.map((option) => option.id)).toEqual([
      'otp:phone',
    ]);

    // The old password still works, which is the property: a mailbox alone did
    // not rewrite it.
    const stillOld = await call('POST', '/api/auth/sign-in/email', {
      email: user.email,
      password: user.password,
    });
    expect(stillOld.status).toBe(HTTP_STATUS.OK);
  });

  test('completes only against a proven second factor', async () => {
    const user = await seedUser();
    const secret = await enrolTotpBySql(user.userId);

    const started = await attemptReset(user);
    const grant = ((await started.json()) as { data?: { grant?: string } }).data
      ?.grant;
    expect(grant).toBeDefined();

    // The grant is NOT sufficient alone: a wrong code leaves the password where
    // it was, and the grant survives for the user's next try rather than the
    // attacker's.
    const wrong = await call('POST', '/api/auth/forgot-password/complete', {
      grant,
      option: 'totp',
      code: '000000',
      newPassword: NEW_PASSWORD,
    });
    expect(wrong.status).not.toBe(HTTP_STATUS.OK);
    const beforeChange = await call('POST', '/api/auth/sign-in/email', {
      email: user.email,
      password: NEW_PASSWORD,
    });
    expect(beforeChange.status).not.toBe(HTTP_STATUS.OK);

    const { code } = await auth.api.generateTOTP({ body: { secret } });
    const completed = await call('POST', '/api/auth/forgot-password/complete', {
      grant,
      option: 'totp',
      code,
      newPassword: NEW_PASSWORD,
    });
    expect(completed.status).toBe(HTTP_STATUS.OK);

    // And the grant is single-use, so a replay cannot rewrite it again.
    const replayCode = await auth.api.generateTOTP({ body: { secret } });
    const replayed = await call('POST', '/api/auth/forgot-password/complete', {
      grant,
      option: 'totp',
      code: replayCode.code,
      newPassword: 'Another-Pass-1!',
    });
    expect(replayed.status).not.toBe(HTTP_STATUS.OK);

    const withNew = await call('POST', '/api/auth/sign-in/email', {
      email: user.email,
      password: NEW_PASSWORD,
    });
    // A challenge, not a session: the reset changed the password and left the
    // second factor exactly where it was.
    expect(await withNew.json()).toMatchObject({ twoFactorRedirect: true });
    // Five recovery requests, each floored at `MINIMUM_RESPONSE_MS` so the
    // anonymous paths cannot be timed. The default 5 s budget is the harness's,
    // not a statement about this flow.
  }, 30_000);

  test('charges the grant budget for guesses only', async () => {
    // The grant's five attempts are the same budget the sign-in challenge has,
    // under the same rule: a code that was COMPARED and lost is a guess; a
    // request that never reached a comparison — here, a completion before any
    // second-factor code was sent, so no proof row exists — is refunded. The
    // completion handler charged every throw.
    const user = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    await enrol(user.userId, 'otp', 'sms');

    const started = await attemptReset(user);
    const grant = ((await started.json()) as { data?: { grant?: string } }).data
      ?.grant;
    expect(grant).toBeDefined();
    const attemptsOf = async () => {
      const [row] = await db
        .select({ value: verifications.value })
        .from(verifications)
        .where(eq(verifications.identifier, `recovery-attempts-${grant}`));
      return row?.value;
    };
    expect(await attemptsOf()).toBe('0');

    const early = await call('POST', '/api/auth/forgot-password/complete', {
      grant,
      option: 'otp:phone',
      code: RIGHT_CODE,
      newPassword: NEW_PASSWORD,
    });
    expect(early.status).not.toBe(HTTP_STATUS.OK);
    expect(await attemptsOf()).toBe('0');

    // With a code in flight, a wrong one IS a guess.
    const sent = await call(
      'POST',
      '/api/auth/forgot-password/second-factor/send',
      { grant, option: 'otp:phone' }
    );
    expect(sent.status).toBe(HTTP_STATUS.OK);
    const wrong = await call('POST', '/api/auth/forgot-password/complete', {
      grant,
      option: 'otp:phone',
      code: '000000',
      newPassword: NEW_PASSWORD,
    });
    expect(wrong.status).not.toBe(HTTP_STATUS.OK);
    expect(await attemptsOf()).toBe('1');
  }, 30_000);

  test('refunds a TOTP check that never reached a comparison', async () => {
    // The checks that answer by RETURNING rather than throwing carry the same
    // distinction as a verdict: a secret that cannot be decrypted — a rotated
    // key — compared nothing, and five of those must not burn the grant.
    const user = await seedUser();
    await enrolTotpBySql(user.userId);

    const started = await attemptReset(user);
    const grant = ((await started.json()) as { data?: { grant?: string } }).data
      ?.grant;
    expect(grant).toBeDefined();
    await db
      .update(twoFactorCredentials)
      .set({ secret: 'not-a-ciphertext' })
      .where(eq(twoFactorCredentials.userId, user.userId));

    const unavailable = await call(
      'POST',
      '/api/auth/forgot-password/complete',
      { grant, option: 'totp', code: '000000', newPassword: NEW_PASSWORD }
    );
    expect(unavailable.status).not.toBe(HTTP_STATUS.OK);
    const [row] = await db
      .select({ value: verifications.value })
      .from(verifications)
      .where(eq(verifications.identifier, `recovery-attempts-${grant}`));
    expect(row?.value).toBe('0');
  }, 30_000);
});

describe('an administrative contact change against a second factor', () => {
  // A separate actor: the target has 2FA on, so its own sign-in returns a
  // challenge rather than a session.
  async function editPhone(
    actor: SeededUser,
    target: SeededUser,
    phoneNumber: string
  ) {
    return call(
      'PUT',
      `/api/dash/users/${target.userId}`,
      {
        name: 'Renamed By Harness',
        email: target.email,
        roleId: target.roleId,
        isActive: true,
        phoneNumber,
      },
      await signInCookie(actor)
    );
  }

  test('is refused when it would take the target’s last usable factor', async () => {
    const admin = await seedUser();
    const phone = uniquePhone();
    const target = await seedUser({
      phoneNumber: phone,
      phoneNumberVerified: true,
    });
    await enrol(target.userId, 'otp', 'sms');

    // Repointing the phone clears `phone_number_verified`, which takes the OTP
    // method out of the offered set. That used to leave the account with 2FA on
    // and nothing to prove it with — a downgrade before step 0, a lockout
    // after.
    const refused = await editPhone(admin, target, uniquePhone());
    expect(refused.status).toBe(HTTP_STATUS.CONFLICT);

    // And nothing was written.
    const [row] = await db
      .select({ phoneNumber: users.phoneNumber })
      .from(users)
      .where(eq(users.id, target.userId));
    expect(row?.phoneNumber).toBe(phone);
    expect(await methodsOf(target.userId)).toEqual(['otp']);
  });

  test('is allowed when another factor survives it', async () => {
    const admin = await seedUser();
    const target = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    await enrol(target.userId, 'otp', 'sms');
    await enrol(target.userId, 'totp');
    await db
      .insert(twoFactorCredentials)
      .values({
        userId: target.userId,
        secret: 'harness-secret',
        backupCodes: 'harness-codes',
        verified: true,
      })
      .onConflictDoNothing();

    // TOTP is bound to no contact, so the change costs the account nothing it
    // cannot still prove.
    const allowed = await editPhone(admin, target, uniquePhone());
    expect(allowed.status).toBe(HTTP_STATUS.OK);
  });

  test('asks ONE question when a request changes both contacts', async () => {
    // ⚠️ The predicate used to be asked per changed kind against UNMODIFIED
    // state, so a request changing both passed both checks — email survived
    // because phone still counted, phone survived because email still counted —
    // and stranded the target anyway. Exact only while a user could hold one OTP
    // enrolment; with two it is the whole finding.
    const admin = await seedUser();
    const phone = uniquePhone();
    const target = await seedUser({
      phoneNumber: phone,
      phoneNumberVerified: true,
    });
    await enrol(target.userId, 'otp', 'sms');
    await enrol(target.userId, 'otp', 'email');

    const refused = await call(
      'PUT',
      `/api/dash/users/${target.userId}`,
      {
        name: 'Renamed By Harness',
        email: `moved.${target.email}`,
        roleId: target.roleId,
        isActive: true,
        phoneNumber: uniquePhone(),
      },
      await signInCookie(admin)
    );
    expect(refused.status).toBe(HTTP_STATUS.CONFLICT);

    const [row] = await db
      .select({ email: users.email, phoneNumber: users.phoneNumber })
      .from(users)
      .where(eq(users.id, target.userId));
    expect(row?.email).toBe(target.email);
    expect(row?.phoneNumber).toBe(phone);
  });

  test('detaches the OTP enrolment from a contact it moved', async () => {
    // Rule 3: the factor must not FOLLOW the address. The admin edit clears the
    // verified flag, but a later re-verification of the new address would re-arm
    // an enrolment pointed at a destination the user never chose.
    const admin = await seedUser();
    const target = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    await enrol(target.userId, 'otp', 'sms');
    await enrol(target.userId, 'totp');
    await db
      .insert(twoFactorCredentials)
      .values({
        userId: target.userId,
        secret: 'harness-secret',
        backupCodes: 'harness-codes',
        verified: true,
      })
      .onConflictDoNothing();

    const allowed = await editPhone(admin, target, uniquePhone());
    expect(allowed.status).toBe(HTTP_STATUS.OK);

    // The phone enrolment is gone and TOTP survives — and, rule 1, the flag is
    // untouched: `users.edit` is not a 2FA disarm.
    expect(await methodsOf(target.userId)).toEqual(['totp']);
    const [row] = await db
      .select({ twoFactorEnabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, target.userId));
    expect(row?.twoFactorEnabled).toBe(true);
  });
});

describe('the administrative reset', () => {
  test('clears everything, and only for a holder of the grant', async () => {
    const target = await seedUser();
    await enrol(target.userId, 'totp');

    // An admin with every permission EXCEPT the new one.
    const withoutGrant = await seedUser({
      permissions: {
        users: { view: true, edit: true, create: true, delete: true },
      },
    });
    const refused = await call(
      'POST',
      `/api/dash/users/${target.userId}/two-factor/reset`,
      {},
      await signInCookie(withoutGrant)
    );
    // `users.edit` is not enough. This is the whole reason it is its own
    // action: an admin who may correct a name may not disarm 2FA.
    expect(refused.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(await methodsOf(target.userId)).toEqual(['totp']);

    const withGrant = await seedUser();
    const allowed = await call(
      'POST',
      `/api/dash/users/${target.userId}/two-factor/reset`,
      {},
      await signInCookie(withGrant)
    );
    expect(allowed.status).toBe(HTTP_STATUS.OK);

    expect(await methodsOf(target.userId)).toEqual([]);
    const [row] = await db
      .select({ twoFactorEnabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, target.userId));
    expect(row?.twoFactorEnabled).toBe(false);
  });

  test('is refused without a FRESH password proof, self-target included', async () => {
    // ⚠️ `D12`. A permission grant says the actor MAY disarm someone's second
    // factor; it does not say the person at the keyboard is still that actor.
    // This endpoint ran `requirePermission`, a rate limit, the visibility gate
    // and the role-scope gate, and called `verifyLoginAttempt` nowhere — while
    // `users/me/change-password` re-authenticated for something strictly less
    // dangerous.
    //
    // The SELF case is the sharp one: `assertTargetUserVisible` exempts self
    // from both its narrowings, so the cheapest self-disarm in the system was to
    // POST your own id from a hijacked session.
    const actor = await seedUser();

    // Signed in FIRST — an enrolled account answers a challenge rather than a
    // session — and NOT re-authenticated: `signInCookie` would open the window.
    const signedIn = await call('POST', '/api/auth/sign-in/email', {
      email: actor.email,
      password: actor.password,
    });
    const cookie = cookieHeader(signedIn.headers.getSetCookie());
    await enrol(actor.userId, 'totp');

    const unproven = await call(
      'POST',
      `/api/dash/users/${actor.userId}/two-factor/reset`,
      {},
      cookie
    );
    expect(unproven.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await methodsOf(actor.userId)).toEqual(['totp']);

    // The same request, after the password is proven on this session.
    const reauth = await call(
      'POST',
      '/api/dash/auth/reauth',
      { password: actor.password },
      cookie
    );
    expect(reauth.status).toBe(HTTP_STATUS.OK);

    const proven = await call(
      'POST',
      `/api/dash/users/${actor.userId}/two-factor/reset`,
      {},
      cookie
    );
    expect(proven.status).toBe(HTTP_STATUS.OK);
    expect(await methodsOf(actor.userId)).toEqual([]);
  });

  test('is refused against a target whose role outranks the actor', async () => {
    // `resetTwoFactor` has no `Own` variant, so `resolveActionScope` answers
    // `scope: 'all'` and `assertTargetUserVisible`'s `createdBy` narrowing never
    // fires. Without the role-scope check every sibling under `/users/:id`
    // applies, an actor refused a `PUT` on this id could still strip its second
    // factor — the weaker gate on the more dangerous action.
    const target = await seedUser();
    await enrol(target.userId, 'totp');

    // ⚠️ `edit` is granted DELIBERATELY. Without it the `PUT` below is refused
    // for lacking `users.edit` at all and never reaches the role-scope gate, so
    // the assertion passed whatever that gate did — the agreement this test
    // exists to prove was untested.
    const narrowActor = await seedUser({
      permissions: { users: { view: true, edit: true, resetTwoFactor: true } },
    });

    const refused = await call(
      'POST',
      `/api/dash/users/${target.userId}/two-factor/reset`,
      {},
      await signInCookie(narrowActor)
    );
    // Collapsed to the answer every other reachability gate gives, so the caller
    // cannot tell "outranks me" from "does not exist".
    expect(refused.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(await methodsOf(target.userId)).toEqual(['totp']);

    // The same actor, holding `users.edit`, is refused the parent `PUT` on the
    // same id by the SAME gate, with the SAME status. That agreement is the
    // finding: measured, both answer 404 rather than one leaking a 403.
    const edit = await call(
      'PUT',
      `/api/dash/users/${target.userId}`,
      {
        name: 'Renamed By Harness',
        email: target.email,
        roleId: target.roleId,
        isActive: true,
      },
      await signInCookie(narrowActor)
    );
    expect(edit.status).toBe(HTTP_STATUS.NOT_FOUND);
  });
});
