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

export const DASHBOARD_PAGES = {
  home: 'الرئيسية',
  users: 'المستخدمين',
  permissions: 'الصلاحيات',
} as const;

/**
 * The page keys as a list, for consumers that need values rather than a lookup —
 * today the `resource` query parameter's enum in the OpenAPI contract.
 *
 * Derived, never written out again: a second hand-maintained copy of these keys
 * would be one page away from disagreeing with the map the permission checker
 * reads. `db/schema.ts` derives the `page_name` pgEnum from the same object and
 * deliberately keeps its own cast — the enum's VALUE ORDER is part of the
 * database schema, so it must not start reading from a general-purpose list.
 */
export const DASHBOARD_PAGE_NAMES = Object.keys(
  DASHBOARD_PAGES
) as readonly DashboardPage[];

/**
 * Permissions available on each page.
 * - view/edit/delete apply to every record.
 * - viewOwn/editOwn/deleteOwn apply only to records the user created.
 * - create permits a new record.
 *
 * Broader actions supersede their own-record variants: view supersedes viewOwn,
 * as edit supersedes editOwn and delete supersedes deleteOwn.
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
export type PermissionObject = Record<
  DashboardPage,
  Record<PermissionAction, boolean>
>;

/**
 * Maps each broad action to its own-record variant for scope resolution.
 */
export const OWN_ACTION_MAP = {
  view: 'viewOwn',
  edit: 'editOwn',
  delete: 'deleteOwn',
} as const satisfies Partial<Record<PermissionAction, PermissionAction>>;

export type AllScopedAction = keyof typeof OWN_ACTION_MAP;

/**
 * Own-scoped action → the all-scoped action that supersedes it. Derived from
 * `OWN_ACTION_MAP` and declared beside it: the permission checker and the
 * grant-scope validator both need this rule, and two copies would be one edit
 * away from disagreeing about who may grant what.
 */
export const SUPERSEDING_ACTION = Object.fromEntries(
  Object.entries(OWN_ACTION_MAP).map(([all, own]) => [own, all])
) as Record<string, AllScopedAction | undefined>;

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
 * Returns the permissions available on a page.
 */
export function getAvailablePermissions(
  pageName: DashboardPage
): PermissionAction[] {
  const page = DEFAULT_PAGE_PERMISSIONS.find((p) => p.name === pageName);
  return page?.availablePermissions || [];
}
