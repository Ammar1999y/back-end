import * as z from 'zod';

import { OTP_AUTO_VERIFY, PHONE_ENABLED } from '../config';
import { OTP_CODE_LENGTH } from './constants';
import { parseEnvEnumList } from './env-list';
import {
  emailSchema,
  passwordSchema,
  phoneSchema,
  sanitizeStrictSingleLine,
} from './rules';

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

// Every verification session is purpose-bound so a proof cannot authorize a
// different action. All values are wired except the reserved 'change_password'.
// ⚠️ Changing this list requires a DB migration (otp_purpose pgEnum).
export const OTP_PURPOSES = [
  'verify_contact',
  'passwordless_login',
  'forgot_password',
  'change_password',
  'change_email',
  'change_phone',
  'two_factor',
] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

const PHONE_CHANNEL_SET = new Set<OtpChannel>(PHONE_OTP_CHANNELS);

/**
 * sms and whatsapp reach the same destination and cost the same, so every
 * per-contact quota and block must treat them as one.
 */
export const isPhoneChannel = (c: OtpChannel): c is PhoneOtpChannel =>
  PHONE_CHANNEL_SET.has(c);

/**
 * The credentials each channel's provider needs, and it is a startup
 * requirement rather than a runtime one.
 *
 * Names live here, beside the channel list, because this module is the single
 * place that answers "is this OTP configuration coherent?" — `lib/env.server.ts`
 * is the natural home for a required-variable list, but importing this module
 * there would pull jsdom and DOMPurify into the startup gate. The variables
 * themselves are read in `utils/otp.ts`.
 */
export const CHANNEL_CREDENTIALS: Readonly<
  Record<OtpChannel, readonly string[]>
> = {
  // `SMTP_FROM` is optional: `sendOtpEmail` falls back to `SMTP_USER` as the
  // sender, so `SMTP_USER` covers both the login and the envelope.
  email: ['SMTP_USER', 'SMTP_PASS'],
  sms: ['DEEWAN_SMS_TOKEN', 'DEEWAN_SENDER_NAME'],
  whatsapp: ['WHATSAPP_API_KEY'],
};

/**
 * Channels listed in the env — parsed STRICTLY, because the two failure modes it
 * used to absorb are both silent deploys of a broken feature.
 *
 * An unknown entry was filtered out and the resulting empty set was then read as
 * "OTP intentionally disabled": measured, `NEXT_PUBLIC_ENABLED_OTP_CHANNELS=emial`
 * logged the disabled notice and every send and verify surface answered 404, in
 * a deployment that otherwise passed every boot check. Duplicates and empty
 * entries are rejected for the same reason — they are always a typo, never an
 * intention.
 *
 * Phone channels are still STRIPPED rather than rejected when
 * `PHONE_NUMBER_MODE` disables phone: that is a coherent configuration (the
 * whole phone feature is off) rather than a mistake in this variable.
 */
function parseEnvChannels(): OtpChannel[] {
  return parseEnvEnumList({
    name: 'NEXT_PUBLIC_ENABLED_OTP_CHANNELS',
    allowed: OTP_CHANNELS,
    noun: 'channel',
    unsetMeans: 'disable OTP entirely',
  }).filter((c) => PHONE_ENABLED || !isPhoneChannel(c));
}

const envChannels: OtpChannel[] = parseEnvChannels();

// `OTP_AUTO_VERIFY` skips code entry on contact verification and the
// authenticated contact-change endpoints, so their channels have to stay
// offered even with none configured. It does NOT stop delivery: recovery and
// passwordless never consult the flag and always issue a real code, which is
// why the credential gate below reads this widened set rather than the
// environment variable alone.
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

/**
 * Every ENABLED channel must have its provider credentials, in production.
 *
 * Fatal at load, alongside the other production-only requirements in
 * `lib/env.server.ts`, because the failure it prevents is invisible until a real
 * user needs it: measured, a deployment satisfying every declared production
 * requirement with `NEXT_PUBLIC_ENABLED_OTP_CHANNELS=email` and no `SMTP_USER` /
 * `SMTP_PASS` started, passed storage readiness, and then ACCEPTED and PERSISTED
 * every send request before delivery failed. Recovery and passwordless login are
 * both unusable in that state.
 *
 * Not gated on `OTP_AUTO_VERIFY`: that bypass never reaches
 * `passwordless_login` or `forgot_password`, both of which always issue a real
 * code, so a channel that is enabled still has to be deliverable.
 *
 * Production only — a developer running with `OTP_AUTO_VERIFY` and no mail
 * provider is a supported local configuration.
 */
if (process.env.NODE_ENV === 'production') {
  const missing = ENABLED_OTP_CHANNELS.flatMap((channel) =>
    CHANNEL_CREDENTIALS[channel]
      .filter((name) => !process.env[name]?.trim())
      .map((name) => `${name} (required by the "${channel}" OTP channel)`)
  );
  if (missing.length > 0)
    throw new Error(
      `Missing required server env var${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`
    );
}

/**
 * Where a code goes: the channel's provider, or — for a test process — an
 * in-memory outbox the test reads back (`utils/otp-outbox.ts`). A channel can
 * then be exercised end to end, and the delivered text asserted, with no
 * provider account.
 *
 * Refused in production at load: a deployment set to `outbox` would accept every
 * send and deliver nothing, which is the failure the credential gate above exists
 * to prevent.
 */
