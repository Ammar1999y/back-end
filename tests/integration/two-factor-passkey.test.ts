/**
 * Passkey as a SECOND factor, and the direct sign-in path that must stay shut.
 *
 * The WebAuthn ceremony needs a browser and an authenticator, so what is
 * asserted is everything around it: that the plugin's own authentication
 * endpoints are unreachable, that the second-factor endpoints refuse anything
 * that is not a live challenge, and that an assertion naming another user's
 * credential is rejected — the case an `allowCredentials` hint cannot catch,
 * because a client can ignore that hint.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SeededUser } from '../helpers/session';

import { and, eq, sql } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import {
  auditLogs,
  passkeys,
  trustedDevices,
  twoFactorCredentials,
  twoFactorMethods,
  users,
} from '@/db/schema';
import { symmetricEncrypt } from 'better-auth/crypto';
import { advancePasskeyCounter } from '@/lib/auth/two-factor-passkey';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { HTTP_STATUS } from '@/utils/api-messages';
import { NAME_MAX } from '@/utils/validation/constants';

import { resetTables } from '../helpers/database';
import { scriptEgress } from '../helpers/egress';
import { baseHeaders, seedUser, uniquePhone } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';
import { buildRegistrationResponse } from '../helpers/webauthn';

const TURNSTILE_HOST = 'challenges.cloudflare.com';

const fixture: { withPasskey: SeededUser | null; other: SeededUser | null } = {
  withPasskey: null,
  other: null,
};

function withPasskey(): SeededUser {
  if (!fixture.withPasskey) throw new Error('fixture not seeded');
  return fixture.withPasskey;
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
      ...(method === 'POST' && { body: JSON.stringify(body ?? {}) }),
    })
  );
}

/**
 * A passkey row, written directly.
 *
 * Registration is a browser ceremony, and what this file tests is the ASSERTION
 * side — which needs a credential to exist, not one to have been created through
 * WebAuthn. The public key is never reached: every case here is refused before
 * signature verification.
 */
async function givePasskey(userId: string, credentialID: string) {
  await db.insert(passkeys).values({
    userId,
    credentialID,
    publicKey: Buffer.from('not-a-real-key').toString('base64'),
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
  });
  await db.insert(twoFactorMethods).values({ userId, method: 'passkey' });
  await db
    .update(users)
    .set({ twoFactorEnabled: true })
    .where(eq(users.id, userId));
}

