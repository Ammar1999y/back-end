export const permissionMsg = {
  nameExists: 'اسم الصلاحية موجود بالفعل، قم بتغيره',
  duplicatePagePermission: 'صلاحية الصفحة مكررة',
  hasUsers: 'لا يمكن حذف هذه الصلاحية لأنها مرتبطة بمستخدمين',
  customPrefixForbidden: (prefix: string) => `لا يمكن أن يبدأ اسم الدور بـ "${prefix}"`,
  cannotEditOwnRole: 'لا يمكنك تعديل الدور المخصص لحسابك',
  customRoleRequiresPermissions: 'يجب تحديد صلاحيات للدور المخصص',
};