/**
 * The two-factor plugin with its sign-in hook replaced by ours.
 *
 * The plugin's hook matches only the credential sign-in paths, and this
 * deployment must issue the same challenge from `/passwordless/verify`, so the
 * issuer lives in `lib/auth/two-factor-challenge.ts` and is the only one. It is
 * installed by `twoFactorSignInGuard`, which — unlike everything else here — is
 * present in every configuration.
 *
 * `otpOptions` is left unset deliberately: that is what makes
 * `/two-factor/send-otp` and `/two-factor/verify-otp` inert, so the second
 * factor's codes run on this project's own OTP system instead.
 */
import type { TotpVerdict } from './totp-replay';
import type { AuthContext, ResolvedChallenge } from './two-factor-challenge';
import type { EntityID } from '@/types';
import type { Passkey } from '@better-auth/passkey';
import type { BetterAuthPlugin } from 'better-auth';

import { eq } from 'drizzle-orm';

import { twoFactorMsg } from '@/app/api/auth/otp/messages';
import { db } from '@/db';
import { twoFactorCredentials } from '@/db/schema';
import { sanitizeForLog, validID } from '@/utils';
import { passkey } from '@better-auth/passkey';
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  isAPIError,
} from 'better-auth/api';
import { symmetricDecrypt } from 'better-auth/crypto';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { PUBLIC_ORIGIN } from '@/lib/env';

import {
  CUSTOM_AUTH_CODE,
  HTTP_STATUS,
  MSG_INVALID_INPUT,
} from '@/utils/api-messages';
import {
  isTwoFactorMethodEnabled,
  TWO_FACTOR_ENABLED,
  TWO_FACTOR_OTP_AVAILABLE,
} from '@/utils/validation/two-factor';

import { authAuditMeta } from './audit-meta';
import { RP_ID } from './passkey-assertion';
import { submittedRememberMe } from './remember-me';
import { consumeTotpCode, DELEGATED_TOTP_WINDOW } from './totp-replay';
import { transactionBoundContext } from './transaction';
import { trustedDevicePlugin } from './trusted-device';
import {
  issueTwoFactorChallenge,
  markTwoFactorProven,
  PLUGIN_VERIFIER_METHOD,
  recordPluginCompletion,
  resolveRequestSession,
  resolveTwoFactorChallenge,
  TWO_FACTOR_CHALLENGE_MAX_AGE_S,
  twoFactorUnavailableError,
  withTwoFactorChallengeTransaction,
} from './two-factor-challenge';
import {
  recordPasskeyEnrolment,
  spendBackupCode,
  twoFactorEnrolment,
} from './two-factor-enrolment';
import { twoFactorOtp } from './two-factor-otp';
import { twoFactorPasskeyPlugins } from './two-factor-passkey';

/**
 * The adapter resolves a model as `schema[modelName]`, so this string and the
 * export in `db/schema.ts` must match exactly or every 2FA read throws.
 */
const TWO_FACTOR_TABLE = 'twoFactorCredentials';

function challengeMissing(): APIError {
  return new APIError(HTTP_STATUS.UNAUTHORIZED, {
    message: twoFactorMsg.challengeMissing,
    code: CUSTOM_AUTH_CODE,
  });
}

/**
 * The challenge a plugin verifier is answering, and the refusal of the branch
 * where there is none.
 *
 * Sign-in mode only, and that is a security invariant rather than a routing
 * detail: with a request session the plugin's own verifier used to run DIRECTLY,
 * outside `withTwoFactorChallengeTransaction`, so neither the challenge's
 * attempt budget nor the sign-in lockout bounded the guesses. Nothing needs that
 * branch — enrolment is owned by `lib/auth/two-factor-enrolment.ts`.
 *
 * `assertPluginVerifierOffered` in `lib/auth.ts` refuses the same shape one
 * layer out, with the same answer. Kept in both places because that fence lives
 * in another module and is keyed by path, and this is the function that owns
 * verification.
 *
 * Separate from `runPluginVerifier` so a verifier can do work that must NOT be
 * inside the transaction, with the challenge already in hand — see the TOTP step
 * reservation.
 */
async function resolveVerifierChallenge(
  ctx: AuthContext
): Promise<ResolvedChallenge> {
  if (await resolveRequestSession(ctx))
    throw new APIError(HTTP_STATUS.BAD_REQUEST, {
      message: MSG_INVALID_INPUT,
      code: CUSTOM_AUTH_CODE,
    });
  const challenge = await resolveTwoFactorChallenge(ctx);
  if (!challenge) throw challengeMissing();
  return challenge;
}

