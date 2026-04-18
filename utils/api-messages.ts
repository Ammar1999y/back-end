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

export const MSG_FETCHED = 'تم جلب البيانات بنجاح';
export const MSG_CREATED = 'تم الإنشاء بنجاح';
export const MSG_UPDATED = 'تم التحديث بنجاح';
export const MSG_DELETED = 'تم الحذف بنجاح';

export const MSG_FETCH_ERROR = 'حدث خطأ في جلب البيانات';
export const MSG_CREATE_ERROR = 'حدث خطأ في الإنشاء';
export const MSG_UPDATE_ERROR = 'حدث خطأ في التحديث';
export const MSG_DELETE_ERROR = 'حدث خطأ في الحذف';

export const MSG_TOO_MANY_REQUESTS =
  'طلبات كثيرة جدًا، حاول مرة أخرى لاحقًا';

export const MSG_PASSWORD_COMPROMISED =
  'هذه الكلمة مستخدمة بكثرة أو مُسرّبة سابقًا، لذلك لا تُعد آمنة. يرجى اختيار كلمة مرور مختلفة.';

export const CREDENTIAL_PROVIDER_ID = 'credential' as const;

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
} as const;
