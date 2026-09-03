/**
 * The OTP second factor, on this project's OTP system rather than the plugin's.
 *
 * Both endpoints serve two modes, discriminated the way the plugin's own
 * verifiers discriminate: a resolved session is an enrolment, and only its
 * absence falls through to the challenge cookie. Neither takes a contact from
 * the request — the address is read from the user row, so nothing can redirect
 * its own second factor.
 */
import type {
  AuthContext,
  RequestSession,
  ResolvedChallenge,
} from './two-factor-challenge';
import type { EntityID } from '@/types';
import type { OtpChannel } from '@/utils/validation/otp';

import { and, eq, isNull } from 'drizzle-orm';

import { otpMsg, twoFactorMsg } from '@/app/api/auth/otp/messages';
import { db } from '@/db';
import { users } from '@/db/schema';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import * as z from 'zod';

import { CUSTOM_AUTH_CODE, HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import {
  otpGuessWasEvaluated,
  processOtpSend,
  processOtpVerify,
} from '@/utils/otp';
import {
  isTwoFactorOtpChannelEnabled,
  TWO_FACTOR_OTP_AVAILABLE,
  twoFactorContactKind,
  twoFactorOtpEnrollSchema,
  twoFactorOtpVerifySchema,
} from '@/utils/validation/two-factor';

import { API_PATH_MAX, getClientIp, USER_AGENT_MAX } from '../audit';
import {
  enforceOtpSurfaceSendQuota,
  enforceOtpVerifyQuota,
} from '../rate-limit';
import { toAuthApiError } from './api-error';
import { envelopeResponse } from './plugin-openapi';
import { requireReauthPassword } from './reauth-grant';
import { revokeOtherSessions } from './rotation';
import {
  completeTwoFactorChallenge,
  optionId,
  otpTargetFor,
  recordMethodIntent,
  resolveRequestSession,
  resolveTwoFactorChallenge,
  spendChallengeAttempt,
} from './two-factor-challenge';
import { auditLifecycle } from './two-factor-enrolment';

const ENTITY_BY_KIND: Readonly<Record<'email' | 'phone', string>> = {
  email: 'البريد الإلكتروني',
  phone: 'رقم الهاتف',
};

interface OtpTarget {
  userId: EntityID;
  userEmail: string;
  channel: OtpChannel;
  /** Read from the user row. Never from the request. */
  destination: string;
}

/**
 * Where an enrolling user's codes would go. The verified-contact requirement is
 * the point: an unverified address would let a typo lock the account at the next
 * sign-in, and would let a brief session holder aim the factor at their own
 * contact.
 */
async function enrolmentTarget(
  userId: EntityID,
  channel: OtpChannel
): Promise<OtpTarget> {
  const [user] = await db
    .select({
      email: users.email,
      emailVerified: users.emailVerified,
      phoneNumber: users.phoneNumber,
      phoneNumberVerified: users.phoneNumberVerified,
    })
    .from(users)
    // `isActive` as well as `deletedAt`: this is a WRITE path, and a suspended
    // account must not be able to add a factor to itself.
    .where(
      and(
        eq(users.id, userId),
        eq(users.isActive, true),
        isNull(users.deletedAt)
      )
    )
    .limit(1);
  if (!user)
    throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
      message: twoFactorMsg.challengeMissing,
      code: CUSTOM_AUTH_CODE,
    });

  const kind = twoFactorContactKind(channel);
  const destination = kind === 'email' ? user.email : user.phoneNumber;
  const verified =
    kind === 'email' ? user.emailVerified : user.phoneNumberVerified;

  if (!destination || !verified)
    throw new APIError(HTTP_STATUS.BAD_REQUEST, {
      message: twoFactorMsg.contactUnverified,
      code: CUSTOM_AUTH_CODE,
    });

  return { userId, userEmail: user.email, channel, destination };
}

function auditMetaOf(ctx: AuthContext, path: string) {
  const headers = ctx.headers ?? ctx.request?.headers ?? new Headers();
  return {
    ip: getClientIp(headers),
    userAgent: headers.get('user-agent')?.slice(0, USER_AGENT_MAX) ?? null,
    apiPath: path.slice(0, API_PATH_MAX),
  };
}

/** 404, not 400: an unserved path answers like every other unserved path. */
function assertOtpAvailable(): void {
  if (!TWO_FACTOR_OTP_AVAILABLE)
    throw new APIError(HTTP_STATUS.NOT_FOUND, {
      message: otpMsg.invalidInput,
      code: CUSTOM_AUTH_CODE,
    });
}

