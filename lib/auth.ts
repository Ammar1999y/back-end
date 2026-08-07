import { db } from '@/db';
import * as schema from '@/db/schema';
import { sanitizeForLog, validID } from '@/utils';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { captcha, haveIBeenPwned } from 'better-auth/plugins';

import {
  CUSTOM_AUTH_CODE,
  EMAIL_NOT_VERIFIED_CODE,
  HTTP_STATUS,
  MSG_EMAIL_NOT_VERIFIED,
  MSG_INVALID_CREDENTIALS,
  MSG_INVALID_INPUT,
  MSG_PAGE_NOT_FOUND,
  MSG_PASSWORD_COMPROMISED,
  MSG_PHONE_NOT_VERIFIED,
  PHONE_NOT_VERIFIED_CODE,
} from '@/utils/api-messages';
import {
  REQUIRE_EMAIL_VERIFICATION,
  REQUIRE_PHONE_VERIFICATION,
} from '@/utils/config';
import { CustomError } from '@/utils/error-class';
import { loginSchema } from '@/utils/validation/auth';
import {
  EMAIL_OTP_AVAILABLE,
  PHONE_OTP_AVAILABLE,
} from '@/utils/validation/otp';

import {
  API_PATH_MAX,
  getClientIp,
  TRUSTED_IP_HEADERS,
  USER_AGENT_MAX,
} from './audit';
import { toAuthApiError } from './auth/api-error';
import { BASE_ERROR_CODES } from './auth/code-errors';
import { LoginRejected, verifyLoginAttempt } from './auth/login-guard';
import { hashPassword } from './auth/password';
import { passwordless } from './auth/passwordless';
import { REQUIRE_ROLE_FOR_LOGIN } from './permissions/constants';
import { sanitizePermissions } from './permissions/utils';
import { enforceRateLimit, ipIdentifier } from './rate-limit';
import { authRateLimitStorage } from './rate-limit/auth-storage';

/**
 * Per-IP sign-in budget. Generous enough that an office behind one NAT egress
 * isn't punished, tight enough that credential stuffing across many accounts
 * is throttled (per-account lockout only covers repeated attempts on ONE
 * account). Applied to an IPv6 /64 bucket, not a single address.
 */
const SIGN_IN_IP_LIMIT_PER_MINUTE = 20;

/**
 * Read-only session lookups are hit on every dashboard navigation and
 * permission check. They must not share the sign-in-grade bucket: behind one
 * NAT egress the default 10/min turns ordinary browsing into deterministic
 * 429s.
 */
const GET_SESSION_LIMIT_PER_MINUTE = 300;
const SIGN_OUT_LIMIT_PER_MINUTE = 30;

// ⚠️ WARNING: password.verify below always returns true because the before
// hook already verifies credentials via verifyLoginAttempt(). If you add a new
// path that relies on Better Auth's built-in password verification, you MUST
// either add verification logic in the before hook or restore the real verify.
const ALLOWED_PATHS = new Set([
  '/get-session',
  '/sign-out',
  '/sign-in/email',
  // Passwordless plugin endpoint — does its own captcha/rate-limit/OTP verify.
  '/passwordless/verify',
]);

const CUSTOM_CODE = CUSTOM_AUTH_CODE;

