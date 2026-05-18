/**
 * When true: users MUST have an active role to login (dashboard-only apps).
 * When false: users CAN login without a role (public website + dashboard).
 *
 * Toggling this requires a new DB migration (`bun drizzle-kit generate`)
 * because it controls the `chk_active_user_has_role` CHECK constraint
 * and the `roleId` foreign key ON DELETE behavior in the users table.
 */
export const REQUIRE_ROLE_FOR_LOGIN = true as boolean;

/**
 * Value used in the form when a user selects custom permissions.
 * Not an actual role ID - triggers creation of a role with scope='custom'.
 */
export const CUSTOM_ROLE_VALUE = 'custom' as const;

export const ROLE_SCOPE = {
  SYSTEM: 'system',
  STANDARD: 'standard',
  CUSTOM: CUSTOM_ROLE_VALUE,
} as const;

export type RoleScope = (typeof ROLE_SCOPE)[keyof typeof ROLE_SCOPE];

export const DASHBOARD_PAGES = {
  home: 'الرئيسية',
  users: 'المستخدمين',
  permissions: 'الصلاحيات',
} as const;

/**
 * الصلاحيات المتاحة لكل صفحة.
 * - view/edit/delete: تطبق على كل السجلات.
 * - viewOwn/editOwn/deleteOwn: تطبق فقط على السجلات التي أنشأها المستخدم نفسه.
 * - create: إنشاء سجل جديد.
 *
 * قاعدة الـ supersession: إذا كان المستخدم يملك view فإن viewOwn مُتجاهل
 * (لا حاجة لفحصه)، وكذلك edit ↔ editOwn و delete ↔ deleteOwn.
 */
export const PERMISSION_ACTIONS = {
  view: 'عرض الكل',
  viewOwn: 'عرض الخاص',
  edit: 'تعديل الكل',
  editOwn: 'تعديل الخاص',
  delete: 'حذف الكل',
  deleteOwn: 'حذف الخاص',
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

/**
 * خريطه الـ action العام إلى نسخة "own" المقابلة.
 * تستخدم لتطبيق قاعدة supersession ولفحص "view OR viewOwn" بشكل موحد.
 */
export const OWN_ACTION_MAP = {
  view: 'viewOwn',
  edit: 'editOwn',
  delete: 'deleteOwn',
} as const satisfies Partial<Record<PermissionAction, PermissionAction>>;

export type AllScopedAction = keyof typeof OWN_ACTION_MAP;
export type OwnScopedAction = (typeof OWN_ACTION_MAP)[AllScopedAction];

/**
 * Access scope resolved from a user's permissions for a given action:
 * - 'all': user has the unrestricted action (e.g. `view`).
 * - 'own': user has only the own-scoped variant (e.g. `viewOwn`) — must filter by created_by.
 */
export type AccessScope = 'all' | 'own';

export interface SessionMetadata {
  roleId?: string | null;
  roleName?: string | null;
  roleScope?: string | null;
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
    name: 'users',
    availablePermissions: [
      'view',
      'viewOwn',
      'edit',
      'editOwn',
      'delete',
      'deleteOwn',
      'create',
    ],
  },
  {
    name: 'permissions',
    availablePermissions: [
      'view',
      'viewOwn',
      'edit',
      'editOwn',
      'delete',
      'deleteOwn',
      'create',
    ],
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
