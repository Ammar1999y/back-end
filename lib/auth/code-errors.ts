import { MSG_INVALID_CREDENTIALS } from '@/utils/api-messages';

const MSG_UNTRUSTED_ORIGIN =
  'تعذر إكمال الطلب من هذا الموقع. أعد تحميل الصفحة من الرابط الرسمي ثم حاول مرة أخرى.';

export const BASE_ERROR_CODES: Record<string, string> = {
  USER_NOT_FOUND: 'المستخدم غير موجود',
  FAILED_TO_CREATE_USER:
    'حدث خطأ ما في عملية إنشاء المستخدم، حاول مجددا، او اعد تحميل الصفحة',
  FAILED_TO_CREATE_SESSION:
    'حدث خطأ ما في عملية إنشاء الجلسة، حاول مجددا، او اعد تحميل الصفحة',
  FAILED_TO_UPDATE_USER:
    'حدث خطأ ما في عملية تحديث المستخدم، حاول مجددا، او اعد تحميل الصفحة',
  FAILED_TO_GET_SESSION:
    'حدث خطأ ما في عملية الحصول على بيانات الجلسة، حاول مجددا، او اعد تحميل الصفحة',
  INVALID_PASSWORD: 'كلمة المرور غير صحيحة',
  INVALID_EMAIL: 'البريد الالكتروني غير صحيح',
  INVALID_EMAIL_OR_PASSWORD: MSG_INVALID_CREDENTIALS,
  INVALID_TOKEN: 'حاول مجددا، او اعد تحميل الصفحة',
  FAILED_TO_GET_USER_INFO:
    'حدث خطأ ما في عملية الحصول على بيانات المستخدم، حاول مجددا، او اعد تحميل الصفحة',
  USER_EMAIL_NOT_FOUND: 'البريد الالكتروني غير موجود',

  SOCIAL_ACCOUNT_ALREADY_LINKED: 'Social account already linked',
  PROVIDER_NOT_FOUND: 'Provider not found',
  ID_TOKEN_NOT_SUPPORTED: 'id_token not supported',
  PASSWORD_TOO_SHORT: 'Password too short',
  PASSWORD_TOO_LONG: 'Password too long',
  CREDENTIAL_ACCOUNT_NOT_FOUND: 'Credential account not found',
  USER_ALREADY_HAS_PASSWORD:
    'User already has a password. Provide that to delete the account.',
  FAILED_TO_UNLINK_LAST_ACCOUNT: "You can't unlink your last account",

  EMAIL_NOT_VERIFIED: 'البريد الالكتروني غير موثوق',
  EMAIL_CAN_NOT_BE_UPDATED: 'لايمكن تحديث البريد الالكتروني',
  SESSION_EXPIRED: 'قم باعادة تسجيل الدخول',
  SESSION_NOT_FRESH: 'مضى وقت طويل على تسجيل دخولك، قم بتسجيل الدخول مرة أخرى',
  ACCOUNT_NOT_FOUND: 'الحساب غير موجود',

  // Origin / CSRF rejections on /sign-in/email, measured. One message for all
  // three: from the caller's side they are the same situation — the browser sent
  // the request from an origin this API does not trust — and none of them
  // reveals anything about an account, so there is no reason to tell them apart
  // in the response. Note `trustedOrigins` is not configured, so Better Auth
  // defaults it to `[baseURL]` — i.e. PUBLIC_ORIGIN alone. A browser front-end
  // served from any other origin gets 403 here on every sign-in, even with
  // correct credentials, and `app.ts`'s CORS_POLICY is a separate list that will
  // happily have allowed the preflight. Set `trustedOrigins` from the same value
  // as CORS_POLICY if the front-end is ever cross-origin.
  INVALID_ORIGIN: MSG_UNTRUSTED_ORIGIN,
  MISSING_OR_NULL_ORIGIN: MSG_UNTRUSTED_ORIGIN,
  CROSS_SITE_NAVIGATION_LOGIN_BLOCKED: MSG_UNTRUSTED_ORIGIN,

  // `POST /get-session` always answers 405 with this code unless
  // `session.deferSessionRefresh` is enabled, and `ROUTE_PREFIXES` registers
  // POST for the whole `/api/auth/*` prefix, so the path is reachable. Nothing
  // the caller can act on beyond retrying with GET.
  METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED: 'حاول مجددا، او اعد تحميل الصفحة',

  USER_ALREADY_EXISTS:
    'المستخدم موجود بالفعل، استخدم بريد الكتروني اخر لإنشاء الحساب',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    'المستخدم موجود بالفعل، استخدم بريد الكتروني اخر لإنشاء الحساب',

  ux_users_phone_number: 'رقم الهاتف موجود من قبل، استخدم رقم هاتف اخر',
};
