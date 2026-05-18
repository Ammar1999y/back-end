import { DASHBOARD_PAGES } from '@/lib/permissions/constants';

export const TITLE_MAX = 255;
export const DESCRIPTION_MAX = 5000;
export const SHORT_TEXT_MAX = 500;
export const URL_MAX = 500;
export const LABEL_MAX = 100;
export const MAX_INT = 999_999_999;
export const MAX_IMAGE_SIZE = 1; // MB - placeholder, will be replaced
export const MAX_IMAGE_PIXELS = 25_000_000; // 25MP max (e.g., 5000×5000) - prevents decompression bombs
export const SERVER_MAX_IMAGE_SIZE = 0.2;
export const NAME_MAX = 150;
export const DIST_MAX = 100;

// Auth
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const EMAIL_MAX = 150;
export const USER_ROLE_MAX = 50;
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
// Rolling 24h cap on failed verifies per (userId, channel). Survives resend
// cycles so an attacker cannot reset the counter by requesting a new code.
export const OTP_MAX_DAILY_VERIFY_ATTEMPTS = 15;
export const OTP_EXPIRY_MINUTES = 10;
export const OTP_BLOCK_DURATION_HOURS = 6;

// Roles & Permissions
export const ROLE_NAME_MIN = 1;
export const ROLE_NAME_MAX = 100;
export const ROLE_DESCRIPTION_MAX = 150;
export const PERMISSIONS_ARRAY_MAX = Object.keys(DASHBOARD_PAGES).length;

// Common schemas
export const ORDER_MAX = 1000;
export const ALT_TEXT_MAX = 200;
export const IDS_ARRAY_MAX = 50;
