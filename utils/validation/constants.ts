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
export const PASSWORD_MAX = 32;
export const EMAIL_MAX = 150;
export const USER_ROLE_MAX = 50;

// Roles & Permissions
export const ROLE_NAME_MIN = 1;
export const ROLE_NAME_MAX = 100;
export const ROLE_DESCRIPTION_MAX = 150;
export const PERMISSIONS_ARRAY_MAX = 50;

// Common schemas
export const ORDER_MAX = 1000;
export const ALT_TEXT_MAX = 200;
export const IDS_ARRAY_MAX = 50;
