/**
 * The second factor end to end: enrol TOTP, sign in, be refused a session, prove
 * the code, receive one.
 *
 * ⚠️ This file is the drift detector for the formats `two-factor-challenge.ts`
 * mirrors rather than imports — the `two_factor` cookie name, the `2fa-`
 * challenge identifier, the `2fa-attempts-<id>` counter. Without it an upstream
 * change to any of them surfaces as users unable to log in, with no failing test.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SeededUser } from '../helpers/session';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import {
  sessions,
  twoFactorCredentials,
  twoFactorMethods,
  users,
} from '@/db/schema';
import { symmetricDecrypt } from 'better-auth/crypto';
import { auth } from '@/lib/auth';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { HTTP_STATUS } from '@/utils/api-messages';

import { resetTables } from '../helpers/database';
import { scriptEgress } from '../helpers/egress';
import { baseHeaders, mergeCookies, seedUser } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

/** The key the plugin encrypts the TOTP secret under. */
const BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? '';

const SIGN_IN_URL = 'http://localhost/api/auth/sign-in/email';
const TURNSTILE_HOST = 'challenges.cloudflare.com';

interface Enrolled {
  user: SeededUser;
  secret: string;
  /** The session cookie the enrolment left behind. */
  cookie: string;
}

const fixture: { enrolled: Enrolled | null } = { enrolled: null };

function enrolled(): Enrolled {
  if (!fixture.enrolled) throw new Error('fixture not enrolled');
  return fixture.enrolled;
}

/**
 * The cookie header a browser would send back, with cleared cookies dropped —
 * the challenge flow expires the session cookie by setting it empty, and
 * replaying `name=` would look like a session token of the empty string.
 */
function cookieHeader(setCookie: string[]): string {
  return setCookie
    .map((value) => value.split(';', 1)[0] ?? '')
    .filter((pair) => pair.length > 0 && !pair.endsWith('='))
    .join('; ');
}

/**
 * `origin` is sent with every request, exactly as a browser does.
 *
 * Better Auth validates it whenever the request carries a COOKIE
 * (`validateOrigin`: `const useCookies = headers.has("cookie")`), so the
 * session-bearing 2FA paths are CSRF-protected and an omitted origin is a 403
 * rather than a pass. Worth knowing on the frontend side: any non-browser
 * client calling these endpoints has to send it too.
 */
