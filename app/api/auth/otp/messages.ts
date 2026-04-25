// All OTP responses must take at least this long to prevent timing-based
// user enumeration. The floor needs to sit above the p99.9 of the real
// path (DB lookup + argon2 + SMS/email delivery). Tune after measuring
// real p99 delivery in production.
// TODO: Measure the real `processOtpSend` latency distribution and tune this value if needed.
export const MINIMUM_RESPONSE_MS = 1500;

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
} as const;
