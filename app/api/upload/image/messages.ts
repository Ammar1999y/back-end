export const uploadMsg = {
  noFiles: 'لم يتم إرسال ملفات',
  noValidFiles: 'لم يتم إرسال ملفات صالحة',
  maxFiles: (max: number) => `الحد الأقصى ${max} ملفات في الطلب الواحد`,
  fileTooLarge: (name: string, maxMB: number) =>
    `حجم الملف ${name} كبير جداً. الحد الأقصى: ${maxMB}MB`,
  invalidType: (name: string) =>
    `نوع الملف ${name} غير مسموح. الأنواع المسموحة: PNG, WebP, SVG`,
  contentMismatch: (name: string) =>
    `محتوى الملف ${name} لا يتطابق مع نوعه المعلن`,
  animatedNotAllowed: (name: string) =>
    `الملف ${name} صورة متحركة، والصور المتحركة غير مدعومة`,
  uploaded: 'تم رفع الملفات بنجاح',
  uploadFailed: 'حدث خطأ في رفع الملفات',
  invalidMimeType: (type: string) =>
    `نوع الملف غير مسموح: ${type}. الأنواع المسموحة: PNG, WebP, SVG`,
  invalidSvg: 'ملف SVG غير صالح',
  /** The pixel-bomb guard. A rejection, so it must not read as a server fault. */
  tooManyPixels: (maxMegapixels: number) =>
    `أبعاد الصورة كبيرة جداً. الحد الأقصى ${maxMegapixels} ميجابكسل`,
  /** One side over what the output format can hold. Also a rejection. */
  edgeTooLong: (maxEdge: number) =>
    `أحد أبعاد الصورة كبير جداً. الحد الأقصى لكل بُعد ${maxEdge} بكسل`,
  /** Truncated transfer, or bytes that are not the format they claim to be. */
  undecodable: 'تعذّرت قراءة الصورة. الملف تالف أو غير مكتمل',
  targetUnreachable: 'تعذّر ضغط الصورة إلى الحجم المطلوب',
  processingBusy: 'خدمة معالجة الصور مشغولة حالياً. حاول لاحقاً',
  invalidResource: 'المورد المطلوب رفع الصورة له غير صالح',
};
