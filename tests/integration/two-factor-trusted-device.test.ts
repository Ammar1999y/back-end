/**
 * Trusted devices — the only mechanism that skips the second factor.
 *
 * The pair that matters: a trusted device skips the challenge, and revoking it
 * brings the challenge back. Without the second half, "the challenge was
 * skipped" is indistinguishable from "2FA silently stopped working".
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SeededUser } from '../helpers/session';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { trustedDevices, twoFactorCredentials } from '@/db/schema';
import { symmetricDecrypt } from 'better-auth/crypto';
import { auth } from '@/lib/auth';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { HTTP_STATUS } from '@/utils/api-messages';

import { resetTables } from '../helpers/database';
import { scriptEgress } from '../helpers/egress';
import { baseHeaders, mergeCookies, seedUser } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const TURNSTILE_HOST = 'challenges.cloudflare.com';
const BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? '';
const USER_AGENT = 'Mozilla/5.0 (harness) TrustedDeviceTest/1.0';

const fixture: {
  user: SeededUser | null;
  secret: string;
  trusted: string;
  backupCodes: string[];
} = {
  user: null,
  secret: '',
  trusted: '',
  backupCodes: [],
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

/**
 * A fresh source address per enrolment.
 *
 * The admission limiter is per IP, and a full enrolment is five requests. With
 * one address for the whole file, adding a test made an unrelated one 429 —
 * a coupling that has nothing to do with what either test asserts. Real users
 * do not share one address either.
 */
const nextTestIp = (() => {
  let n = 0;
  return () => {
    n += 1;
    return `203.0.113.${(n % 200) + 20}`;
  };
})();

