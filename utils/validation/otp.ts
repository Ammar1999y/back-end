import * as z from 'zod';

import { OTP_CODE_LENGTH } from './constants';
import { emailSchema, phoneSchema, sanitizeStrictSingleLine } from './rules';

// ── Channel Configuration ──
// All supported channels — any change here requires a DB migration
// (update the CHECK constraint chk_verification_channel on verification_sessions)
export const OTP_CHANNELS = ['email', 'sms', 'whatsapp'] as const;
export type OtpChannel = (typeof OTP_CHANNELS)[number];

// ── OTP Purpose ──
// Every verification session is bound to exactly one purpose so an OTP proven
// for one reason can never authorize a different sensitive action. Wired today:
// 'verify_contact' (public ownership proof) and 'change_email' / 'change_phone'
// (authenticated, pending-until-verified). The remaining values are reserved
// for future flows and are not produced by any endpoint yet.
// ⚠️ Changing this list requires a DB migration (otp_purpose pgEnum).
export const OTP_PURPOSES = [
  'verify_contact',
  'passwordless_login',
  'forgot_password',
  'change_password',
  'change_email',
  'change_phone',
] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

// Currently enabled channels — change this to enable SMS/WhatsApp later.
// If not set, OTP is completely disabled (empty array).
// Exposed to the client via NEXT_PUBLIC_ so the UI can adapt.
export const ENABLED_OTP_CHANNELS: readonly OtpChannel[] = process.env
  .NEXT_PUBLIC_ENABLED_OTP_CHANNELS
  ? process.env.NEXT_PUBLIC_ENABLED_OTP_CHANNELS.split(',')
      .map((c) => c.trim())
      .filter((c): c is OtpChannel =>
        (OTP_CHANNELS as readonly string[]).includes(c)
      )
  : [];

export const OTP_ENABLED = ENABLED_OTP_CHANNELS.length > 0;

const MSG_CHANNEL_DISABLED = 'طريقة الإرسال غير مسموحة حالياً';

export const channelSchema = z
  .enum(OTP_CHANNELS)
  .refine((ch) => (ENABLED_OTP_CHANNELS as readonly string[]).includes(ch), {
    message: MSG_CHANNEL_DISABLED,
  });

export const otpCodeSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z
    .string('رمز التحقق مطلوب')
    .length(OTP_CODE_LENGTH, `رمز التحقق يجب أن يكون ${OTP_CODE_LENGTH} أرقام`)
    .regex(/^[0-9]+$/, 'رمز التحقق يجب أن يحتوي على أرقام فقط')
);

const codeSchema = otpCodeSchema;

// ── Send OTP Schemas ──
const sendOtpPhoneSchema = z.object({
  channel: z.literal('whatsapp'),
  phoneNumber: phoneSchema,
});

const sendOtpEmailSchema = z.object({
  channel: z.literal('email'),
  email: emailSchema,
});

const sendOtpSmsSchema = z.object({
  channel: z.literal('sms'),
  phoneNumber: phoneSchema,
});

// Enabled-channel enforcement: sendOtpSchema and verifyOtpSchema both validate
// that the requested channel is in ENABLED_OTP_CHANNELS. This is the single
// source of truth — route-level checks are not needed.
export const sendOtpSchema = z
  .discriminatedUnion('channel', [
    sendOtpPhoneSchema,
    sendOtpEmailSchema,
    sendOtpSmsSchema,
  ])
  .superRefine((data, ctx) => {
    if (!(ENABLED_OTP_CHANNELS as readonly string[]).includes(data.channel)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: MSG_CHANNEL_DISABLED,
      });
    }
  });

export type SendOtpInput = z.infer<typeof sendOtpSchema>;

// ── Verify OTP Schemas ──
const verifyOtpPhoneSchema = z.object({
  channel: z.literal('whatsapp'),
  phoneNumber: phoneSchema,
  code: codeSchema,
});

const verifyOtpEmailSchema = z.object({
  channel: z.literal('email'),
  email: emailSchema,
  code: codeSchema,
});

const verifyOtpSmsSchema = z.object({
  channel: z.literal('sms'),
  phoneNumber: phoneSchema,
  code: codeSchema,
});

export const verifyOtpSchema = z
  .discriminatedUnion('channel', [
    verifyOtpPhoneSchema,
    verifyOtpEmailSchema,
    verifyOtpSmsSchema,
  ])
  .superRefine((data, ctx) => {
    if (!(ENABLED_OTP_CHANNELS as readonly string[]).includes(data.channel)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: MSG_CHANNEL_DISABLED,
      });
    }
  });

export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
