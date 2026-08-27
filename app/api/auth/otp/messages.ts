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
} as const;
