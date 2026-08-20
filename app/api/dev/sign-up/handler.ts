import type { Handler } from '@/lib/http/contract';

import { withTransaction } from '@/db';
import { accounts, rolePermissions, roles, users } from '@/db/schema';
import * as z from 'zod';
import { hashPassword } from '@/lib/auth/password';
import {
  DEFAULT_PAGE_PERMISSIONS,
  ROLE_SCOPE,
} from '@/lib/permissions/constants';

import {
  CREDENTIAL_PROVIDER_ID,
  HTTP_STATUS,
  MSG_CREATE_ERROR,
  MSG_CREATED,
} from '@/utils/api-messages';
import {
  apiError,
  apiSuccess,
  handleApiError,
  handleUserUniqueViolation,
  requireJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { NAME_MAX } from '@/utils/validation/constants';
import {
  emailSchema,
  passwordSchema,
  zodIssueMessage,
} from '@/utils/validation/rules';

/** Exported for the OpenAPI document — see the note in the sessions handler. */
export const devSignUpSchema = z.object({
  name: z
    .string()
    .min(2, 'الاسم مطلوب')
    .max(NAME_MAX, `الاسم يجب أن لا يتجاوز ${NAME_MAX} حرفاً`),
  email: emailSchema,
  password: passwordSchema,
});

export const POST: Handler = async (ctx) => {
  if (process.env.NODE_ENV !== 'development') {
    return apiError({
      message: 'هذه النقطة متاحة فقط في بيئة التطوير',
      status: HTTP_STATUS.FORBIDDEN,
    });
  }

  try {
    const body = requireJsonBody(await ctx.readJson());

    const parsed = devSignUpSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        zodIssueMessage(parsed.error),
        HTTP_STATUS.UNPROCESSABLE
      );

    const { name, email, password } = parsed.data;
    const hashedPassword = await hashPassword(password);

    const newId = await withTransaction(async (tx) => {
      const [systemRole] = await tx
        .insert(roles)
        .values({
          roleName: `system-${email}`,
          scope: ROLE_SCOPE.SYSTEM,
          isActive: true,
        })
        .returning({ id: roles.id });

      if (!systemRole)
        throw new CustomError(MSG_CREATE_ERROR, HTTP_STATUS.INTERNAL_ERROR);

      const allPermissions = DEFAULT_PAGE_PERMISSIONS.map((page) => ({
        roleId: systemRole.id,
        pageName:
          page.name as (typeof rolePermissions.$inferInsert)['pageName'],
        permissions: Object.fromEntries(
          page.availablePermissions.map((action) => [action, true])
        ) as (typeof rolePermissions.$inferInsert)['permissions'],
      }));

      await tx.insert(rolePermissions).values(allPermissions);

      const [newUser] = await tx
        .insert(users)
        .values({
          name,
          email,
          roleId: systemRole.id,
          isActive: true,
        })
        .returning({ id: users.id });

      if (!newUser)
        throw new CustomError(MSG_CREATE_ERROR, HTTP_STATUS.INTERNAL_ERROR);

      await tx.insert(accounts).values({
        accountId: newUser.id,
        providerId: CREDENTIAL_PROVIDER_ID,
        userId: newUser.id,
        password: hashedPassword,
      });

      return newUser.id;
    });

    return apiSuccess({
      message: MSG_CREATED,
      data: { id: newId },
      status: HTTP_STATUS.CREATED,
    });
  } catch (error) {
    // Shared exact-name resolver, like every other user endpoint: `includes()`
    // would classify any constraint whose name merely CONTAINS a known one, and
    // an unrecognized constraint must reach the logged 500 rather than be
    // reported to the client as a conflict it can fix.
    const conflict = handleUserUniqueViolation(error);
    if (conflict) return conflict;
    return handleApiError(error, MSG_CREATE_ERROR);
  }
};