/**
 * Runs one of the library's verifiers inside the challenge transaction.
 *
 * `verify` is handed the auth context with its adapter bound to that
 * transaction; `transactionBoundContext` says why the library's own would not
 * be. Every caller must pass it through to the endpoint it delegates to.
 */
async function runPluginVerifier<T>(
  ctx: AuthContext,
  challenge: ResolvedChallenge,
  verify: (context: AuthContext['context']) => Promise<T>
) {
  const result = await withTwoFactorChallengeTransaction(
    ctx,
    challenge,
    async () => {
      const bound = await transactionBoundContext(ctx.context);
      try {
        return { response: await verify(bound) };
      } catch (error) {
        // Invalid-code attempts must commit their counters before returning the error.
        if (isAPIError(error)) return { error };
        throw error;
      }
    }
  );
  if (!result) throw challengeMissing();
  if ('error' in result) throw result.error;
  return result.response;
}

/**
 * Reserve the step the submitted code names, before the library spends it.
 *
 * Reads and decrypts the credential itself rather than asking the plugin, which
 * exposes no hook between "this code is valid" and "here is your session". A
 * missing credential, an undecryptable secret or a code matching no step in the
 * window all answer `'rejected'` — the library is about to answer that too, with
 * its own counters and message, and this must not pre-empt it.
 *
 * ⚠️ Called BEFORE `withTwoFactorChallengeTransaction` opens. The claim is a
 * single guarded UPDATE, atomic on its own, and outside the transaction it also
 * outlives a rollback — a step this accepted stays spent even when the request
 * that spent it fails afterwards, which is the conservative half of a choice
 * either way would be defensible on.
 *
 * Moving it inside is not otherwise blocked, but it would have to travel with
 * the transaction's executor — `consumeTotpCode`'s `executor`, which states why.
 * Nothing about the credential row's LOCK is what forces that: the claim is one
 * autocommitted UPDATE whose lock is gone before the verifier runs, and the
 * library's own writes reach that row through the adapter
 * `transactionBoundContext` bound to this transaction, so they would be on the
 * connection already holding it. The cost of getting it wrong is the pool:
 * measured, a pooled claim from inside the transaction answers one request in
 * 3.6 s and wedges ten concurrent ones past 30 s.
 */
/**
 * What is submitted to the library's verifier in place of a code the
 * reservation found already spent.
 *
 * It has to be a code no secret can ever produce, and non-digits are that:
 * `createOTP().verify` compares against `generateHOTP`, whose output is
 * `toString().padStart(digits, '0')` — decimal digits only, at every step of
 * every window. The library then walks its normal wrong-code path, so a replay
 * and a guess cost the same and read the same.
 */
const SPENT_TOTP_CODE = 'spent!';

async function reserveSignInTotpStep(
  ctx: AuthContext,
  userId: EntityID
): Promise<TotpVerdict> {
  const code = (ctx.body as { code?: unknown } | undefined)?.code;
  if (typeof code !== 'string') return 'rejected';

  const [credential] = await db
    .select({
      secret: twoFactorCredentials.secret,
      verified: twoFactorCredentials.verified,
    })
    .from(twoFactorCredentials)
    .where(eq(twoFactorCredentials.userId, userId))
    .limit(1);
  if (!credential?.verified) return 'rejected';

  const secret = await symmetricDecrypt({
    key: ctx.context.secretConfig,
    data: credential.secret,
  }).catch(() => null);
  if (!secret) return 'rejected';

  return consumeTotpCode(userId, secret, code, {
    window: DELEGATED_TOTP_WINDOW,
  });
}

function forwardVerifierHeaders(ctx: AuthContext, headers: Headers) {
  for (const cookie of headers.getSetCookie())
    ctx.responseHeaders?.append('set-cookie', cookie);
  headers.forEach((value, name) => {
    if (name !== 'set-cookie') ctx.responseHeaders?.set(name, value);
  });
}

/**
 * Baked into every enrolled authenticator, so changing it later means
 * re-enrolling every user.
 */
const TOTP_ISSUER = 'Dashboard';

/**
 * The user id out of a plugin verifier's response body.
 *
 * Read from the RESPONSE, not from a session lookup: the sign-in branch has no
 * request session, and the token it answers with is the one it just replaced.
 */
