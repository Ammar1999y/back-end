import { EntityID } from '@/types';
import * as z from 'zod';
import { CUSTOM_ROLE_VALUE } from '@/lib/permissions/constants';

import { PHONE_ENABLED, PHONE_REQUIRED } from '@/utils/config';

import { NAME_MAX } from './constants';
import { channelEnabledRefine, otpCodeSchema } from './otp';
import { permissionsArraySchema } from './permissions';
import {
  emailSchema,
  idSchema,
  optionalPhoneSchema,
  passwordSchema,
  phoneSchema,
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
  // Always parsed (so the type is stable); the mode-specific rules below reject
  // it when phone is disabled and require it when phone is mandatory. Handlers
  // only persist it when PHONE_ENABLED.
  phoneNumber: optionalPhoneSchema,
});

/**
 * Enforce PHONE_NUMBER_MODE at the app boundary:
 * - disabled: a phone must not be supplied.
 * - required: a phone must be supplied.
 */
function validatePhoneByMode(
  data: { phoneNumber?: string | null },
  ctx: z.RefinementCtx
) {
  if (!PHONE_ENABLED && data.phoneNumber) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'رقم الهاتف غير مُفعّل في النظام',
      path: ['phoneNumber'],
    });
  }
  if (PHONE_REQUIRED && !data.phoneNumber) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'رقم الهاتف مطلوب',
      path: ['phoneNumber'],
    });
  }
}

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

export const createUserSchema = userRoleSchema.superRefine((data, ctx) => {
  validateCustomRolePermissions(data, ctx);
  validatePhoneByMode(data, ctx);
});

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
  .superRefine((data, ctx) => {
    validateCustomRolePermissions(data, ctx);
    validatePhoneByMode(data, ctx);
  });

// Reject unknown keys with .strict() so a client sending email/roleId/password/
// isActive gets a 4xx instead of a misleading 200 with the fields silently stripped.
export const selfUpdateUserSchema = userRoleSchema
  .pick({ name: true })
  .extend({ id: idSchema })
  .strict();

// Self-service: change own password
export const changePasswordSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
});

// Self-service: change own email — step 1 (initiate). Requires current-password
// re-auth; the new address is NOT written until ownership is proven via OTP.
export const changeEmailSchema = z.object({
  currentPassword: passwordSchema,
  newEmail: emailSchema,
});

// Self-service: change own email — step 2 (verify + commit). `newEmail` must
// match the address the OTP was sent to (enforced by the session lookup).
export const changeEmailVerifySchema = z.object({
  newEmail: emailSchema,
  code: otpCodeSchema,
});

// Phone OTP delivery channel (email is never a phone channel).
const phoneOtpChannelSchema = z.enum(['sms', 'whatsapp']);

// Self-service: change own phone — step 1 (initiate).
export const changePhoneSchema = z.object({
  currentPassword: passwordSchema,
  newPhoneNumber: phoneSchema,
  channel: phoneOtpChannelSchema,
});

// Self-service: change own phone — step 2 (verify + commit). Re-checks channel
// availability so a channel disabled between initiate and verify is rejected.
export const changePhoneVerifySchema = z
  .object({
    newPhoneNumber: phoneSchema,
    channel: phoneOtpChannelSchema,
    code: otpCodeSchema,
  })
  .superRefine(channelEnabledRefine);

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
