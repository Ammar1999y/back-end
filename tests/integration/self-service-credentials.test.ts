/**
 * The self-service credential surface: the five routes a user changes their own
 * credentials through, plus the two unauthenticated recovery entry points.
 *
 * `POST /api/dash/users/me/change-password`, `.../change-email`,
 * `.../change-email/verify`, `.../change-phone`, `.../change-phone/verify`,
 * `POST /api/auth/forgot-password/send`, `.../reset`,
 * `POST /api/auth/passwordless/send`.
 *
 * Closes F16 of `reports/claude-opus-audit.md`: none of these was referenced
 * anywhere under `tests/` before this file. They are the endpoints where a
 * regression is a credential-boundary failure rather than a broken feature, and
 * three accepted risks are recorded against exactly this code —
 * `reports/should-ignore.md` #54 (the re-auth / mutation TOCTOU) and Known
 * Issues #1 (a stale proof outliving a rotation) and #6 (no out-of-band notice).
 * Each was accepted without a single test pinning what the code does today, so
 * there was nothing to notice the moment an accepted risk became a realised one.
 *
 * **Four properties this file exists to hold, in descending order of cost if
 * they break:**
 *
 * 1. A refused change leaves the stored hash BYTE-IDENTICAL. Every negative
 *    case re-reads `accounts.password`; a status code alone cannot tell a
 *    rejection from a rejection that already wrote.
 * 2. A successful rotation revokes every OTHER session and keeps the current
 *    one, and drops the user's pending OTP proofs. Known Issues #1 is about a
 *    proof that survives a rotation, so the purge is asserted by row state — a
 *    `forgot_password` proof seeded before the change, gone after it — and not
 *    inferred from a 200.
 * 3. The recovery endpoints are indistinguishable for a known and an unknown
 *    address — same status, same body, same 1500 ms floor — while only the
 *    known one actually dispatches a message. Both halves together are the
 *    enumeration boundary; either alone passes for the wrong reason.
 * 4. The new address of an email change is never written until the code sent to
 *    THAT address comes back. A session thief cannot move the address without
 *    also holding the destination mailbox.
 *
 * **Where the code comes from, and why not the database.** The brief said to
 * read the OTP out of `verification_codes`. That column does not hold one:
 * `hashOtpCode` stores an `o1:<keyId>:<mac>` HMAC envelope
 * (`lib/auth/otp-hash.ts`), so the row is not invertible. The plaintext exists
 * in exactly one place a test can reach — the message that was delivered — so
 * `sentMail()` is the seam, and reading it there also proves the send path
 * reached delivery at all and addressed it correctly.
 *
 * **Order matters inside two describes.** A code is captured in the test that
 * sends it, because the preload clears the mailbox in `beforeEach`; the verify
 * tests that follow read it from a holder and throw a named error rather than a
 * confusing assertion failure when the earlier test did not run.
 *
 * **Seeded once, in `beforeAll`.** Argon2id at 64 MiB is charged per hash and
 * per verify, and truncating mid-file would delete the other actors' session
 * rows underneath them — the later tests would answer 401 instead of their
 * assertion. The SQLite limiter IS reset per test: these routes charge real
 * per-user and per-destination budgets, and a fixed-window row left inside its
 * window is not expired, so a sweep would leave the next test's first request
 * denied with an unexplained 429.
 */
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import crypto from 'node:crypto';
import type { SignedInSession } from '../helpers/session';

import { and, eq } from 'drizzle-orm';

import { app } from '@/app';
import { otpMsg } from '@/app/api/auth/otp/messages';
import { userMsg } from '@/app/api/dash/users/messages';
import { db } from '@/db';
import {
  accounts,
  auditLogs,
  sessions,
  users,
  verificationSessions,
} from '@/db/schema';
import { generateUuidV7 } from '@/lib/id';

import {
  HTTP_STATUS,
  MSG_INVALID_CREDENTIALS,
  MSG_INVALID_INPUT,
  MSG_LOGIN_REQUIRED,
  MSG_PASSWORD_COMPROMISED,
} from '@/utils/api-messages';
import { OTP_AUTO_VERIFY, PHONE_ENABLED } from '@/utils/config';
import {
  EMAIL_OTP_AVAILABLE,
  PHONE_OTP_AVAILABLE,
} from '@/utils/validation/otp';

import { resetTables } from '../helpers/database';
import { scriptEgress } from '../helpers/egress';
import { sentMail, settleDelivery } from '../helpers/mailbox';
import {
  authedRequest,
  baseHeaders,
  seedUser,
  signIn,
  TEST_IP,
} from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

/**
 * What a stored credential actually looks like: `p1:<pepperId>:$argon2id$…`.
 *
 * Three assertions in this file used `toStartWith('$argon2id$')` and failed —
 * correctly, because that is NOT the stored format. `lib/auth/password.ts`
 * wraps the PHC string in a peppered envelope (`HASH_ENVELOPE_VERSION`, the
 * pepper id, then the hash), and `parsePasswordHash` rejects anything else. The
 * bare-prefix form would have passed only if the pepper had been silently
 * dropped — i.e. it asserted the one state that would be a real defect.
 *
 * Matched as a shape rather than compared to a literal so a pepper ROTATION
 * (which changes the id) does not fail it, while a missing or malformed envelope
 * still does.
 */
const PEPPERED_HASH = /^p\d+:[^:]+:\$argon2id\$/;

/**
 * 45 s, and it is not padding. Every OTP response carries `ensureMinDelay`'s
 * 1500 ms anti-timing floor, and the tests that prove a rotation end to end pay
 * two Argon2id hashes at 64 MiB plus two sign-in verifies on top. At Bun's 5 s
 * default the slow tests fail on the clock rather than on an assertion, which is
 * the least informative way for this file to break.
 */
