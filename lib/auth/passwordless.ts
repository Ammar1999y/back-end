import type { BetterAuthPlugin } from 'better-auth';

import { and, eq, isNull } from 'drizzle-orm';

import { ensureMinDelay, otpMsg } from '@/app/api/auth/otp/messages';
import { db, withTransaction } from '@/db';
import { userContactColumn } from '@/db/queries';
import { users } from '@/db/schema';
import { sanitizeForLog } from '@/utils';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import * as z from 'zod';

import {
  CUSTOM_AUTH_CODE,
  HTTP_STATUS,
  MSG_PAGE_NOT_FOUND,
} from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import {
  collapseProofThrottle,
  markContactVerified,
  processOtpVerify,
} from '@/utils/otp';
import { OTP_ENABLED, verifyOtpSchema } from '@/utils/validation/otp';

import { API_PATH_MAX, auditLog, getClientIp, USER_AGENT_MAX } from '../audit';
import { verifyTurnstileRequest } from '../captcha';
import { enforceOtpVerifyQuota } from '../rate-limit';
import { toAuthApiError } from './api-error';

/**
 * Records that a just-issued session was withdrawn before its cookie shipped.
 *
 * Best-effort and swallowed: the caller is already rethrowing the failure that
 * caused it, and a second fault here must not replace that one. A missing
 * compensating row leaves the same gap this closes, which is why it is logged.
 */
async function recordAbandonedSession(params: {
  userId: string;
  userEmail: string;
  sessionId: string;
  auditMeta: { ip: string | null; userAgent: string | null; apiPath: string };
}): Promise<void> {
  try {
    await withTransaction((tx) =>
      auditLog(tx, {
        userId: params.userId,
        userEmail: params.userEmail,
        action: 'DELETE',
        tableName: 'sessions',
        recordId: params.sessionId,
        oldData: { loginSuccess: true },
        newData: { sessionAbandoned: true, reason: 'cookie_delivery_failed' },
        meta: params.auditMeta,
      })
    );
  } catch (error) {
    console.error(
      sanitizeForLog({
        msg: 'passwordless.abandonedSessionAudit.failed',
        userId: params.userId,
        sessionId: params.sessionId,
        error,
      })
    );
  }
}

/**
 * Passwordless login (step 2 / verify). Reuses the project's hardened OTP
 * system (processOtpVerify, dual counters, captcha, audit, privacy collapse)
 * and delegates ONLY the session issuance to Better Auth, so there is a single
 * OTP system. Implemented as a Better Auth plugin endpoint because issuing a
 * signed session cookie + running the session-creation databaseHook can only be
 * done from inside a Better Auth endpoint context.
 *
 * Path: POST /api/auth/passwordless/verify  (also added to ALLOWED_PATHS).
 */