export const auth = betterAuth({
  baseURL: process.env.NEXT_PUBLIC_URL!,
  database: drizzleAdapter(db, { provider: 'pg', schema: schema }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    password: {
      hash: hashPassword,
      // Always true — the before hook already verifies via verifyLoginAttempt().
      // See ALLOWED_PATHS warning above before adding new password-based paths.
      verify: async () => true,
    },
  },

  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (!ALLOWED_PATHS.has(ctx.path))
        throw new APIError(HTTP_STATUS.NOT_FOUND, {
          message: MSG_PAGE_NOT_FOUND,
          code: CUSTOM_CODE,
        });
      if (ctx.path === '/sign-in/email') {
        const { email, password } =
          ctx.body && typeof ctx.body === 'object'
            ? (ctx.body as Record<string, unknown>)
            : {};

        const { success, data } = loginSchema.safeParse({
          email,
          password,
          captcha: 'success', // captcha plugin runs before this middleware, so we can assume it's always valid here
        });

        if (!success) {
          throw new APIError(HTTP_STATUS.UNPROCESSABLE, {
            message: MSG_INVALID_INPUT,
            code: CUSTOM_CODE,
          });
        }

        // Build audit metadata so login success / lockout transitions are
        // recorded inside verifyLoginAttempt's transaction.
        const reqHeaders =
          (ctx as { headers?: Headers }).headers ??
          (ctx as { request?: Request }).request?.headers ??
          new Headers();

        // Authoritative per-IP admission, consumed BEFORE any credential work.
        // Two reasons this replaces Better Auth's own /sign-in/email rule
        // (disabled in `rateLimit.customRules` below):
        //  1. Atomicity — Better Auth admits on a separate read then write, so
        //     parallel requests at the boundary can all observe the same
        //     remaining quota and pass. Redis' sliding window increments
        //     atomically.
        //  2. Trust — `ipIdentifier` resolves only the edge headers
        //     (lib/audit.ts) and buckets IPv6 by /64, so the limit can't be
        //     bypassed by forging or rotating `x-forwarded-for`. It throws 503
        //     when no trusted IP is present, which fails sign-in closed rather
        //     than skipping the limit.
        // Per-account lockout does not cover this: spraying one password
        // across many accounts never trips it.
        try {
          await enforceRateLimit({
            scope: 'auth.sign-in.ip',
            identifier: ipIdentifier(reqHeaders),
            limit: SIGN_IN_IP_LIMIT_PER_MINUTE,
            window: 60,
            failClosed: true,
          });
        } catch (e) {
          if (e instanceof CustomError)
            throw toAuthApiError(e, MSG_INVALID_CREDENTIALS);
          throw e;
        }

        const auditMeta = {
          ip: getClientIp(reqHeaders),
          userAgent:
            reqHeaders.get('user-agent')?.slice(0, USER_AGENT_MAX) ?? null,
          apiPath: ctx.path.slice(0, API_PATH_MAX),
        };

        // Atomic: lock row → check lock → verify password → update attempts
        // All in one transaction — eliminates the TOCTOU race condition
        try {
          await verifyLoginAttempt({
            email: data.email,
            password: data.password,
            auditMeta,
          });
        } catch (e) {
          if (e instanceof LoginRejected)
            throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
              message: MSG_INVALID_CREDENTIALS,
              code: CUSTOM_CODE,
            });
          throw e;
        }

        return {
          context: {
            ...ctx,
            body: {
              email: data.email,
              password: data.password,
            },
          },
        };
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      const errorCode = (ctx.context?.returned as any)?.body?.code;

      // `Object.hasOwn` + an own-property read, not `BASE_ERROR_CODES[code]`:
      // the code is framework-supplied text, and a plain object resolves
      // inherited members — `constructor` or `toString` would look like a
      // mapped code and put a function where the message belongs.
      const mappedMessage =
        typeof errorCode === 'string' &&
        Object.hasOwn(BASE_ERROR_CODES, errorCode)
          ? BASE_ERROR_CODES[errorCode]
          : undefined;

      if (errorCode && errorCode !== CUSTOM_CODE && mappedMessage) {
        throw new APIError(
          (ctx.context?.returned as any)?.statusCode || HTTP_STATUS.BAD_REQUEST,
          {
            message: mappedMessage,
            code: CUSTOM_CODE,
          }
        );
      }
      if (
        errorCode &&
        errorCode !== CUSTOM_CODE &&
        errorCode !== EMAIL_NOT_VERIFIED_CODE &&
        errorCode !== PHONE_NOT_VERIFIED_CODE
      )
        console.error(sanitizeForLog(ctx.context?.returned));
    }),
  },

  advanced: {
    database: {
      generateId: false,
    },
    // Better Auth otherwise resolves the client IP from `x-forwarded-for`,
    // which is client-controllable whenever the origin is directly reachable.
    // Pin it to the same trusted edge headers the rest of the app uses so the
    // IP written into session metadata — and any Better Auth limiter — can't
    // be forged. IPv6 is bucketed by /64, matching `ipBucket`.
    ipAddress: {
      ipAddressHeaders: [...TRUSTED_IP_HEADERS],
      ipv6Subnet: 64,
    },
  },

  logger: {
    disabled: true,
  },

  session: {
    expiresIn: 2_419_200, // 28 days
    updateAge: 86_400, // 1 day
    freshAge: 60 * 60 * 10, // 10 hours
    cookieCache: {
      enabled: true,
      maxAge: 300, // 5 minutes, TODO: change it depending on the app security policy
    },
    additionalFields: {
      metadata: {
        type: 'json',
        required: false,
        defaultValue: '{}',
        input: false,
      },
    },
    modelName: 'sessions',
  },
  databaseHooks: {
    session: {
      create: {
        // Fail-closed: any error here must block session creation
        before: async (session) => {
          const userId = validID(session.userId);
          if (!userId)
            throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
              message: MSG_INVALID_CREDENTIALS,
              code: CUSTOM_CODE,
            });

          const userData = await db.query.users.findFirst({
            where: (users, { eq, and, isNull }) =>
              and(eq(users.id, userId), isNull(users.deletedAt)),
            columns: {
              isActive: true,
              roleId: true,
              emailVerified: true,
              phoneNumberVerified: true,
            },
            with: {
              role: {
                columns: {
                  id: true,
                  roleName: true,
                  scope: true,
                  isActive: true,
                },
                with: {
                  rolePermissions: {
                    columns: { pageName: true, permissions: true },
                  },
                },
              },
            },
          });

          // Block inactive users or users with inactive roles from getting sessions
          if (
            !userData ||
            !userData.isActive ||
            (userData.role && !userData.role.isActive)
          ) {
            throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
              message: MSG_INVALID_CREDENTIALS,
              code: CUSTOM_CODE,
            });
          }

          // Verification gates. These run AFTER the password has already been
          // verified (verifyLoginAttempt in the /sign-in/email before hook), so
          // revealing the distinct signal leaks nothing to someone who doesn't
          // know the password — every other login failure still returns the
          // generic 401 above. The frontend keys on the code to start the OTP
          // flow.
          //
          // Enforced ONLY when the contact can actually be verified right now
          // (an OTP channel for it is enabled). This is the deliberate design
          // (report/owner decision): the verified flag always reflects reality
          // and is never auto-flipped. So when OTP is off the gate is inert and
          // users work freely; turning OTP on later makes unverified users
          // verify at their next login, without ever losing track of who is
          // genuinely verified.
          if (
            REQUIRE_EMAIL_VERIFICATION &&
            EMAIL_OTP_AVAILABLE &&
            !userData.emailVerified
          ) {
            throw new APIError(HTTP_STATUS.FORBIDDEN, {
              message: MSG_EMAIL_NOT_VERIFIED,
              code: EMAIL_NOT_VERIFIED_CODE,
            });
          }

          if (
            REQUIRE_PHONE_VERIFICATION &&
            PHONE_OTP_AVAILABLE &&
            !userData.phoneNumberVerified
          ) {
            throw new APIError(HTTP_STATUS.FORBIDDEN, {
              message: MSG_PHONE_NOT_VERIFIED,
              code: PHONE_NOT_VERIFIED_CODE,
            });
          }

          if (!userData.roleId || !userData.role) {
            if (REQUIRE_ROLE_FOR_LOGIN) {
              throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
                message: MSG_INVALID_CREDENTIALS,
                code: CUSTOM_CODE,
              });
            }
            return {
              data: {
                ...session,
                metadata: {},
              },
            };
          }

          return {
            data: {
              ...session,
              metadata: {
                roleId: userData.roleId,
                roleName: userData.role.roleName,
                roleScope: userData.role.scope,
                permissions: sanitizePermissions(userData.role.rolePermissions),
              },
            },
          };
        },
      },
    },
  },

  // https://www.better-auth.com/docs/concepts/rate-limit
  // Storage is Upstash Redis (see lib/rate-limit/) so the counter is shared
  // across serverless instances on Vercel.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 10,
    customStorage: authRateLimitStorage,
    // Explicit per-path budgets. The default 10/min bucket is sized for
    // credential endpoints; leaving unrelated traffic in it means one surface
    // throttles another.
    customRules: {
      '/get-session': { window: 60, max: GET_SESSION_LIMIT_PER_MINUTE },
      '/sign-out': { window: 60, max: SIGN_OUT_LIMIT_PER_MINUTE },
      // Owned by the atomic, trusted-IP limiter in the before hook. Keeping a
      // second quota here would only add a weaker, non-atomic duplicate of a
      // limit we already enforce — not a second layer.
      '/sign-in/email': false,
      // The passwordless plugin runs its own fail-closed per-IP limiter.
      '/passwordless/verify': false,
    },
  },

  user: {
    modelName: 'users',
    additionalFields: {
      roleId: {
        type: 'string',
        required: false,
        defaultValue: null,
        input: false,
        fieldName: 'role_id',
      },
      // Virtual field - populated from session metadata
      roleName: {
        type: 'string',
        required: false,
        defaultValue: null,
        input: false,
        returned: false,
      },
    },
  },
  account: {
    modelName: 'accounts',
  },
  // read more https://www.better-auth.com/docs/reference/options#emailverification
  plugins: [
    haveIBeenPwned({
      customPasswordCompromisedMessage: MSG_PASSWORD_COMPROMISED,
    }),
    captcha({
      provider: 'cloudflare-turnstile',
      secretKey:
        process.env.NODE_ENV === 'development'
          ? '1x0000000000000000000000000000000AA'
          : process.env.TURNSTILE_SECRET_KEY!,
      endpoints: ['/sign-in/email'], // TODO: add the proper endpoints
    }),
    // Passwordless sign-in (OTP → session). Verifies its own captcha/OTP.
    passwordless(),
  ],
});
