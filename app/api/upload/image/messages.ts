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
  uploaded: 'تم رفع الملفات بنجاح',
  uploadFailed: 'حدث خطأ في رفع الملفات',
  invalidMimeType: (type: string) =>
    `نوع الملف غير مسموح: ${type}. الأنواع المسموحة: PNG, WebP, SVG`,
  invalidSvg: 'ملف SVG غير صالح',
};