async function signIn(user: SeededUser) {
  const response = await call('POST', '/api/auth/sign-in/email', {
    email: user.email,
    password: user.password,
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    cookie: cookieHeader(response.headers.getSetCookie()),
  };
}

beforeAll(async () => {
  await resetTables();
  await resetSqliteStores();
  scriptEgress(TURNSTILE_HOST, () => Response.json({ success: true }));

  fixture.withPasskey = await seedUser();
  fixture.other = await seedUser();
  await givePasskey(withPasskey().userId, 'harness-credential-one');
  if (fixture.other)
    await givePasskey(fixture.other.userId, 'harness-credential-two');
});

describe('registering a passkey', () => {
  const RP_ID = new URL(PUBLIC_ORIGIN).hostname;

  async function register(user: SeededUser, userVerified: boolean) {
    const signedIn = await signIn(user);
    expect(signedIn.status).toBe(HTTP_STATUS.OK);

    // ⚠️ The ceremony spans two requests with the library's own bodies, so the
    // password cannot ride on it. It is proven once here and spent by
    // `verify-registration` — without which a ten-hour-old session added a
    // second factor with no proof at all.
    const granted = await call(
      'POST',
      '/api/auth/two-factor/passkey/grant',
      { password: user.password },
      signedIn.cookie
    );
    expect(granted.status).toBe(HTTP_STATUS.OK);
    const grant = ((await granted.json()) as { data?: { grant?: string } }).data
      ?.grant;
    expect(grant).toBeDefined();

    const optionsResponse = await call(
      'GET',
      '/api/auth/passkey/generate-register-options',
      undefined,
      signedIn.cookie
    );
    expect(optionsResponse.status).toBe(HTTP_STATUS.OK);
    const options = (await optionsResponse.json()) as { challenge: string };
    const jar = [
      signedIn.cookie,
      cookieHeader(optionsResponse.headers.getSetCookie()),
    ]
      .filter(Boolean)
      .join('; ');

    const ceremony = buildRegistrationResponse({
      challenge: options.challenge,
      origin: PUBLIC_ORIGIN,
      rpId: RP_ID,
      userVerified,
    });

    const verified = await call(
      'POST',
      '/api/auth/passkey/verify-registration',
      { response: ceremony.response, grant },
      jar
    );
    return { verified, credentialId: ceremony.credentialId };
  }

  test('refuses inputs this schema could not store', async () => {
    // ⚠️ The plugin's own bodies are an unbounded `name` and a plain `string`
    // id, while this schema stores `varchar(150)` and a UUID. An overlong name
    // reached the database and answered 500; a malformed id reached a UUID
    // comparison instead of a validation response. Both on an authenticated
    // surface whose contract is a 4xx envelope everywhere else.
    const user = await seedUser();
    const signedIn = await signIn(user);

    const overlong = await call(
      'POST',
      '/api/auth/passkey/update-passkey',
      { id: crypto.randomUUID(), name: 'x'.repeat(NAME_MAX + 1) },
      signedIn.cookie
    );
    expect(overlong.status).toBe(HTTP_STATUS.UNPROCESSABLE);

    const malformed = await call(
      'POST',
      '/api/auth/passkey/delete-passkey',
      { id: 'not-a-uuid' },
      signedIn.cookie
    );
    expect(malformed.status).toBe(HTTP_STATUS.UNPROCESSABLE);
  });

  test('refuses a ceremony with no re-authentication grant', async () => {
    const user = await seedUser();
    const signedIn = await signIn(user);
    const optionsResponse = await call(
      'GET',
      '/api/auth/passkey/generate-register-options',
      undefined,
      signedIn.cookie
    );
    const options = (await optionsResponse.json()) as { challenge: string };
    const jar = [
      signedIn.cookie,
      cookieHeader(optionsResponse.headers.getSetCookie()),
    ]
      .filter(Boolean)
      .join('; ');

    const ceremony = buildRegistrationResponse({
      challenge: options.challenge,
      origin: PUBLIC_ORIGIN,
      rpId: RP_ID,
      userVerified: true,
    });
    const verified = await call(
      'POST',
      '/api/auth/passkey/verify-registration',
      { response: ceremony.response },
      jar
    );
    expect(verified.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    const rows = await db
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.credentialID, ceremony.credentialId));
    expect(rows).toHaveLength(0);
  });

  test('refuses an authenticator that did not verify the user', async () => {
    // ⚠️ The SIGNED bit, not the requested option. The plugin's own
    // `/passkey/verify-registration` passes `requireUserVerification: false`, so
    // `authenticatorSelection.userVerification: 'required'` is a hint a client
    // can drop — this ceremony drops it. Our assertion path DOES require user
    // verification, so a credential admitted here is inert: the user holds a
    // second factor that fails every login, and is locked out if it is the only
    // one.
    const user = await seedUser();
    const { verified, credentialId } = await register(user, false);

    expect(verified.status).not.toBe(HTTP_STATUS.OK);
    const rows = await db
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.credentialID, credentialId));
    // Refused BEFORE the row is written, not cleaned up afterwards.
    expect(rows).toHaveLength(0);
  });

  test('accepts an authenticator that did', async () => {
    const user = await seedUser();
    // A second device, signed in before the ceremony: adding a method evicts
    // it and keeps the registering session.
    const otherDevice = await signIn(user);
    expect(otherDevice.status).toBe(HTTP_STATUS.OK);
    const { verified, credentialId } = await register(user, true);

    expect(verified.status).toBe(HTTP_STATUS.OK);
    const sessions = await db.query.sessions.findMany({
      where: (session, { eq: is }) => is(session.userId, user.userId),
    });
    expect(sessions).toHaveLength(1);
    const rows = await db
      .select({ id: passkeys.id, userId: passkeys.userId })
      .from(passkeys)
      .where(eq(passkeys.credentialID, credentialId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(user.userId);

    // And it is a second factor from this moment, attributably: the intent row
    // and the lifecycle event are written together.
    const methods = await db
      .select({ method: twoFactorMethods.method })
      .from(twoFactorMethods)
      .where(eq(twoFactorMethods.userId, user.userId));
    expect(methods.map((row) => row.method)).toEqual(['passkey']);
    const added = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.userId, user.userId),
          sql`${auditLogs.newData} ->> 'twoFactorMethodAdded' = 'passkey'`
        )
      );
    expect(added).toHaveLength(1);
  });
});

