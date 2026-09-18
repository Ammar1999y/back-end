/**
 * The closed value sets this application shares with its PostgreSQL enums, and
 * the one predicate that reads them.
 *
 * ⚠️ NO imports and NO environment reads, and that is the reason the file
 * exists rather than a preference. `db/schema.ts` builds `pgEnum`s from these
 * lists, so `drizzle-kit generate` — and the `check:schema-drift` gate that runs
 * it — loaded whichever module declared them; and
 * `scripts/check-two-factor-rollout.ts` exists to judge a PROPOSED configuration
 * it takes on the command line. Both used to pull
 * `utils/validation/otp.ts` and `utils/validation/two-factor.ts`, which parse
 * `NEXT_PUBLIC_ENABLED_*` at module load: a schema generation and a preflight
 * therefore printed the runtime's disabled notices, and a malformed CURRENT
 * value threw before either had done anything.
 *
 * Anything that depends on what is ENABLED belongs in those two modules, not
 * here.
 */

// The email/phone split is declared HERE and nowhere else: `isPhoneChannel`,
// the per-contact quota grouping, the phone-only schemas and the availability
// flags all derive from these two lists. `OTP_CHANNELS` is the concatenation,
// so its order — which the `otp_channel` pgEnum depends on — stays stable.
// ⚠️ Changing these requires a DB migration (otp_channel pgEnum).
export const EMAIL_OTP_CHANNELS = ['email'] as const;
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

// ⚠️ Changing this list requires a DB migration (two_factor_method pgEnum).
export const TWO_FACTOR_METHODS = [
  'totp',
  'otp',
  'backup_code',
  'passkey',
] as const;

export type TwoFactorMethod = (typeof TWO_FACTOR_METHODS)[number];

const PHONE_CHANNEL_SET = new Set<OtpChannel>(PHONE_OTP_CHANNELS);

/**
 * sms and whatsapp reach the same destination and cost the same, so every
 * per-contact quota and block must treat them as one.
 */
export const isPhoneChannel = (c: OtpChannel): c is PhoneOtpChannel =>
  PHONE_CHANNEL_SET.has(c);
