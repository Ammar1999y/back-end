/**
 * App-level configuration toggles for the starter kit.
 *
 * These live in code (not only env) because several gate DB CHECK constraints
 * and FK behavior — changing them requires a new migration to keep the DB in
 * sync. This file has NO imports so it is safe to pull into both the schema
 * (server) and client bundles without circular-dependency risk.
 */

/**
 * Authoritative calendar timezone for date filtering and reporting.
 *
 * A "created on 2 Aug" filter has to mean the same rows for every viewer and
 * for the server, so calendar boundaries are resolved in ONE declared zone
 * rather than in whatever zone the browser or the host happens to run in.
 * Without this the client sent local midnight and the server re-derived
 * start/end-of-day in its own zone, shifting the selected day by the offset
 * between them.
 *
 * `NEXT_PUBLIC_` so both bundles resolve the same value: a server-only variable
 * is inlined as `undefined` in the client, which reintroduces the divergence
 * this constant exists to remove. A calendar zone is not a secret.
 */
const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Riyadh';

function resolveBusinessTimezone(): string {
  const configured = process.env.NEXT_PUBLIC_BUSINESS_TIMEZONE?.trim();
  if (!configured) return DEFAULT_BUSINESS_TIMEZONE;

  try {
    // Throws RangeError on an unknown zone. Failing beats falling back: a typo
    // that silently resolves to Riyadh is how "off by one day" reaches production.
    new Intl.DateTimeFormat('en-US', { timeZone: configured });
  } catch {
    throw new Error(
      `Invalid NEXT_PUBLIC_BUSINESS_TIMEZONE: "${configured}" is not a recognized IANA time zone`
    );
  }

  return configured;
}

export const BUSINESS_TIMEZONE = resolveBusinessTimezone();

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
export const OTP_AUTO_VERIFY = false;

/**
 * Whether a submitted `rememberMe` is honoured.
 *
 * `false` pins every session to the short lifetime regardless of what the client
 * asked for, which is what a deployment that wants uniform session expiry needs.
 * `true` — the default — means the choice reaches session creation and the
 * cookie, instead of being read and dropped.
 */
export const HONOUR_REMEMBER_ME = true as boolean;

/**
 * Whether passwordless sign-in (`/api/auth/passwordless/*`) is served.
 *
 * ⚠️ SEPARATE from `OTP_ENABLED`, and that is the whole point. Passwordless is
 * the weakest first-factor route this deployment has — one emailed code and you
 * are in — and it could previously only be switched off by switching off the OTP
 * machinery that contact verification, account recovery and the second factor
 * all depend on. That matters most in exactly the situation where an operator
 * would want it: abuse on this path, or the population whose only second factor
 * is a code to the contact this login just proved.
 *
 * A disabled surface answers 404, matching how a disabled 2FA method behaves.
 */
export const PASSWORDLESS_ENABLED = true as boolean;