function post(url: string, body: unknown, cookie?: string): Promise<Response> {
  return app.handle(
    new Request(url, {
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

/** A live code for `secret`, through the plugin's own generator. */
async function totpCode(secret: string): Promise<string> {
  const { code } = await auth.api.generateTOTP({ body: { secret } });
  return code;
}

/**
 * Signs in and returns the response plus the cookies it set. Deliberately not
 * `helpers/session.signIn`, which throws on anything but a 200 — a challenge is
 * the expected outcome here, not a failure.
 */
async function signInRaw(
  user: SeededUser,
  body: Record<string, unknown> = {},
  jar = ''
): Promise<{
  status: number;
  body: unknown;
  cookie: string;
  setCookie: string[];
}> {
  const response = await post(
    SIGN_IN_URL,
    { email: user.email, password: user.password, ...body },
    jar || undefined
  );
  const setCookie = response.headers.getSetCookie();
  return {
    status: response.status,
    body: await response.json(),
    cookie: jar ? mergeCookies(jar, setCookie) : cookieHeader(setCookie),
    setCookie,
  };
}

/** How long the newest session row for `userId` lives, in days. */
async function newestSessionLifetimeDays(userId: string): Promise<number> {
  const rows = await db
    .select({ createdAt: sessions.createdAt, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  const newest = rows.toSorted(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  )[0];
  if (!newest) throw new Error('no session row');
  return (newest.expiresAt.getTime() - newest.createdAt.getTime()) / 86_400_000;
}

async function sessionCount(userId: string): Promise<number> {
  const rows = await db.query.sessions.findMany({
    where: (session, { eq: is }) => is(session.userId, userId),
  });
  return rows.length;
}

beforeAll(async () => {
  await resetTables();
  await resetSqliteStores();
  scriptEgress(TURNSTILE_HOST, () => Response.json({ success: true }));

  const user = await seedUser();

  // Sign in first: enrolment is a session-bearing, password-re-authenticated
  // action, exactly like changing a password.
  const first = await signInRaw(user);
  if (first.status !== HTTP_STATUS.OK)
    throw new Error(`fixture sign-in returned ${first.status}`);

  const enableResponse = await post(
    'http://localhost/api/auth/two-factor/totp/start',
    { password: user.password },
    first.cookie
  );
  const enableBody = (await enableResponse.json()) as {
    data?: { totpURI?: string };
  };
  if (enableResponse.status !== HTTP_STATUS.OK || !enableBody.data?.totpURI)
    throw new Error(
      `start returned ${enableResponse.status}: ${JSON.stringify(enableBody)}`
    );

  // Read the stored secret and decrypt it, rather than pulling it out of the
  // `totpURI`: the URI carries `base32.encode(secret)` while `generateTOTP` and
  // the plugin's own verifier both take the RAW value, so the query parameter
  // produces codes that never match.
  const [credential] = await db
    .select({ secret: twoFactorCredentials.secret })
    .from(twoFactorCredentials)
    .where(eq(twoFactorCredentials.userId, user.userId));
  if (!credential) throw new Error('enable stored no TOTP credential');
  const secret = await symmetricDecrypt({
    key: BETTER_AUTH_SECRET,
    data: credential.secret,
  });

  // Enrolment is not complete until a code is proven — this is the call that
  // flips `two_factor_enabled` and writes the intent row.
  const confirm = await post(
    'http://localhost/api/auth/two-factor/totp/confirm',
    { code: await totpCode(secret) },
    first.cookie
  );
  if (confirm.status !== HTTP_STATUS.OK)
    throw new Error(
      `enrolment verify returned ${confirm.status}: ${await confirm.text()}`
    );

  fixture.enrolled = {
    user,
    secret,
    cookie: cookieHeader(confirm.headers.getSetCookie()) || first.cookie,
  };
});

describe('enrolling TOTP', () => {
  test('flips the flag and records the intent row the challenge reads', async () => {
    const [row] = await db
      .select({ twoFactorEnabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, enrolled().user.userId));
    expect(row?.twoFactorEnabled).toBe(true);

    // The half Better Auth does not model: without this row the user is told
    // 2FA is on and is never challenged.
    const intent = await db
      .select({
        method: twoFactorMethods.method,
        channel: twoFactorMethods.channel,
      })
      .from(twoFactorMethods)
      .where(eq(twoFactorMethods.userId, enrolled().user.userId));
    expect(intent).toEqual([{ method: 'totp', channel: null }]);
  });

  test('the plugin’s own verifier refuses the enrolment branch', async () => {
    // ⚠️ The transition is owned, and this is what keeps it that way. The
    // plugin's `/two-factor/verify-totp` also serves ENROLMENT: it writes
    // `verified` and, on a first enable, `twoFactorEnabled`, and knows nothing
    // about the intent row that has to move with them — so a success there is
    // exactly the split state the owned endpoint exists to prevent. Sign-in
    // mode still goes through it; the tests below are that half.
    const other = await seedUser();
    const otherSession = await signInRaw(other);
    const refused = await post(
      'http://localhost/api/auth/two-factor/verify-totp',
      { code: '000000' },
      otherSession.cookie
    );
    expect(refused.status).toBe(HTTP_STATUS.BAD_REQUEST);

    const [row] = await db
      .select({ twoFactorEnabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, other.userId));
    expect(row?.twoFactorEnabled).toBe(false);
  });
});

describe('signing in with TOTP enrolled', () => {
  test('a correct password alone does NOT produce a session', async () => {
    const before = await sessionCount(enrolled().user.userId);
    const attempt = await signInRaw(enrolled().user);

    expect(attempt.status).toBe(HTTP_STATUS.OK);
    expect(attempt.body).toMatchObject({
      twoFactorRedirect: true,
      twoFactorMethods: ['totp'],
    });

    // The session the sign-in handler created is withdrawn, not merely hidden:
    // a row left behind would be a usable credential for anyone holding the
    // token, and the count is what proves it is gone.
    expect(await sessionCount(enrolled().user.userId)).toBe(before);
  });

  test('the challenge cookie plus a correct code completes the sign-in', async () => {
    const attempt = await signInRaw(enrolled().user);
    const before = await sessionCount(enrolled().user.userId);

    const verify = await post(
      'http://localhost/api/auth/two-factor/verify-totp',
      { code: await totpCode(enrolled().secret) },
      attempt.cookie
    );

    expect(verify.status).toBe(HTTP_STATUS.OK);
    expect(await sessionCount(enrolled().user.userId)).toBe(before + 1);
    // The pair that proves the whole mirrored format works: our issuer wrote a
    // challenge that the library's own verifier could read.
    expect(cookieHeader(verify.headers.getSetCookie())).toContain(
      'session_token'
    );
  });

  test('a wrong code is refused and does not issue a session', async () => {
    const attempt = await signInRaw(enrolled().user);
    const before = await sessionCount(enrolled().user.userId);

    const verify = await post(
      'http://localhost/api/auth/two-factor/verify-totp',
      { code: '000000' },
      attempt.cookie
    );

    expect(verify.status).not.toBe(HTTP_STATUS.OK);
    expect(await sessionCount(enrolled().user.userId)).toBe(before);
  });

  test('a verification with no challenge cookie is refused', async () => {
    // The shape of the attack the design exists to stop: jumping straight to the
    // second factor without having proven the first.
    const verify = await post(
      'http://localhost/api/auth/two-factor/verify-totp',
      { code: await totpCode(enrolled().secret) }
    );
    expect(verify.status).not.toBe(HTTP_STATUS.OK);
  });

  test('the plugin verifier honours the SUBMITTED remember choice, not a stale marker', async () => {
    // The plugin's `valid()` reads the `dont_remember` cookie alone to size the
    // session. A "do not remember" login leaves that marker in the jar, and the
    // plugin never clears it, so a later remembered login through the same
    // verifier got a one-day row. The challenge issuance now writes the marker
    // from what THIS sign-in submitted.
    const short = await signInRaw(enrolled().user, { rememberMe: false });
    expect(short.body).toMatchObject({ twoFactorRedirect: true });
    const shortVerify = await post(
      'http://localhost/api/auth/two-factor/verify-totp',
      { code: await totpCode(enrolled().secret) },
      short.cookie
    );
    expect(shortVerify.status).toBe(HTTP_STATUS.OK);
    expect(
      await newestSessionLifetimeDays(enrolled().user.userId)
    ).toBeLessThan(2);

    // The same browser: the marker from the short login is still in the jar.
    const staleJar = mergeCookies(
      short.cookie,
      shortVerify.headers.getSetCookie()
    );
    expect(staleJar).toContain('dont_remember');

    const remembered = await signInRaw(
      enrolled().user,
      { rememberMe: true },
      staleJar
    );
    expect(remembered.body).toMatchObject({ twoFactorRedirect: true });
    const rememberedVerify = await post(
      'http://localhost/api/auth/two-factor/verify-totp',
      { code: await totpCode(enrolled().secret) },
      remembered.cookie
    );
    expect(rememberedVerify.status).toBe(HTTP_STATUS.OK);
    expect(
      await newestSessionLifetimeDays(enrolled().user.userId)
    ).toBeGreaterThan(20);
  });
});

describe('a method the challenge did not offer', () => {
  test('cannot complete the sign-in through the plugin verifier', async () => {
    // ⚠️ The plugin's `/two-factor/verify-backup-code` reads the encrypted set
    // and nothing else: not the acknowledgement, not the intent row, not the
    // companion record. A generated-but-unacknowledged set is not an offered
    // method — the challenge says `['totp']` — yet a real code from it completed
    // the login. The before-hook now refuses a verifier whose method the
    // challenge did not issue.
    const generated = await post(
      'http://localhost/api/auth/two-factor/generate-backup-codes',
      { password: enrolled().user.password },
      enrolled().cookie
    );
    expect(generated.status).toBe(HTTP_STATUS.OK);
    const codes =
      ((await generated.json()) as { data?: { backupCodes?: string[] } }).data
        ?.backupCodes ?? [];
    expect(codes.length).toBeGreaterThan(1);

    const attempt = await signInRaw(enrolled().user);
    expect(attempt.body).toMatchObject({ twoFactorMethods: ['totp'] });
    const before = await sessionCount(enrolled().user.userId);

    const unoffered = await post(
      'http://localhost/api/auth/two-factor/verify-backup-code',
      { code: codes[0] },
      attempt.cookie
    );
    expect(unoffered.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(await sessionCount(enrolled().user.userId)).toBe(before);

    // Acknowledged, the same set IS offered, and the verifier is reachable —
    // which is what proves the refusal keyed on the offered set.
    const acknowledged = await post(
      'http://localhost/api/auth/two-factor/backup-codes/acknowledge',
      { password: enrolled().user.password },
      enrolled().cookie
    );
    expect(acknowledged.status).toBe(HTTP_STATUS.OK);

    const offered = await signInRaw(enrolled().user);
    expect(offered.body).toMatchObject({
      twoFactorMethods: expect.arrayContaining(['totp', 'backup_code']),
    });
    // Re-measured: confirming a method revokes the caller's OTHER sessions.
    const afterAcknowledge = await sessionCount(enrolled().user.userId);
    const completed = await post(
      'http://localhost/api/auth/two-factor/verify-backup-code',
      { code: codes[1] },
      offered.cookie
    );
    expect(completed.status).toBe(HTTP_STATUS.OK);
    expect(await sessionCount(enrolled().user.userId)).toBe(
      afterAcknowledge + 1
    );
  });
});