function userIdOf(returned: unknown): unknown {
  if (!returned || typeof returned !== 'object') return null;
  const user = (returned as { user?: unknown }).user;
  if (!user || typeof user !== 'object') return null;
  return (user as { id?: unknown }).id;
}

/**
 * The credential row `/passkey/verify-registration` just wrote.
 *
 * The endpoint answers with the persisted row — `Passkey` from
 * `@better-auth/passkey` — and that `id` is the only thing naming WHICH
 * credential the ceremony produced. Shape-checked rather than cast: `returned`
 * is the library's, and an enrolment recorded against a credential this could
 * not name is the failure `recordPasskeyEnrolment` exists to refuse.
 */
function registeredPasskeyId(returned: unknown): EntityID | null {
  if (!returned || typeof returned !== 'object') return null;
  const row = returned as Partial<Passkey>;
  return validID(row.id) || null;
}

/**
 * The `/sign-in/email` half of enforcement, and the reason it is its own plugin.
 *
 * ⚠️ Installed UNCONDITIONALLY, including when the method list is empty: with
 * it inside `twoFactorAuth()`, emptying `NEXT_PUBLIC_ENABLED_2FA_METHODS` removes
 * enforcement from this path while `/passwordless/verify`, which calls the issuer
 * directly, keeps refusing the same account. `issueTwoFactorChallenge` owns the
 * empty-list decision; this plugin only has to be present for it to be asked.
 */
