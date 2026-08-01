/**
 * App-level configuration toggles for the starter kit.
 *
 * These live in code (not only env) because several gate DB CHECK constraints
 * and FK behavior — changing them requires a new migration to keep the DB in
 * sync. This file has NO imports so it is safe to pull into both the schema
 * (server) and client bundles without circular-dependency risk.
 */

export type PhoneNumberMode = 'required' | 'optional' | 'disabled';

/**
 * Controls the role of the phone number across the whole app:
 * - 'required': every active user must have a phone number; it is part of the
 *   account identity and `phone_number` is NOT NULL at the DB level.
 * - 'optional': a phone number may be present and verifiable, but is never
 *   mandatory. A present `phone_number_verified = true` still requires a
 *   `phone_number` to exist (CHECK constraint).
 * - 'disabled': phone is removed from every flow — sms/whatsapp OTP is off,
 *   `phone_number_verified` is unused, and the change-phone endpoints 404.
 *
 * ⚠️ Toggling this requires a new migration (`bun drizzle-kit generate`): it
 * gates the `chk_phone_required` / `chk_phone_verified_requires_phone` CHECK
 * constraints and the `phone_number` nullability on the users table.
 */
export const PHONE_NUMBER_MODE = 'optional' as PhoneNumberMode;

/** Phone participates in the app at all (present in some form). */
export const PHONE_ENABLED = PHONE_NUMBER_MODE !== 'disabled';

/** Phone is mandatory for every active user. */
export const PHONE_REQUIRED = PHONE_NUMBER_MODE === 'required';

/**
 * When true, a correct password alone is not enough to obtain a session: the
 * user's email must also be verified. The gate runs in the session-creation
 * hook (after the password has already been verified) and rejects with a
 * distinct `EMAIL_NOT_VERIFIED` signal so the frontend can route the user into
 * the OTP flow. Every other login failure keeps the single generic
 * invalid-credentials response, so this leaks nothing to an attacker who does
 * not know the password. Default off to preserve current behavior.
 */
export const REQUIRE_EMAIL_VERIFICATION = false as boolean;

/**
 * Same policy for the phone number. Only enforced when phone is actually part
 * of the app (PHONE_ENABLED) and OTP can actually verify it (OTP_ENABLED + an
 * enabled phone channel) — see the login gate in lib/auth.ts. Default off.
 */
export const REQUIRE_PHONE_VERIFICATION = false as boolean;

/**
 * OTP bypass. When enabled, an OTP "send" request marks the target contact
 * verified immediately — and a sensitive change (email/phone) is committed
 * immediately — WITHOUT generating or validating a code. The frontend can run
 * the normal request flow and it is approved instantly (no code entry).
 *
 * Use during local development/testing, or when no OTP provider is configured
 * and the owner does not want OTP verification. Exposed to the client via
 * NEXT_PUBLIC_ so the UI can skip the code-entry step.
 *
 * ⚠️ when change it, you need to update NEXT_PUBLIC_OTP_AUTO_VERIFY in .env to update the UI
 */
export const OTP_AUTO_VERIFY = true;