export const passwordless = () =>
  ({
    id: 'passwordless',
    endpoints: {
      passwordlessVerify: createAuthEndpoint(
        '/passwordless/verify',
        {
          method: 'POST',
          body: z.record(z.string(), z.unknown()),
          metadata: {
            openapi: {
              responses: {
                '200': {
                  description: 'Passwordless sign-in succeeded.',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          success: { type: 'boolean' },
                          message: { type: 'string' },
                          data: {
                            type: 'object',
                            properties: { loggedIn: { type: 'boolean' } },
                            required: ['loggedIn'],
                          },
                        },
                        required: ['success', 'message', 'data'],
                      },
                    },
                  },
                },
              },
            },
          },
        },
        async (ctx) => {
          const headers: Headers =
            (ctx as { headers?: Headers }).headers ??
            (ctx as { request?: Request }).request?.headers ??
            new Headers();

          // Floor the response time across the account-revealing paths below
          // (unknown identifier returns fast with no Argon2id; a real verify runs
          // it) so timing can't be used to enumerate accounts.
          const start = Date.now();
          // Only failures that could reveal whether an account exists pay the
          // timing floor; universally-reachable rejections (captcha, malformed
          // input, throttling) may return fast.
          let accountRevealing = false;

          // Every limiter call lives INSIDE this boundary. Outside it, a
          // CustomError (429 throttle, 503 missing-IP / limiter outage) is not
          // an APIError and Better Call turns it into an empty 500.
          try {
            // Surfaced directly (not account-specific → no enumeration risk).
            if (!OTP_ENABLED)
              throw new APIError(HTTP_STATUS.NOT_FOUND, {
                message: MSG_PAGE_NOT_FOUND,
                code: CUSTOM_AUTH_CODE,
              });

            const captchaOk = await verifyTurnstileRequest(headers);
            if (!captchaOk)
              throw new APIError(HTTP_STATUS.FORBIDDEN, {
                message: otpMsg.captchaFailed,
                code: CUSTOM_AUTH_CODE,
              });

            const parsed = verifyOtpSchema.safeParse(ctx.body);
            if (!parsed.success)
              throw new APIError(HTTP_STATUS.UNPROCESSABLE, {
                message: otpMsg.invalidInput,
                code: CUSTOM_AUTH_CODE,
              });

            const { channel, code } = parsed.data;
            const identifier =
              channel === 'email' ? parsed.data.email : parsed.data.phoneNumber;

            await enforceOtpVerifyQuota({
              channel,
              identifier,
              surface: 'passwordless',
            });

            accountRevealing = true;
            const [userData] = await db
              .select({ id: users.id, email: users.email })
              .from(users)
              .where(
                and(
                  eq(userContactColumn(channel), identifier),
                  isNull(users.deletedAt),
                  eq(users.isActive, true)
                )
              )
              .limit(1);

            if (!userData)
              throw new CustomError(
                otpMsg.invalidOrExpired,
                HTTP_STATUS.BAD_REQUEST
              );

            const auditMeta = {
              ip: getClientIp(headers),
              userAgent:
                headers.get('user-agent')?.slice(0, USER_AGENT_MAX) ?? null,
              apiPath: '/passwordless/verify'.slice(0, API_PATH_MAX),
            };

            // The OTP to email/phone proves control of that contact, so flip the
            // matching verified flag too (also satisfies the login gate below).
            await processOtpVerify({
              userId: userData.id,
              userEmail: userData.email,
              channel,
              purpose: 'passwordless_login',
              identifier,
              code,
              auditMeta,
              onVerified: async (tx, matched) => {
                await markContactVerified(tx, {
                  userId: userData.id,
                  channel,
                  auditMeta,
                  onMissing: () => {
                    throw new CustomError(
                      otpMsg.invalidOrExpired,
                      HTTP_STATUS.BAD_REQUEST
                    );
                  },
                });

                // The authoritative forensic record, written in the SAME
                // transaction as the proof consumption (the mutation this
                // endpoint actually owns). It survives whatever happens next:
                // if the role/verification gate then rejects the login, the
                // trail still shows that a valid code was presented and spent.
                await auditLog(tx, {
                  userId: userData.id,
                  userEmail: userData.email,
                  action: 'UPDATE',
                  tableName: 'verification_sessions',
                  // The row this event is actually about. Recording the user
                  // id under a `verification_sessions` table name made the
                  // event unjoinable to the proof it describes.
                  recordId: matched.verificationSessionId,
                  oldData: {},
                  newData: {
                    passwordlessProofVerified: true,
                    channel,
                  },
                  meta: auditMeta,
                });
              },
            });

            // Load the user BEFORE creating the session: a failure here used to
            // leave an orphaned session row behind with no way to reach it.
            const user = await ctx.context.internalAdapter.findUserById(
              userData.id
            );
            if (!user)
              throw new CustomError(
                otpMsg.invalidOrExpired,
                HTTP_STATUS.BAD_REQUEST
              );

            // Issue the session. createSession runs the session.create
            // databaseHook (active/role/verification gates + permission
            // metadata), so passwordless logins are gated exactly like password
            // logins. A gate failure surfaces as its own APIError.
            const session = await ctx.context.internalAdapter.createSession(
              userData.id
            );
            if (!session)
              throw new CustomError(
                otpMsg.invalidOrExpired,
                HTTP_STATUS.BAD_REQUEST
              );

            try {
              await setSessionCookie(ctx, { session, user });
            } catch (cookieError) {
              // The row exists but its token was never delivered. Leaving it
              // would put a session the user cannot see or use into their
              // active-session list, so compensate explicitly.
              //
              // `createSession` above already fired `session.create.after`, so a
              // `loginSuccess` row for this session is committed and CANNOT be
              // withdrawn — an audit log is append-only. The compensating event
              // below is what keeps the trail honest: without it the marker
              // describes a session that no longer exists, which is the exact
              // invariant centralising the write was meant to restore.
              await recordAbandonedSession({
                userId: userData.id,
                userEmail: userData.email,
                sessionId: session.id,
                auditMeta,
              });
              await ctx.context.internalAdapter
                .deleteSession(session.token)
                .catch(() => {
                  // Fixed fields ONLY — deliberately not the error.
                  //
                  // This deletion is parameterised by the session TOKEN, and a
                  // driver error embeds its bound parameters in the message. So
                  // the one log written when revocation fails was the one most
                  // likely to print a token that is still live. `serializeForLog`
                  // now withholds such messages, but in development it returns
                  // the raw object, so the safe thing here is to never hand it
                  // the error at all. `sessionId` is the row's public id, not a
                  // credential, and is enough to find the orphan.
                  console.error(
                    sanitizeForLog({
                      msg: 'passwordless.orphanSessionCleanup.failed',
                      userId: userData.id,
                      sessionId: session.id,
                    })
                  );
                });
              throw cookieError;
            }

            // No `loginSuccess` row here any more: `lib/auth.ts`'s
            // `session.create.after` hook writes exactly one, for every method
            // that issues a session, and this endpoint's `createSession` above
            // triggers it. Two writers meant two rows for one login. The channel
            // this login used is on the in-transaction proof event above, which
            // is the record that matters.
            await ensureMinDelay(Date.now() - start);
            return ctx.json({
              success: true,
              message: otpMsg.loginSuccess,
              data: { loggedIn: true },
            });
          } catch (caught) {
            if (accountRevealing) await ensureMinDelay(Date.now() - start);
            // Before `toAuthApiError`, which preserves 429 with its headers by
            // design: a proof-state throttle is account-dependent, so on this
            // ANONYMOUS endpoint it has to become the same generic 400 an unknown
            // address gets. The pre-lookup limiter 429s above are unmarked and
            // still surface.
            const e = collapseProofThrottle(caught, otpMsg.invalidOrExpired);
            if (e instanceof APIError) throw e;
            if (e instanceof CustomError)
              throw toAuthApiError(e, otpMsg.invalidOrExpired);
            throw e;
          }
        }
      ),
    },
  }) satisfies BetterAuthPlugin;
