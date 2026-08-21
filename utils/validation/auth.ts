import type { EntityID } from '@/types';

import * as z from 'zod';
import { CUSTOM_ROLE_VALUE } from '@/lib/permissions/constants';

import { PHONE_ENABLED, PHONE_REQUIRED } from '@/utils/config';

import { NAME_MAX } from './constants';
import { channelEnabledRefine, otpCodeSchema, PHONE_OTP_CHANNELS } from './otp';
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
 * Enforce PHONE_NUMBER_MODE at the app boundary, for all three modes:
 *
 * - `disabled`: a non-empty phone is rejected. An explicit `null`/`''` is
 *   accepted and ignored — the field is inert, not forbidden, so a client that
 *   always sends the key still works.
 * - `optional`: anything valid, including none.
 * - `required`: a phone must be supplied on create. On UPDATE an omitted key
 *   means "keep the current number" (`allowAbsent`), so requiring it there
 *   rejected every partial update — the one mode combination that contradicted
 *   the documented update semantics.
 */
function validatePhoneByMode(
  data: { phoneNumber?: string | null },
  ctx: z.RefinementCtx,
  { allowAbsent = false }: { allowAbsent?: boolean } = {}
) {
  if (!PHONE_ENABLED && data.phoneNumber) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'رقم الهاتف غير مُفعّل في النظام',
      path: ['phoneNumber'],
    });
  }
  // `undefined` only when the key was absent: optionalPhoneSchema maps '' to
  // null, so an empty submitted value is still "supplied, and cleared".
  const absent = data.phoneNumber === undefined;
  if (PHONE_REQUIRED && !data.phoneNumber && !(allowAbsent && absent)) {
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
  ctx: z.RefinementCtx,
  /**
   * Updates may OMIT `permissions` to mean "keep the current matrix". The
   * client only sends it when it actually changed, so requiring it here made
   * renaming a custom-role user fail with a 422. Creates still require it —
   * there is no existing matrix to keep.
   */
  { permissionsOptional = false }: { permissionsOptional?: boolean } = {}
) {
  // Omitted and empty are different requests. `undefined` alone means "keep";
  // an explicitly supplied `[]` claims to clear the matrix, and the handler
  // reads presence off `.length` — so it silently selected "keep" too and
  // returned 200 for a change that never happened. A custom role with no
  // permissions is not a product state, so it is rejected in both variants.
  const suppliedEmpty =
    Array.isArray(data.permissions) && data.permissions.length === 0;
  const missing = permissionsOptional
    ? suppliedEmpty
    : !data.permissions?.length;

  if (missing && data.roleId === CUSTOM_ROLE_VALUE) {
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

type UserPayloadShape = {
  roleId: EntityID | typeof CUSTOM_ROLE_VALUE;
  permissions?: unknown[];
  phoneNumber?: string | null;
};

function refineUserPayload(data: UserPayloadShape, ctx: z.RefinementCtx) {
  validateCustomRolePermissions(data, ctx);
  validatePhoneByMode(data, ctx);
}

/** Update variant: an omitted permission matrix or phone means "unchanged". */
function refineUserUpdatePayload(data: UserPayloadShape, ctx: z.RefinementCtx) {
  validateCustomRolePermissions(data, ctx, { permissionsOptional: true });
  validatePhoneByMode(data, ctx, { allowAbsent: true });
}

/**
 * Create stays LENIENT on purpose. Unknown keys are stripped, which is the
 * documented and tested mass-assignment contract for this endpoint: a client
 * may post server-owned fields (`createdBy`, …) and they must be dropped, not
 * rejected. Every field the create handler writes is read from the parsed
 * output, so stripping is safe here — and unlike the update path there is no
 * "looks like it worked but didn't" failure mode, since every mutable field
 * except `phoneNumber` is required.
 */
export const createUserSchema = userRoleSchema.superRefine(refineUserPayload);

const updateUserObject = userRoleSchema.omit({ password: true }).extend({
  id: idSchema,
  isActive: z.boolean(),
  password: z
    .preprocess(
      (e) => (typeof e === 'string' && e.trim().length > 0 ? e : null),
      passwordSchema.optional().nullish()
    )
    .optional()
    .nullish(),
});

/**
 * Server-side admin update contract.
 *
 * `phoneNumber` is genuinely optional here — omitted (`undefined`) means "keep
 * the current number" and an explicit `null`/`''` means "clear it". The
 * handler derives presence from the PARSED value; reading it off the raw body
 * let a stripped typo look like "not supplied" and return 200 without
 * performing the update.
 */
export const adminUpdateUserSchema = updateUserObject
  .extend({ phoneNumber: optionalPhoneSchema.optional() })
  .strict()
  .superRefine(refineUserUpdatePayload);

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
const phoneOtpChannelSchema = z.enum(PHONE_OTP_CHANNELS);

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

// Type inference for the front end
// type CreateUserInput = z.input<typeof createUserSchema>;
// type UpdateUserInput = z.input<typeof updateUserSchema>;
// type CreateUserOutput = z.output<typeof createUserSchema>;
// type UpdateUserOutput = z.output<typeof updateUserSchema>;
// type LoginFormData = z.input<typeof loginSchema>;

// used in front-end
// const updateUserSchema = updateUserObject.superRefine(refineUserUpdatePayload);
