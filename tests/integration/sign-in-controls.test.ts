/**
 * Four controls on `POST /api/auth/sign-in/email` that nothing asserted.
 *
 * - **The per-account lockout** (`lib/auth/login-guard.ts`). The counter, the
 *   threshold, the refusal of a *correct* password mid-lock, the release, and
 *   the reset — each checked by ROW STATE as well as by status, because a 401
 *   cannot tell "wrong password" from "locked" and the two leave completely
 *   different rows behind.
 * - **A Turnstile REFUSAL.** The egress fake answers `{ success: true }` by
 *   default, so until now no test had ever seen the endpoint decline one.
 * - **The bound on outbound siteverify calls.** Admission runs before Better
 *   Auth plugins, so request N+1 cannot buy siteverify call N+1.
 * - **The attributes of the cookie sign-in sets.** `tests/helpers/session.ts`
 *   has exposed `setCookie` "for assertions about attributes" with no caller.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from 'bun:test';
import type { SeededUser } from '../helpers/session';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import {
  auditLogs,
  roles,
  sessions,
  users,
  verificationCodes,
  verificationSessions,
} from '@/db/schema';
import { BETTER_AUTH_ENDPOINTS } from '@/lib/auth/allowed-paths';
import { BASE_ERROR_CODES } from '@/lib/auth/code-errors';
import {
  LOCK_DURATION_SECONDS,
  MAX_FAILED_ATTEMPTS,
} from '@/lib/auth/login-guard';
import { PUBLIC_ORIGIN } from '@/lib/env';
import { PRE_AUTH_LIMIT } from '@/lib/http/pre-auth';

import { CUSTOM_AUTH_CODE, HTTP_STATUS } from '@/utils/api-messages';
import { hashOtpCode } from '@/utils/otp';
import { OTP_EXPIRY_MINUTES, PASSWORD_MAX } from '@/utils/validation/constants';

import { resetTables } from '../helpers/database';
import { egressCallsTo, scriptEgress } from '../helpers/egress';
import { baseHeaders, seedUser, signIn, TEST_IP } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const SIGN_IN_URL = 'http://localhost/api/auth/sign-in/email';
const TURNSTILE_HOST = 'challenges.cloudflare.com';

/**
 * Satisfies `passwordSchema` (lower, upper, digit, symbol, length).
 *
 * One that does NOT would answer 422 from the `before` hook's
 * `loginSchema.safeParse` and never reach `verifyLoginAttempt` — so a malformed
 * password would silently stop counting failed attempts.
 */
const WRONG_PASSWORD = 'Harness!Wr0ngPass';

/** A domain `emailSchema` accepts, belonging to nobody. */
const UNKNOWN_EMAIL = 'harness.no.such.account@gmail.com';

/**
 * Restores the default `{ success: true }` siteverify answer for a
 * describe-level `beforeAll`.
 *
 * `resetEgress` runs in the base preload's `beforeEach`, which has NOT run yet
 * when a describe's `beforeAll` executes — so an override installed by the last
 * test of the PREVIOUS describe is still in force there. Not hypothetical: the
 * `{ success: false }` flood below leaked into the cookie fixture's sign-in and
 * answered it `403 VERIFICATION_FAILED`. A fixture that signs in states the
 * captcha answer it needs rather than inheriting one.
 */
function acceptCaptcha(): void {
  scriptEgress(TURNSTILE_HOST, () => Response.json({ success: true }));
}

function attempt(email: string, password: string): Promise<Response> {
  return app.handle(
    new Request(SIGN_IN_URL, {
      method: 'POST',
      headers: baseHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ email, password }),
    })
  );
}

interface LockRow {
  failedLoginAttempts: number;
  lockedUntil: Date | null;
}

async function lockRow(userId: string): Promise<LockRow> {
  const [row] = await db
    .select({
      failedLoginAttempts: users.failedLoginAttempts,
      lockedUntil: users.lockedUntil,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) throw new Error(`no users row for ${userId}`);
  return row;
}

async function sessionCount(userId: string): Promise<number> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  return rows.length;
}