const OTP_DELIVERY_MODES = ['provider', 'outbox'] as const;
const otpDelivery = process.env.OTP_DELIVERY?.trim() || 'provider';
if (!(OTP_DELIVERY_MODES as readonly string[]).includes(otpDelivery))
  throw new Error(
    `OTP_DELIVERY must be one of ${OTP_DELIVERY_MODES.join(', ')}; got "${otpDelivery}"`
  );
export const OTP_DELIVERY_OUTBOX = otpDelivery === 'outbox';
if (OTP_DELIVERY_OUTBOX && process.env.NODE_ENV === 'production')
  throw new Error(
    'OTP_DELIVERY=outbox is a test transport: no code would ever reach a user. Unset it in production.'
  );

/** Narrows unvalidated input to a channel that is enabled right now. */
export function isChannelEnabled(channel: string): channel is OtpChannel {
  return (ENABLED_OTP_CHANNELS as readonly string[]).includes(channel);
}

/** A channel capable of verifying the email / the phone is enabled. */
export const EMAIL_OTP_AVAILABLE = EMAIL_OTP_CHANNELS.some(isChannelEnabled);
export const PHONE_OTP_AVAILABLE = PHONE_OTP_CHANNELS.some(isChannelEnabled);

const MSG_CHANNEL_DISABLED = 'طريقة الإرسال غير مسموحة حالياً';

/**
 * Shared superRefine: the requested channel must be currently enabled.
 *
 * Module-private, and it applies to the SEND schemas ONLY. A send is the act the
 * channel decides — it selects a provider and spends money at one. A VERIFY does
 * not: `processOtpVerify` selects the proof row by `contactKind` and the verify
 * quota buckets by it, and both collapse `sms` and `whatsapp` onto `'phone'`, so
 * the channel is not part of the proof's identity. Checking it there refused the
 * honest caller who named the transport their code actually arrived on — after
 * ops disabled it inside the code's lifetime — while the identical request
 * naming the sibling channel verified the SAME row and committed the same
 * change. See `changePhoneVerifySchema`, which reached this conclusion first.
 */
function channelEnabledRefine(data: { channel: string }, ctx: z.RefinementCtx) {
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

// Enabled-channel enforcement lives on the SEND schemas and nowhere else — see
// `channelEnabledRefine`. This is the single source of truth for it;
// route-level checks are not needed.
export const sendOtpSchema = z
  .discriminatedUnion('channel', [
    sendOtpPhoneSchema,
    sendOtpEmailSchema,
    sendOtpSmsSchema,
  ])
  .superRefine(channelEnabledRefine);

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

// No `channelEnabledRefine` on either schema below, and these are the ANONYMOUS
// surfaces where it mattered most: `/api/auth/otp/verify`,
// `/api/auth/passwordless/verify` and `/api/auth/forgot-password/reset` all
// parse through them, so a caller holding a real code delivered over a
// since-disabled channel got 422 while the same code named `sms` verified. See
// `channelEnabledRefine`.
export const verifyOtpSchema = z.discriminatedUnion('channel', [
  verifyOtpPhoneSchema,
  verifyOtpEmailSchema,
  verifyOtpSmsSchema,
]);

/**
 * `/passwordless/verify` issues a session, so it carries the same `rememberMe`
 * `/sign-in/email` does. Absent means remembered — see `submittedRememberMe`.
 */
const rememberMeField = { rememberMe: z.boolean().optional() };
export const passwordlessVerifySchema = z.discriminatedUnion('channel', [
  verifyOtpPhoneSchema.extend(rememberMeField),
  verifyOtpEmailSchema.extend(rememberMeField),
  verifyOtpSmsSchema.extend(rememberMeField),
]);

// Same shape as verify (channel + identifier + code) plus the new password.
export const resetPasswordSchema = z.discriminatedUnion('channel', [
  verifyOtpPhoneSchema.extend({ newPassword: passwordSchema }),
  verifyOtpEmailSchema.extend({ newPassword: passwordSchema }),
  verifyOtpSmsSchema.extend({ newPassword: passwordSchema }),
]);

/**
 * The second half of a reset for an account that holds a second factor.
 *
 * `grant` is the token `/forgot-password/reset` answered with; `option` is one
 * of the identities it listed. Neither is a credential on its own — the grant
 * proves the recovery contact and nothing else, and `option` only names which
 * factor the `code` below is for.
 */
const recoveryGrantSchema = z.object({
  grant: z.string().min(1).max(200),
  option: z.string().min(1).max(40),
});

export const recoverySecondFactorSendSchema = recoveryGrantSchema;

export const recoveryCompleteSchema = recoveryGrantSchema.extend({
  code: otpCodeSchema.or(
    // A backup code is not a six-digit OTP: `xxxxx-xxxxx` from the generated
    // set. Bounded rather than free text.
    z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/u, 'رمز الاسترجاع غير صحيح')
  ),
  newPassword: passwordSchema,
});

// used in the front end
// type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
// type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
// type SendOtpInput = z.infer<typeof sendOtpSchema>;
