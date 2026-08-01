import type { BetterAuthPlugin } from 'better-auth';

import { and, eq, isNull } from 'drizzle-orm';

import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import * as z from 'zod';

import { ensureMinDelay, otpMsg } from '@/app/api/auth/otp/messages';
import { db } from '@/db';
import { users } from '@/db/schema';

import {
  CUSTOM_AUTH_CODE,
  HTTP_STATUS,
  MSG_PAGE_NOT_FOUND,
} from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import { markContactVerified, processOtpVerify } from '@/utils/otp';
import { OTP_ENABLED, verifyOtpSchema } from '@/utils/validation/otp';

import { API_PATH_MAX, getClientIp, USER_AGENT_MAX } from '../audit';
import { verifyTurnstileRequest } from '../captcha';
import { enforceRateLimit, ipIdentifier, otpVerifyScope } from '../rate-limit';

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
        { method: 'POST', body: z.record(z.string(), z.unknown()) },
        async (ctx) => {
          const headers: Headers =
            (ctx as { headers?: Headers }).headers ??
            (ctx as { request?: Request }).request?.headers ??
            new Headers();

          // Floor the response time across the account-revealing paths below
          // (unknown identifier returns fast with no Argon2id; a real verify runs
          // it) so timing can't be used to enumerate accounts.
          const start = Date.now();

          // Surfaced directly (not account-specific → no enumeration risk).
          if (!OTP_ENABLED)
            throw new APIError(HTTP_STATUS.NOT_FOUND, {
              message: MSG_PAGE_NOT_FOUND,
              code: CUSTOM_AUTH_CODE,
            });

          // Per-IP cap BEFORE captcha so the outbound siteverify call is bounded.
          await enforceRateLimit({
            scope: 'passwordless.verify.ip',
            identifier: ipIdentifier(headers),
            limit: 60,
            window: 60,
            failClosed: true,
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

          await enforceRateLimit({
            scope: otpVerifyScope(channel),
            identifier: identifier.toLowerCase(),
            limit: 10,
            window: 600,
            failClosed: true,
          });

          try {
            const [userData] = await db
              .select({ id: users.id, email: users.email })
              .from(users)
              .where(
                and(
                  channel === 'email'
                    ? eq(users.email, identifier)
                    : eq(users.phoneNumber, identifier),
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
              onVerified: (tx) =>
                markContactVerified(tx, {
                  userId: userData.id,
                  channel,
                  auditMeta,
                  onMissing: () => {
                    throw new CustomError(
                      otpMsg.invalidOrExpired,
                      HTTP_STATUS.BAD_REQUEST
                    );
                  },
                }),
            });

            // Issue the session. createSession runs the session.create
            // databaseHook (active/role/verification gates + permission
            // metadata), so passwordless logins are gated exactly like password
            // logins. A gate failure surfaces as its own APIError.
            const session =
              await ctx.context.internalAdapter.createSession(userData.id);
            const user = await ctx.context.internalAdapter.findUserById(
              userData.id
            );
            if (!session || !user)
              throw new CustomError(
                otpMsg.invalidOrExpired,
                HTTP_STATUS.BAD_REQUEST
              );

            await setSessionCookie(ctx, { session, user });

            await ensureMinDelay(Date.now() - start);
            return ctx.json({
              success: true,
              message: otpMsg.loginSuccess,
              data: { loggedIn: true },
            });
          } catch (e) {
            await ensureMinDelay(Date.now() - start);
            if (e instanceof APIError) throw e;
            if (e instanceof CustomError) {
              // Privacy collapse: unknown user / wrong code / expired / no
              // session all map to one generic 400; only throttling stays
              // distinct (passed as literal statuses so APIError accepts them).
              if (e.status === HTTP_STATUS.TOO_MANY_REQUESTS)
                throw new APIError(HTTP_STATUS.TOO_MANY_REQUESTS, {
                  message: e.message,
                  code: CUSTOM_AUTH_CODE,
                });
              if (e.status === HTTP_STATUS.SERVICE_UNAVAILABLE)
                throw new APIError(HTTP_STATUS.SERVICE_UNAVAILABLE, {
                  message: e.message,
                  code: CUSTOM_AUTH_CODE,
                });
              throw new APIError(HTTP_STATUS.BAD_REQUEST, {
                message: otpMsg.invalidOrExpired,
                code: CUSTOM_AUTH_CODE,
              });
            }
            throw e;
          }
        }
      ),
    },
  }) satisfies BetterAuthPlugin;
