/**
 * The response an ANONYMOUS verification endpoint gives once a proof row crosses
 * its attempt threshold, compared against the response an address with no account
 * gets for the same request.
 *
 * This is the property the collapse exists for, and it was one-sided. A proof row
 * exists only for a real account, so its throttle is account-dependent:
 * `processOtpVerify` turns the fifth wrong code for an existing proof into a
 * `429` carrying the block message and `Retry-After: 21600`, while an unknown
 * address keeps taking the generic `400`. `POST /api/auth/otp/verify` collapsed
 * that; recovery and passwordless did not — recovery preserves every 429 through
 * its status filter, and passwordless preserves it through `toAuthApiError`. Five
 * CAPTCHA-solvable requests then distinguished an active account by status,
 * header and body, and left the real proof in a six-hour blocked state as a side
 * effect.
 *
 * `collapseProofThrottle` (`utils/otp.ts`) is the shared fix: `blockedError`
 * marks the error with `OTP_PROOF_THROTTLE_CODE`, and every anonymous boundary
 * collapses THAT KIND rather than collapsing 429 by status — so a pre-lookup
 * IP or destination limiter, which fires for real and fake identifiers alike,
 * still surfaces its own 429 and its own `Retry-After`.
 *
 * Each block below drives the real address to its threshold and then compares
 * exactly one crossing attempt against one unknown-address attempt. That is what
 * the finding is about, and it keeps the cost bounded: every request here pays
 * the endpoint's 1.5 s timing floor.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { SeedOptions } from '../helpers/session';
import type { OtpPurpose } from '@/utils/validation/otp';

import { and, eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { verificationCodes, verificationSessions } from '@/db/schema';

import { HTTP_STATUS } from '@/utils/api-messages';
import { OTP_MAX_VERIFY_ATTEMPTS } from '@/utils/validation/constants';

import { resetTables } from '../helpers/database';
import { settleDelivery } from '../helpers/mailbox';
import { baseHeaders, seedUser } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

/** Never the code a send issued, so every attempt below is a wrong guess. */
const WRONG_CODE = '000000';
const UNKNOWN_EMAIL = 'otp.enumeration.nobody@gmail.com';
const NEW_PASSWORD = 'Harness!Reset1';

function post(path: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: baseHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
  );
}

/** What a caller can actually observe, and therefore what must not differ. */
interface Observed {
  status: number;
  retryAfter: string | null;
  message: string;
}

async function observe(response: Response): Promise<Observed> {
  const body = (await response.json()) as { message?: string };
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    message: body.message ?? '',
  };
}

interface Surface {
  name: string;
  /**
   * The account state this surface's SEND actually issues a code for.
   *
   * Contact verification needs `emailVerified: false`, and it is the difference
   * between a real test and a vacuous one: `POST /api/auth/otp/send`
   * short-circuits to the generic 200 for an already-verified contact before
   * `processOtpSend` runs, so with `seedUser()`'s default no
   * `verification_sessions` row is written, every attempt below returns the "no
   * session" 404, and the block passes identically against unfixed code.
   */
  seed?: SeedOptions;
  /** The proof row the loop must actually drive to its threshold. */
  purpose: OtpPurpose;
  send: (email: string) => Promise<Response>;
  verify: (email: string) => Promise<Response>;
}

const SURFACES: readonly Surface[] = [
  {
    name: 'contact verification',
    seed: { emailVerified: false },
    purpose: 'verify_contact',
    send: (email) => post('/api/auth/otp/send', { channel: 'email', email }),
    verify: (email) =>
      post('/api/auth/otp/verify', {
        channel: 'email',
        email,
        code: WRONG_CODE,
      }),
  },
  {
    name: 'password recovery',
    purpose: 'forgot_password',
    send: (email) =>
      post('/api/auth/forgot-password/send', { channel: 'email', email }),
    verify: (email) =>
      post('/api/auth/forgot-password/reset', {
        channel: 'email',
        email,
        code: WRONG_CODE,
        newPassword: NEW_PASSWORD,
      }),
  },
  {
    name: 'passwordless login',
    purpose: 'passwordless_login',
    send: (email) =>
      post('/api/auth/passwordless/send', { channel: 'email', email }),
    verify: (email) =>
      post('/api/auth/passwordless/verify', {
        channel: 'email',
        email,
        code: WRONG_CODE,
      }),
  },
];

/** The proof row this surface's loop was supposed to be charging. */
async function proofRow(userId: string, purpose: OtpPurpose) {
  const [row] = await db
    .select({
      id: verificationSessions.id,
      verifyAttemptNumber: verificationSessions.verifyAttemptNumber,
      isBlocked: verificationSessions.isBlocked,
    })
    .from(verificationSessions)
    .where(
      and(
        eq(verificationSessions.userId, userId),
        eq(verificationSessions.purpose, purpose)
      )
    );
  return row ?? null;
}