export const twoFactorOtp = () =>
  ({
    id: 'two-factor-otp',
    endpoints: {
      /**
       * No captcha, deliberately: reaching this needs a session or a challenge
       * cookie, and a challenge cookie follows a verified password, so the gate
       * in front is stronger than one. Cost stays bounded by the per-destination
       * surface quota and the app-wide daily breaker.
       */
      twoFactorOtpSend: createAuthEndpoint(
        '/two-factor/otp/send',
        {
          method: 'POST',
          body: z.record(z.string(), z.unknown()).optional(),
          metadata: {
            openapi: envelopeResponse('A second-factor code was sent.', {
              type: 'object',
              properties: { nextAllowedIn: { type: 'integer' } },
              required: ['nextAllowedIn'],
            }),
          },
        },
        async (ctx) => {
          assertOtpAvailable();
          try {
            // Session first, challenge second — the library's own order, shared
            // with `verify` through `resolveRequestSession`.
            const requestSession = await resolveRequestSession(ctx);
            if (requestSession)
              // ⚠️ The ENROLMENT branch only, and at the START of the flow.
              // Adding a second factor is a security-state change and a session
              // alone was enough for it, so a hijacked session could enrol OTP
              // to a contact it already controlled and from there make password
              // recovery refuse permanently. `verify` takes no password: it is
              // the second half of a flow this call already gated, and the code
              // it needs went to the user's own contact. The sign-in branch
              // takes none either — the caller holds a challenge cookie, which
              // follows a verified password.
              await requireReauthPassword(ctx, requestSession.userId);

            const target = requestSession
              ? await enrolmentTargetFromSession(ctx, requestSession)
              : signInTarget(
                  await requireChallenge(ctx),
                  (ctx.body as { option?: unknown } | undefined)?.option
                );

            // Both modes, at the one boundary that reaches a provider: an
            // enrolment row outlives the channel list that admitted it, so a
            // channel the deployment has since dropped must not still deliver.
            if (!isTwoFactorOtpChannelEnabled(target.channel))
              throw new APIError(HTTP_STATUS.BAD_REQUEST, {
                message: twoFactorMsg.methodUnavailable,
                code: CUSTOM_AUTH_CODE,
              });

            await enforceOtpSurfaceSendQuota({
              channel: target.channel,
              destination: target.destination,
              surface: 'two_factor',
            });

            const { nextAllowedIn } = await processOtpSend({
              userId: target.userId,
              identifier: target.destination,
              channel: target.channel,
              purpose: 'two_factor',
              sendTo: target.destination,
              entityName: ENTITY_BY_KIND[twoFactorContactKind(target.channel)],
            });

            return ctx.json({
              success: true,
              message: twoFactorMsg.codeSent,
              data: { nextAllowedIn },
            });
          } catch (caught) {
            throw asAuthError(caught, twoFactorMsg.sendError);
          }
        }
      ),

      twoFactorOtpVerify: createAuthEndpoint(
        '/two-factor/otp/verify',
        {
          method: 'POST',
          body: z.record(z.string(), z.unknown()),
          metadata: {
            openapi: envelopeResponse(
              'The second factor was verified: a sign-in completed, or the OTP method was enrolled.'
            ),
          },
        },
        async (ctx) => {
          assertOtpAvailable();

          const parsed = twoFactorOtpVerifySchema.safeParse(ctx.body);
          if (!parsed.success)
            throw new APIError(HTTP_STATUS.UNPROCESSABLE, {
              message: otpMsg.invalidInput,
              code: CUSTOM_AUTH_CODE,
            });

          const requestSession = await resolveRequestSession(ctx);

          return requestSession
            ? verifyForEnrolment(ctx, requestSession, parsed.data.code)
            : verifyForSignIn(
                ctx,
                await requireChallenge(ctx),
                parsed.data.code
              );
        }
      ),
    },
  }) satisfies import('better-auth').BetterAuthPlugin;

/**
 * The pending challenge, or the 401 every caller with neither a session nor a
 * live challenge gets.
 */
async function requireChallenge(ctx: AuthContext) {
  const challenge = await resolveTwoFactorChallenge(ctx);
  if (!challenge)
    throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
      message: twoFactorMsg.challengeMissing,
      code: CUSTOM_AUTH_CODE,
    });
  return challenge;
}

/**
 * Sign-in mode: the destination comes from the enrolment the CHALLENGE offers.
 *
 * `option` names which one, because a user may hold an OTP enrolment per contact
 * kind and they are different possessions — the same reason the passwordless
 * exclusion is by kind. An unnamed option falls back to the challenge's default,
 * and an option the challenge does not offer is refused rather than resolved.
 */
function signInTarget(
  challenge: ResolvedChallenge,
  option: unknown
): OtpTarget {
  const target = otpTargetFor(
    challenge,
    typeof option === 'string' ? option : null
  );
  if (!target)
    throw new APIError(HTTP_STATUS.BAD_REQUEST, {
      message: twoFactorMsg.methodUnavailable,
      code: CUSTOM_AUTH_CODE,
    });
  return {
    userId: challenge.user.id,
    userEmail: challenge.user.email,
    channel: target.channel,
    destination: target.destination,
  };
}