describe('deleting a passkey', () => {
  /** The grant the delete spends, minted on a fresh session for `user`. */
  async function grantFor(user: SeededUser) {
    const signedIn = await signIn(user);
    expect(signedIn.status).toBe(HTTP_STATUS.OK);
    const granted = await call(
      'POST',
      '/api/auth/two-factor/passkey/grant',
      { password: user.password },
      signedIn.cookie
    );
    expect(granted.status).toBe(HTTP_STATUS.OK);
    const grant = ((await granted.json()) as { data?: { grant?: string } }).data
      ?.grant;
    return { cookie: signedIn.cookie, grant };
  }

  async function passkeyRowId(credentialID: string): Promise<string> {
    const [row] = await db
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.credentialID, credentialID));
    if (!row) throw new Error('no passkey row');
    return row.id;
  }

  test('the last passkey of a passkey-only account is refused, like any last method', async () => {
    // ⚠️ The plugin's own endpoint deleted the row and nothing else, so the
    // account stayed two-factor-enabled with an intent row, no credential and a
    // 403 at its next sign-in — the state `/two-factor/methods/disable` refuses
    // to produce with its last-method rule. Same rule, same answer.
    const user = await seedUser();
    // A user with no second factor signs in to a session; the passkey is added
    // to an already-signed-in account, as it would be in settings.
    const { cookie, grant } = await grantFor(user);
    await givePasskey(user.userId, 'harness-only-credential');
    const id = await passkeyRowId('harness-only-credential');

    const refused = await call(
      'POST',
      '/api/auth/passkey/delete-passkey',
      { id, grant },
      cookie
    );
    expect(refused.status).toBe(HTTP_STATUS.CONFLICT);
    const rows = await db
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.id, id));
    expect(rows).toHaveLength(1);
  });

  test('the last passkey goes when another method remains, and takes the method and every trusted device with it', async () => {
    const user = await seedUser();
    const { cookie, grant } = await grantFor(user);
    await givePasskey(user.userId, 'harness-removable-credential');
    // A USABLE second method: a `totp` row with no verified secret is not a
    // factor a challenge would offer, and the removal would then be refused as
    // stranding.
    await db.insert(twoFactorCredentials).values({
      userId: user.userId,
      secret: await symmetricEncrypt({
        key: process.env.BETTER_AUTH_SECRET ?? '',
        data: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      }),
      backupCodes: await symmetricEncrypt({
        key: process.env.BETTER_AUTH_SECRET ?? '',
        data: '[]',
      }),
      verified: true,
    });
    await db.insert(twoFactorMethods).values({
      userId: user.userId,
      method: 'totp',
    });
    // A device trusted against the factor about to go. Removing a method
    // revokes trust — a standing skip of a factor that no longer exists.
    await db.insert(trustedDevices).values({
      userId: user.userId,
      trustIdentifier: 'trust-device-harness-passkey',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const id = await passkeyRowId('harness-removable-credential');

    const deleted = await call(
      'POST',
      '/api/auth/passkey/delete-passkey',
      { id, grant },
      cookie
    );
    expect(deleted.status).toBe(HTTP_STATUS.OK);

    const remainingPasskeys = await db
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.userId, user.userId));
    expect(remainingPasskeys).toHaveLength(0);
    const methods = await db
      .select({ method: twoFactorMethods.method })
      .from(twoFactorMethods)
      .where(eq(twoFactorMethods.userId, user.userId));
    expect(methods.map((row) => row.method)).toEqual(['totp']);
    const trust = await db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, user.userId));
    expect(trust).toHaveLength(0);
  });

  test("another user's passkey answers as if it did not exist", async () => {
    const intruder = await seedUser();
    const { cookie, grant } = await grantFor(intruder);
    const victimId = await passkeyRowId('harness-credential-one');

    const refused = await call(
      'POST',
      '/api/auth/passkey/delete-passkey',
      { id: victimId, grant },
      cookie
    );
    expect(refused.status).toBe(HTTP_STATUS.NOT_FOUND);
    const rows = await db
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.id, victimId));
    expect(rows).toHaveLength(1);
  });
});

describe('the direct passkey sign-in path', () => {
  test('is not routed, so a passkey cannot replace the password', async () => {
    // The bypass this whole design exists to refuse. `verify-authentication`
    // looks a credential up by id ALONE and issues a session to its owner — if
    // it were reachable, a passkey would be a full login and the password step
    // would be decorative.
    for (const path of [
      '/api/auth/passkey/verify-authentication',
      '/api/auth/passkey/generate-authenticate-options',
      '/api/auth/sign-in/passkey',
    ]) {
      const response = await call('POST', path, {
        response: { id: 'harness-credential-one' },
      });
      expect(response.status, path).toBe(HTTP_STATUS.NOT_FOUND);
    }
  });
});

