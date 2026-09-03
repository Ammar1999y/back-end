/**
 * Origin validation on the two paths a browser reaches with no cookie at all,
 * judged by ROW STATE rather than by status alone.
 *
 * Better Auth's router-level origin check skips a cookie-less request and leaves
 * it to the endpoint's own `formCsrfMiddleware`, which runs AFTER `hooks.before`
 * — where `lib/auth.ts` runs the real password verification for `/sign-in/email`
 * and where `/passwordless/verify`, a local endpoint, declared no such middleware
 * at all. So an untrusted origin used to answer 403 only after the password had
 * been compared, the failed-attempt counter charged, or the OTP consumed and a
 * session row written. The hook now runs the same check first.
 *
 * Each refusal below is therefore asserted from three sides: the status and the
 * localised body, no session row, and the credential state untouched — a wrong
 * password that charged nothing, a correct code that is still live.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SeededUser } from '../helpers/session';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import {
  auditLogs,
  sessions,
  users,
  verificationCodes,
  verificationSessions,
} from '@/db/schema';
import { BASE_ERROR_CODES } from '@/lib/auth/code-errors';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { CUSTOM_AUTH_CODE, HTTP_STATUS } from '@/utils/api-messages';

import { resetTables } from '../helpers/database';
import { seedOtpProof } from '../helpers/otp';
import { baseHeaders, seedUser } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const UNTRUSTED_ORIGIN = 'https://attacker.example';

/** Satisfies `passwordSchema`, so a refusal cannot come from input validation. */
const WRONG_PASSWORD = 'Harness!Wr0ngPass';

const CODE = '424242';

interface FirstLoginPath {
  path: string;
  /** A body that is VALID for the path, so nothing short of the origin refuses it. */
  body: (user: SeededUser) => Record<string, unknown>;
  /** A body that reaches the credential check and fails it. */
  wrongBody: (user: SeededUser) => Record<string, unknown>;
}

const PATHS: readonly FirstLoginPath[] = [
  {
    path: '/sign-in/email',
    body: (user) => ({ email: user.email, password: user.password }),
    wrongBody: (user) => ({ email: user.email, password: WRONG_PASSWORD }),
  },
  {
    path: '/passwordless/verify',
    body: (user) => ({ channel: 'email', email: user.email, code: CODE }),
    wrongBody: (user) => ({
      channel: 'email',
      email: user.email,
      code: '000000',
    }),
  },
];

