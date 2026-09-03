// Anonymous OTP handlers use this floor to reduce lookup/proof timing signals.
// Provider delivery is deferred on anonymous send paths and is not part of it.
// TODO: Measure the real `processOtpSend` latency distribution and tune this value if needed.
const MINIMUM_RESPONSE_MS = 1500;

export async function ensureMinDelay(elapsed: number): Promise<void> {
  if (elapsed < MINIMUM_RESPONSE_MS)
    await new Promise((r) => setTimeout(r, MINIMUM_RESPONSE_MS - elapsed));
}

export const otpMsg = {
  alreadyVerified: 'الحساب مُفعّل مسبقاً',
  identifierNotFound: (entityName: string) =>
    `${entityName} غير مسجل في النظام`,
  sendSuccess: 'تم إرسال رمز التحقق بنجاح',
  sendError: 'حدث خطأ أثناء إرسال رمز التحقق',
  verifySuccess: (channel: string) =>
    channel === 'email'
      ? 'تم التحقق من البريد الإلكتروني بنجاح'
      : 'تم التحقق من رقم الهاتف بنجاح',
  verifyError: 'حدث خطأ أثناء التحقق من الرمز',
  invalidOrExpired: 'رمز التحقق غير صحيح أو منتهي الصلاحية',
  captchaFailed: 'حدث خطاء اثناء التحقق من انك انسان، اعد المحاولة',
  invalidInput: 'صيغة المدخلات غير صحيحة',
  // Forgot-password / passwordless
  passwordResetSuccess: 'تم تعيين كلمة المرور الجديدة بنجاح',
  passwordResetError: 'حدث خطأ أثناء إعادة تعيين كلمة المرور',
  loginSuccess: 'تم تسجيل الدخول بنجاح',
  loginError: 'حدث خطأ أثناء تسجيل الدخول',
  /**
   * Distinct rather than collapsed into the generic message: reaching it
   * requires a VALID recovery code, so the caller already controls the contact
   * and learns nothing new about the account.
   */
  recoverySecondFactorRequired:
    'تم التحقق من الرمز. أكمل التحقق بخطوتين لتعيين كلمة المرور الجديدة',
  recoveryBlockedByTwoFactor:
    'لا يمكن إعادة تعيين كلمة المرور عبر هذه الوسيلة لأنها نفس وسيلة التحقق بخطوتين. استخدم طريقة تحقق أخرى أو تواصل مع الدعم',
} as const;

/**
 * Separate from `otpMsg` because the user is already known from the challenge
 * cookie or the session, so nothing here has to collapse into one
 * indistinguishable string to avoid revealing whether an account exists.
 */
export const twoFactorMsg = {
  challengeMissing: 'انتهت جلسة التحقق. يرجى تسجيل الدخول من جديد',
  methodUnavailable: 'طريقة التحقق غير متاحة لحسابك',
  contactUnverified: 'يجب تأكيد وسيلة التواصل قبل استخدامها للتحقق بخطوتين',
  codeSent: 'تم إرسال رمز التحقق',
  sendError: 'حدث خطأ أثناء إرسال رمز التحقق',
  invalidCode: 'رمز التحقق غير صحيح أو منتهي الصلاحية',
  tooManyAttempts: 'تجاوزت عدد المحاولات. يرجى تسجيل الدخول من جديد',
  enabled: 'تم تفعيل التحقق بخطوتين',
  disabled: 'تم إلغاء تفعيل طريقة التحقق',
  lastMethod:
    'لا يمكن إزالة طريقة التحقق الوحيدة. قم بإلغاء تفعيل التحقق بخطوتين بدلاً من ذلك',
  verifySuccess: 'تم التحقق بنجاح',
  trustRequiresProof:
    'يجب إكمال التحقق بخطوتين على هذا الجهاز قبل حفظه كجهاز موثوق',
  totpAlreadyEnrolled:
    'يوجد تطبيق مصادقة مُفعّل بالفعل. قم بإزالته أولاً قبل إضافة تطبيق جديد',
  passkeyNotUserVerifying:
    'هذا الجهاز لا يطلب التحقق من هويتك (بصمة أو رمز)، فلا يصلح كوسيلة تحقق ثانية. استخدم جهازاً يدعم التحقق البيومتري أو رمز PIN',
  /**
   * Refuses a contact change that would take away the target's last usable
   * second factor. The same rule `/two-factor/methods/disable` applies to a user
   * removing their own last method — an edit must not be a way around it.
   */
  contactChangeStrands:
    'لا يمكن تغيير وسيلة التواصل لأن ذلك سيُفقد الحساب طريقة التحقق بخطوتين الوحيدة. أعد تعيين التحقق بخطوتين للحساب أولاً',
  twoFactorUnavailable:
    'تعذّر إكمال التحقق بخطوتين: لا توجد طريقة تحقق متاحة على حسابك حالياً. تواصل مع الدعم لاستعادة الوصول',
} as const;
