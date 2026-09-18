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

/**
 * The dashboard pages, IN ORDER, and the single place that order is written.
 *
 * A tuple rather than the keys of the label map, because this list is also the
 * `page_name` PostgreSQL enum and its value order is part of the database
 * schema. `Object.keys` returns `string[]`, so deriving the enum from the map
 * needs an assertion in `db/schema.ts` that would compile for any list, empty
 * included.
 *
 * ⚠️ Adding an entry requires a generated migration — `bun run db:generate`,
 * gated by `bun run check:schema-drift`. Without it the first permission write
 * for the new page fails with PostgreSQL `22P02`.
 */
export const DASHBOARD_PAGE_NAMES = [
  'home',
  'users',
  'permissions',
  'media',
] as const;

export type DashboardPage = (typeof DASHBOARD_PAGE_NAMES)[number];

/**
 * Typed as a total `Record`, so a page added above without a label here — or a
 * label here for a page not above — is a compile error rather than a lookup
 * that returns `undefined` at runtime.
 */
export const DASHBOARD_PAGES: Record<DashboardPage, string> = {
  home: 'الرئيسية',
  users: 'المستخدمين',
  permissions: 'الصلاحيات',
  media: 'الملفات',
};

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
  /**
   * Page-scoped to `users`, so `sanitizePermissions` resolves it to `false`
   * everywhere else. Its own action rather than part of `edit`: an admin who may
   * correct a name should not thereby be able to disarm someone's 2FA.
   */
  resetTwoFactor: 'إعادة تعيين التحقق بخطوتين',
  /**
   * Page-scoped to `media`. Moving a file between the private and the public
   * bucket changes who on the internet can read it, which `edit` (a rename, a
   * move between folders) never does — so it is its own grant, like
   * `resetTwoFactor`, and `validatePermissionScope` refuses to confer it to a
   * role whose creator does not hold it.
   */
  publish: 'نشر',
} as const;

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
      'resetTwoFactor',
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
  // No `viewOwn`: a library that shows each user only their own uploads is not
  // a shared library, and a folder view that hides other people's files reads
  // as an empty folder. `editOwn`/`deleteOwn` resolve against `files.uploaded_by`
  // and `folders.created_by`.
  {
    name: 'media',
    availablePermissions: [
      'view',
      'edit',
      'editOwn',
      'delete',
      'deleteOwn',
      'create',
      'publish',
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