function post(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/api/auth${path}`, {
      method: 'POST',
      headers: baseHeaders({ 'content-type': 'application/json', ...headers }),
      body: JSON.stringify(body),
    })
  );
}

interface CredentialState {
  failedLoginAttempts: number;
  sessions: number;
  auditRows: number;
  /** Live, unconsumed code rows for the user's passwordless proof. */
  liveCodes: number;
  verifyAttempts: number;
}

async function credentialState(userId: string): Promise<CredentialState> {
  const [user] = await db
    .select({ failedLoginAttempts: users.failedLoginAttempts })
    .from(users)
    .where(eq(users.id, userId));
  const sessionRows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  const audit = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(eq(auditLogs.userId, userId));
  const proofs = await db
    .select({
      id: verificationSessions.id,
      verifyAttemptNumber: verificationSessions.verifyAttemptNumber,
    })
    .from(verificationSessions)
    .where(eq(verificationSessions.userId, userId));
  const codes =
    proofs.length > 0
      ? await db
          .select({ id: verificationCodes.id })
          .from(verificationCodes)
          .where(eq(verificationCodes.sessionId, proofs[0]?.id ?? ''))
      : [];

  return {
    failedLoginAttempts: user?.failedLoginAttempts ?? -1,
    sessions: sessionRows.length,
    auditRows: audit.length,
    liveCodes: codes.length,
    verifyAttempts: proofs[0]?.verifyAttemptNumber ?? -1,
  };
}

/** The state a user has before any request: one live proof, nothing charged. */
const UNTOUCHED: CredentialState = {
  failedLoginAttempts: 0,
  sessions: 0,
  auditRows: 0,
  liveCodes: 1,
  verifyAttempts: 0,
};

async function seedUserWithProof(): Promise<SeededUser> {
  const user = await seedUser();
  await seedOtpProof({
    userId: user.userId,
    identifier: user.email,
    purpose: 'passwordless_login',
    code: CODE,
  });
  return user;
}

beforeAll(async () => {
  await resetTables();
});

beforeEach(() => {
  resetSqliteStores();
});

/**
 * Every header shape Better Auth's `validateFormCsrf` refuses for a cookie-less
 * request. The three error codes all localise to the one untrusted-origin
 * message, and the status is the same, so a client cannot tell which rule fired.
 */
const REFUSED_HEADERS: readonly [string, Record<string, string>][] = [
  ['an untrusted Origin', { origin: UNTRUSTED_ORIGIN }],
  [
    'an untrusted Referer and no Origin',
    { referer: `${UNTRUSTED_ORIGIN}/login` },
  ],
  [
    'a cross-site navigation (a form post from another site)',
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
  ],
  [
    'a cross-site fetch carrying its Origin',
    {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
      origin: UNTRUSTED_ORIGIN,
    },
  ],
  ['Origin: null', { origin: 'null' }],
  [
    'fetch metadata with no Origin or Referer to validate',
    { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' },
  ],
];

describe.each([...PATHS])(
  '$path with no cookie',
  ({ path, body, wrongBody }) => {
    test.each(REFUSED_HEADERS)(
      '%s is refused before any credential or database work',
      async (_label, headers) => {
        const user = await seedUserWithProof();

        // The CORRECT credential, so that "still live" is the proof: had the
        // request reached verification, the code would be consumed or the
        // password accepted and a session row written.
        const response = await post(path, body(user), headers);

        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
        expect(await response.json()).toEqual({
          message: BASE_ERROR_CODES.INVALID_ORIGIN,
          code: CUSTOM_AUTH_CODE,
        });
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(await credentialState(user.userId)).toEqual(UNTOUCHED);
      }
    );

    test('an untrusted Origin with a WRONG credential charges nothing either', async () => {
      // The counter is the discriminator: a wrong password that reached
      // `verifyLoginAttempt` records a failed attempt, and a wrong code that
      // reached `processOtpVerify` records a verify attempt.
      const user = await seedUserWithProof();

      const response = await post(path, wrongBody(user), {
        origin: UNTRUSTED_ORIGIN,
      });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(await credentialState(user.userId)).toEqual(UNTOUCHED);
    });

    test('the same Origin as PUBLIC_ORIGIN, as a browser sends it, proceeds', async () => {
      const user = await seedUserWithProof();

      const response = await post(path, body(user), {
        origin: PUBLIC_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
      const state = await credentialState(user.userId);
      expect(state.sessions).toBe(1);
    });

    test('no Origin, Referer or fetch metadata at all is admitted, and reaches the credentials', async () => {
      // Better Auth's documented allowance for non-browser clients: there is
      // nothing to validate, so nothing refuses. Recorded here so the contract is
      // visible — this request DOES reach the credential check, and the wrong
      // credential is charged.
      const user = await seedUserWithProof();

      const response = await post(path, wrongBody(user), {});

      expect(response.status).not.toBe(HTTP_STATUS.FORBIDDEN);
      expect(response.status).toBeGreaterThanOrEqual(HTTP_STATUS.BAD_REQUEST);
      const state = await credentialState(user.userId);
      expect(state.sessions).toBe(0);
      expect(
        path === '/sign-in/email'
          ? state.failedLoginAttempts
          : state.verifyAttempts
      ).toBe(1);
    });

    test('with a cookie present, an untrusted Origin is refused by the router-level check', async () => {
      // Any cookie at all switches Better Auth to its cookie-bearing rule, which
      // validates the Origin on every non-GET request ahead of every hook.
      const user = await seedUserWithProof();

      const response = await post(path, body(user), {
        cookie: 'unrelated=1',
        origin: UNTRUSTED_ORIGIN,
      });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(await response.json()).toEqual({
        message: BASE_ERROR_CODES.INVALID_ORIGIN,
        code: CUSTOM_AUTH_CODE,
      });
      expect(await credentialState(user.userId)).toEqual(UNTOUCHED);
    });

    test('with a cookie present and no Origin at all, the request is refused', async () => {
      const user = await seedUserWithProof();

      const response = await post(path, body(user), { cookie: 'unrelated=1' });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(await credentialState(user.userId)).toEqual(UNTOUCHED);
    });
  }
);