describe('crossing the proof-attempt threshold reveals nothing', () => {
  beforeEach(async () => {
    // A fresh proof row per surface, and a fresh send-cycle: the previous
    // surface's failures live on their own `(user, contactKind, purpose)` row,
    // but the send quotas are per destination.
    await resetTables();
    // And a fresh limiter: this file issues 21 verify and 3 send requests
    // against FIXED-WINDOW keys derived from `TEST_IP`, which persist across
    // files in one `bun test` process. A stale counter from a sibling shows up
    // here as a broken parity assertion rather than as a 429.
    resetSqliteStores();
  });

  test.each(SURFACES.map((surface) => [surface.name, surface] as const))(
    '%s answers the same past the threshold as for an unknown address',
    async (_name, surface) => {
      const user = await seedUser(surface.seed);

      // A real proof row, so the attempt counters below have something to
      // charge. The unknown address deliberately gets no send — there is no
      // account, so there is no row to create, which is the asymmetry the
      // response must not expose.
      const sent = await surface.send(user.email);
      expect(sent.status).toBe(HTTP_STATUS.OK);
      await settleDelivery();

      // The row has to EXIST before the loop, or every attempt below answers
      // "no session" and the surface proves nothing.
      expect(await proofRow(user.userId, surface.purpose)).toMatchObject({
        verifyAttemptNumber: 0,
        isBlocked: false,
      });

      const real: Observed[] = [];
      for (let attempt = 1; attempt <= OTP_MAX_VERIFY_ATTEMPTS + 1; attempt++)
        real.push(await observe(await surface.verify(user.email)));

      // The threshold was actually CROSSED. Without this the block is satisfied
      // by six identical 404s and cannot tell `collapseProofThrottle` from its
      // absence.
      expect(await proofRow(user.userId, surface.purpose)).toMatchObject({
        isBlocked: true,
      });

      const unknown = await observe(await surface.verify(UNKNOWN_EMAIL));

      // The crossing attempt is the one that used to differ.
      const crossing = real.at(-1);
      expect(crossing).toEqual(unknown);

      // And every attempt before it, so the answer is constant rather than
      // merely equal at the boundary.
      for (const observed of real) expect(observed).toEqual(unknown);

      // Positively: the shared answer is the generic 400 with no backoff hint,
      // not a 429 that both happen to give.
      expect(unknown.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(unknown.retryAfter).toBeNull();
    },
    120_000
  );
});

/**
 * An `o1:` envelope naming a key generation the keyring no longer holds.
 *
 * `canEvaluateOtp` answers `false` for exactly this and nothing else, and the
 * pair below is why that question exists: `verifyOtpCode` THROWS here — which an
 * operator has to see — but a throw on an anonymous verification path rolls the
 * transaction back into a 500, while an unknown identifier keeps taking the
 * generic 400. Five requests then distinguish a real live proof from a
 * nonexistent account, on a mistimed key rotation, with no credential at all.
 *
 * The key id is well-formed (`KEY_ID_PATTERN`) and the MAC is the right length,
 * so it reaches `getOtpKey` rather than being refused as malformed — a malformed
 * envelope is EVALUABLE and takes the ordinary wrong-code path.
 */
const REMOVED_KEY_HASH = `o1:removedgen:${'A'.repeat(43)}`;

describe('a proof hashed under a removed key reveals nothing either', () => {
  beforeEach(async () => {
    await resetTables();
    resetSqliteStores();
  });

  test.each(SURFACES.map((surface) => [surface.name, surface] as const))(
    '%s answers the same as for an unknown address',
    async (_name, surface) => {
      const user = await seedUser(surface.seed);
      const sent = await surface.send(user.email);
      expect(sent.status).toBe(HTTP_STATUS.OK);
      await settleDelivery();

      const row = await proofRow(user.userId, surface.purpose);
      expect(row).not.toBeNull();

      // The real row, its stored code replaced with one no configured key can
      // evaluate. Everything else about the request is unchanged.
      const updated = await db
        .update(verificationCodes)
        .set({ code: REMOVED_KEY_HASH })
        .where(eq(verificationCodes.sessionId, row?.id ?? ''))
        .returning({ id: verificationCodes.id });
      expect(updated).toHaveLength(1);

      const observed = await observe(await surface.verify(user.email));
      const unknown = await observe(await surface.verify(UNKNOWN_EMAIL));

      expect(observed).toEqual(unknown);
      // Positively: the generic 400, not the 500 the throw used to produce.
      expect(observed.status).toBe(HTTP_STATUS.BAD_REQUEST);
    },
    120_000
  );
});
