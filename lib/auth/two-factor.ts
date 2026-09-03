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
import type { BetterAuthPlugin } from 'better-auth';

import { twoFactorMsg } from '@/app/api/auth/otp/messages';
import { sanitizeForLog, validID } from '@/utils';
import { passkey } from '@better-auth/passkey';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins/two-factor';

import { CUSTOM_AUTH_CODE, HTTP_STATUS } from '@/utils/api-messages';
import {
  isTwoFactorMethodEnabled,
  TWO_FACTOR_ENABLED,
  TWO_FACTOR_OTP_AVAILABLE,
} from '@/utils/validation/two-factor';

import { API_PATH_MAX, getClientIp, USER_AGENT_MAX } from '../audit';
import { submittedRememberMe } from './remember-me';
import { trustedDevicePlugin } from './trusted-device';
import {
  issueTwoFactorChallenge,
  markTwoFactorProven,
  PLUGIN_VERIFIER_METHOD,
  recordPluginCompletion,
  resolveRequestSession,
  TWO_FACTOR_CHALLENGE_MAX_AGE_S,
  twoFactorUnavailableError,
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

            const headers =
              ctx.headers ?? ctx.request?.headers ?? new Headers();

            const outcome = await issueTwoFactorChallenge(ctx, {
              userId: newSession.user.id,
              userEmail: newSession.user.email,
              session: {
                id: newSession.session.id,
                token: newSession.session.token,
              },
              firstFactor: 'password',
              rememberMe: submittedRememberMe(ctx.body),
              auditMeta: {
                ip: getClientIp(headers),
                userAgent:
                  headers.get('user-agent')?.slice(0, USER_AGENT_MAX) ?? null,
                apiPath: (ctx.path ?? '/sign-in/email').slice(0, API_PATH_MAX),
              },
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
    endpoints,
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
            if (!(await recordPasskeyEnrolment(ctx, requestSession)))
              console.error(
                sanitizeForLog({
                  msg: 'twoFactor.enrolPasskey.intentUnrecorded',
                  userId: requestSession.userId,
                  effect:
                    'the credential exists but is not offered as a factor',
                })
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
