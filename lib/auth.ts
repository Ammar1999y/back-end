import { db } from '@/db';
import * as schema from '@/db/schema';
import { sanitizeForLog, validID } from '@/utils';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { captcha, haveIBeenPwned } from 'better-auth/plugins';

import {
  HTTP_STATUS,
  MSG_INVALID_CREDENTIALS,
  MSG_INVALID_INPUT,
  MSG_PAGE_NOT_FOUND,
  MSG_PASSWORD_COMPROMISED,
} from '@/utils/api-messages';
import { loginSchema } from '@/utils/validation/auth';

import { API_PATH_MAX, getClientIp, USER_AGENT_MAX } from './audit';
import { BASE_ERROR_CODES } from './auth/code-errors';
import { LoginRejected, verifyLoginAttempt } from './auth/login-guard';
import { REQUIRE_ROLE_FOR_LOGIN } from './permissions/constants';
import { sanitizePermissions } from './permissions/utils';
import { authRateLimitStorage } from './rate-limit/auth-storage';

// ⚠️ WARNING: password.verify below always returns true because the before
// hook already verifies credentials via verifyLoginAttempt(). If you add a new
// path that relies on Better Auth's built-in password verification, you MUST
// either add verification logic in the before hook or restore the real verify.
const ALLOWED_PATHS = new Set(['/get-session', '/sign-out', '/sign-in/email']);

const CUSTOM_CODE = '__';

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
      // verify: verifyPassword,
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

      if (
        errorCode &&
        errorCode !== CUSTOM_CODE &&
        BASE_ERROR_CODES[errorCode]
      ) {
        throw new APIError(
          (ctx.context?.returned as any)?.statusCode || HTTP_STATUS.BAD_REQUEST,
          {
            message: BASE_ERROR_CODES[errorCode],
            code: CUSTOM_CODE,
          }
        );
      } else if (errorCode && errorCode !== CUSTOM_CODE)
        console.error(sanitizeForLog(ctx.context?.returned));
    }),
  },

  advanced: {
    database: {
      generateId: false,
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
    customRules: {
      '/sign-in/email': { window: 60, max: 5 },
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
  ],
});
// eslint-disable-next-line unicorn/prefer-export-from
export { hashPassword, verifyPassword };