setDefaultTimeout(45_000);

/** Satisfies `passwordSchema`, and differs from the harness's seeded password. */
const NEW_PASSWORD = 'Harness!Rotated1';
const RESET_PASSWORD = 'Harness!Reset0ne';

/** Any six digits; the schema only cares about length and character class. */
const ARBITRARY_CODE = '000000';

const CHANGE_PASSWORD = '/api/dash/users/me/change-password';
const CHANGE_EMAIL = '/api/dash/users/me/change-email';
const CHANGE_EMAIL_VERIFY = '/api/dash/users/me/change-email/verify';
const CHANGE_PHONE = '/api/dash/users/me/change-phone';
const CHANGE_PHONE_VERIFY = '/api/dash/users/me/change-phone/verify';
const FORGOT_SEND = '/api/auth/forgot-password/send';
const FORGOT_RESET = '/api/auth/forgot-password/reset';
const PASSWORDLESS_SEND = '/api/auth/passwordless/send';

/** `emailSchema` accepts only a handful of consumer domains. */
function uniqueEmail(prefix: string): string {
  return `${prefix}.${generateUuidV7().replaceAll('-', '').slice(0, 16)}@gmail.com`;
}

/** `Array#toSorted` takes no default comparator; ids and purposes are text. */
const compareText = (a: string, b: string): number =>
  a === b ? 0 : a < b ? -1 : 1;

interface ApiBody {
  success: boolean;
  message: string;
  data: unknown;
}

async function bodyOf(response: Response): Promise<ApiBody> {
  return (await response.json()) as ApiBody;
}

/**
 * One field of the envelope, as its own await.
 *
 * `messageOf`/`dataOf` exist because `(await bodyOf(r)).message` reads as an
 * await of the member rather than of the response, which is what
 * `unicorn/no-await-expression-member` objects to. Same for the `userRow`
 * accessors below.
 */
async function messageOf(response: Response): Promise<string> {
  const body = await bodyOf(response);
  return body.message;
}

async function dataOf(response: Response): Promise<unknown> {
  const body = await bodyOf(response);
  return body.data;
}

