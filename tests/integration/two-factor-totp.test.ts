/**
 * The second factor end to end: enrol TOTP, sign in, be refused a session, prove
 * the code, receive one.
 *
 * ⚠️ This file is the drift detector for the formats `two-factor-challenge.ts`
 * mirrors rather than imports — the `two_factor` cookie name, the `2fa-`
 * challenge identifier, the `2fa-attempts-<id>` counter. Without it an upstream
 * change to any of them surfaces as users unable to log in, with no failing test.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from 'bun:test';
import type { SeededUser } from '../helpers/session';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { MAX_POOL_CONNECTIONS } from '@/db/limits';
import {
  sessions,
  twoFactorCredentials,
  twoFactorMethods,
  users,
} from '@/db/schema';
import {
  generateRandomString,
  symmetricDecrypt,
  symmetricEncrypt,
} from 'better-auth/crypto';
import { auth } from '@/lib/auth';
import { consumeTotpCode, DELEGATED_TOTP_WINDOW } from '@/lib/auth/totp-replay';
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
function post(
  url: string,
  body: unknown,
  cookie?: string,
  /** Overridden only where a case must not share the default's per-IP budget. */
  ip?: string
): Promise<Response> {
  return app.handle(
    new Request(url, {
      method: 'POST',
      headers: baseHeaders({
        'content-type': 'application/json',
        origin: PUBLIC_ORIGIN,
        ...(cookie && { cookie }),
        ...(ip && { 'cf-connecting-ip': ip }),
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

const TOTP_PERIOD_MS = 30_000;

/**
 * `beginAttempt(5)` inside Better Auth's own `verifyTOTP`, deliberately NOT
 * `TWO_FACTOR_ALLOWED_ATTEMPTS`: the library's verifiers run their own budget,
 * and this file measures theirs. The two happen to agree today.
 */
const PLUGIN_ALLOWED_ATTEMPTS = 5;

/**
 * A code for a time step nothing in this file has spent yet.
 *
 * An accepted code now RESERVES its step (RFC 6238 §5.2), and this whole file
 * runs inside a second or two — so without moving the clock, the enrolment code
 * and every sign-in code below are the same string and every case after the
 * first would be refused as a replay. Each caller gets its own period; the
 * clock is restored in `afterAll`.
 */
async function freshTotpCode(secret: string): Promise<string> {
  setSystemTime(new Date(Date.now() + TOTP_PERIOD_MS));
  return totpCode(secret);
}

/**
 * Signs in and returns the response plus the cookies it set. Deliberately not
 * `helpers/session.signIn`, which throws on anything but a 200 — a challenge is
 * the expected outcome here, not a failure.
 */
async function signInRaw(
  user: SeededUser,
  body: Record<string, unknown> = {},
  jar = '',
  ip?: string
): Promise<{
  status: number;
  body: unknown;
  cookie: string;
  setCookie: string[];
}> {
  const response = await post(
    SIGN_IN_URL,
    { email: user.email, password: user.password, ...body },
    jar || undefined,
    ip
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

/** The library's account-level consecutive-failure count for this user. */
async function failedVerifications(userId: string): Promise<number> {
  const [row] = await db
    .select({ failed: twoFactorCredentials.failedVerificationCount })
    .from(twoFactorCredentials)
    .where(eq(twoFactorCredentials.userId, userId))
    .limit(1);
  if (!row) throw new Error('no two-factor credential row');
  return row.failed;
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

/**
 * The library's account lockout is per CREDENTIAL and outlives a test: ten
 * consecutive failed verifications lock the row for fifteen minutes, and every
 * later case in this file then answers 429 instead of the status it asserts.
 *
 * It has to be cleared between cases rather than after the one obvious
 * offender, because a REPLAY is charged exactly like a wrong code — see
 * `SPENT_TOTP_CODE` in `lib/auth/two-factor.ts` — so the replay and concurrency
 * cases spend the same budget as the invalid-code ones. That charging is
 * asserted directly below; clearing it here is what keeps the assertion local
 * to the case that makes it.
 */
afterEach(async () => {
  /* eslint-disable-next-line drizzle/enforce-update-with-where -- every
     credential row in the harness database, deliberately: the cases below enrol
     users of their own and each one carries its own lock */
  await db
    .update(twoFactorCredentials)
    .set({ failedVerificationCount: 0, lockedUntil: null });
});

afterAll(() => {
  // `setSystemTime()` with no argument IS the documented reset; this tier runs
  // `--no-isolate`, so a clock left forward would follow every later file.
  setSystemTime();
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
      { code: await freshTotpCode(enrolled().secret) },
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

  test('a code that already completed a sign-in cannot complete a second one', async () => {
    // RFC 6238 §5.2. Nothing reserved the accepted time step, so an OBSERVED
    // code stayed acceptable for its whole period plus the window either side —
    // about ninety seconds in which somebody holding the password and a
    // shoulder-surfed code got their own session after the owner had used it.
    const code = await freshTotpCode(enrolled().secret);

    const first = await signInRaw(enrolled().user);
    const firstVerify = await post(
      'http://localhost/api/auth/two-factor/verify-totp',
      { code },
      first.cookie
    );
    expect(firstVerify.status).toBe(HTTP_STATUS.OK);

    const second = await signInRaw(enrolled().user);
    const before = await sessionCount(enrolled().user.userId);
    const secondVerify = await post(
      'http://localhost/api/auth/two-factor/verify-totp',
      { code },
      second.cookie
    );

    expect(secondVerify.status).not.toBe(HTTP_STATUS.OK);
    expect(await sessionCount(enrolled().user.userId)).toBe(before);
    // And the refusal is the ordinary invalid-code answer: "that one was
    // already used" would tell the holder their capture was good.
    expect(cookieHeader(secondVerify.headers.getSetCookie())).not.toContain(
      'session_token'
    );
  });

  test('a replay costs what a wrong code costs, not nothing', async () => {
    // The status and the message matched before this; the COST did not. A
    // replay refused ahead of the library spent no attempt of the challenge's
    // five and no failure of the account's ten, so a holder of a captured code
    // could repeat it indefinitely past the point at which a guess would have
    // destroyed the challenge — and that difference is the oracle: it says the
    // capture was genuine.
    const code = await freshTotpCode(enrolled().secret);
    const owner = await signInRaw(enrolled().user);
    const ownerVerify = await post(
      'http://localhost/api/auth/two-factor/verify-totp',
      { code },
      owner.cookie
    );
    expect(ownerVerify.status).toBe(HTTP_STATUS.OK);

    // One challenge, replayed until its budget is gone. The last answer is the
    // exhausted-challenge refusal, which is what a sixth WRONG code gets.
    const attacker = await signInRaw(enrolled().user);
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= PLUGIN_ALLOWED_ATTEMPTS; attempt++) {
      const replay = await post(
        'http://localhost/api/auth/two-factor/verify-totp',
        { code },
        attacker.cookie
      );
      statuses.push(replay.status);
    }

    expect(statuses).toEqual([
      ...Array.from(
        { length: PLUGIN_ALLOWED_ATTEMPTS },
        () => HTTP_STATUS.UNAUTHORIZED
      ),
      HTTP_STATUS.BAD_REQUEST,
    ]);
    // And the account-level budget moved too: the sign-in that completed above
    // cleared it, so every count here is a replay the library charged for.
    expect(await failedVerifications(enrolled().user.userId)).toBe(
      PLUGIN_ALLOWED_ATTEMPTS
    );
  });

  test('the step is advanced, so a code from an EARLIER period is refused too', async () => {
    // The window is ±1 period, so the previous period's code is otherwise still
    // acceptable — and it is the one an attacker is most likely to hold.
    const previous = await freshTotpCode(enrolled().secret);
    // Reserve the current step through a real sign-in.
    const priming = await signInRaw(enrolled().user);
    const primed = await post(
      'http://localhost/api/auth/two-factor/verify-totp',
      { code: await freshTotpCode(enrolled().secret) },
      priming.cookie
    );
    expect(primed.status).toBe(HTTP_STATUS.OK);

    const attempt = await signInRaw(enrolled().user);
    const before = await sessionCount(enrolled().user.userId);
    const verify = await post(
      'http://localhost/api/auth/two-factor/verify-totp',
      { code: previous },
      attempt.cookie
    );

    expect(verify.status).not.toBe(HTTP_STATUS.OK);
    expect(await sessionCount(enrolled().user.userId)).toBe(before);
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

  test('every concurrent submission of one code answers, and exactly one wins', async () => {
    // `MAX_POOL_CONNECTIONS` submissions at once, which is the shape that
    // exposed two different ways of never answering: a statement issued against
    // the POOL from inside the challenge transaction (every request holding a
    // connection and waiting for another), and the step reservation taking the
    // credential row's lock inside that transaction while the library's own
    // verifier updates the same row through the pool. Neither is a lock
    // PostgreSQL can break, so the assertion is simply that all of them answer.
    const code = await freshTotpCode(enrolled().secret);
    const before = await sessionCount(enrolled().user.userId);

    const attempts = [];
    for (let index = 0; index < MAX_POOL_CONNECTIONS; index++)
      attempts.push(await signInRaw(enrolled().user));

    const answers = await Promise.all(
      attempts.map((attempt) =>
        post(
          'http://localhost/api/auth/two-factor/verify-totp',
          { code },
          attempt.cookie
        )
      )
    );

    // One code, one session. The rest are the ordinary invalid-code answer.
    expect(
      answers.filter((answer) => answer.status === HTTP_STATUS.OK)
    ).toHaveLength(1);
    expect(await sessionCount(enrolled().user.userId)).toBe(before + 1);
  }, 30_000);

  test('every concurrent INVALID submission answers too', async () => {
    // The half the correct-code case cannot reach. A wrong code is rejected by
    // the reservation and falls through to the library, so all
    // `MAX_POOL_CONNECTIONS` requests open the challenge transaction — each
    // holding a connection, nine of them waiting on the user row lock — and the
    // one holding the lock then needs a POOL connection for the library's own
    // credential read. There is none, and none can be returned until it
    // finishes. Nothing in PostgreSQL breaks that: the wait is in the
    // application pool.
    // One address per submission. The per-IP admission budget is a real
    // control and would answer some of these 429 before they reach a
    // connection, which is exactly the state this has to get past to measure
    // what the pool does. A distributed attacker has the same addresses.
    const addresses = Array.from(
      { length: MAX_POOL_CONNECTIONS },
      (_, index) => `203.0.113.${index + 1}`
    );
    const attempts = [];
    for (const address of addresses)
      attempts.push(await signInRaw(enrolled().user, {}, '', address));

    const answers = await Promise.all(
      attempts.map((attempt, index) =>
        post(
          'http://localhost/api/auth/two-factor/verify-totp',
          { code: '000000' },
          attempt.cookie,
          addresses[index]
        )
      )
    );

    expect(answers.map((answer) => answer.status)).toEqual(
      Array.from(
        { length: MAX_POOL_CONNECTIONS },
        () => HTTP_STATUS.UNAUTHORIZED
      )
    );
  }, 60_000);

  test('the reservation covers the window the library can still be in', async () => {
    // The two verifiers read the clock at different instants, so the library's
    // ±1 window sits around a LATER reading than the reservation's. A step
    // boundary crossed between them puts `current + 2` inside the library's
    // window and outside a ±1 reservation — an accepted code that spends no
    // step, and is therefore replayable. `DELEGATED_TOTP_WINDOW` is what makes
    // that step reachable; this is the property, measured on the reservation
    // itself rather than on an injected clock.
    const user = await seedUser();
    const secret = generateRandomString(32);
    await db.insert(twoFactorCredentials).values({
      userId: user.userId,
      secret: await symmetricEncrypt({ key: BETTER_AUTH_SECRET, data: secret }),
      backupCodes: await symmetricEncrypt({
        key: BETTER_AUTH_SECRET,
        data: '[]',
      }),
      verified: true,
    });

    const now = Date.now();
    setSystemTime(new Date(now + 2 * TOTP_PERIOD_MS));
    const twoPeriodsAhead = await totpCode(secret);
    setSystemTime(new Date(now));

    expect(
      await consumeTotpCode(user.userId, secret, twoPeriodsAhead, {
        window: DELEGATED_TOTP_WINDOW,
      })
    ).toBe('matched');
    // And still once only.
    expect(
      await consumeTotpCode(user.userId, secret, twoPeriodsAhead, {
        window: DELEGATED_TOTP_WINDOW,
      })
    ).toBe('replayed');
  });

  test('a verification with no challenge cookie is refused', async () => {
    // The shape of the attack the design exists to stop: jumping straight to the
    // second factor without having proven the first.
    const verify = await post(
      'http://localhost/api/auth/two-factor/verify-totp',
      { code: await freshTotpCode(enrolled().secret) }
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
      { code: await freshTotpCode(enrolled().secret) },
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
      { code: await freshTotpCode(enrolled().secret) },
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
    const generatedSet = (await generated.json()) as {
      data?: { backupCodes?: string[]; setId?: string };
    };
    const codes = generatedSet.data?.backupCodes ?? [];
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
      {
        password: enrolled().user.password,
        setId: generatedSet.data?.setId,
      },
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

describe('the backup-code verifier under the same concurrency', () => {
  test('every concurrent INVALID backup code answers', async () => {
    // The sibling of the TOTP case, and not covered by it: this verifier has no
    // step reservation in front of it, and it reads the credential through the
    // same `ctx.context.adapter` — so it is the second endpoint that could hold
    // a pooled connection inside the challenge transaction. Self-contained
    // because it must not depend on which earlier case last acknowledged a set.
    const generated = await post(
      'http://localhost/api/auth/two-factor/generate-backup-codes',
      { password: enrolled().user.password },
      enrolled().cookie
    );
    expect(generated.status).toBe(HTTP_STATUS.OK);
    const setId = ((await generated.json()) as { data?: { setId?: string } })
      .data?.setId;
    const acknowledged = await post(
      'http://localhost/api/auth/two-factor/backup-codes/acknowledge',
      { password: enrolled().user.password, setId },
      enrolled().cookie
    );
    expect(acknowledged.status).toBe(HTTP_STATUS.OK);

    const addresses = Array.from(
      { length: MAX_POOL_CONNECTIONS },
      (_, index) => `198.51.100.${index + 1}`
    );
    const attempts = [];
    for (const address of addresses)
      attempts.push(await signInRaw(enrolled().user, {}, '', address));

    const answers = await Promise.all(
      attempts.map((attempt, index) =>
        post(
          'http://localhost/api/auth/two-factor/verify-backup-code',
          { code: 'zzzzz-zzzzz' },
          attempt.cookie,
          addresses[index]
        )
      )
    );

    expect(answers.map((answer) => answer.status)).toEqual(
      Array.from(
        { length: MAX_POOL_CONNECTIONS },
        () => HTTP_STATUS.UNAUTHORIZED
      )
    );
  }, 60_000);
});
