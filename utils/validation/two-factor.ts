/**
 * Which second factors this deployment offers, and where a 2FA OTP is delivered.
 *
 * `lib/auth/allowed-paths.ts` derives the served Better Auth paths from
 * `ENABLED_TWO_FACTOR_METHODS`, so a disabled method's endpoints answer 404
 * rather than being merely hidden.
 */
import type { OtpChannel } from './otp';

import * as z from 'zod';

import { PHONE_ENABLED } from '../config';
import { parseEnvEnumList } from './env-list';
import {
  CHANNEL_CREDENTIALS,
  EMAIL_OTP_AVAILABLE,
  isPhoneChannel,
  OTP_CHANNELS,
  otpCodeSchema,
  PHONE_OTP_AVAILABLE,
} from './otp';
import { idSchema, passwordSchema } from './rules';

export const TWO_FACTOR_METHODS = [
  'totp',
  'otp',
  'backup_code',
  'passkey',
] as const;

export type TwoFactorMethod = (typeof TWO_FACTOR_METHODS)[number];

const METHODS_VAR = 'NEXT_PUBLIC_ENABLED_2FA_METHODS';
const CHANNELS_VAR = 'NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS';

/**
 * Deliberately a SEPARATE variable from `NEXT_PUBLIC_ENABLED_OTP_CHANNELS`: a
 * second factor delivered to the contact that can reset the password is not a
 * second factor against anyone holding that contact.
 */
const ENABLED_TWO_FACTOR_OTP_CHANNELS: readonly OtpChannel[] = parseEnvEnumList(
  {
    name: CHANNELS_VAR,
    allowed: OTP_CHANNELS,
    noun: 'channel',
    unsetMeans: 'disable the OTP second factor',
  }
).filter((channel) => PHONE_ENABLED || !isPhoneChannel(channel));

export const ENABLED_TWO_FACTOR_METHODS: readonly TwoFactorMethod[] =
  parseEnvEnumList({
    name: METHODS_VAR,
    allowed: TWO_FACTOR_METHODS,
    noun: 'method',
    unsetMeans: 'disable two-factor authentication entirely',
  });

const METHOD_SET = new Set<string>(ENABLED_TWO_FACTOR_METHODS);
const CHANNEL_SET = new Set<string>(ENABLED_TWO_FACTOR_OTP_CHANNELS);

export const TWO_FACTOR_ENABLED = ENABLED_TWO_FACTOR_METHODS.length > 0;

export function isTwoFactorMethodEnabled(
  method: string
): method is TwoFactorMethod {
  return METHOD_SET.has(method);
}

export function isTwoFactorOtpChannelEnabled(
  channel: string
): channel is OtpChannel {
  return CHANNEL_SET.has(channel);
}

export const TWO_FACTOR_OTP_AVAILABLE =
  METHOD_SET.has('otp') && ENABLED_TWO_FACTOR_OTP_CHANNELS.length > 0;

export const TWO_FACTOR_OTP_CHANNELS = ENABLED_TWO_FACTOR_OTP_CHANNELS;

/**
 * What a code over `channel` proves possession of. Mirrors `otpContactKind` in
 * `lib/rate-limit/api.ts`; both derive from `isPhoneChannel`.
 */
export const twoFactorContactKind = (channel: OtpChannel): 'email' | 'phone' =>
  isPhoneChannel(channel) ? 'phone' : 'email';

/**
 * Logged once, and it says the part an operator does not expect: an empty list
 * does not only hide the surfaces, it stops ENFORCEMENT for accounts that
 * already hold `two_factor_enabled`. They sign in with the password alone until
 * a method is configured again.
 */
if (!TWO_FACTOR_ENABLED)
  console.error(
    JSON.stringify({
      msg: 'twoFactor.disabled no method configured',
      effect:
        'every two-factor and passkey surface answers 404, AND every enrolled ' +
        'account signs in with its first factor alone',
    })
  );

if (METHOD_SET.has('otp') && ENABLED_TWO_FACTOR_OTP_CHANNELS.length === 0)
  throw new Error(
    `${METHODS_VAR} enables "otp" but ${CHANNELS_VAR} names no channel. ` +
      `Set ${CHANNELS_VAR} to a comma-separated list of ${OTP_CHANNELS.join(', ')}, ` +
      `or remove "otp" from ${METHODS_VAR}.`
  );

