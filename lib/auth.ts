import { db } from '@/db';
import * as schema from '@/db/schema';
import { sanitizeForLog, validID } from '@/utils';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { captcha, haveIBeenPwned } from 'better-auth/plugins';

import { loginSchema } from '@/utils/validation/auth';

import { BASE_ERROR_CODES } from './auth/code-errors';
import { getUserPermissions } from './permissions/utils';

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
        throw new APIError(404, {
          message: 'الصفحة غير موجودة',
          code: CUSTOM_CODE,
        });
      let body;
      if (ctx.path === '/sign-in/email') {
        const { email, password } = ctx.body;
        const safeUserData = loginSchema.safeParse({
          email,
          password,
        });

        if (!safeUserData.success) {
          throw new APIError(422, {
            message: 'قم بالتحقق من البيانات المدخله',
          });
        }
        body = {
          email: safeUserData.data.email,
          password: safeUserData.data.password,
        };
      }
      if (body)
        return {
          context: {
            ...ctx,
            body,
          },
        };
    }),
    after: createAuthMiddleware(async (ctx) => {
      const errorCode = (ctx.context?.returned as any)?.body?.code;

      if (
        errorCode &&
        errorCode !== CUSTOM_CODE &&
        BASE_ERROR_CODES[errorCode]
      ) {
        throw new APIError((ctx.context?.returned as any)?.statusCode || 400, {
          message: BASE_ERROR_CODES[errorCode],
          code: CUSTOM_CODE,
        });
      } else if (errorCode && errorCode !== CUSTOM_CODE)
        console.error(ctx.context?.returned);
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
      maxAge: 600,
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
  // TODO: open it when set the cach
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          try {
            const userId = validID(session.userId);
            if (!userId) return;

            // Fetch user with role relation
            const userData = await db.query.users.findFirst({
              where: (users, { eq }) => eq(users.id, userId),
              columns: {
                roleId: true,
              },
              with: {
                role: {
                  columns: {
                    id: true,
                    roleName: true,
                  },
                },
              },
            });

            if (!userData || !userData.roleId || !userData.role) {
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
                  permissions: await getUserPermissions({
                    roleId: userData.roleId,
                    session: null,
                    forceDB: true,
                  }),
                },
              },
            };
          } catch (error) {
            console.error(sanitizeForLog(error));
          }
        },
      },
    },
  },

  // https://www.better-auth.com/docs/concepts/rate-limit
  rateLimit: {
    enabled: true,
    window: 60,
    max: 10,
    storage: 'memory', // TODO: Use Redis/Upstash in production for multi-instance
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
