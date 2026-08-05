// Shared API response messages used across multiple endpoints.

export const MSG_INTERNAL_ERROR = 'حدث خطأ في الخادم';
export const MSG_DATA_ALREADY_EXISTS = 'البيانات مستخدمة بالفعل';
export const MSG_EMAIL_EXISTS = 'البريد الإلكتروني مستخدم بالفعل';
export const MSG_PHONE_EXISTS = 'رقم الهاتف مستخدم بالفعل';

export const MSG_LOGIN_REQUIRED = 'قم بتسجيل الدخول اولا';
export const MSG_INSUFFICIENT_PERMISSIONS = 'ليس لديك صلاحيه';
export const MSG_CANNOT_GRANT_UNOWNED_PERMISSIONS =
  'لا يمكنك منح صلاحيات لا تملكها';

export const MSG_PAGE_NOT_FOUND = 'الصفحة غير موجودة';
export const MSG_NOT_FOUND = 'البيانات غير موجودة';
export const MSG_INVALID_INPUT = 'قم بالتحقق من البيانات المدخله';
export const MSG_INVALID_CREDENTIALS = 'البيانات المدخله غير صحيحه';
export const MSG_EMAIL_NOT_VERIFIED =
  'يجب تفعيل البريد الإلكتروني قبل تسجيل الدخول';

/**
 * Distinct error code returned ONLY when login is blocked because the email is
 * unverified (REQUIRE_EMAIL_VERIFICATION). Every other login failure keeps the
 * generic invalid-credentials response, so this leaks nothing pre-password.
 * The frontend keys on it to route the user into the OTP verification flow.
 */
export const EMAIL_NOT_VERIFIED_CODE = 'EMAIL_NOT_VERIFIED' as const;

export const MSG_PHONE_NOT_VERIFIED = 'يجب تفعيل رقم الهاتف قبل تسجيل الدخول';

/** Distinct code for the phone-verification login gate (REQUIRE_PHONE_VERIFICATION). */
export const PHONE_NOT_VERIFIED_CODE = 'PHONE_NOT_VERIFIED' as const;

export const MSG_FETCHED = 'تم جلب البيانات بنجاح';
export const MSG_CREATED = 'تم الإنشاء بنجاح';
export const MSG_UPDATED = 'تم التحديث بنجاح';
export const MSG_DELETED = 'تم الحذف بنجاح';

export const MSG_FETCH_ERROR = 'حدث خطأ في جلب البيانات';
export const MSG_CREATE_ERROR = 'حدث خطأ في الإنشاء';
export const MSG_UPDATE_ERROR = 'حدث خطأ في التحديث';
export const MSG_DELETE_ERROR = 'حدث خطأ في الحذف';

export const MSG_TOO_MANY_REQUESTS = 'طلبات كثيرة جدًا، حاول مرة أخرى لاحقًا';

export const MSG_SERVICE_UNAVAILABLE =
  'الخدمة غير متاحة مؤقتًا، حاول مرة أخرى بعد قليل';

export const MSG_PASSWORD_COMPROMISED =
  'هذه الكلمة مستخدمة بكثرة أو مُسرّبة سابقًا، لذلك لا تُعد آمنة. يرجى اختيار كلمة مرور مختلفة.';

export const CREDENTIAL_PROVIDER_ID = 'credential' as const;

/**
 * Sentinel error `code` used for all of our own better-auth APIError throws, so
 * the after-hook can distinguish them from Better Auth's built-in error codes
 * and leave their (already-localized) message untouched.
 */
export const CUSTOM_AUTH_CODE = '__' as const;

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;