interface ParsedCookie {
  name: string;
  value: string;
  /** Lower-cased attribute name → value; a boolean attribute maps to `''`. */
  attributes: Map<string, string>;
}

/**
 * A real parse, not a substring match.
 *
 * `header.includes('HttpOnly')` passes on a cookie whose VALUE contains the
 * word, and an attribute list in a different order — or one that spells
 * `SameSite=lax` in lower case — breaks a match written against one shape.
 */
function parseSetCookie(header: string): ParsedCookie {
  const [pair = '', ...rest] = header.split(';');
  const attributes = new Map<string, string>();
  for (const part of rest) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf('=');
    attributes.set(
      (at === -1 ? trimmed : trimmed.slice(0, at)).toLowerCase(),
      at === -1 ? '' : trimmed.slice(at + 1)
    );
  }
  const split = pair.indexOf('=');
  return {
    name: split === -1 ? pair : pair.slice(0, split),
    value: split === -1 ? '' : pair.slice(split + 1),
    attributes,
  };
}

beforeAll(async () => {
  await resetTables();
  // Files share a worker process under `--no-isolate`, so the per-IP sign-in
  // budget can arrive already spent by an earlier file — and the describe-level
  // `beforeAll`s below run before the first `beforeEach`.
  resetSqliteStores();
});

beforeEach(() => {
  // The 20/min per-IP budget lives in SQLite, is per process, and two tests here
  // exhaust it deliberately. Sweeping does not clear a live fixed window; only
  // deleting the file does.
  resetSqliteStores();
});

afterEach(() => {
  // `setSystemTime()` with no argument IS the documented reset. `useRealTimers`
  // is not a top-level `bun:test` export (checked in `bun-types/test.d.ts`); it
  // exists only under the `jest`/`vi` compatibility namespaces.
  setSystemTime();
});

/**
 * The `before` hook substitutes a one-shot proof for the plaintext before Better
 * Auth's handler runs (`lib/auth/password-proof.ts`), and bounds any inbound
 * `password` so that no value a client can send is proof-shaped.
 *
 * Both halves are asserted against the LIVE endpoint rather than the module,
 * because the property is about what survives the whole chain: the substitution
 * must be invisible to a correct sign-in, and the bound must apply on a path
 * whose Better Auth schema declares an unbounded `z.string()`.
 */
