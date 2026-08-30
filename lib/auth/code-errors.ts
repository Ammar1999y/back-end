import {
  MSG_INVALID_CREDENTIALS,
  MSG_INVALID_INPUT,
} from '@/utils/api-messages';

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

  // No `METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED` here. Better Auth throws it
  // for `POST /get-session` unless `session.deferSessionRefresh` is enabled, and
  // `BETTER_AUTH_ENDPOINTS` records that path as GET-only — so `app.ts` answers
  // 405 from the manifest and `auth.handler` never runs (measured: 405,
  // `Allow: GET, HEAD, OPTIONS`). A mapping for a code this deployment cannot
  // produce is the dead-entry shape the audit already objected to.

  USER_ALREADY_EXISTS:
    'المستخدم موجود بالفعل، استخدم بريد الكتروني اخر لإنشاء الحساب',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    'المستخدم موجود بالفعل، استخدم بريد الكتروني اخر لإنشاء الحساب',

  ux_users_phone_number: 'رقم الهاتف موجود من قبل، استخدم رقم هاتف اخر',

  // Better Auth's own request-shape rejections, and the only two of its 49 codes
  // still unmapped that this deployment can actually PRODUCE — measured by
  // driving hostile bodies at all four allowlisted paths and collecting every
  // `code` this map does not carry. Both put a raw English internal on the wire
  // in an Arabic-locale API: `POST /api/auth/passwordless/verify` with `[]`
  // answered `"[body] Invalid input: expected record, received array"`, and any
  // malformed JSON answered `"Invalid JSON in request body"`.
  //
  // The other 18 unmapped codes belong to endpoints this deployment does not
  // mount (social linking, email verification, callback URLs), so mapping them
  // would be the dead-entry shape removed above. `tests/integration/
  // auth-error-localisation.test.ts` is what keeps that judgement honest: it
  // fails if any unmapped code becomes reachable.
  VALIDATION_ERROR: MSG_INVALID_INPUT,
  BAD_REQUEST: MSG_INVALID_INPUT,

  MISSING_RESPONSE:
    'تعذر التحقق من أنك لست روبوتاً. أعد تحميل الصفحة وحاول مرة أخرى',
  VERIFICATION_FAILED:
    'تعذر التحقق من أنك لست روبوتاً. أعد تحميل الصفحة وحاول مرة أخرى',
  UNKNOWN_ERROR: 'حاول مجددا، او اعد تحميل الصفحة',
};
