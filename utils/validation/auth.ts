import * as z from 'zod';
import { ROLE_SCOPE } from '@/lib/permissions/constants';

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
});

export type LoginFormData = z.input<typeof loginSchema>;

export const ROLE_TYPE_VALUES = [ROLE_SCOPE.STANDARD, ROLE_SCOPE.CUSTOM] as const;
export type RoleType = (typeof ROLE_TYPE_VALUES)[number];

const baseUserFields = {
  email: emailSchema,
  name: z.preprocess(
    sanitizeStrictSingleLine,
    z
      .string()
      .min(2, 'الاسم مطلوب')
      .max(NAME_MAX, `الاسم يجب أن لا يتجاوز ${NAME_MAX} حرفاً`)
  ),
  isActive: z.boolean().default(true),
};

const standardRoleSchema = z.object({
  roleType: z.literal(ROLE_SCOPE.STANDARD),
  roleId: idSchema,
});

const customRoleSchema = z.object({
  roleType: z.literal(ROLE_SCOPE.CUSTOM),
  permissions: permissionsArraySchema.min(1, 'يجب تحديد صلاحيات للدور المخصص'),
});

const roleAssignment = z.discriminatedUnion('roleType', [
  standardRoleSchema,
  customRoleSchema,
]);

export const createUserSchema = z
  .object({
    ...baseUserFields,
    password: passwordSchema,
  })
  .and(roleAssignment);

const optionalPassword = z
  .preprocess(
    (e) => (typeof e === 'string' && e.trim().length ? e : null),
    passwordSchema.optional().nullish()
  )
  .optional()
  .nullish();

export const updateUserSchema = z
  .object({
    ...baseUserFields,
    id: idSchema,
    isActive: z.boolean(),
    password: optionalPassword,
  })
  .and(roleAssignment);

export const selfUpdateUserSchema = z.object({
  id: idSchema,
  name: baseUserFields.name,
  email: baseUserFields.email,
  password: optionalPassword,
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
