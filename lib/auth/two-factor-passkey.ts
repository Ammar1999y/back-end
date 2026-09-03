/**
 * Passkey as a SECOND factor, which the passkey plugin does not offer.
 *
 * ⚠️ The plugin's `/passkey/verify-authentication` resolves a credential by
 * `credentialID` alone and calls `createSession(passkey.userId)` — a complete
 * unauthenticated sign-in endpoint. It and
 * `/passkey/generate-authenticate-options` must stay absent from
 * `BETTER_AUTH_ENDPOINTS`, unconditionally and with no flag.
 *
 * The assertion here is bound to the pending challenge twice, and neither half
 * is optional: `allowCredentials` is scoped to the challenge user (a browser
 * hint, not a guarantee), and the stored credential is looked up UNDER that user
 * so a mismatch cannot resolve at all.
 */
import type { AuthContext } from './two-factor-challenge';
import type { EntityID } from '@/types';

import { and, eq, lt } from 'drizzle-orm';

import { twoFactorMsg } from '@/app/api/auth/otp/messages';
import { db, withTransaction } from '@/db';
import { passkeys, verifications } from '@/db/schema';
import { sanitizeForLog } from '@/utils';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import * as z from 'zod';

import { CUSTOM_AUTH_CODE, HTTP_STATUS } from '@/utils/api-messages';
import { VERIFICATION_IDENTIFIER_MAX } from '@/utils/validation/constants';
import {
  isTwoFactorMethodEnabled,
  twoFactorPasskeyVerifySchema,
} from '@/utils/validation/two-factor';

import { PUBLIC_ORIGIN } from '../env';
import { envelopeResponse } from './plugin-openapi';
import {
  completeTwoFactorChallenge,
  resolveTwoFactorChallenge,
  spendChallengeAttempt,
} from './two-factor-challenge';

/**
 * Must equal what the plugin's `getRpID` computes at registration — a credential
 * registered under one RP ID cannot be asserted under another — so it is derived
 * from the same source rather than configured twice.
 */
const RP_ID = new URL(PUBLIC_ORIGIN).hostname;

/** Taken from the library's option type: a local copy would silently narrow it. */
type AuthenticatorTransportFuture = NonNullable<
  NonNullable<
    Parameters<typeof generateAuthenticationOptions>[0]['allowCredentials']
  >[number]['transports']
>[number];

const CHALLENGE_MAX_AGE_S = 300;

/**
 * Keyed by the 2FA challenge id rather than a cookie of its own, which is what
 * makes the ceremony inseparable from the sign-in it belongs to: one started
 * under one challenge cannot be completed under another.
 */
function ceremonyIdentifier(challengeId: string): string {
  return `2fa-webauthn-${challengeId}`.slice(0, VERIFICATION_IDENTIFIER_MAX);
}

async function requireChallenge(ctx: AuthContext) {
  const challenge = await resolveTwoFactorChallenge(ctx);
  if (!challenge)
    throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
      message: twoFactorMsg.challengeMissing,
      code: CUSTOM_AUTH_CODE,
    });
  if (!challenge.methods.includes('passkey'))
    throw new APIError(HTTP_STATUS.BAD_REQUEST, {
      message: twoFactorMsg.methodUnavailable,
      code: CUSTOM_AUTH_CODE,
    });
  return challenge;
}

/**
 * Raises a credential's signature counter to `to`, and never lowers it.
 *
 * ⚠️ A monotonic maximum, NOT a compare-and-swap on the value the assertion was
 * verified against. Under a swap, two concurrent assertions that both read 3
 * resolve as "3→4 lands, 3→9 loses" and the row keeps 4 — so a cloned
 * authenticator replaying 5 through 8 passes the monotonicity check the counter
 * exists to provide. `WHERE counter < to` keeps the higher of the two, and "no
 * row updated" then means the stored value is already at least `to`, which is
 * the outcome we want rather than a failure.
 *
 * Exported for its own test: the ceremony cannot be driven without a real
 * authenticator, so this write is the only part of the counter path a test can
 * reach, and it is the part that matters.
 */
