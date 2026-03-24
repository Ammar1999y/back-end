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
} from '@/utils/api-messages';
import { loginSchema } from '@/utils/validation/auth';

import { BASE_ERROR_CODES } from './auth/code-errors';
import {
  checkLoginLock,
  recordFailedLogin,
  resetLoginAttempts,
} from './auth/login-guard';
import { REQUIRE_ROLE_FOR_LOGIN } from './permissions/constants';
import { sanitizePermissions } from './permissions/utils';

const ALLOWED_PATHS = new Set([
  '/get-session',
  '/sign-out',
  '/revoke-session',
  '/sign-in/email',
]);

const CUSTOM_CODE = '__';

export const auth = betterAuth({
  baseURL: process.env.NEXT_PUBLIC_URL!,
  database: drizzleAdapter(db, { provider: 'pg', schema: schema }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    password: {
      hash: hashPassword,
      verify: verifyPassword,
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
        });

        if (!success) {
          throw new APIError(HTTP_STATUS.UNPROCESSABLE, {
            message: MSG_INVALID_INPUT,
            code: CUSTOM_CODE,
          });
        }

        const user = await db.query.users.findFirst({
          where: (u, { eq, and, isNull }) =>
            and(eq(u.email, data.email), isNull(u.deletedAt)),
          columns: { isActive: true },
          with: {
            role: {
              columns: { isActive: true },
            },
          },
        });

        if (user && (!user.isActive || (user.role && !user.role.isActive)))
          throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
            message: MSG_INVALID_CREDENTIALS,
            code: CUSTOM_CODE,
          });

        // Check account lock (race-condition safe with FOR UPDATE)
        // Returns same error as invalid credentials to prevent user enumeration
        const lockStatus = await checkLoginLock(data.email);
        if (lockStatus?.locked) {
          throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
            message: MSG_INVALID_CREDENTIALS,
            code: CUSTOM_CODE,
          });
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

      if (ctx.path === '/sign-in/email') {
        const email: string | undefined = ctx.body?.email;

        if (email && ctx.context?.newSession) {
          // Successful login — reset attempts (no-op if already 0)
          try {
            await resetLoginAttempts(email);
          } catch (e) {
            console.error(sanitizeForLog(e));
          }
          return;
        }

        // Failed login — record attempt (may trigger lock)
        if (email && errorCode && errorCode !== CUSTOM_CODE) {
          await recordFailedLogin(email);
        }
      }

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

  // 404,403,401,400, 429, 500,
  // onAPIError: {
  //   onError: (error, ctx) => {
  //     throw new APIError(403, {
  //       message: 'تم رفض الوصول: تحتاج صلاحيات أعلى أو إعادة المصادقة.',
  //       code: 'ACCESS_DENIED',
  //     });
  //   },
  //   throw: true,
  // },

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
      maxAge: 300,
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
                permissions: sanitizePermissions(
                  userData.role.rolePermissions
                ),
              },
            },
          };
        },
      },
    },
  },

  // https://www.better-auth.com/docs/concepts/rate-limit
  rateLimit: {
    enabled: true,
    window: 60,
    max: 10,
    storage: 'memory', // TODO: in multiple server/less function instances Use Redis
    customRules: {
      '/sign-in/email': { window: 60, max: 5 },
      '/sign-up/email': { window: 60, max: 3 },
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
      customPasswordCompromisedMessage: 'كلمة السر ضعيفه، قم بتغيرها',
    }),
    captcha({
      provider: 'cloudflare-turnstile',
      secretKey:
        process.env.NODE_ENV === 'development'
          ? '1x0000000000000000000000000000000AA'
          : process.env.TURNSTILE_SECRET_KEY!,
      endpoints: ['/sign-up/email', '/sign-in/email'], // TODO: add the proper endpoints
    }),
  ],
});
// eslint-disable-next-line unicorn/prefer-export-from
export { hashPassword, verifyPassword };
