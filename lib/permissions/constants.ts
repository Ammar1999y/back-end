/**
 * SuperAdmin role that cannot be edited or deleted
 */
export const SUPER_ADMIN_ROLE = 'superAdmin' as const;

/**
 * Value used in the form when a user selects custom permissions.
 * Not an actual role ID - triggers creation of a role with scope='custom'.
 */
export const CUSTOM_ROLE_VALUE = 'custom' as const;

export const DASHBOARD_PAGES = {
  home: 'الرئيسية',
  users: 'المستخدمين',
  permissions: 'الصلاحيات',
  mainPage: 'الصفحه الرئيسية',
} as const;

/**
 * الصلاحيات المتاحة لكل صفحة
 */
export const PERMISSION_ACTIONS = {
  view: 'عرض',
  edit: 'تعديل',
  delete: 'حذف',
  create: 'إنشاء',
} as const;

export type DashboardPage = keyof typeof DASHBOARD_PAGES;
export type PermissionAction = keyof typeof PERMISSION_ACTIONS;
export type DashboardPageValues =
  (typeof DASHBOARD_PAGES)[keyof typeof DASHBOARD_PAGES];
export type PermissionObject = Record<
  DashboardPage,
  Record<PermissionAction, boolean>
>;

export interface SessionMetadata {
  roleId?: string | null;
  roleName?: string | null;
  permissions?: Partial<PermissionObject>;
}

export const DEFAULT_PAGE_PERMISSIONS: Array<{
  name: DashboardPage;
  availablePermissions: PermissionAction[];
}> = [
  {
    name: 'home',
    availablePermissions: ['view'],
  },
  {
    name: 'mainPage',
    availablePermissions: ['view', 'edit'],
  },
  {
    name: 'users',
    availablePermissions: ['view', 'edit', 'delete', 'create'],
  },
  {
    name: 'permissions',
    availablePermissions: ['view', 'edit', 'create'],
  },
];

/**
 * دالة للحصول على الصلاحيات المتاحة لصفحة معينة
 */
export function getAvailablePermissions(
  pageName: DashboardPage
): PermissionAction[] {
  const page = DEFAULT_PAGE_PERMISSIONS.find((p) => p.name === pageName);
  return page?.availablePermissions || [];
}