async function enrolmentTargetFromSession(
  ctx: AuthContext,
  requestSession: RequestSession
): Promise<OtpTarget> {
  const parsed = twoFactorOtpEnrollSchema.safeParse(ctx.body);
  if (!parsed.success)
    throw new APIError(HTTP_STATUS.UNPROCESSABLE, {
      message: twoFactorMsg.methodUnavailable,
      code: CUSTOM_AUTH_CODE,
    });

  return enrolmentTarget(
    requestSession.userId,
    parsed.data.channel as OtpChannel
  );
}

async function verifyForSignIn(
  ctx: AuthContext,
  challenge: ResolvedChallenge,
  code: string
) {
  const target = signInTarget(
    challenge,
    (ctx.body as { option?: unknown } | undefined)?.option
  );

  // Charged BEFORE the challenge budget: a quota rejection produced no verdict,
  // and `spendChallengeAttempt` no longer writes the counter back, so spending
  // first and then throwing here would destroy the challenge.
  const auditMeta = auditMetaOf(ctx, '/two-factor/otp/verify');
  await enforceOtpVerifyQuota({
    channel: target.channel,
    identifier: target.destination,
    surface: 'two_factor',
  });

  const attempt = await spendChallengeAttempt(ctx, challenge.challengeId);
  if (!attempt.ok)
    throw new APIError(HTTP_STATUS.BAD_REQUEST, {
      message: twoFactorMsg.tooManyAttempts,
      code: CUSTOM_AUTH_CODE,
    });

  try {
    await processOtpVerify({
      userId: challenge.user.id,
      userEmail: challenge.user.email,
      channel: target.channel,
      purpose: 'two_factor',
      identifier: target.destination,
      code,
      auditMeta,
    });
  } catch (caught) {
    // ⚠️ Exactly one of the two, and which one is not "did it throw". The
    // challenge budget is five GUESSES; `processOtpVerify` also throws when no
    // proof row exists, when no live code exists, when the proof row is already
    // blocked and when the database faults, and none of those compared a code.
    // Charging them let a user who submits before pressing send — or five
    // transient faults — exhaust a challenge without ever guessing.
    await (otpGuessWasEvaluated(caught)
      ? attempt.recordFailure()
      : attempt.restore());
    throw asAuthError(caught, twoFactorMsg.invalidCode);
  }

  // Past this point the code is spent and the verdict was "correct". A restore
  // would re-arm a counter whose challenge is about to be consumed.
  const completed = await completeTwoFactorChallenge(
    ctx,
    challenge,
    optionId('otp', twoFactorContactKind(target.channel))
  );
  if (!completed)
    throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
      message: twoFactorMsg.challengeMissing,
      code: CUSTOM_AUTH_CODE,
    });

  return ctx.json({
    success: true,
    message: otpMsg.loginSuccess,
    data: { loggedIn: true },
  });
}

async function verifyForEnrolment(
  ctx: AuthContext,
  requestSession: RequestSession,
  code: string
) {
  const target = await enrolmentTargetFromSession(ctx, requestSession);
  const auditMeta = auditMetaOf(ctx, '/two-factor/otp/verify');

  await enforceOtpVerifyQuota({
    channel: target.channel,
    identifier: target.destination,
    surface: 'two_factor',
  });

  try {
    await processOtpVerify({
      userId: target.userId,
      userEmail: target.userEmail,
      channel: target.channel,
      purpose: 'two_factor',
      identifier: target.destination,
      code,
      auditMeta,
      onVerified: async (tx) => {
        await recordMethodIntent(tx, {
          userId: target.userId,
          method: 'otp',
          channel: target.channel,
        });
        await tx
          .update(users)
          .set({ twoFactorEnabled: true })
          .where(eq(users.id, target.userId));
        await auditLifecycle(tx, ctx, requestSession, {
          twoFactorMethodAdded: optionId(
            'otp',
            twoFactorContactKind(target.channel)
          ),
          channel: target.channel,
          twoFactorEnabled: true,
        });
        // In the proof transaction, so the enrolment and the eviction of every
        // other session commit together — the caller's own session kept.
        await revokeOtherSessions(tx, target.userId, requestSession.sessionId);
      },
    });
  } catch (caught) {
    throw asAuthError(caught, twoFactorMsg.invalidCode);
  }

  return ctx.json({
    success: true,
    message: twoFactorMsg.enabled,
    data: { method: 'otp', channel: target.channel },
  });
}

/**
 * Better Call only understands `APIError`; anything else escapes its boundary as
 * an empty 500, turning a 429 with a `Retry-After` into a fault the client
 * cannot back off from.
 */
function asAuthError(caught: unknown, generic: string): unknown {
  if (caught instanceof APIError) return caught;
  if (caught instanceof CustomError) return toAuthApiError(caught, generic);
  return caught;
}