function request(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  cookie?: string,
  ip?: string
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${url}`, {
      method,
      headers: baseHeaders({
        'content-type': 'application/json',
        origin: PUBLIC_ORIGIN,
        ...(ip && { 'cf-connecting-ip': ip }),
        // A real client always sends one, and it is what makes a listed device
        // recognisable. Asserting on it needs it to be here.
        'user-agent': USER_AGENT,
        ...(cookie !== undefined && { cookie }),
      }),
      ...(method === 'POST' && { body: JSON.stringify(body ?? {}) }),
    })
  );
}

async function totpCode(secret = fixture.secret): Promise<string> {
  const { code } = await auth.api.generateTOTP({ body: { secret } });
  return code;
}

interface SignInResult {
  body: Record<string, unknown>;
  cookie: string;
}

async function signIn(
  jar = '',
  user = actor(),
  ip?: string
): Promise<SignInResult> {
  const response = await request(
    'POST',
    '/api/auth/sign-in/email',
    { email: user.email, password: user.password },
    jar,
    ip
  );
  return {
    body: (await response.json()) as Record<string, unknown>,
    cookie: mergeCookies(jar, response.headers.getSetCookie()),
  };
}

/**
 * Enrols TOTP through the real endpoints and returns the verified jar.
 *
 * Extracted rather than seeded: this file is one of the two the verification
 * report named for writing final state by SQL, and that pattern is what let an
 * inert passkey enrolment ship green. A trusted device now requires a proven
 * second factor, so producing one legitimately is the only honest fixture — and
 * once the flow is a helper, a second user costs one call.
 */
async function enrolTotp(
  user: SeededUser,
  /** Only the fixture needs a set; every extra call spends the shared IP budget. */
  withBackupCodes = false
): Promise<{
  jar: string;
  secret: string;
  backupCodes: string[];
}> {
  const ip = nextTestIp();
  const first = await signIn('', user, ip);
  const start = await request(
    'POST',
    '/api/auth/two-factor/totp/start',
    { password: user.password },
    first.cookie,
    ip
  );
  if (start.status !== HTTP_STATUS.OK)
    throw new Error(`totp/start returned ${start.status}`);

  const [credential] = await db
    .select({ secret: twoFactorCredentials.secret })
    .from(twoFactorCredentials)
    .where(eq(twoFactorCredentials.userId, user.userId));
  if (!credential) throw new Error('no TOTP credential stored');
  const secret = await symmetricDecrypt({
    key: BETTER_AUTH_SECRET,
    data: credential.secret,
  });

  const confirm = await request(
    'POST',
    '/api/auth/two-factor/totp/confirm',
    { code: await totpCode(secret) },
    first.cookie,
    ip
  );
  if (confirm.status !== HTTP_STATUS.OK)
    throw new Error(`totp/confirm returned ${confirm.status}`);

  // Backup codes are their own method now, with their own generation and their
  // own acknowledgement — enrolling TOTP no longer mints a set as a side effect.
  let backupCodes: string[] = [];
  if (withBackupCodes) {
    const generated = await request(
      'POST',
      '/api/auth/two-factor/generate-backup-codes',
      { password: user.password },
      first.cookie,
      ip
    );
    if (generated.status !== HTTP_STATUS.OK)
      throw new Error(`generate-backup-codes returned ${generated.status}`);
    backupCodes =
      ((await generated.json()) as { data?: { backupCodes?: string[] } }).data
        ?.backupCodes ?? [];
    const acknowledged = await request(
      'POST',
      '/api/auth/two-factor/backup-codes/acknowledge',
      { password: user.password },
      first.cookie,
      ip
    );
    if (acknowledged.status !== HTTP_STATUS.OK)
      throw new Error(`acknowledge returned ${acknowledged.status}`);
  }

  return {
    jar: mergeCookies(first.cookie, confirm.headers.getSetCookie()),
    secret,
    backupCodes,
  };
}

beforeAll(async () => {
  await resetTables();
  await resetSqliteStores();
  scriptEgress(TURNSTILE_HOST, () => Response.json({ success: true }));

  fixture.user = await seedUser();
  const enrolled = await enrolTotp(actor(), true);
  fixture.secret = enrolled.secret;
  fixture.trusted = enrolled.jar;
  fixture.backupCodes = enrolled.backupCodes;
});

describe('a hostile verification body', () => {
  test('cannot smuggle trustDevice or disableSession past the backup-code path', async () => {
    // Both flags are the caller's to set on the library's endpoint. `trustDevice`
    // would mint a record this application cannot list; `disableSession` consumes
    // the code and returns WITHOUT completing the challenge or re-arming the
    // attempt counter, spending a recovery code and bricking the challenge in one
    // call. The before hook forces both false.
    const code = fixture.backupCodes[0];
    expect(code).toBeDefined();

    const before = await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, actor().userId));

    const attempt = await signIn();
    expect(attempt.body).toMatchObject({ twoFactorRedirect: true });

    const verified = await request(
      'POST',
      '/api/auth/two-factor/verify-backup-code',
      { code, trustDevice: true, disableSession: true },
      attempt.cookie
    );
    // `disableSession: false` won, so the challenge completed and a session
    // exists — the response is not the token-less shape the flag produces.
    expect(verified.status).toBe(HTTP_STATUS.OK);

    const jar = mergeCookies(attempt.cookie, verified.headers.getSetCookie());
    const session = await request(
      'GET',
      '/api/auth/get-session',
      undefined,
      jar
    );
    expect(await session.json()).not.toBeNull();

    // And `trustDevice: false` won, so nothing new was recorded.
    const after = await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, actor().userId));
    expect(after).toHaveLength(before.length);
  });
});

describe('trusting a device', () => {
  test('records something the user can actually recognise', async () => {
    const granted = await request(
      'POST',
      '/api/auth/two-factor/trust-device',
      {},
      fixture.trusted
    );
    expect(granted.status).toBe(HTTP_STATUS.OK);
    fixture.trusted = mergeCookies(
      fixture.trusted,
      granted.headers.getSetCookie()
    );

    const [row] = await db
      .select()
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, actor().userId));

    // The whole reason this is ours rather than the plugin's: its record holds
    // a user id and nothing else, so a settings screen could show a count and
    // no more.
    expect(row).toBeDefined();
    expect(row?.userAgent).toBe(USER_AGENT);
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('is listed to its owner', async () => {
    const listed = await request(
      'GET',
      '/api/auth/two-factor/trusted-devices',
      undefined,
      fixture.trusted
    );
    expect(listed.status).toBe(HTTP_STATUS.OK);
    const body = (await listed.json()) as {
      data: { devices: { id: string }[] };
    };
    expect(body.data.devices).toHaveLength(1);
  });
});

describe('the skip, and taking it away', () => {
  test('a trusted device signs in without a challenge', async () => {
    const attempt = await signIn(fixture.trusted);

    // The pair's first half. `twoFactorRedirect` absent AND a session cookie
    // present — either alone would also match a broken 2FA that stopped
    // challenging anyone.
    expect(attempt.body.twoFactorRedirect).toBeUndefined();
    expect(attempt.cookie).toContain('session_token');
  });

  test('an untrusted device is still challenged', async () => {
    // Same credentials, no trust cookie. This is what proves the skip came from
    // the device record rather than from 2FA having quietly switched off.
    const attempt = await signIn();
    expect(attempt.body).toMatchObject({
      twoFactorRedirect: true,
      // TOTP leads: the system priority puts an authenticator ahead of recovery
      // material, and `defaultMethod` never routes to a backup code.
      twoFactorMethods: ['totp', 'backup_code'],
      defaultMethod: 'totp',
    });
  });

  test('revoking brings the challenge back on that same device', async () => {
    const listed = await request(
      'GET',
      '/api/auth/two-factor/trusted-devices',
      undefined,
      fixture.trusted
    );
    const body = (await listed.json()) as {
      data: { devices: { id: string }[] };
    };
    const target = body.data.devices[0];
    expect(target).toBeDefined();

    const revoked = await request(
      'POST',
      '/api/auth/two-factor/trusted-devices/revoke',
      { id: target?.id },
      fixture.trusted
    );
    expect(revoked.status).toBe(HTTP_STATUS.OK);

    const attempt = await signIn(fixture.trusted);
    expect(attempt.body).toMatchObject({ twoFactorRedirect: true });
  });

  test('a session that has not proven a second factor cannot be trusted', async () => {
    // The planting precondition, refused. A stolen session on an account with no
    // 2FA used to mint a 30-day skip that survived the victim later enabling it.
    const other = await seedUser();
    const otherSignIn = await request(
      'POST',
      '/api/auth/sign-in/email',
      { email: other.email, password: other.password },
      ''
    );
    const otherCookie = cookieHeader(otherSignIn.headers.getSetCookie());

    const granted = await request(
      'POST',
      '/api/auth/two-factor/trust-device',
      {},
      otherCookie
    );
    expect(granted.status).toBe(HTTP_STATUS.FORBIDDEN);

    const rows = await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, other.userId));
    expect(rows).toHaveLength(0);
  });

  test('the proof is single-use', async () => {
    // A second "remember this device" needs a second verification, so one
    // completed challenge cannot be replayed into any number of skips.
    const again = await request(
      'POST',
      '/api/auth/two-factor/trust-device',
      {},
      fixture.trusted
    );
    expect(again.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  test('a trusted device is refused once the account has no usable factor', async () => {
    // ⚠️ Ordering, and it is the whole finding. Device trust used to be consumed
    // BEFORE the offered set was computed, so exactly the population an
    // operator's method-list change strands kept signing in with the password
    // alone — indefinitely, on a 30-day grant made against a factor that no
    // longer exists — while every other holder of the same enrolment was
    // refused. The skip has to be a skip of a factor that is still there.
    const stranded = await seedUser();
    const enrolled = await enrolTotp(stranded);
    const granted = await request(
      'POST',
      '/api/auth/two-factor/trust-device',
      {},
      enrolled.jar
    );
    expect(granted.status).toBe(HTTP_STATUS.OK);
    const trustedJar = mergeCookies(
      enrolled.jar,
      granted.headers.getSetCookie()
    );

    // The capability disappears; the intent row and `two_factor_enabled` stay,
    // which is precisely the state a dropped method or a deleted credential
    // leaves behind.
    await db
      .delete(twoFactorCredentials)
      .where(eq(twoFactorCredentials.userId, stranded.userId));

    const refused = await request(
      'POST',
      '/api/auth/sign-in/email',
      { email: stranded.email, password: stranded.password },
      trustedJar
    );
    expect(refused.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(cookieHeader(refused.headers.getSetCookie())).not.toContain(
      'session_token'
    );
  });

  test('removing a method revokes the proof that could mint a new trust', async () => {
    // ⚠️ Revoking the trusted-device ROWS is only half of it. The proof marker
    // is keyed by SESSION id, so a sweep on `value = userId` never reached it —
    // and method removal deliberately keeps the caller's session, which is
    // exactly where a surviving marker lets the same request mint a replacement
    // trusted device and undo the revocation it just performed.
    //
    // The marker is live here: enrolment proved a TOTP code on this session and
    // nothing has spent it, so a 403 below can only come from the removal.
    const owner = await seedUser();
    const enrolled = await enrolTotp(owner, true);

    const removed = await request(
      'POST',
      '/api/auth/two-factor/methods/disable',
      { method: 'backup_code', password: owner.password },
      enrolled.jar
    );
    expect(removed.status).toBe(HTTP_STATUS.OK);

    const again = await request(
      'POST',
      '/api/auth/two-factor/trust-device',
      {},
      enrolled.jar
    );
    expect(again.status).toBe(HTTP_STATUS.FORBIDDEN);

    const rows = await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, owner.userId));
    expect(rows).toHaveLength(0);
  });

  test('a device id that is not the caller’s is refused', async () => {
    const other = await seedUser();
    const otherEnrolled = await enrolTotp(other);
    const otherGrant = await request(
      'POST',
      '/api/auth/two-factor/trust-device',
      {},
      otherEnrolled.jar
    );
    expect(otherGrant.status).toBe(HTTP_STATUS.OK);

    const [victim] = await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, other.userId));
    expect(victim).toBeDefined();

    const attempt = await request(
      'POST',
      '/api/auth/two-factor/trusted-devices/revoke',
      { id: victim?.id },
      fixture.trusted
    );
    expect(attempt.status).toBe(HTTP_STATUS.NOT_FOUND);

    // And it is still there.
    const [survivor] = await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.id, victim?.id ?? ''));
    expect(survivor).toBeDefined();
  });
});
