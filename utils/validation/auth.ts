import * as z from 'zod';
import { CUSTOM_ROLE_VALUE } from '@/lib/permissions/constants';

import { NAME_MAX } from './constants';
import { pagePermissionSchema } from './permissions';
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

export const createUserSchema = z.object({
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
  permissions: z.array(pagePermissionSchema).optional(),
});

export const updateUserSchema = createUserSchema
  .omit({ password: true })
  .extend({
    id: idSchema,
    password: z
      .preprocess(
        (e) => (typeof e === 'string' && e.trim().length ? e : null),
        passwordSchema.optional().nullish()
      )
      .optional()
      .nullish(),
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