describe('the password proof that replaces the plaintext', () => {
  const fixture: { user: SeededUser | null } = { user: null };

  function actor(): SeededUser {
    if (!fixture.user) throw new Error('fixture not seeded');
    return fixture.user;
  }

  beforeAll(async () => {
    acceptCaptcha();
    fixture.user = await seedUser();
  });

  test('a correct password still signs in, so the substitution is invisible', async () => {
    const response = await attempt(actor().email, actor().password);
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
  });

  test('a password over PASSWORD_MAX is refused before any credential work', async () => {
    // Longer than a proof, so it also covers the shape an attacker would try if
    // they were guessing at the marker rather than at the password.
    const response = await attempt(actor().email, 'A1!a'.repeat(PASSWORD_MAX));
    expect(response.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    // Refused, not merely failed: a rejection that had reached
    // `verifyLoginAttempt` would have charged the account a failed attempt, and
    // an unauthenticated caller must not be able to drive a victim toward the
    // lockout with input the schema was always going to reject.
    expect(await lockRow(actor().userId)).toEqual({
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('the per-account login lockout', () => {
  const fixture: {
    user: SeededUser | null;
    attempts: { status: number; row: LockRow }[];
  } = { user: null, attempts: [] };

  function actor(): SeededUser {
    if (!fixture.user) throw new Error('fixture not seeded');
    return fixture.user;
  }

  beforeAll(async () => {
    acceptCaptcha();
    fixture.user = await seedUser();
    // Driven once, here: every wrong password costs an Argon2id verify at
    // 64 MiB. The two tests that follow assert over the recorded row states
    // instead of replaying the arc per test.
    for (let n = 1; n <= MAX_FAILED_ATTEMPTS; n++) {
      const response = await attempt(actor().email, WRONG_PASSWORD);
      fixture.attempts.push({
        status: response.status,
        row: await lockRow(actor().userId),
      });
    }
  });

  test('each wrong password increments the counter, and nothing locks early', () => {
    const belowThreshold = fixture.attempts.slice(0, -1);
    expect(belowThreshold.length).toBe(MAX_FAILED_ATTEMPTS - 1);

    for (const [index, { status, row }] of belowThreshold.entries()) {
      expect(status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(row.failedLoginAttempts).toBe(index + 1);
      expect(row.lockedUntil).toBeNull();
    }
  });

  test('the lock engages AT the threshold, for LOCK_DURATION_SECONDS', () => {
    const final = fixture.attempts.at(-1);
    if (!final) throw new Error('fixture recorded no attempts');

    expect(final.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(final.row.failedLoginAttempts).toBe(MAX_FAILED_ATTEMPTS);
    expect(final.row.lockedUntil).not.toBeNull();

    // The instant the production comparison reads, not a re-parse of it:
    // `login-guard.ts` compares this `Date` directly.
    const remaining =
      ((final.row.lockedUntil?.getTime() ?? 0) - Date.now()) / 1000;
    expect(remaining).toBeLessThanOrEqual(LOCK_DURATION_SECONDS);
    expect(remaining).toBeGreaterThan(LOCK_DURATION_SECONDS - 60);
  });

  test('a CORRECT password during the lock is refused and changes nothing', async () => {
    const before = await lockRow(actor().userId);
    expect(before.lockedUntil).not.toBeNull();

    const response = await attempt(actor().email, actor().password);

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await sessionCount(actor().userId)).toBe(0);
    // This is the property that matters, and only the row can show it: the
    // locked branch returns before the password is verified, so the counter is
    // neither incremented nor the lock extended by a valid credential.
    expect(await lockRow(actor().userId)).toEqual(before);
  });

  test('locked, wrong-password and unknown-account refusals are identical', async () => {
    const other = await seedUser();

    const lockedResponse = await attempt(actor().email, actor().password);
    const wrongResponse = await attempt(other.email, WRONG_PASSWORD);
    const unknownResponse = await attempt(UNKNOWN_EMAIL, WRONG_PASSWORD);

    const lockedBody = await lockedResponse.text();
    const wrongBody = await wrongResponse.text();
    const unknownBody = await unknownResponse.text();

    expect(lockedResponse.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(wrongResponse.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(unknownResponse.status).toBe(HTTP_STATUS.UNAUTHORIZED);

    // Three different internal states — locked, bad credential, no such row —
    // and one indistinguishable answer. Anything else is an account-existence
    // and account-state oracle.
    expect(lockedBody).toBe(wrongBody);
    expect(lockedBody).toBe(unknownBody);
    expect(lockedBody).not.toContain(actor().email);
    expect(lockedBody).not.toContain(actor().userId);
    expect(lockedBody.toLowerCase()).not.toContain('lock');
  });

  test('the lock releases at locked_until and the next attempt is charged afresh', async () => {
    const armed = await lockRow(actor().userId);
    if (!armed.lockedUntil) throw new Error('the lock is not armed');

    // The comparison at `login-guard.ts:152` is against the PROCESS clock, so
    // this is the instrument that drives it. PostgreSQL's `NOW()` is untouched
    // and nothing on the release path re-reads it.
    setSystemTime(new Date(armed.lockedUntil.getTime() + 1000));

    const response = await attempt(actor().email, WRONG_PASSWORD);

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    // Released, then charged: the expiry branch zeroes both columns inside the
    // same transaction, and this failure counts as the first of a fresh run.
    // `failed_login_attempts` still at 5 would mean the lock never lifted.
    expect(await lockRow(actor().userId)).toEqual({
      failedLoginAttempts: 1,
      lockedUntil: null,
    });
  });

  test('a successful login resets the counter to 0', async () => {
    // Back on the real clock (`afterEach`), against a row carrying one failure
    // and no lock — which is what makes the reset visible rather than a no-op.
    expect(await lockRow(actor().userId)).toEqual({
      failedLoginAttempts: 1,
      lockedUntil: null,
    });

    const response = await attempt(actor().email, actor().password);

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(await lockRow(actor().userId)).toEqual({
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
  });
});

describe('a refused or unavailable Turnstile verification', () => {
  const fixture: { user: SeededUser | null } = { user: null };

  function actor(): SeededUser {
    if (!fixture.user) throw new Error('fixture not seeded');
    return fixture.user;
  }

  beforeAll(async () => {
    fixture.user = await seedUser();
  });

  test('a refusal answers 403 and never reaches the credentials', async () => {
    scriptEgress(TURNSTILE_HOST, () => Response.json({ success: false }));

    const response = await attempt(actor().email, actor().password);
    const body = await response.text();

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    // The captcha plugin answers from `onRequest`, upstream of every Better Auth
    // hook, so its raw English body and framework code used to reach the client
    // untranslated. `localiseAuthError` in `app.ts` is the only position
    // downstream of the whole plugin chain, and it maps them there.
    expect(JSON.parse(body)).toEqual({
      message: BASE_ERROR_CODES.VERIFICATION_FAILED,
      code: CUSTOM_AUTH_CODE,
    });
    expect(response.headers.get('content-type')).toStartWith(
      'application/json'
    );
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(egressCallsTo(TURNSTILE_HOST).length).toBe(1);

    // The credentials were CORRECT. An untouched counter and no session row are
    // what prove the captcha plugin short-circuited upstream of
    // `verifyLoginAttempt`, rather than a password check having failed.
    expect(await lockRow(actor().userId)).toEqual({
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
    expect(await sessionCount(actor().userId)).toBe(0);
    expect(body).not.toContain(actor().email);
  });

  test('a 5xx from siteverify fails CLOSED, even when its body says success', async () => {
    // Body and status disagree on purpose: only the transport failure should be
    // consulted. A handler that read the body first would sign this user in.
    scriptEgress(TURNSTILE_HOST, () =>
      Response.json({ success: true }, { status: 500 })
    );

    const response = await attempt(actor().email, actor().password);

    expect(response.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
    // Translated at the prefix handler like the other two captcha outcomes; the
    // STATUS is the fail-closed assertion and it is unchanged.
    expect(await response.json()).toEqual({
      message: BASE_ERROR_CODES.UNKNOWN_ERROR,
      code: CUSTOM_AUTH_CODE,
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await sessionCount(actor().userId)).toBe(0);
    expect(egressCallsTo(TURNSTILE_HOST).length).toBe(1);
  });

  test('a siteverify that never answers is bounded, and refuses', async () => {
    // The route honours the abort rather than hanging for ever: the plugin
    // passes its own `AbortSignal` into `fetch`, and the guard's
    // `new Request(input, init)` carries it through (measured).
    scriptEgress(
      TURNSTILE_HOST,
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        })
    );

    const started = Date.now();
    const response = await attempt(actor().email, actor().password);
    const elapsed = Date.now() - started;

    expect(response.status).toBe(HTTP_STATUS.INTERNAL_ERROR);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await sessionCount(actor().userId)).toBe(0);

    // Fail-closed is only half of it. The other half is the cost: one inbound
    // request pins an outbound socket for the plugin's whole deadline —
    // `CAPTCHA_VERIFY_TIMEOUT_MS = 10_000` in
    // `better-auth/dist/plugins/captcha/constants.mjs`. NOT `lib/captcha.ts`'s
    // 3 s bound, which this endpoint does not use.
    expect(elapsed).toBeGreaterThanOrEqual(9000);
    expect(elapsed).toBeLessThan(20_000);
  }, 40_000);
});

describe('outbound captcha admission', () => {
  test('the control: with no captcha header, nothing goes out at all', async () => {
    const response = await app.handle(
      new Request(SIGN_IN_URL, {
        method: 'POST',
        headers: {
          'cf-connecting-ip': TEST_IP,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          email: UNKNOWN_EMAIL,
          password: WRONG_PASSWORD,
        }),
      })
    );

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    // The most common client error on this endpoint — a stale page, a blocked
    // `challenges.cloudflare.com`, a native client. It used to answer in English
    // with a raw framework code and NO `content-type`.
    expect(response.headers.get('content-type')).toStartWith(
      'application/json'
    );
    expect(await response.json()).toEqual({
      message: BASE_ERROR_CODES.MISSING_RESPONSE,
      code: CUSTOM_AUTH_CODE,
    });
    expect(egressCallsTo(TURNSTILE_HOST)).toEqual([]);
  });

  test('N+1 requests produce at most N siteverify calls', async () => {
    scriptEgress(TURNSTILE_HOST, () => Response.json({ success: false }));

    // The sign-in budget, not `PRE_AUTH_LIMIT`: admission for this path is the
    // `preAuthLimit` its own `BETTER_AUTH_ENDPOINTS` record declares, applied in
    // the prefix handler ahead of the captcha plugin's `onRequest`. That
    // ordering is the whole assertion — the plugin's outbound `siteverify`
    // carries a 10 s timeout and had no bound of any kind while Better Auth's
    // own rule for this path was `false`.
    const limit =
      BETTER_AUTH_ENDPOINTS.find(
        (endpoint) => endpoint.path === '/sign-in/email'
      )?.preAuthLimit ?? PRE_AUTH_LIMIT;

    const statuses: number[] = [];
    for (let n = 0; n <= limit; n++) {
      const response = await attempt(UNKNOWN_EMAIL, WRONG_PASSWORD);
      statuses.push(response.status);
    }

    expect(statuses.slice(0, limit)).toEqual(
      Array.from({ length: limit }, () => HTTP_STATUS.FORBIDDEN)
    );
    expect(statuses.at(-1)).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
    expect(egressCallsTo(TURNSTILE_HOST).length).toBe(limit);
  }, 120_000);
});

describe('the cookie sign-in sets', () => {
  const fixture: { user: SeededUser | null; cookies: ParsedCookie[] } = {
    user: null,
    cookies: [],
  };

  function token(): ParsedCookie {
    const found = fixture.cookies.find((cookie) =>
      cookie.name.endsWith('session_token')
    );
    if (!found)
      throw new Error(
        `no session cookie among: ${fixture.cookies.map((c) => c.name).join(', ')}`
      );
    return found;
  }

  beforeAll(async () => {
    // The describe above deliberately exhausts `/sign-in/email`'s per-IP budget,
    // and a describe-level `beforeAll` runs before the file's first `beforeEach`
    // — so this reset has to be here, not inherited.
    resetSqliteStores();
    acceptCaptcha();
    const session = await signIn(await seedUser());
    fixture.user = session.user;
    fixture.cookies = session.setCookie.map(parseSetCookie);
  });

  test('sign-in emits the session token and the cookie-cache cookie', () => {
    // Named, so the sweep below is known to cover more than one cookie and so a
    // NEW cookie on this response — anything carrying session state to the
    // browser — has to be looked at rather than inherited silently.
    const names = fixture.cookies.map((cookie) => cookie.name);
    expect(names.toSorted((a, b) => (a === b ? 0 : a < b ? -1 : 1))).toEqual([
      'better-auth.session_data',
      'better-auth.session_token',
    ]);
  });

  test('the session cookie is HttpOnly, SameSite=Lax and scoped to Path=/', () => {
    expect(token().attributes.has('httponly')).toBe(true);
    expect(token().attributes.get('samesite')?.toLowerCase()).toBe('lax');
    expect(token().attributes.get('path')).toBe('/');
  });

  test('Secure is set exactly when the configured origin is https', () => {
    // Nothing in `lib/auth.ts` sets `useSecureCookies`, so Better Auth derives
    // it from the baseURL scheme. The rule is what deserves pinning — it stays
    // right on a deployment that serves https — but on its own it would hold
    // whichever way the flag went, so the scheme this tier actually runs under
    // is recorded next to it: `PUBLIC_ORIGIN` is http, and `Secure` is ABSENT.
    expect(token().attributes.has('secure')).toBe(
      PUBLIC_ORIGIN.startsWith('https://')
    );
    expect(PUBLIC_ORIGIN.startsWith('http://')).toBe(true);
  });

  test('every cookie the sign-in sets carries the same protections', () => {
    expect(fixture.cookies.length).toBeGreaterThan(0);

    // The class, not the instance: the cookie-cache cookie is set on the same
    // response and carries a signed copy of the session payload, so a missing
    // `HttpOnly` there is the same defect as on the token.
    for (const cookie of fixture.cookies)
      expect({
        name: cookie.name,
        httpOnly: cookie.attributes.has('httponly'),
        sameSite: cookie.attributes.get('samesite')?.toLowerCase(),
        path: cookie.attributes.get('path'),
        secure: cookie.attributes.has('secure'),
      }).toEqual({
        name: cookie.name,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: PUBLIC_ORIGIN.startsWith('https://'),
      });
  });

  test('the session cookie value carries no identity of its own', () => {
    if (!fixture.user) throw new Error('fixture not seeded');
    const value = decodeURIComponent(token().value);

    // Only the TOKEN cookie: `better-auth.session_data` is the cookie cache and
    // legitimately carries the session payload, which includes the email. Its
    // protection is `HttpOnly` plus the signature, asserted above.
    expect(value).not.toContain(fixture.user.email);
    expect(value).not.toContain(fixture.user.userId);
    expect(value.length).toBeGreaterThan(0);
  });
});

describe('what the audit trail claims about a login', () => {
  /**
   * `loginSuccess` has to mean "a session exists", and it did not.
   *
   * `verifyLoginAttempt` wrote it from Better Auth's `before` hook — ahead of the
   * `session.create.before` gates that can still reject an inactive role, a
   * missing required role or an unverified contact — and the same helper proves
   * the current password for three already-authenticated mutation routes, one of
   * which then rejects the request because the submitted address is unchanged. So
   * a forensic query could not tell a completed login from a rejected one or from
   * a routine password re-prompt. Now the proof and the issuance are two
   * different events.
   */
  async function rowsFor(userId: string) {
    const rows = await db
      .select({
        action: auditLogs.action,
        tableName: auditLogs.tableName,
        newData: auditLogs.newData,
        oldData: auditLogs.oldData,
      })
      .from(auditLogs)
      .where(eq(auditLogs.userId, userId));
    return rows.map((row) => ({
      action: row.action,
      tableName: row.tableName,
      data: (row.newData ?? {}) as Record<string, unknown>,
      oldData: row.oldData,
    }));
  }

  /**
   * A live `passwordless_login` proof for `user`, hashed by the production
   * helper.
   *
   * Direct SQL rather than a send request: the send path defers delivery and the
   * code it issues is never returned to the client, so a test that goes through
   * it cannot present the right code. `hashOtpCode` is the same envelope the
   * real send writes, so the verify path is exercised for real.
   */
  async function seedPasswordlessProof(
    userId: string,
    email: string,
    code: string
  ): Promise<void> {
    const [row] = await db
      .insert(verificationSessions)
      .values({
        userId,
        channel: 'email',
        identifier: email,
        purpose: 'passwordless_login',
        attemptNumber: 1,
      })
      .returning({ id: verificationSessions.id });
    if (!row) throw new Error('seedPasswordlessProof inserted no session');

    await db.insert(verificationCodes).values({
      sessionId: row.id,
      code: hashOtpCode(code),
      expiresAt: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000),
    });
  }

  beforeEach(async () => {
    await resetTables();
    resetSqliteStores();
    acceptCaptcha();
  });

  test('a completed sign-in records the proof and exactly one issuance', async () => {
    const user = await seedUser();
    const response = await attempt(user.email, user.password);
    expect(response.status).toBe(HTTP_STATUS.OK);

    const rows = await rowsFor(user.userId);
    const proofs = rows.filter((row) => row.data.passwordVerified === true);
    const issuances = rows.filter((row) => row.data.loginSuccess === true);

    expect(proofs).toHaveLength(1);
    expect(proofs[0]?.data.purpose).toBe('sign_in');
    // Exactly one, and on `sessions` rather than on `users`: the row it is about
    // is the session that now exists. Two writers used to produce two rows for
    // one passwordless login.
    expect(issuances).toHaveLength(1);
    expect(issuances[0]?.tableName).toBe('sessions');
    expect(issuances[0]?.data.method).toBe('password');
    // INSERT with no prior state: the row it describes was just created, and
    // `computeChangedFields({}, newData)` on an UPDATE reported every key as
    // changed against a state that never existed.
    expect(issuances[0]?.action).toBe('INSERT');
    expect(issuances[0]?.oldData).toBeNull();
  });

  test('a passwordless login records exactly one issuance, labelled passwordless', async () => {
    // The method this centralisation was introduced FOR: `createSession` fires
    // the same hook, and the endpoint used to write its own row as well — two
    // rows for one login. Nothing pinned that, so a second writer could come
    // back unnoticed.
    const code = '424242';
    const user = await seedUser();
    await seedPasswordlessProof(user.userId, user.email, code);

    const response = await app.handle(
      new Request('http://localhost/api/auth/passwordless/verify', {
        method: 'POST',
        headers: baseHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ channel: 'email', email: user.email, code }),
      })
    );
    expect(response.status).toBe(HTTP_STATUS.OK);

    const rows = await rowsFor(user.userId);
    const issuances = rows.filter((row) => row.data.loginSuccess === true);

    expect(issuances).toHaveLength(1);
    expect(issuances[0]?.tableName).toBe('sessions');
    expect(issuances[0]?.data.method).toBe('passwordless');
    expect(issuances[0]?.action).toBe('INSERT');

    // No password was proven, so no proof event may claim one.
    expect(rows.filter((row) => row.data.passwordVerified === true)).toEqual(
      []
    );
    // And the in-transaction proof event that IS the authoritative record.
    expect(
      rows.filter((row) => row.data.passwordlessProofVerified === true)
    ).toHaveLength(1);
  });

  test('a rejected post-password gate records the proof and NO issuance', async () => {
    // The password is correct and the ACCOUNT is active — `verifyLoginAttempt`
    // filters an inactive user out before the password is even compared, so
    // deactivating the user would test the wrong gate. Deactivating its ROLE is
    // the one that runs AFTER the password: `verifyLoginAttempt` never looks at
    // the role, and `session.create.before` refuses on it. Before the split, this
    // request wrote `loginSuccess: true` for a login that never happened.
    const user = await seedUser();
    await db
      .update(roles)
      .set({ isActive: false })
      .where(eq(roles.id, user.roleId));

    const response = await attempt(user.email, user.password);
    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await sessionCount(user.userId)).toBe(0);

    const rows = await rowsFor(user.userId);
    expect(
      rows.filter((row) => row.data.passwordVerified === true)
    ).toHaveLength(1);
    expect(rows.filter((row) => row.data.loginSuccess === true)).toEqual([]);
  });

  test('a wrong password records neither', async () => {
    const user = await seedUser();

    const response = await attempt(user.email, WRONG_PASSWORD);
    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

    const rows = await rowsFor(user.userId);
    expect(rows.filter((row) => row.data.passwordVerified === true)).toEqual(
      []
    );
    expect(rows.filter((row) => row.data.loginSuccess === true)).toEqual([]);
  });
});
