import { EntityID } from '@/types';
import * as z from 'zod';
import { CUSTOM_ROLE_VALUE } from '@/lib/permissions/constants';

import { NAME_MAX } from './constants';
import { permissionsArraySchema } from './permissions';
import {
  emailSchema,
  idSchema,
  passwordSchema,
  sanitizeStrictSingleLine,
} from './rules';

export const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  captcha: z
    .string()
    .min(1, 'الرجاء التحقق من أنك لست روبوت')
    .max(1000, 'الرجاء التحقق من أنك لست روبوت'),
});

export type LoginFormData = z.input<typeof loginSchema>;

const userRoleSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.preprocess(
    sanitizeStrictSingleLine,
    z
      .string()
      .min(2, 'الاسم مطلوب')
      .max(NAME_MAX, `الاسم يجب أن لا يتجاوز ${NAME_MAX} حرفاً`)
  ),
  isActive: z.boolean().default(true),
  roleId: z.union([z.literal(CUSTOM_ROLE_VALUE), idSchema]),
  permissions: permissionsArraySchema.optional(),
});

function validateCustomRolePermissions(
  data: {
    roleId: EntityID | typeof CUSTOM_ROLE_VALUE;
    permissions?: unknown[];
  },
  ctx: z.RefinementCtx
) {
  if (data.roleId === CUSTOM_ROLE_VALUE && !data.permissions?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'يجب تحديد صلاحيات للدور المخصص',
      path: ['permissions'],
    });
  }

  if (data.roleId !== CUSTOM_ROLE_VALUE && data.permissions?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'الصلاحيات مسموح بها فقط عند اختيار دور مخصص',
      path: ['permissions'],
    });
  }
}

export const createUserSchema = userRoleSchema.superRefine(
  validateCustomRolePermissions
);

export const updateUserSchema = userRoleSchema
  .omit({ password: true })
  .extend({
    id: idSchema,
    isActive: z.boolean(),
    password: z
      .preprocess(
        (e) => (typeof e === 'string' && e.trim().length ? e : null),
        passwordSchema.optional().nullish()
      )
      .optional()
      .nullish(),
  })
  .superRefine(validateCustomRolePermissions);

export const selfUpdateUserSchema = userRoleSchema.pick({ name: true }).extend({
  id: idSchema,
});

// Self-service: change own password
export const changePasswordSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
});

// Self-service: change own email
export const changeEmailSchema = z.object({
  currentPassword: passwordSchema,
  newEmail: emailSchema,
});

// Type inference
export type CreateUserInput = z.input<typeof createUserSchema>;
export type UpdateUserInput = z.input<typeof updateUserSchema>;
export type CreateUserOutput = z.output<typeof createUserSchema>;
export type UpdateUserOutput = z.output<typeof updateUserSchema>;

/** @deprecated Use CreateUserInput instead */
export type CreateUserFormData = CreateUserInput;
/** @deprecated Use CreateUserOutput instead */
export type CreateUserFormDataOutput = CreateUserOutput;
/** @deprecated Use UpdateUserInput instead */
export type UpdateUserFormData = UpdateUserInput;
