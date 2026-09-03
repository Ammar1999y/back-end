import { DASHBOARD_PAGES } from '@/lib/permissions/constants';

export const URL_MAX = 500;
export const MAX_IMAGE_SIZE = 1; // MB - placeholder, will be replaced
export const MAX_IMAGE_PIXELS = 25_000_000; // 25MP max (e.g., 5000×5000) - prevents decompression bombs
/**
 * WebP's own hard ceiling per side, and therefore the contract: an image inside
 * MAX_IMAGE_PIXELS can still be un-encodable. Measured — a 1000x20000 PNG is
 * 20 MP and 100 KB, so it passes both the pixel cap and the 1 MiB file cap, and
 * the encoder then threw `ERR_IMAGE_ENCODE_FAILED`, which reached the caller as
 * a 500. Checked from the header, before the decode.
 */
export const MAX_IMAGE_EDGE = 16_383;
export const SERVER_MAX_IMAGE_SIZE = 0.2;
export const NAME_MAX = 150;

// Auth
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const EMAIL_MAX = 150;
export const PHONE_NUMBER_MAX = 15;

// OTP / Verification
export const OTP_CODE_LENGTH = 6;
// ⚠️ Changing this value requires generating a new migration to keep the DB in sync.
export const OTP_IDENTIFIER_MAX = 160;
// ⚠️ Baked into DB CHECK constraint `chk_attempt_number_max` (db/schema.ts).
// Changing this value requires generating a new migration to keep the DB in sync.
export const OTP_MAX_ATTEMPTS = 5;
// ⚠️ Baked into DB CHECK constraint `chk_verify_attempt_number_max` (db/schema.ts).
// Changing this value requires generating a new migration to keep the DB in sync.
export const OTP_MAX_VERIFY_ATTEMPTS = 5;
// Cap on failed verifies per (userId, contactKind, purpose) — the unique key
// of a proof row, so one flow's failures cannot deny another. NOT a rolling
// window: the row anchors its own 24h period. Survives resend cycles so an
// attacker cannot reset it by requesting a new code.
export const OTP_MAX_DAILY_VERIFY_ATTEMPTS = 15;
export const OTP_EXPIRY_MINUTES = 10;
export const OTP_BLOCK_DURATION_HOURS = 6;

// Two-factor
/**
 * Bound on `verifications.identifier` and `trusted_devices.trust_identifier`.
 * The values are library-shaped, and headroom matters: truncating an identifier
 * would silently collide two challenges instead of failing.
 *
 * ⚠️ Changing this value requires a new migration.
 */
export const VERIFICATION_IDENTIFIER_MAX = 160;
/**
 * Bound on `passkeys.credential_id`, base64url of at most 1023 bytes by spec.
 *
 * ⚠️ Changing this value requires a new migration.
 */
export const CREDENTIAL_ID_MAX = 1400;

// Roles & Permissions
export const ROLE_NAME_MIN = 1;
export const ROLE_NAME_MAX = 100;
export const ROLE_DESCRIPTION_MAX = 150;
export const PERMISSIONS_ARRAY_MAX = Object.keys(DASHBOARD_PAGES).length;

// Common schemas
export const IDS_ARRAY_MAX = 50;
