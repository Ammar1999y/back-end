import * as z from 'zod';

import { OTP_AUTO_VERIFY, PHONE_ENABLED } from '../config';
import { OTP_CODE_LENGTH } from './constants';
import {
  emailSchema,
  passwordSchema,
  phoneSchema,
  sanitizeStrictSingleLine,
} from './rules';

// ── Channel Configuration ──
// The email/phone split is declared HERE and nowhere else: `isPhoneChannel`,
// the per-contact quota grouping, the phone-only schemas and the availability
// flags all derive from these two lists. `OTP_CHANNELS` is the concatenation,
// so its order — which the `otp_channel` pgEnum depends on — stays stable.
// ⚠️ Changing these requires a DB migration (otp_channel pgEnum).
const EMAIL_OTP_CHANNELS = ['email'] as const;
export const PHONE_OTP_CHANNELS = ['sms', 'whatsapp'] as const;
export const OTP_CHANNELS = [
  ...EMAIL_OTP_CHANNELS,
  ...PHONE_OTP_CHANNELS,
] as const;

export type OtpChannel = (typeof OTP_CHANNELS)[number];
export type PhoneOtpChannel = (typeof PHONE_OTP_CHANNELS)[number];

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

const PHONE_CHANNEL_SET = new Set<OtpChannel>(PHONE_OTP_CHANNELS);

/**
 * sms and whatsapp reach the same destination and cost the same, so every
 * per-contact quota and block must treat them as one.
 */
export const isPhoneChannel = (c: OtpChannel): c is PhoneOtpChannel =>
  PHONE_CHANNEL_SET.has(c);

// Channels listed in the env, filtered to real ones and — when phone is
// disabled (PHONE_NUMBER_MODE) — with the phone channels stripped so the
// config can't contradict itself.
const envChannels: OtpChannel[] = (
  process.env.NEXT_PUBLIC_ENABLED_OTP_CHANNELS
    ? process.env.NEXT_PUBLIC_ENABLED_OTP_CHANNELS.split(',')
        .map((c) => c.trim())
        .filter((c): c is OtpChannel =>
          (OTP_CHANNELS as readonly string[]).includes(c)
        )
    : []
).filter((c) => PHONE_ENABLED || !isPhoneChannel(c));

// When OTP is bypassed (OTP_AUTO_VERIFY), no real delivery happens, but the
// verification UI still needs channels to offer and the flag-flip endpoints
// must stay reachable. Email is always available; phone channels only when
// phone is enabled.
const bypassChannels: readonly OtpChannel[] = OTP_AUTO_VERIFY
  ? [...EMAIL_OTP_CHANNELS, ...(PHONE_ENABLED ? PHONE_OTP_CHANNELS : [])]
  : [];

// Enabled channels — exposed to the client via NEXT_PUBLIC_ so the UI adapts.
// Empty array means OTP is completely disabled.
const ENABLED_OTP_CHANNELS: readonly OtpChannel[] = [
  ...new Set([...envChannels, ...bypassChannels]),
];

export const OTP_ENABLED = ENABLED_OTP_CHANNELS.length > 0;

/**
 * Logged ONCE, at module load, because it is a DEPLOY fault and not a request
 * event.
 *
 * It has to be logged somewhere: with OTP off, every recovery and passwordless
 * request answers 404, and a 404 from a misconfiguration is indistinguishable in
 * an access log from a 404 on an unrouted path. It must not be logged PER
 * REQUEST — the three send handlers did that ahead of their own IP limiter, so
 * anyone could inflate the error stream at will whenever OTP was intentionally
 * off.
 */
if (!OTP_ENABLED)
  console.error(
    JSON.stringify({
      msg: 'otp.disabled no channel configured',
      effect: 'every OTP send and verify surface answers 404',
    })
  );

/** Narrows unvalidated input to a channel that is enabled right now. */
export function isChannelEnabled(channel: string): channel is OtpChannel {
  return (ENABLED_OTP_CHANNELS as readonly string[]).includes(channel);
}

/** A channel capable of verifying the email / the phone is enabled. */
export const EMAIL_OTP_AVAILABLE = EMAIL_OTP_CHANNELS.some(isChannelEnabled);
export const PHONE_OTP_AVAILABLE = PHONE_OTP_CHANNELS.some(isChannelEnabled);

const MSG_CHANNEL_DISABLED = 'طريقة الإرسال غير مسموحة حالياً';

/** Shared superRefine: the requested channel must be currently enabled. */
export function channelEnabledRefine(
  data: { channel: string },
  ctx: z.RefinementCtx
) {
  if (!isChannelEnabled(data.channel)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: MSG_CHANNEL_DISABLED,
    });
  }
}

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
  .superRefine(channelEnabledRefine);

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
  .superRefine(channelEnabledRefine);

// ── Reset-Password Schema (forgot-password) ──
// Same shape as verify (channel + identifier + code) plus the new password.
export const resetPasswordSchema = z
  .discriminatedUnion('channel', [
    verifyOtpPhoneSchema.extend({ newPassword: passwordSchema }),
    verifyOtpEmailSchema.extend({ newPassword: passwordSchema }),
    verifyOtpSmsSchema.extend({ newPassword: passwordSchema }),
  ])
  .superRefine(channelEnabledRefine);

// used in the front end
// type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
// type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
// type SendOtpInput = z.infer<typeof sendOtpSchema>;