describe('signing in with a passkey second factor', () => {
  test('the password alone is refused and passkey is offered', async () => {
    const attempt = await signIn(withPasskey());
    expect(attempt.body).toMatchObject({
      twoFactorRedirect: true,
      twoFactorMethods: ['passkey'],
    });
    expect(attempt.cookie).not.toContain('session_token');
  });

  test('the ceremony cannot be started without a challenge', async () => {
    const response = await call('POST', '/api/auth/two-factor/passkey/options');
    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  test('the ceremony cannot be completed without a challenge', async () => {
    const response = await call('POST', '/api/auth/two-factor/passkey/verify', {
      response: { id: 'harness-credential-one' },
    });
    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  test('a challenge yields options scoped to that user alone', async () => {
    const attempt = await signIn(withPasskey());
    const response = await call(
      'POST',
      '/api/auth/two-factor/passkey/options',
      {},
      attempt.cookie
    );
    expect(response.status).toBe(HTTP_STATUS.OK);

    const body = (await response.json()) as {
      data: { challenge: string; allowCredentials: { id: string }[] };
    };
    expect(body.data.challenge).toBeTruthy();
    // Only this user's credential. The other user's exists and must not appear:
    // offering it would invite the wrong account to be proven.
    expect(body.data.allowCredentials.map((c) => c.id)).toEqual([
      'harness-credential-one',
    ]);
  });

  test("an assertion naming another user's credential is refused", async () => {
    const attempt = await signIn(withPasskey());
    await call(
      'POST',
      '/api/auth/two-factor/passkey/options',
      {},
      attempt.cookie
    );

    // `allowCredentials` is a hint the client may ignore, so the server looks
    // the credential up UNDER the challenge user. This is exactly the check the
    // plugin's own endpoint does not make — it resolves by credential id alone.
    const response = await call(
      'POST',
      '/api/auth/two-factor/passkey/verify',
      { response: { id: 'harness-credential-two' } },
      attempt.cookie
    );
    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  test('a user with 2FA on but nothing enrolled is refused the login', async () => {
    const plain = await seedUser();
    await db
      .update(users)
      .set({ twoFactorEnabled: true })
      .where(eq(users.id, plain.userId));

    // Fail closed. An empty offered set used to complete the login and write an
    // audit row; a third party can produce that state through an ordinary
    // contact edit, which made `users.edit` a way to disarm someone else's
    // second factor. The exit for this user is the administrative reset.
    const attempt = await signIn(plain);
    expect(attempt.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(attempt.body.twoFactorRedirect).toBeUndefined();

    // And no usable session came back with the refusal.
    const session = await call(
      'GET',
      '/api/auth/get-session',
      undefined,
      attempt.cookie
    );
    expect(await session.json()).toBeNull();
  });

  test('a challenge that does not offer passkey refuses the ceremony', async () => {
    // The other half, and the one that distinguishes 400 from 401: a LIVE
    // challenge exists, but this user's second factor is an OTP. Starting a
    // passkey ceremony on it must fail as "not for this challenge" rather than
    // as "no challenge".
    const otpUser = await seedUser({
      phoneNumber: uniquePhone(),
      phoneNumberVerified: true,
    });
    await db
      .insert(twoFactorMethods)
      .values({ userId: otpUser.userId, method: 'otp', channel: 'sms' });
    await db
      .update(users)
      .set({ twoFactorEnabled: true })
      .where(eq(users.id, otpUser.userId));

    const attempt = await signIn(otpUser);
    expect(attempt.body).toMatchObject({ twoFactorMethods: ['otp'] });

    const response = await call(
      'POST',
      '/api/auth/two-factor/passkey/options',
      {},
      attempt.cookie
    );
    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });
});

describe('the signature counter', () => {
  async function counterOf(passkeyId: string): Promise<number | undefined> {
    const [after] = await db
      .select({ counter: passkeys.counter })
      .from(passkeys)
      .where(eq(passkeys.id, passkeyId));
    return after?.counter;
  }

  async function seedCredential(credentialID: string): Promise<string> {
    const owner = await seedUser();
    await givePasskey(owner.userId, credentialID);
    const [row] = await db
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.credentialID, credentialID));
    expect(row?.id).toBeDefined();
    return row?.id ?? '';
  }

  test('keeps the HIGHER of two concurrent assertions, whichever lands first', async () => {
    // The direction that matters, and the one a compare-and-swap gets wrong.
    // Two concurrent assertions both read the stored value; the one carrying the
    // LOWER new counter lands first. A swap on the read value then rejects the
    // higher one and the row keeps the lower, so a clone replaying every value
    // in between passes the monotonicity check the counter exists to provide.
    const passkeyId = await seedCredential('harness-credential-counter-lower');
    if (!passkeyId) return;

    expect(await advancePasskeyCounter(passkeyId, 4)).toBe(true);
    expect(await advancePasskeyCounter(passkeyId, 9)).toBe(true);
    expect(await counterOf(passkeyId)).toBe(9);
  });

  test('refuses to move backwards, and reports the write as not needed', async () => {
    const passkeyId = await seedCredential('harness-credential-counter-higher');
    if (!passkeyId) return;

    expect(await advancePasskeyCounter(passkeyId, 9)).toBe(true);
    // Already at least 9: nothing to write, and the caller logs rather than
    // failing the sign-in.
    expect(await advancePasskeyCounter(passkeyId, 4)).toBe(false);
    expect(await counterOf(passkeyId)).toBe(9);

    expect(await advancePasskeyCounter(passkeyId, 10)).toBe(true);
    expect(await counterOf(passkeyId)).toBe(10);
  });
});
