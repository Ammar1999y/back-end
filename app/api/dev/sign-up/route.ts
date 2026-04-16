import { accounts, rolePermissions, roles, users } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { getConstraintName, isUniqueViolation } from '@/utils';
import * as z from 'zod';
import { hashPassword } from '@/lib/auth';
import {
  DEFAULT_PAGE_PERMISSIONS,
  ROLE_SCOPE,
} from '@/lib/permissions/constants';

import {
  CREDENTIAL_PROVIDER_ID,
  HTTP_STATUS,
  MSG_CREATE_ERROR,
  MSG_CREATED,
  MSG_EMAIL_EXISTS,
} from '@/utils/api-messages';
import {
  apiError,
  apiSuccess,
  handleApiError,
  parseJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import { NAME_MAX } from '@/utils/validation/constants';
import { emailSchema, passwordSchema } from '@/utils/validation/rules';

const devSignUpSchema = z.object({
  name: z
    .string()
    .min(2, 'الاسم مطلوب')
    .max(NAME_MAX, `الاسم يجب أن لا يتجاوز ${NAME_MAX} حرفاً`),
  email: emailSchema,
  password: passwordSchema,
});

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== 'development') {
    return apiError({
      message: 'هذه النقطة متاحة فقط في بيئة التطوير',
      status: HTTP_STATUS.FORBIDDEN,
    });
  }

  try {
    const body = await parseJsonBody(request);

    const parsed = devSignUpSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        parsed.error.issues[0].message,
        HTTP_STATUS.UNPROCESSABLE
      );

    const { name, email, password } = parsed.data;
    const hashedPassword = await hashPassword(password);

    const newId = await withTransaction(async (tx) => {
      // Create a dedicated system role with all permissions for this user
      const [systemRole] = await tx
        .insert(roles)
        .values({
          roleName: `system-${email}`,
          scope: ROLE_SCOPE.SYSTEM,
          isActive: true,
        })
        .returning({ id: roles.id });

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
    if (isUniqueViolation(error)) {
      const constraint = getConstraintName(error);
      if (constraint.includes('ux_users_email')) {
        return handleApiError(
          new CustomError(MSG_EMAIL_EXISTS, HTTP_STATUS.CONFLICT)
        );
      }
    }
    return handleApiError(error, MSG_CREATE_ERROR);
  }
}