export async function advancePasskeyCounter(
  passkeyId: string,
  to: number
): Promise<boolean> {
  // An authenticator that implements no counter reports 0 for every assertion,
  // which SimpleWebAuthn accepts. There is nothing to advance and nothing to
  // reconcile, and without this every such sign-in would log.
  if (to === 0) return true;

  const [advanced] = await db
    .update(passkeys)
    .set({ counter: to })
    .where(and(eq(passkeys.id, passkeyId), lt(passkeys.counter, to)))
    .returning({ id: passkeys.id });
  return Boolean(advanced);
}

async function userPasskeys(userId: EntityID) {
  return db
    .select({
      credentialID: passkeys.credentialID,
      publicKey: passkeys.publicKey,
      counter: passkeys.counter,
      transports: passkeys.transports,
      userId: passkeys.userId,
    })
    .from(passkeys)
    .where(eq(passkeys.userId, userId));
}

export const twoFactorPasskey = () =>
  ({
    id: 'two-factor-passkey',
    endpoints: {
      twoFactorPasskeyOptions: createAuthEndpoint(
        '/two-factor/passkey/options',
        {
          method: 'POST',
          metadata: {
            openapi: envelopeResponse(
              'WebAuthn authentication options, scoped to the challenge user.',
              { type: 'object' }
            ),
          },
        },
        async (ctx) => {
          const challenge = await requireChallenge(ctx);
          const credentials = await userPasskeys(challenge.user.id);
          if (credentials.length === 0)
            throw new APIError(HTTP_STATUS.BAD_REQUEST, {
              message: twoFactorMsg.methodUnavailable,
              code: CUSTOM_AUTH_CODE,
            });

          const options = await generateAuthenticationOptions({
            rpID: RP_ID,
            // A second factor must prove a person, not just a device: without
            // user verification a stolen unlocked laptop asserts silently.
            userVerification: 'required',
            allowCredentials: credentials.map((credential) => ({
              id: credential.credentialID,
              transports: credential.transports
                ? (credential.transports.split(
                    ','
                  ) as AuthenticatorTransportFuture[])
                : undefined,
            })),
          });

          // Replacing any previous ceremony for this challenge is deliberate:
          // only the newest options stay live.
          await withTransaction(async (tx) => {
            await tx
              .delete(verifications)
              .where(
                eq(
                  verifications.identifier,
                  ceremonyIdentifier(challenge.challengeId)
                )
              );
            await tx.insert(verifications).values({
              identifier: ceremonyIdentifier(challenge.challengeId),
              value: options.challenge,
              expiresAt: new Date(Date.now() + CHALLENGE_MAX_AGE_S * 1000),
            });
          });

          return ctx.json({ success: true, data: options });
        }
      ),

      twoFactorPasskeyVerify: createAuthEndpoint(
        '/two-factor/passkey/verify',
        {
          method: 'POST',
          body: z.record(z.string(), z.unknown()),
          metadata: {
            openapi: envelopeResponse(
              'The passkey assertion was verified and the sign-in completed.'
            ),
          },
        },
        async (ctx) => {
          const challenge = await requireChallenge(ctx);

          const parsed = twoFactorPasskeyVerifySchema.safeParse(ctx.body);
          if (!parsed.success)
            throw new APIError(HTTP_STATUS.UNPROCESSABLE, {
              message: twoFactorMsg.invalidCode,
              code: CUSTOM_AUTH_CODE,
            });
          const { response } = parsed.data;

          const attempt = await spendChallengeAttempt(
            ctx,
            challenge.challengeId
          );
          if (!attempt.ok)
            throw new APIError(HTTP_STATUS.BAD_REQUEST, {
              message: twoFactorMsg.tooManyAttempts,
              code: CUSTOM_AUTH_CODE,
            });

          // The attempt is spent and NOT written back, so every exit below has
          // to settle it exactly once. `settled` is what makes the catch a
          // refund for everything that produced no verdict: a rejected
          // assertion, or one naming a credential this user does not hold,
          // charges on its own way out; a ceremony that was never started, a
          // malformed body, a database error or a counter write that throws
          // gives the attempt back instead of leaving the row absent.
          let settled = false;
          const chargeFailure = async () => {
            settled = true;
            await attempt.recordFailure();
          };

          try {
            const identifier = ceremonyIdentifier(challenge.challengeId);
            const stored =
              await ctx.context.internalAdapter.consumeVerificationValue(
                identifier
              );
            if (!stored || stored.expiresAt <= new Date())
              throw new APIError(HTTP_STATUS.BAD_REQUEST, {
                message: twoFactorMsg.invalidCode,
                code: CUSTOM_AUTH_CODE,
              });

            const credentialId = (response as { id?: unknown }).id;
            if (typeof credentialId !== 'string')
              throw new APIError(HTTP_STATUS.UNPROCESSABLE, {
                message: twoFactorMsg.invalidCode,
                code: CUSTOM_AUTH_CODE,
              });

            // The server-side binding: `allowCredentials` is a hint the browser
            // may ignore, so the credential is looked up UNDER the challenge
            // user rather than globally.
            const [credential] = await db
              .select({
                credentialID: passkeys.credentialID,
                publicKey: passkeys.publicKey,
                counter: passkeys.counter,
                transports: passkeys.transports,
                id: passkeys.id,
              })
              .from(passkeys)
              .where(
                and(
                  eq(passkeys.credentialID, credentialId),
                  eq(passkeys.userId, challenge.user.id)
                )
              )
              .limit(1);

            if (!credential) {
              await chargeFailure();
              throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
                message: twoFactorMsg.invalidCode,
                code: CUSTOM_AUTH_CODE,
              });
            }

            let verification;
            try {
              verification = await verifyAuthenticationResponse({
                // The library checks the shape itself and throws into the catch
                // below; a Zod mirror of `AuthenticationResponseJSON` would only
                // drift from it.
                response: response as unknown as Parameters<
                  typeof verifyAuthenticationResponse
                >[0]['response'],
                expectedChallenge: stored.value,
                expectedOrigin: PUBLIC_ORIGIN,
                expectedRPID: RP_ID,
                credential: {
                  id: credential.credentialID,
                  publicKey: new Uint8Array(
                    Buffer.from(credential.publicKey, 'base64')
                  ),
                  counter: credential.counter,
                  transports: credential.transports
                    ? (credential.transports.split(
                        ','
                      ) as AuthenticatorTransportFuture[])
                    : undefined,
                },
                requireUserVerification: true,
              });
            } catch (error) {
              await chargeFailure();
              console.error(
                sanitizeForLog({ msg: 'twoFactor.passkey.verifyFailed', error })
              );
              throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
                message: twoFactorMsg.invalidCode,
                code: CUSTOM_AUTH_CODE,
              });
            }

            if (!verification.verified) {
              await chargeFailure();
              throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
                message: twoFactorMsg.invalidCode,
                code: CUSTOM_AUTH_CODE,
              });
            }

            // A concurrent assertion already carried the row to at least this
            // value. Logged because it is the only visible trace of two
            // simultaneous ceremonies on one credential, not because it failed.
            // A THROW here is still refunded: the assertion was proven, so the
            // attempt was not a guess and the challenge is still live.
            if (
              !(await advancePasskeyCounter(
                credential.id,
                verification.authenticationInfo.newCounter
              ))
            )
              console.error(
                sanitizeForLog({
                  msg: 'twoFactor.passkey.counterReconciled',
                  passkeyId: credential.id,
                })
              );

            // The challenge is about to be consumed, so nothing after this may
            // re-arm its counter.
            settled = true;

            const completed = await completeTwoFactorChallenge(
              ctx,
              challenge,
              'passkey'
            );
            if (!completed)
              throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
                message: twoFactorMsg.challengeMissing,
                code: CUSTOM_AUTH_CODE,
              });

            return ctx.json({
              success: true,
              message: twoFactorMsg.verifySuccess,
              data: { loggedIn: true },
            });
          } catch (error) {
            if (!settled) await attempt.restore();
            throw error;
          }
        }
      ),
    },
  }) satisfies import('better-auth').BetterAuthPlugin;

export const twoFactorPasskeyPlugins = isTwoFactorMethodEnabled('passkey')
  ? [twoFactorPasskey()]
  : [];