const twoFactorSignInGuard = () =>
  ({
    id: 'two-factor-sign-in-guard',
    hooks: {
      after: [
        {
          matcher: (context) => context.path === '/sign-in/email',
          handler: createAuthMiddleware(async (ctx) => {
            const newSession = ctx.context.newSession;
            if (!newSession) return;

            const outcome = await issueTwoFactorChallenge(ctx, {
              userId: newSession.user.id,
              userEmail: newSession.user.email,
              session: {
                id: newSession.session.id,
                token: newSession.session.token,
              },
              firstFactor: 'password',
              rememberMe: submittedRememberMe(ctx.body),
              auditMeta: authAuditMeta(ctx, ctx.path ?? '/sign-in/email'),
            });

            if (outcome.kind === 'refused') throw twoFactorUnavailableError();
            if (outcome.kind === 'proceed') return;

            return ctx.json(outcome.body);
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;

const twoFactorAuth = () => {
  // Destructured rather than deleted so a second hook added upstream lands in
  // this binding instead of slipping in unnoticed.
  const { hooks: _pluginSignInHook, ...core } = twoFactor({
    twoFactorTable: TWO_FACTOR_TABLE,
    issuer: TOTP_ISSUER,
    twoFactorCookieMaxAge: TWO_FACTOR_CHALLENGE_MAX_AGE_S,
    // Second layer: the allow-list already answers these paths 404.
    totpOptions: { disable: !isTwoFactorMethodEnabled('totp') },
    // Left unset on purpose — see the note at the top of this file.
    otpOptions: undefined,
  });

  // ⚠️ Removed, not merely un-allow-listed: `lib/auth/two-factor-enrolment.ts`
  // serves `/two-factor/disable` and `/two-factor/generate-backup-codes`
  // itself, and two endpoints cannot claim one path. `enableTwoFactor` is gone
  // outright — it can only produce TOTP in this configuration, and it writes
  // the flag and the credential in two places this deployment then has to
  // compensate. `verifyTOTP`, `verifyBackupCode` and `getTOTPURI` stay.
  const {
    enableTwoFactor: _enable,
    disableTwoFactor: _disable,
    generateBackupCodes: _generateBackupCodes,
    ...endpoints
  } = core.endpoints;

  return {
    ...core,
    endpoints: {
      ...endpoints,
      verifyTOTP: createAuthEndpoint(
        endpoints.verifyTOTP.path,
        { ...endpoints.verifyTOTP.options, use: [] },
        async (ctx) => {
          const challenge = await resolveVerifierChallenge(ctx);

          // The step is reserved BEFORE the library verifies, because after it
          // verifies there is a session and cookies to undo. EVERY verdict then
          // falls through to the library, which owns the attempt counter, the
          // account lockout and the invalid-code answer.
          //
          // A reserved step spent on a request the library then refuses for
          // some other reason is the accepted cost: it burns at most the
          // remainder of one 30-second period for that account.
          const reserved = await reserveSignInTotpStep(ctx, challenge.user.id);

          const result = await runPluginVerifier(
            ctx,
            challenge,
            async (context) => {
              const verified = await endpoints.verifyTOTP({
                ...ctx,
                // A replay is delegated as a WRONG code rather than refused
                // here, and that is the whole point: refusing here skipped
                // `beginAttempt`, `recordTwoFactorFailure` and the library's own
                // message, so six replays of one captured code left a challenge
                // that a sixth wrong guess would have destroyed. The cost is
                // what tells the holder their capture was good; matching the
                // status and the message is not enough.
                body:
                  reserved === 'replayed'
                    ? { ...ctx.body, code: SPENT_TOTP_CODE }
                    : ctx.body,
                context,
                returnHeaders: true,
              });

              // ⚠️ The invariant the whole reservation rests on: a completed
              // TOTP sign-in spent a step. The library THROWS on a bad code, so
              // reaching here is an acceptance, and an acceptance the
              // reservation did not claim would hand out a session while
              // leaving the code replayable.
              //
              // Checked rather than assumed, because the two verifiers agree
              // only by construction: they read the clock at different instants
              // (`DELEGATED_TOTP_WINDOW` is what covers that) and the
              // credential row at different instants too, so a concurrent
              // enrolment confirmation flipping `verified` between the two
              // reads would also land here. A plain `Error` rolls the
              // transaction back — the new session with it — where an
              // `APIError` would commit it.
              if (reserved !== 'matched')
                throw new Error(
                  'TOTP verification accepted a step the replay reservation did not claim'
                );
              return verified;
            }
          );
          forwardVerifierHeaders(ctx, result.headers);
          return ctx.json(result.response);
        }
      ),
      verifyBackupCode: createAuthEndpoint(
        endpoints.verifyBackupCode.path,
        { ...endpoints.verifyBackupCode.options, use: [] },
        async (ctx) => {
          const result = await runPluginVerifier(
            ctx,
            await resolveVerifierChallenge(ctx),
            (context) =>
              endpoints.verifyBackupCode({
                ...ctx,
                context,
                returnHeaders: true,
              })
          );
          forwardVerifierHeaders(ctx, result.headers);
          return ctx.json(result.response);
        }
      ),
    },
    hooks: {
      after: [
        {
          // The library's verifiers complete a challenge without passing through
          // `completeTwoFactorChallenge`, so its tail — the device-trust proof,
          // the completion event and the companion rows — has to happen here or
          // it works for our methods and silently does nothing for these two.
          matcher: (context) =>
            context.path !== undefined &&
            context.path in PLUGIN_VERIFIER_METHOD,
          handler: createAuthMiddleware(async (ctx) => {
            if (isAPIError(ctx.context.returned)) return;
            const newSession = ctx.context.newSession;
            const completedWith = PLUGIN_VERIFIER_METHOD[ctx.path];
            if (!newSession || !completedWith) return;
            await markTwoFactorProven(ctx, newSession.session.id);
            await recordPluginCompletion(ctx, completedWith, newSession);
          }),
        },
        {
          // The plugin rewrites the encrypted set without a count. Keeping one
          // is what lets `backupCodesReady` stop offering an exhausted set.
          matcher: (context) =>
            context.path === '/two-factor/verify-backup-code',
          handler: createAuthMiddleware(async (ctx) => {
            if (isAPIError(ctx.context.returned)) return;
            const userId = validID(userIdOf(ctx.context.returned));
            if (userId) await spendBackupCode(userId).catch(() => {});
          }),
        },
        {
          // A registered passkey is only a second factor once it is recorded as
          // one. The plugin persists the credential and knows nothing about
          // intent, so this is where the two meet.
          matcher: (context) => context.path === '/passkey/verify-registration',
          handler: createAuthMiddleware(async (ctx) => {
            if (isAPIError(ctx.context.returned)) return;
            const requestSession = await resolveRequestSession(ctx);
            if (!requestSession) return;
            const credentialId = registeredPasskeyId(ctx.context.returned);
            const outcome = credentialId
              ? await recordPasskeyEnrolment(ctx, requestSession, credentialId)
              : 'failed';
            if (outcome === 'recorded') return;
            console.error(
              sanitizeForLog({
                msg: 'twoFactor.enrolPasskey.intentUnrecorded',
                userId: requestSession.userId,
                effect: credentialId
                  ? outcome === 'no-passkey'
                    ? 'the credential was deleted before it could be enrolled'
                    : 'the credential exists but is not offered as a factor'
                  : 'the registration response did not name the credential it wrote',
              })
            );
            // The registration's own 200 said a second factor was added, and
            // none was. An `APIError` thrown from an `after` hook replaces the
            // response and carries its own status — the endpoint sets none — so
            // the client learns the ceremony did not achieve what it was for.
            //
            // The credential the plugin wrote is deliberately NOT removed on
            // `'failed'`: that path is a write that already failed, so a
            // compensating write is the least likely thing to succeed, and it
            // would delete a credential the authenticator now holds on the
            // strength of it. The message names the state instead.
            const credentialGone = outcome === 'no-passkey';
            throw new APIError(
              credentialGone
                ? HTTP_STATUS.CONFLICT
                : HTTP_STATUS.INTERNAL_ERROR,
              {
                message: credentialGone
                  ? twoFactorMsg.passkeyNotSaved
                  : twoFactorMsg.passkeyNotEnrolled,
                code: CUSTOM_AUTH_CODE,
              }
            );
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
};

/**
 * Registration and management only. Three of the plugin's endpoints are removed
 * from its map, not merely left off the allow-list:
 *
 *  - `verifyPasskeyAuthentication` resolves a credential by id alone and mints a
 *    session for its owner — an unauthenticated sign-in — and
 *    `generatePasskeyAuthenticationOptions` is its first half. Absent from the
 *    router, they cannot be served by a later allow-list edit.
 *  - `deletePasskey`: removing a credential can remove a second factor, so
 *    `lib/auth/two-factor-enrolment.ts` serves that path with the last-method
 *    rule and the trust revocation the other removals have.
 *
 * ⚠️ The library does NOT refuse two endpoints on one path — its conflict check
 * only logs — and resolution follows plugin order, in which this plugin comes
 * after the enrolment one. Dropping the `deletePasskey` destructure would hand
 * the path back to the library silently; the passkey suite's 409 on a last
 * credential is what would catch it.
 */
const passkeyManagement = () => {
  const plugin = passkey({
    rpName: TOTP_ISSUER,
    // Both pinned to the deployment, not derived from the request: the plugin
    // reads `expectedOrigin` from the caller's own `Origin` header when
    // `origin` is unset, so half the ceremony would be fenced by browser RP-ID
    // rules and Better Auth's origin middleware while the assertion half
    // (`lib/auth/passkey-assertion.ts`) already pins `PUBLIC_ORIGIN`.
    origin: PUBLIC_ORIGIN,
    rpID: RP_ID,
    schema: { passkey: { modelName: 'passkeys' } },
    // A client hint, and not the control: the plugin's own
    // `/passkey/verify-registration` passes `requireUserVerification: false`,
    // so a client that drops this still registers. The refusal below is the
    // gate.
    authenticatorSelection: { userVerification: 'required' },
    registration: {
      // The SIGNED UV bit, not the requested option. A credential registered
      // without user verification proves a device and not a person, and the
      // assertion path requires UV — so accepting one enrols a second factor
      // that can never complete. Thrown before the row is persisted.
      afterVerification: ({ verification }) => {
        if (verification.registrationInfo?.userVerified !== true)
          throw new APIError(HTTP_STATUS.BAD_REQUEST, {
            message: twoFactorMsg.passkeyNotUserVerifying,
            code: CUSTOM_AUTH_CODE,
          });
      },
    },
  });
  const {
    deletePasskey: _deletePasskey,
    generatePasskeyAuthenticationOptions: _authenticationOptions,
    verifyPasskeyAuthentication: _authentication,
    ...endpoints
  } = plugin.endpoints;
  return { ...plugin, endpoints } satisfies BetterAuthPlugin;
};

export const twoFactorPlugins = [
  // Never conditional — see `twoFactorSignInGuard`.
  twoFactorSignInGuard(),
  ...(TWO_FACTOR_ENABLED
    ? [
        twoFactorAuth(),
        trustedDevicePlugin(),
        twoFactorEnrolment(),
        ...(TWO_FACTOR_OTP_AVAILABLE ? [twoFactorOtp()] : []),
        ...(isTwoFactorMethodEnabled('passkey') ? [passkeyManagement()] : []),
        ...twoFactorPasskeyPlugins,
      ]
    : []),
];