function anonPost(url: string, body: unknown): Request {
  return new Request(new URL(url, 'http://localhost'), {
    method: 'POST',
    headers: baseHeaders({ 'content-type': 'application/json' }),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function authedPost(
  session: SignedInSession,
  url: string,
  body: unknown
): Request {
  return authedRequest(session, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Everything `authedPost` sends except the captcha token. */
function authedPostWithoutCaptcha(
  session: SignedInSession,
  url: string,
  body: unknown
): Request {
  return new Request(new URL(url, 'http://localhost'), {
    method: 'POST',
    headers: {
      'cf-connecting-ip': TEST_IP,
      'content-type': 'application/json',
      cookie: session.cookie,
    },
    body: JSON.stringify(body),
  });
}

async function storedHash(userId: string): Promise<string> {
  const [row] = await db
    .select({ value: accounts.password })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  return row?.value ?? '';
}

async function accountIdOf(userId: string): Promise<string> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  if (!row) throw new Error(`no credential account for ${userId}`);
  return row.id;
}

async function liveSessionIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  return rows.map((row) => row.id).toSorted(compareText);
}

async function userRow(userId: string) {
  const [row] = await db
    .select({
      email: users.email,
      emailVerified: users.emailVerified,
      phoneNumber: users.phoneNumber,
      failedLoginAttempts: users.failedLoginAttempts,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) throw new Error(`no user row for ${userId}`);
  return row;
}

async function emailOf(userId: string): Promise<string> {
  const row = await userRow(userId);
  return row.email;
}

async function phoneOf(userId: string): Promise<string | null> {
  const row = await userRow(userId);
  return row.phoneNumber;
}

async function failedAttempts(userId: string): Promise<number> {
  const row = await userRow(userId);
  return row.failedLoginAttempts;
}

function proofRows(userId: string) {
  return db
    .select({
      id: verificationSessions.id,
      purpose: verificationSessions.purpose,
      identifier: verificationSessions.identifier,
      targetIdentifier: verificationSessions.targetIdentifier,
      consumedAt: verificationSessions.consumedAt,
    })
    .from(verificationSessions)
    .where(eq(verificationSessions.userId, userId));
}

function auditRows(userId: string, tableName: string) {
  return db
    .select({
      recordId: auditLogs.recordId,
      action: auditLogs.action,
      newData: auditLogs.newData,
      oldData: auditLogs.oldData,
      apiPath: auditLogs.apiPath,
      ipAddress: auditLogs.ipAddress,
    })
    .from(auditLogs)
    .where(
      and(eq(auditLogs.userId, userId), eq(auditLogs.tableName, tableName))
    );
}

/**
 * The code as the user would read it out of the message that was actually
 * delivered, plus the address it went to.
 *
 * `verification_codes.code` is an HMAC envelope, so this is the only place the
 * plaintext exists — see the note at the top of the file.
 */
async function delivered(): Promise<{ to: string; code: string }> {
  // Delivery is deferred to post-response work, so the message is not in the
  // mailbox when `app.handle()` resolves.
  await settleDelivery();
  const mail = sentMail().at(-1);
  if (!mail) throw new Error('nothing was delivered');
  const match = /\b(\d{6})\b/.exec(mail.text ?? '');
  if (!match?.[1])
    throw new Error(`no six-digit code in the delivered message: ${mail.text}`);
  return { to: mail.to ?? '', code: match[1] };
}

/** A code that is guaranteed not to be the one that was issued. */
function otherThan(code: string): string {
  return String((Number(code) + 1) % 1_000_000).padStart(6, '0');
}

/** Makes the HIBP fake answer "this password appears in a breach". */
function scriptBreached(candidate: string): void {
  const suffix = crypto
    .createHash('sha1')
    .update(candidate, 'utf8')
    .digest('hex')
    .toUpperCase()
    .slice(5);
  scriptEgress(
    'api.pwnedpasswords.com',
    () =>
      new Response(`${suffix}:42\n`, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
  );
}

function signInResponse(email: string, secret: string): Promise<Response> {
  return app.handle(
    anonPost('/api/auth/sign-in/email', { email, password: secret })
  );
}

/**
 * Every actor, seeded and signed in once.
 *
 * Split by what each one's tests do to it rather than by route: a wrong
 * `currentPassword` charges a real failed-login attempt (five locks the account
 * for five minutes), and a successful rotation invalidates the seeded password —
 * so an actor that both refuses and succeeds would make later assertions pass
 * for reasons that have nothing to do with the endpoint.
 */
const actors: Record<string, SignedInSession> = {};
const seeded: Record<
  string,
  { userId: string; email: string; password: string }
> = {};

function actor(name: string): SignedInSession {
  const value = actors[name];
  if (!value) throw new Error(`actor "${name}" was not seeded`);
  return value;
}

function subject(name: string) {
  const value = seeded[name];
  if (!value) throw new Error(`subject "${name}" was not seeded`);
  return value;
}

beforeAll(async () => {
  await resetTables();

  // Two sessions each for the actors whose tests assert the revocation sweep:
  // "other sessions die, this one lives" needs an other.
  const pwUser = await seedUser();
  actors.pwPrimary = await signIn(pwUser);
  actors.pwSecondary = await signIn(pwUser);
  seeded.pw = pwUser;

  const pwGuardUser = await seedUser();
  actors.pwGuard = await signIn(pwGuardUser);
  seeded.pwGuard = pwGuardUser;

  const emailUser = await seedUser();
  actors.emailPrimary = await signIn(emailUser);
  actors.emailSecondary = await signIn(emailUser);
  seeded.email = emailUser;

  const emailGuardUser = await seedUser();
  actors.emailGuard = await signIn(emailGuardUser);
  seeded.emailGuard = emailGuardUser;

  // Recovery is unauthenticated, but the reset has to be shown revoking a live
  // session, so this one signs in and never uses the cookie again.
  const forgotUser = await seedUser();
  actors.forgot = await signIn(forgotUser);
  seeded.forgot = forgotUser;

  // No session: these only need an address that resolves to a real row.
  seeded.forgotRefused = await seedUser();
  seeded.enumKnown = await seedUser();
}, 120_000);

beforeEach(() => {
  // Deleting the files, not sweeping them: a fixed-window counter inside its
  // window is not expired, so the OTP send/verify budgets these routes charge
  // would deny the next test with an unexplained 429.
  resetSqliteStores();
});

describe('the deployment configuration these assertions are written against', () => {
  test('OTP is real, email is the only enabled channel, phone is present but unverifiable', () => {
    // Asserted rather than assumed: three of the describes below would pass for
    // entirely the wrong reason under a different configuration — the OTP bypass
    // commits contact changes with no code at all, and an enabled phone channel
    // turns the change-phone 503 into a send.
    expect(OTP_AUTO_VERIFY).toBe(false);
    expect(EMAIL_OTP_AVAILABLE).toBe(true);
    expect(PHONE_ENABLED).toBe(true);
    expect(PHONE_OTP_AVAILABLE).toBe(false);
  });
});

// ── 1. change-password ───────────────────────────────────────────────────────

describe('POST /api/dash/users/me/change-password — refusals', () => {
  test('no cookie is 401, and the body names nothing', async () => {
    const before = await storedHash(subject('pwGuard').userId);

    const response = await app.handle(
      anonPost(CHANGE_PASSWORD, {
        currentPassword: subject('pwGuard').password,
        newPassword: NEW_PASSWORD,
      })
    );

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    // The whole envelope, not just the status: `data` must stay null, because
    // this is the shape every unauthenticated caller sees, and a handler that
    // started returning a user id here would still be answering 401.
    expect(await bodyOf(response)).toEqual({
      success: false,
      message: MSG_LOGIN_REQUIRED,
      data: null,
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await storedHash(subject('pwGuard').userId)).toBe(before);
  });

  test('a session whose row is gone is 401, not a rotation', async () => {
    // The property `assertLiveSession` exists for, asserted on the handler its
    // docstring names. Better Auth serves the session from a signed cookie cache
    // for five minutes, so the cookie still resolves a user after the row is
    // deleted — only the live check refuses it.
    const doomed = await seedUser();
    const session = await signIn(doomed);
    await db.delete(sessions).where(eq(sessions.userId, doomed.userId));

    const response = await app.handle(
      authedPost(session, CHANGE_PASSWORD, {
        currentPassword: doomed.password,
        newPassword: NEW_PASSWORD,
      })
    );

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await messageOf(response)).toBe(MSG_LOGIN_REQUIRED);
    expect(await storedHash(doomed.userId)).toMatch(PEPPERED_HASH);
  });

  test('a missing captcha token is 403 and never reaches the password', async () => {
    const before = await storedHash(subject('pwGuard').userId);

    const response = await app.handle(
      authedPostWithoutCaptcha(actor('pwGuard'), CHANGE_PASSWORD, {
        currentPassword: subject('pwGuard').password,
        newPassword: NEW_PASSWORD,
      })
    );

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(await messageOf(response)).toBe(otpMsg.captchaFailed);
    expect(await storedHash(subject('pwGuard').userId)).toBe(before);
  });

  test('a body that is not JSON is 400', async () => {
    const response = await app.handle(
      authedPost(actor('pwGuard'), CHANGE_PASSWORD, '{"currentPassword":')
    );

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(await messageOf(response)).toBe(MSG_INVALID_INPUT);
  });

  test('a JSON array body is 400, not a 500 and not a 422', async () => {
    // `requireJsonBody` rejects an array explicitly. Without it the array would
    // reach `safeParse` and the 422 message would be about a missing field
    // rather than about the request being the wrong shape entirely.
    const response = await app.handle(
      authedPost(actor('pwGuard'), CHANGE_PASSWORD, [
        { currentPassword: 'x', newPassword: 'y' },
      ])
    );

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(await messageOf(response)).toBe(MSG_INVALID_INPUT);
  });

  test('a missing newPassword is 422 and the hash is untouched', async () => {
    const before = await storedHash(subject('pwGuard').userId);

    const response = await app.handle(
      authedPost(actor('pwGuard'), CHANGE_PASSWORD, {
        currentPassword: subject('pwGuard').password,
      })
    );

    expect(response.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(await dataOf(response)).toBeNull();
    expect(await storedHash(subject('pwGuard').userId)).toBe(before);
  });

  test('a non-string currentPassword is 422', async () => {
    const response = await app.handle(
      authedPost(actor('pwGuard'), CHANGE_PASSWORD, {
        currentPassword: 12_345,
        newPassword: NEW_PASSWORD,
      })
    );

    expect(response.status).toBe(HTTP_STATUS.UNPROCESSABLE);
  });

  test('a newPassword under the minimum is 422', async () => {
    const response = await app.handle(
      authedPost(actor('pwGuard'), CHANGE_PASSWORD, {
        currentPassword: subject('pwGuard').password,
        newPassword: 'Ab1!',
      })
    );

    expect(response.status).toBe(HTTP_STATUS.UNPROCESSABLE);
  });

  test('a newPassword over the maximum is 422', async () => {
    const response = await app.handle(
      authedPost(actor('pwGuard'), CHANGE_PASSWORD, {
        currentPassword: subject('pwGuard').password,
        newPassword: `Aa1!${'x'.repeat(130)}`,
      })
    );

    expect(response.status).toBe(HTTP_STATUS.UNPROCESSABLE);
  });

  test('newPassword equal to currentPassword is 400 BEFORE any re-auth', async () => {
    const before = await userRow(subject('pwGuard').userId);

    const response = await app.handle(
      authedPost(actor('pwGuard'), CHANGE_PASSWORD, {
        currentPassword: NEW_PASSWORD,
        newPassword: NEW_PASSWORD,
      })
    );

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(await messageOf(response)).toBe(userMsg.newPasswordSameAsCurrent);
    // The discriminator for ORDER. The pair sent above is not this user's
    // password, so if the equality check ran after `verifyLoginAttempt` the
    // failed-attempt counter would have moved and five such requests would lock
    // the account out. It has not moved, so the check is where the handler says.
    expect(await failedAttempts(subject('pwGuard').userId)).toBe(
      before.failedLoginAttempts
    );
  });

  test('a breached newPassword is 400, and is refused before the current one is checked', async () => {
    scriptBreached(NEW_PASSWORD);
    const before = await userRow(subject('pwGuard').userId);
    const hashBefore = await storedHash(subject('pwGuard').userId);

    const response = await app.handle(
      authedPost(actor('pwGuard'), CHANGE_PASSWORD, {
        currentPassword: subject('pwGuard').password,
        newPassword: NEW_PASSWORD,
      })
    );

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(await messageOf(response)).toBe(MSG_PASSWORD_COMPROMISED);
    expect(await storedHash(subject('pwGuard').userId)).toBe(hashBefore);
    // The HIBP screen runs before re-auth, so a request that was going to be
    // refused anyway does not spend one of the account's five attempts.
    expect(await failedAttempts(subject('pwGuard').userId)).toBe(
      before.failedLoginAttempts
    );
  });

  test('a wrong currentPassword is 400, charges an attempt, and writes nothing', async () => {
    const hashBefore = await storedHash(subject('pwGuard').userId);
    const attemptsBefore = await failedAttempts(subject('pwGuard').userId);
    const auditBefore = await auditRows(subject('pwGuard').userId, 'accounts');

    const response = await app.handle(
      authedPost(actor('pwGuard'), CHANGE_PASSWORD, {
        currentPassword: 'Wrong!Passw0rd',
        newPassword: NEW_PASSWORD,
      })
    );

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(await bodyOf(response)).toEqual({
      success: false,
      message: userMsg.currentPasswordIncorrect,
      data: null,
    });
    // Byte-identical, which is the only statement that distinguishes "refused"
    // from "refused after writing".
    expect(await storedHash(subject('pwGuard').userId)).toBe(hashBefore);
    // The rejection came out of `verifyLoginAttempt` and not out of an earlier
    // guard: only that path charges the lockout counter.
    expect(await failedAttempts(subject('pwGuard').userId)).toBe(
      attemptsBefore + 1
    );
    // And the audit trail records no credential mutation.
    expect(await auditRows(subject('pwGuard').userId, 'accounts')).toHaveLength(
      auditBefore.length
    );
  });
});

describe('POST /api/dash/users/me/change-password — the rotation', () => {
  test('rotates the hash, kills every other session, purges pending proofs and audits it', async () => {
    const userId = subject('pw').userId;
    const accountId = await accountIdOf(userId);
    const hashBefore = await storedHash(userId);
    const sessionsBefore = await liveSessionIds(userId);
    expect(sessionsBefore).toHaveLength(2);

    // Known Issues #1 is about a proof that outlives a rotation: an unconsumed
    // `forgot_password` code issued before the change would otherwise still
    // reset the NEW password. Seeded directly, because the point is the purge
    // and not how the row got there.
    await db.insert(verificationSessions).values({
      userId,
      channel: 'email',
      identifier: subject('pw').email,
      purpose: 'forgot_password',
      attemptNumber: 1,
    });
    expect(await proofRows(userId)).toHaveLength(1);

    const response = await app.handle(
      authedPost(actor('pwPrimary'), CHANGE_PASSWORD, {
        currentPassword: subject('pw').password,
        newPassword: NEW_PASSWORD,
      })
    );

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(await bodyOf(response)).toEqual({
      success: true,
      message: userMsg.passwordChanged,
      data: null,
    });

    const hashAfter = await storedHash(userId);
    expect(hashAfter).not.toBe(hashBefore);
    // A rehash, not a copy and not a cleartext write.
    expect(hashAfter).toMatch(PEPPERED_HASH);

    // The revocation sweep: the requesting session survives, the other does not.
    const sessionsAfter = await liveSessionIds(userId);
    expect(sessionsAfter).toHaveLength(1);
    expect(sessionsBefore).toContain(sessionsAfter[0] ?? '');

    expect(await proofRows(userId)).toEqual([]);

    const rows = await auditRows(userId, 'accounts');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recordId).toBe(accountId);
    expect(rows[0]?.action).toBe('UPDATE');
    // The flag survives the audit redactor. Its key matches the `password`
    // fragment on the denylist, and only the "a boolean is never a secret" rule
    // keeps the event from being stored empty — which is what an investigation
    // into a credential change would otherwise find instead of the change.
    expect(rows[0]?.newData).toEqual({ passwordChanged: true });
    expect(rows[0]?.apiPath).toBe(CHANGE_PASSWORD);
    expect(rows[0]?.ipAddress).toBe(TEST_IP);
    // And nothing stored the password itself under any key.
    expect(JSON.stringify(rows[0])).not.toContain(NEW_PASSWORD);
  });

  test('the old password no longer signs in and the new one does', async () => {
    const stale = await signInResponse(
      subject('pw').email,
      subject('pw').password
    );
    expect(stale.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(stale.headers.getSetCookie()).toEqual([]);
    // The generic credential message, not "your password was changed".
    expect(await stale.text()).toContain(MSG_INVALID_CREDENTIALS);

    const fresh = await signInResponse(subject('pw').email, NEW_PASSWORD);
    expect(fresh.status).toBe(HTTP_STATUS.OK);
    expect(fresh.headers.getSetCookie().length).toBeGreaterThan(0);
  });

  test('the revoked session cannot rotate the password it no longer owns', async () => {
    // The other half of the sweep, through the endpoint rather than the table:
    // the cookie is still validly signed and its cached copy still resolves a
    // user, so only the live-session check stands between it and a rotation.
    const response = await app.handle(
      authedPost(actor('pwSecondary'), CHANGE_PASSWORD, {
        currentPassword: NEW_PASSWORD,
        newPassword: 'Harness!Rotated2',
      })
    );

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await messageOf(response)).toBe(MSG_LOGIN_REQUIRED);
  });

  test('the surviving session is still usable', async () => {
    const response = await app.handle(
      authedRequest(actor('pwPrimary'), '/api/dash/users')
    );
    expect(response.status).toBe(HTTP_STATUS.OK);
  });
});

// ── 2. change-email ──────────────────────────────────────────────────────────

describe('POST /api/dash/users/me/change-email — refusals', () => {
  test('no cookie is 401 on both steps', async () => {
    const initiate = await app.handle(
      anonPost(CHANGE_EMAIL, {
        currentPassword: subject('emailGuard').password,
        newEmail: uniqueEmail('anon'),
      })
    );
    expect(initiate.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await bodyOf(initiate)).toEqual({
      success: false,
      message: MSG_LOGIN_REQUIRED,
      data: null,
    });

    const verify = await app.handle(
      anonPost(CHANGE_EMAIL_VERIFY, {
        newEmail: uniqueEmail('anon'),
        code: ARBITRARY_CODE,
      })
    );
    expect(verify.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await messageOf(verify)).toBe(MSG_LOGIN_REQUIRED);
  });

  test('a wrong currentPassword is 400, sends nothing and moves nothing', async () => {
    const userId = subject('emailGuard').userId;
    const before = await userRow(userId);

    const response = await app.handle(
      authedPost(actor('emailGuard'), CHANGE_EMAIL, {
        currentPassword: 'Wrong!Passw0rd',
        newEmail: uniqueEmail('rejected'),
      })
    );

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(await bodyOf(response)).toEqual({
      success: false,
      message: userMsg.currentPasswordIncorrect,
      data: null,
    });
    expect(await emailOf(userId)).toBe(before.email);
    // No code went to the address the caller named, so a stolen session cannot
    // be used to mail an arbitrary address without the password.
    await settleDelivery();
    expect(sentMail()).toEqual([]);
    expect(await proofRows(userId)).toEqual([]);
  });

  test('a newEmail equal to the current one is 400 and sends nothing', async () => {
    const userId = subject('emailGuard').userId;

    const response = await app.handle(
      authedPost(actor('emailGuard'), CHANGE_EMAIL, {
        currentPassword: subject('emailGuard').password,
        newEmail: subject('emailGuard').email,
      })
    );

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(await messageOf(response)).toBe(userMsg.newEmailSameAsCurrent);
    await settleDelivery();
    expect(sentMail()).toEqual([]);
    expect(await proofRows(userId)).toEqual([]);
  });

  test('a malformed address is 422 before the password is checked', async () => {
    const attemptsBefore = await failedAttempts(subject('emailGuard').userId);

    const response = await app.handle(
      authedPost(actor('emailGuard'), CHANGE_EMAIL, {
        currentPassword: 'Wrong!Passw0rd',
        newEmail: 'not-an-address',
      })
    );

    expect(response.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(await failedAttempts(subject('emailGuard').userId)).toBe(
      attemptsBefore
    );
  });

  test('a verify for an address no code was issued for is 404 and leaks nothing', async () => {
    const stranger = uniqueEmail('never');

    const response = await app.handle(
      authedPost(actor('emailGuard'), CHANGE_EMAIL_VERIFY, {
        newEmail: stranger,
        code: ARBITRARY_CODE,
      })
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    const body = await bodyOf(response);
    expect(body.data).toBeNull();
    // The proof lookup is keyed on the caller's own id, so this 404 says nothing
    // about whether the address belongs to anybody — and the message must not
    // echo the request back either.
    expect(body.message).not.toContain(stranger);
    expect(body.message).not.toContain(subject('emailGuard').userId);
  });
});

/**
 * The two-step change, in order. The code is captured in the first test because
 * the preload clears the mailbox between tests.
 */
const pendingEmail: { address: string; code: string } = {
  address: '',
  code: '',
};

describe('POST /api/dash/users/me/change-email — the two-step change', () => {
  test('initiate sends the code to the NEW address and commits nothing', async () => {
    const userId = subject('email').userId;
    const before = await userRow(userId);
    const target = uniqueEmail('moved');

    const response = await app.handle(
      authedPost(actor('emailPrimary'), CHANGE_EMAIL, {
        currentPassword: subject('email').password,
        newEmail: target,
      })
    );

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(await bodyOf(response)).toEqual({
      success: true,
      message: userMsg.emailChangeCodeSent,
      data: { otpSent: true },
    });

    // The property the whole two-step flow exists for: a session thief cannot
    // move the address, only ask for a code at an address they already control.
    const after = await userRow(userId);
    expect(after.email).toBe(before.email);
    expect(after.emailVerified).toBe(before.emailVerified);

    // Exactly one message, to the NEW address and to nothing else.
    await settleDelivery();
    expect(sentMail()).toHaveLength(1);
    const mail = await delivered();
    expect(mail.to).toBe(target);
    expect(mail.to).not.toBe(before.email);

    // The pending change lives in the proof row, bound to the new address.
    const rows = await proofRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.purpose).toBe('change_email');
    expect(rows[0]?.targetIdentifier).toBe(target);
    expect(rows[0]?.consumedAt).toBeNull();

    pendingEmail.address = target;
    pendingEmail.code = mail.code;
  });

  test('a wrong code is refused and the address stays where it was', async () => {
    if (!pendingEmail.code) throw new Error('the initiate test did not run');
    const userId = subject('email').userId;
    const before = await userRow(userId);

    const response = await app.handle(
      authedPost(actor('emailPrimary'), CHANGE_EMAIL_VERIFY, {
        newEmail: pendingEmail.address,
        code: otherThan(pendingEmail.code),
      })
    );

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(await dataOf(response)).toBeNull();
    expect(await emailOf(userId)).toBe(before.email);
    // The proof survives so the user can still finish with the real code.
    const rows = await proofRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.consumedAt).toBeNull();
  });

  test('the delivered code commits the change, revokes the other session and audits it', async () => {
    if (!pendingEmail.code) throw new Error('the initiate test did not run');
    const userId = subject('email').userId;
    const before = await userRow(userId);
    const sessionsBefore = await liveSessionIds(userId);
    expect(sessionsBefore).toHaveLength(2);

    const response = await app.handle(
      authedPost(actor('emailPrimary'), CHANGE_EMAIL_VERIFY, {
        newEmail: pendingEmail.address,
        code: pendingEmail.code,
      })
    );

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(await bodyOf(response)).toEqual({
      success: true,
      message: userMsg.emailChanged,
      data: { verified: true },
    });

    const after = await userRow(userId);
    expect(after.email).toBe(pendingEmail.address);
    expect(after.emailVerified).toBe(true);

    // Email is a credential here, so it carries the same revocation policy as
    // the password.
    const sessionsAfter = await liveSessionIds(userId);
    expect(sessionsAfter).toHaveLength(1);
    expect(sessionsBefore).toContain(sessionsAfter[0] ?? '');

    // The consumed proof survives as a single-use record; nothing else does.
    const rows = await proofRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.purpose).toBe('change_email');
    expect(rows[0]?.consumedAt).not.toBeNull();

    const userAudit = await auditRows(userId, 'users');
    const change = userAudit.filter(
      (row) =>
        (row.newData as Record<string, unknown> | null)?.email ===
        pendingEmail.address
    );
    expect(change).toHaveLength(1);
    expect(change[0]?.oldData).toEqual({
      email: before.email,
      emailVerified: before.emailVerified,
    });
    expect(change[0]?.apiPath).toBe(CHANGE_EMAIL_VERIFY);
  });

  test('the new address signs in and the old one does not', async () => {
    if (!pendingEmail.address) throw new Error('the initiate test did not run');

    const moved = await signInResponse(
      pendingEmail.address,
      subject('email').password
    );
    expect(moved.status).toBe(HTTP_STATUS.OK);

    const abandoned = await signInResponse(
      subject('email').email,
      subject('email').password
    );
    expect(abandoned.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  test('replaying the consumed code is refused', async () => {
    if (!pendingEmail.code) throw new Error('the initiate test did not run');
    const userId = subject('email').userId;

    const response = await app.handle(
      authedPost(actor('emailPrimary'), CHANGE_EMAIL_VERIFY, {
        newEmail: pendingEmail.address,
        code: pendingEmail.code,
      })
    );

    // The code row is deleted on success, so the proof cannot be spent twice.
    // A 200 here would look harmlessly idempotent while meaning that a captured
    // code stays live after it has been used.
    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(await emailOf(userId)).toBe(pendingEmail.address);
  });
});

// ── 3. forgot-password ───────────────────────────────────────────────────────

describe('POST /api/auth/forgot-password/send — the enumeration boundary', () => {
  test('an address nobody owns gets exactly what a real one gets', async () => {
    const unknownStarted = Date.now();
    const unknownResponse = await app.handle(
      anonPost(FORGOT_SEND, { channel: 'email', email: uniqueEmail('ghost') })
    );
    const unknownElapsed = Date.now() - unknownStarted;
    const unknownBody = await bodyOf(unknownResponse);
    await settleDelivery();
    const unknownMail = [...sentMail()];

    const knownStarted = Date.now();
    const knownResponse = await app.handle(
      anonPost(FORGOT_SEND, {
        channel: 'email',
        email: subject('enumKnown').email,
      })
    );
    const knownElapsed = Date.now() - knownStarted;
    const knownBody = await bodyOf(knownResponse);

    // Status, body and the delay floor are the three channels a client can
    // observe. All three have to agree, or the endpoint answers the question
    // "does this account exist".
    expect(unknownResponse.status).toBe(HTTP_STATUS.OK);
    expect(knownResponse.status).toBe(unknownResponse.status);
    expect(knownBody).toEqual(unknownBody);
    expect(unknownBody).toEqual({
      success: true,
      message: otpMsg.sendSuccess,
      data: { nextAllowedIn: 30 },
    });
    expect(unknownElapsed).toBeGreaterThanOrEqual(1500);
    expect(knownElapsed).toBeGreaterThanOrEqual(1500);

    // And the difference that must stay invisible to the client is real: only
    // the known address was mailed, and only it grew a proof row.
    expect(unknownMail).toEqual([]);
    await settleDelivery();
    expect(sentMail()).toHaveLength(1);
    await settleDelivery();
    expect(sentMail()[0]?.to).toBe(subject('enumKnown').email);
    const rows = await proofRows(subject('enumKnown').userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.purpose).toBe('forgot_password');
  });
});

describe('POST /api/auth/forgot-password/reset', () => {
  test('a wrong code and an address nobody owns are the same 400', async () => {
    const userId = subject('forgotRefused').userId;
    const hashBefore = await storedHash(userId);

    const sent = await app.handle(
      anonPost(FORGOT_SEND, {
        channel: 'email',
        email: subject('forgotRefused').email,
      })
    );
    expect(sent.status).toBe(HTTP_STATUS.OK);
    const issued = await delivered();

    const wrongCode = await app.handle(
      anonPost(FORGOT_RESET, {
        channel: 'email',
        email: subject('forgotRefused').email,
        code: otherThan(issued.code),
        newPassword: RESET_PASSWORD,
      })
    );
    const wrongCodeBody = await bodyOf(wrongCode);

    const unowned = await app.handle(
      anonPost(FORGOT_RESET, {
        channel: 'email',
        email: uniqueEmail('ghost'),
        code: ARBITRARY_CODE,
        newPassword: RESET_PASSWORD,
      })
    );
    const unownedBody = await bodyOf(unowned);

    expect(wrongCode.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(unowned.status).toBe(wrongCode.status);
    // The same answer, field for field. This is what the handler's blanket
    // collapse of every privacy-sensitive status exists to produce, and it is
    // the reason the reset path can afford to swallow its own errors.
    expect(unownedBody).toEqual(wrongCodeBody);
    expect(wrongCodeBody).toEqual({
      success: false,
      message: otpMsg.invalidOrExpired,
      data: null,
    });

    expect(await storedHash(userId)).toBe(hashBefore);
    // The old password still works, i.e. the refusal really refused.
    const stillValid = await signInResponse(
      subject('forgotRefused').email,
      subject('forgotRefused').password
    );
    expect(stillValid.status).toBe(HTTP_STATUS.OK);
  });

  test('the delivered code resets the password, revokes every session and cannot be replayed', async () => {
    const userId = subject('forgot').userId;
    const hashBefore = await storedHash(userId);
    expect(await liveSessionIds(userId)).toHaveLength(1);

    const sent = await app.handle(
      anonPost(FORGOT_SEND, {
        channel: 'email',
        email: subject('forgot').email,
      })
    );
    expect(sent.status).toBe(HTTP_STATUS.OK);
    const issued = await delivered();
    expect(issued.to).toBe(subject('forgot').email);

    const reset = await app.handle(
      anonPost(FORGOT_RESET, {
        channel: 'email',
        email: subject('forgot').email,
        code: issued.code,
        newPassword: RESET_PASSWORD,
      })
    );

    expect(reset.status).toBe(HTTP_STATUS.OK);
    expect(await bodyOf(reset)).toEqual({
      success: true,
      message: otpMsg.passwordResetSuccess,
      data: { reset: true },
    });

    const hashAfter = await storedHash(userId);
    expect(hashAfter).not.toBe(hashBefore);
    expect(hashAfter).toMatch(PEPPERED_HASH);

    // No session to keep on this path: whoever was signed in while the account
    // was compromised is signed out by the recovery.
    expect(await liveSessionIds(userId)).toEqual([]);

    const audit = await auditRows(userId, 'accounts');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.newData).toEqual({ passwordReset: true });
    expect(audit[0]?.apiPath).toBe(FORGOT_RESET);

    // Single use: the consumed proof stays as a record, its code does not.
    const replay = await app.handle(
      anonPost(FORGOT_RESET, {
        channel: 'email',
        email: subject('forgot').email,
        code: issued.code,
        newPassword: 'Harness!Reset0wo',
      })
    );
    expect(replay.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(await messageOf(replay)).toBe(otpMsg.invalidOrExpired);

    const old = await signInResponse(
      subject('forgot').email,
      subject('forgot').password
    );
    expect(old.status).toBe(HTTP_STATUS.UNAUTHORIZED);

    const fresh = await signInResponse(subject('forgot').email, RESET_PASSWORD);
    expect(fresh.status).toBe(HTTP_STATUS.OK);
  });
});

// ── 4. passwordless/send ─────────────────────────────────────────────────────

describe('POST /api/auth/passwordless/send — the enumeration boundary', () => {
  test('an address nobody owns gets exactly what a real one gets', async () => {
    const unknownStarted = Date.now();
    const unknownResponse = await app.handle(
      anonPost(PASSWORDLESS_SEND, {
        channel: 'email',
        email: uniqueEmail('ghost'),
      })
    );
    const unknownElapsed = Date.now() - unknownStarted;
    const unknownBody = await bodyOf(unknownResponse);
    await settleDelivery();
    const unknownMail = [...sentMail()];

    const knownResponse = await app.handle(
      anonPost(PASSWORDLESS_SEND, {
        channel: 'email',
        email: subject('enumKnown').email,
      })
    );
    const knownBody = await bodyOf(knownResponse);

    expect(unknownResponse.status).toBe(HTTP_STATUS.OK);
    expect(knownResponse.status).toBe(unknownResponse.status);
    expect(knownBody).toEqual(unknownBody);
    expect(unknownBody).toEqual({
      success: true,
      message: otpMsg.sendSuccess,
      data: { nextAllowedIn: 30 },
    });
    expect(unknownElapsed).toBeGreaterThanOrEqual(1500);

    expect(unknownMail).toEqual([]);
    await settleDelivery();
    expect(sentMail()).toHaveLength(1);
    await settleDelivery();
    expect(sentMail()[0]?.to).toBe(subject('enumKnown').email);

    // A DIFFERENT proof row from the recovery one this address grew earlier: the
    // purpose is part of the key, so a passwordless login code can never be
    // spent as a password reset.
    const rows = await proofRows(subject('enumKnown').userId);
    expect(rows.map((row) => row.purpose).toSorted(compareText)).toEqual([
      'forgot_password',
      'passwordless_login',
    ]);
  });

  test('a disabled channel is refused, not answered with a fake success', async () => {
    // `sms` is not in NEXT_PUBLIC_ENABLED_OTP_CHANNELS for this tier, so the
    // schema's channel refine rejects it. The generic-success collapse covers
    // 400/404 only, so the 422 still surfaces — a client asking for a transport
    // the deployment does not have is a client error, not a privacy question.
    const response = await app.handle(
      anonPost(PASSWORDLESS_SEND, {
        channel: 'sms',
        phoneNumber: '966500000001',
      })
    );

    expect(response.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(await messageOf(response)).toBe(otpMsg.invalidInput);
    await settleDelivery();
    expect(sentMail()).toEqual([]);
  });
});

// ── 5. change-phone ──────────────────────────────────────────────────────────

describe('POST /api/dash/users/me/change-phone', () => {
  test('the route exists under PHONE_NUMBER_MODE optional and is session-gated', async () => {
    // Not a 404: the endpoint 404s only when phone is disabled outright, so this
    // separates "phone is off" from "phone is on and you are anonymous".
    const response = await app.handle(
      anonPost(CHANGE_PHONE, {
        currentPassword: subject('pwGuard').password,
        newPhoneNumber: '966500000002',
        channel: 'sms',
      })
    );

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await messageOf(response)).toBe(MSG_LOGIN_REQUIRED);
  });

  test('with no phone channel enabled it is 503 and never reaches the password', async () => {
    const userId = subject('pwGuard').userId;
    const before = await userRow(userId);

    const response = await app.handle(
      authedPost(actor('pwGuard'), CHANGE_PHONE, {
        currentPassword: subject('pwGuard').password,
        newPhoneNumber: '966500000002',
        channel: 'sms',
      })
    );

    // This tier runs with NEXT_PUBLIC_ENABLED_OTP_CHANNELS=email, so no phone
    // channel can prove ownership. Refusing up front is the only alternative to
    // sending to a dead channel or stranding the change forever.
    expect(response.status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
    expect(await messageOf(response)).toBe(userMsg.verificationUnavailable);
    const after = await userRow(userId);
    expect(after.phoneNumber).toBe(before.phoneNumber);
    // The availability check precedes re-auth, so nothing was charged.
    expect(after.failedLoginAttempts).toBe(before.failedLoginAttempts);
    await settleDelivery();
    expect(sentMail()).toEqual([]);
  });

  test('verify rejects a disabled channel at the schema, and is session-gated', async () => {
    const anonymous = await app.handle(
      anonPost(CHANGE_PHONE_VERIFY, {
        newPhoneNumber: '966500000002',
        channel: 'sms',
        code: ARBITRARY_CODE,
      })
    );
    expect(anonymous.status).toBe(HTTP_STATUS.UNAUTHORIZED);

    const authenticated = await app.handle(
      authedPost(actor('pwGuard'), CHANGE_PHONE_VERIFY, {
        newPhoneNumber: '966500000002',
        channel: 'sms',
        code: ARBITRARY_CODE,
      })
    );
    expect(authenticated.status).toBe(HTTP_STATUS.UNPROCESSABLE);
    expect(await phoneOf(subject('pwGuard').userId)).toBeNull();
  });
});
