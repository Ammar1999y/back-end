import type { DetectResult } from './detect-result';

import {
  FOLDER_MAX_CHILDREN,
  FOLDER_MAX_DEPTH,
  FOLDER_RECURSIVE_DELETE_MAX,
} from '@/utils/validation/constants';

export const mediaMsg = {
  fetched: 'تم جلب البيانات بنجاح',
  uploaded: 'تم رفع الملف بنجاح',
  folderCreated: 'تم إنشاء المجلد بنجاح',
  updated: 'تم التحديث بنجاح',
  deleted: 'تم الحذف بنجاح',
  published: 'تم نشر الملف',
  unpublished: 'تم إلغاء نشر الملف',

  folderNotFound: 'المجلد غير موجود',
  fileNotFound: 'الملف غير موجود',
  folderNameExists: 'يوجد مجلد بهذا الاسم في نفس المكان',
  folderNotEmpty: 'لا يمكن حذف مجلد يحتوي على ملفات أو مجلدات فرعية',
  folderTooLarge: `لا يمكن حذف مجلد يحتوي على أكثر من ${FOLDER_RECURSIVE_DELETE_MAX} عنصراً، احذف بعض المحتويات أولاً`,
  folderBusy:
    'يوجد ملفات قيد الرفع أو المعالجة داخل المجلد، حاول مرة أخرى بعد قليل',
  invalidRecursive: 'قيمة الحذف المتكرر غير صحيحة',
  folderTooDeep: `لا يمكن أن يتجاوز عمق المجلدات ${FOLDER_MAX_DEPTH} مستويات`,
  folderTooManyChildren: `لا يمكن أن يحتوي المجلد على أكثر من ${FOLDER_MAX_CHILDREN} مجلداً فرعياً`,
  folderCycle: 'لا يمكن نقل مجلد إلى داخل نفسه أو أحد مجلداته الفرعية',
  invalidScope: 'نطاق البحث غير صحيح',

  fileInUse: 'لا يمكن حذف ملف مرتبط بسجلات أخرى',
  fileInUseBy: (labels: readonly string[], hidden: number) =>
    `لا يمكن حذف الملف لأنه مستخدم في: ${labels.join('، ')}${
      hidden > 0 ? ` و${hidden} سجل آخر` : ''
    }`,
  fileBusy: 'الملف قيد المعالجة، حاول مرة أخرى بعد قليل',
  visibilityDisabled: 'هذا النوع من التخزين غير مفعل في هذا النظام',
  unpublishInUse: 'لا يمكن إلغاء نشر ملف مستخدم في محتوى منشور',
  linkVisibilityMismatch:
    'لا يمكن ربط الملف بهذا الغرض لأن مستوى خصوصيته مختلف، حاول مرة أخرى',
  linkNotAllowed: 'لا يمكن ربط هذا الملف بهذا السجل',

  invalidPurpose: 'الغرض من الرفع غير معروف',
  kindNotAllowedHere: 'هذا النوع من الملفات غير مسموح به هنا',
  typeNotAllowed: (name: string) => `نوع الملف "${name}" غير مدعوم`,
  documentTooLarge: (name: string, maxMb: number) =>
    `الملف "${name}" يتجاوز الحجم المسموح (${maxMb} ميجابايت)`,
  refused: (
    name: string,
    reason: Exclude<DetectResult, { ok: true }>['reason']
  ) =>
    ({
      signature: `محتوى الملف "${name}" لا يطابق نوعه المعلن`,
      container: `الملف "${name}" ليس ملفاً صالحاً من النوع المعلن`,
      mismatch: `الملف "${name}" من نوع مختلف عن النوع المعلن`,
      macros: `الملف "${name}" يحتوي على وحدات ماكرو وغير مسموح به`,
      embedded: `الملف "${name}" يحتوي على عناصر مضمنة وغير مسموح به`,
      encrypted: `الملف "${name}" محمي بكلمة مرور ولا يمكن التحقق منه`,
    })[reason],

  uploadFailed: 'حدث خطأ أثناء رفع الملف',
  storeFailed: 'حدث خطأ في التخزين، حاول مرة أخرى بعد قليل',
  fetchError: 'حدث خطأ في جلب البيانات',
  updateError: 'حدث خطأ في التحديث',
  deleteError: 'حدث خطأ في الحذف',
};