/**
 * A WARNING, not a refusal.
 *
 * ⚠️ Disjointness is a property of the authentication CHAIN, not of the
 * configuration: the reset now proves a second factor from a set that excludes
 * the contact its own code arrived on, and refuses outright when nothing
 * survives that exclusion. Refusing to boot here enforced the same rule a second
 * time, in the one place it cannot be exact — it made a supported deployment
 * unstartable while promising a guarantee the chain, not the environment, has to
 * provide.
 */
const overlappingKinds = ENABLED_TWO_FACTOR_OTP_CHANNELS.filter((channel) =>
  twoFactorContactKind(channel) === 'email'
    ? EMAIL_OTP_AVAILABLE
    : PHONE_OTP_AVAILABLE
);
if (
  ENABLED_TWO_FACTOR_METHODS.length === 1 &&
  METHOD_SET.has('otp') &&
  ENABLED_TWO_FACTOR_OTP_CHANNELS.length > 0 &&
  overlappingKinds.length === ENABLED_TWO_FACTOR_OTP_CHANNELS.length
)
  console.error(
    JSON.stringify({
      msg: 'twoFactor.otpOverlapsRecovery',
      methods: [...ENABLED_TWO_FACTOR_METHODS],
      otpChannels: [...ENABLED_TWO_FACTOR_OTP_CHANNELS],
      effect:
        'every second factor reaches a contact account recovery also reaches, ' +
        'so password recovery will refuse for these users and the administrative ' +
        'reset is their only route back',
      remedy: `add "totp", "backup_code" or "passkey" to ${METHODS_VAR}, or point ${CHANNELS_VAR} at a contact kind recovery does not use`,
    })
  );

/**
 * `OTP_AUTO_VERIFY` is deliberately not consulted: a second factor that can be
 * skipped is not one, so 2FA always needs a real provider.
 */
if (process.env.NODE_ENV === 'production') {
  const missing = ENABLED_TWO_FACTOR_OTP_CHANNELS.flatMap((channel) =>
    CHANNEL_CREDENTIALS[channel]
      .filter((name) => !process.env[name]?.trim())
      .map((name) => `${name} (required by the "${channel}" 2FA OTP channel)`)
  );
  if (missing.length > 0)
    throw new Error(
      `Missing required server env var${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`
    );
}

// The 2FA surfaces take no identifier from the client: the user is known from
// the session when enrolling and from the challenge cookie when signing in.
// Every body below is both what its endpoint parses and what
// `lib/http/openapi.ts` publishes for it.

/**
 * Validated against the 2FA-enabled channels rather than `OTP_CHANNELS`: a
 * channel with no provider configured would enrol a method that cannot deliver.
 */
const enabledTwoFactorChannel = z
  .string()
  .refine(isTwoFactorOtpChannelEnabled, 'طريقة الإرسال غير مسموحة حالياً');

export const twoFactorOtpEnrollSchema = z.object({
  channel: enabledTwoFactorChannel,
});

/** An offered option's identity — `otp:email`, `otp:phone`, `totp`, … */
const optionIdSchema = z.string().min(1).max(40);

/**
 * Both modes of `/two-factor/otp/send`: `channel` and `password` on the
 * enrolment branch (a session), `option` on the sign-in branch (a challenge).
 */
export const twoFactorOtpSendSchema = z.object({
  channel: enabledTwoFactorChannel.optional(),
  option: optionIdSchema.optional(),
  password: passwordSchema.optional(),
});

export const twoFactorOtpVerifySchema = z.object({
  code: otpCodeSchema,
  channel: enabledTwoFactorChannel.optional(),
  option: optionIdSchema.optional(),
});

/** Re-authentication alone: TOTP setup, backup-code generation, disable, the passkey grant. */
export const twoFactorPasswordSchema = z.object({ password: passwordSchema });

export const twoFactorTotpConfirmSchema = z.object({ code: otpCodeSchema });

/** Names ONE enrolment: `contactKind` distinguishes a user's two OTP rows. */
export const twoFactorMethodOptionSchema = z.object({
  method: z.enum(TWO_FACTOR_METHODS),
  contactKind: z.enum(['email', 'phone']).optional(),
});

export const twoFactorMethodDisableSchema = twoFactorMethodOptionSchema.extend({
  password: passwordSchema,
});

export const twoFactorPasskeyVerifySchema = z.object({
  response: z.record(z.string(), z.unknown()),
});

/** A row this schema stores by UUID: a trusted device, a passkey. */
export const ownedRowSchema = z.object({ id: idSchema });
