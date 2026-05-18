// Unique indexes follow 'ux_<table>_<column>' convention (e.g. ux_users_email).
// Violation resolvers match against the full index name — keep names unique across tables.
//
// ⚠️ IMPORTANT: When adding new columns that will be searchable via ILIKE in the
// data-table UI, you MUST also add a corresponding trigram (GIN) index in:
//   db/migrations/001_add_trgm_indexes.sql
// Without a trgm index, ILIKE '%text%' queries will cause full table scans.

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import {
  CUSTOM_ROLE_VALUE,
  DASHBOARD_PAGES,
  DashboardPage,
  PermissionAction,
  REQUIRE_ROLE_FOR_LOGIN,
  ROLE_SCOPE,
  SessionMetadata,
} from '@/lib/permissions/constants';

import {
  EMAIL_MAX,
  NAME_MAX,
  ROLE_DESCRIPTION_MAX,
  ROLE_NAME_MAX,
  URL_MAX,
} from '@/utils/validation/constants';
import { API_PATH_MAX } from '@/lib/audit';

export type PermissionActions = Record<PermissionAction, boolean>;

// ================================
// Common Fields Helpers
// ================================

const timestamps = {
  createdAt: timestamp('created_at', {
    withTimezone: true,
    precision: 2,
    mode: 'string',
  })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {
    withTimezone: true,
    precision: 2,
    mode: 'string',
  })
    .defaultNow()
    .$onUpdate(() => sql`now()`)
    .notNull(),
};

// ================================
// Enums
// ================================

export const bucketTypeEnum = ['public', 'private'] as const;
export const pageNameValues = Object.keys(DASHBOARD_PAGES) as unknown as [
  DashboardPage,
  ...DashboardPage[],
];
/**
 * Role Scope Values:
 * - 'system': Protected/immutable roles created by developer (e.g., superAdmin) - cannot be modified or deleted
 * - 'standard': Normal roles created via dashboard - fully editable and visible in permissions page
 * - 'custom': User-specific roles - only visible/editable when editing that specific user
 */
export const roleScopeValues = [
  ROLE_SCOPE.SYSTEM,
  ROLE_SCOPE.STANDARD,
  ROLE_SCOPE.CUSTOM,
] as const;
export const bucketType = pgEnum('bucket_type', bucketTypeEnum);
export const auditLogActionEnum = ['INSERT', 'UPDATE', 'DELETE'] as const;
export const auditLogAction = pgEnum('audit_log_action', auditLogActionEnum);
export const pageName = pgEnum('page_name', pageNameValues);
export const roleScope = pgEnum('role_scope', roleScopeValues);
export const fileContextTablesEnum = [''] as const;

export const fileContextTable = pgEnum(
  'file_context_table',
  fileContextTablesEnum
);

// ================================
// Type definitions for JSONB fields
// ================================

export type AuditAction = 'INSERT' | 'UPDATE' | 'DELETE';

// ================================
// Users Table (Managed by Better Auth)
// ================================
export const users = pgTable(
  'users',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    name: varchar('name', { length: NAME_MAX }).notNull(),
    email: varchar('email', { length: EMAIL_MAX }).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    roleId: integer('role_id').references(() => roles.id, {
      onDelete: REQUIRE_ROLE_FOR_LOGIN ? 'restrict' : 'set null',
    }),
    // TODO: Remove failedLoginAttempts & lockedUntil, and convert it to Redis or any KV store
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', {
      withTimezone: true,
      precision: 2,
      mode: 'string',
    }),
    deletedAt: timestamp('deleted_at', {
      withTimezone: true,
      precision: 2,
      mode: 'string',
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('ux_users_email')
      .on(t.email)
      .where(sql`deleted_at IS NULL`),
    index('idx_users_role_active')
      .on(t.roleId)
      .where(sql`deleted_at IS NULL`),
    index('idx_users_created_at')
      .on(t.createdAt)
      .where(sql`deleted_at IS NULL`),
    check('chk_email_lowercase', sql`email = LOWER(email)`),
    check(
      'chk_failed_login_attempts_non_negative',
      sql`failed_login_attempts >= 0`
    ),
    check(
      'chk_deleted_user_inactive',
      sql`deleted_at IS NULL OR is_active = false`
    ),
    ...(REQUIRE_ROLE_FOR_LOGIN
      ? [
          check(
            'chk_active_user_has_role',
            sql`deleted_at IS NOT NULL OR role_id IS NOT NULL`
          ),
        ]
      : []),
  ]
);

// ================================
// Sessions Table
// ================================
// TODO: Add cron job to delete sessions older than 30 days
export const sessions = pgTable(
  'sessions',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      precision: 2,
      mode: 'string',
    }).notNull(),
    token: varchar('token', { length: 500 }).notNull(),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: varchar('user_agent', { length: 2000 }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Session metadata for caching permissions
    metadata: jsonb('metadata').$type<SessionMetadata>(),
    ...timestamps,
  },
  (t) => [
    index('idx_sessions_user_id').on(t.userId),
    index('idx_sessions_expires_at').on(t.expiresAt),
    uniqueIndex('ux_sessions_token').on(t.token),
  ]
);

// ================================
// Accounts Table
// ================================
export const accounts = pgTable(
  'accounts',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    accountId: varchar('account_id', { length: 255 }).notNull(),
    providerId: varchar('provider_id', { length: 100 }).notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    password: varchar('password', { length: 255 }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('ux_accounts_provider_user').on(t.providerId, t.userId),
    uniqueIndex('ux_accounts_provider_account').on(t.providerId, t.accountId),
    check(
      'chk_password_hash_length',
      sql`password IS NULL OR char_length(password) >= 50`
    ),
    // Credential-provider records must have a password hash
    check(
      'chk_credential_password',
      sql`provider_id <> 'credential' OR password IS NOT NULL`
    ),
  ]
);

// ================================
// User Tracking Fields (after users is defined)
// ================================

const userTracking = {
  createdBy: integer('created_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  updatedBy: integer('updated_by').references(() => users.id, {
    onDelete: 'set null',
  }),
};

/* eslint-disable @typescript-eslint/no-unused-vars */
// @ts-ignore
const auditFields = {
  ...timestamps,
  ...userTracking,
};

// ================================
// Files Table
// ================================
export const files = pgTable(
  'files',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    r2Key: varchar('r2_key', { length: URL_MAX }).notNull(),
    bucketType: bucketType('bucket_type').notNull(),
    contextTable: fileContextTable('context_table'),
    contextId: integer('context_id'),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    width: integer('width'),
    height: integer('height'),
    blurhash: varchar('blurhash', { length: 100 }),
    sortOrder: integer('sort_order').notNull().default(0),
    isTemporary: boolean('is_temporary').notNull().default(true),
    uploadedBy: integer('uploaded_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => [
    index('idx_files_uploaded_by').on(t.uploadedBy),
    uniqueIndex('ux_files_r2_key').on(t.r2Key),
    index('idx_files_context').on(t.contextTable, t.contextId, t.sortOrder),
    check('chk_size_bytes_positive', sql`size_bytes >= 0`),
    check('chk_sort_order_positive', sql`sort_order >= 0`),
    check('chk_width_positive', sql`width IS NULL OR width > 0`),
    check('chk_height_positive', sql`height IS NULL OR height > 0`),
  ]
);

// ================================
// Audit Log Table
// ================================
/**
 * Retention & Archival Strategy:
 * 1. Archive old logs to cold storage (S3/R2) before deletion
 * 2. Keep summary statistics for compliance reporting
 * 3. Use pg_partman for automated partition management
 * 4. TODO: Add cron job to archive/delete audit logs older than 30 days
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: integer('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    userEmail: varchar('user_email', { length: EMAIL_MAX }).notNull(),
    tableName: varchar('table_name', { length: 50 }).notNull(),
    recordId: integer('record_id').notNull(),
    action: auditLogAction('action').notNull(),
    oldData: jsonb('old_data'),
    newData: jsonb('new_data'),
    changedFields: jsonb('changed_fields'),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: varchar('user_agent', { length: 2000 }),
    apiPath: varchar('api_path', { length: API_PATH_MAX }),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      precision: 2,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('idx_audit_logs_table_record').on(t.tableName, t.recordId)]
);

// ================================
// Roles Table (defined first for FK reference)
// في حال اردت ان يتم تحديث جميع المستخدمين في حال تغير اي شي في الدور، يتم اضافه عامود الاصدار، وفي كل طلب يتم التحقق من الاصدار
// ================================
export const roles = pgTable(
  'roles',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    roleName: varchar('role_name', { length: ROLE_NAME_MAX })
      .notNull()
      .unique('ux_roles_role_name'),
    description: varchar('description', { length: ROLE_DESCRIPTION_MAX }),
    isActive: boolean('is_active').default(true).notNull(),
    scope: roleScope('scope').notNull().default(ROLE_SCOPE.STANDARD),
    ...timestamps,
  },
  (t) => [
    index('idx_roles_scope_active_created').on(
      t.scope,
      t.isActive,
      t.createdAt
    ),
    check(
      'chk_custom_prefix_scope',
      sql.raw(
        `(role_name LIKE '${CUSTOM_ROLE_VALUE}-%' AND scope = '${CUSTOM_ROLE_VALUE}') OR (role_name NOT LIKE '${CUSTOM_ROLE_VALUE}-%' AND scope <> '${CUSTOM_ROLE_VALUE}')`
      )
    ),
  ]
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    roleId: integer('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    pageName: pageName('page_name').notNull(),
    permissions: jsonb('permissions').$type<PermissionActions>().notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      precision: 2,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('idx_role_permissions_role_id').on(t.roleId),
    uniqueIndex('ux_role_permissions_role_page').on(t.roleId, t.pageName),
  ]
);

// ================================
// Relations
// ================================

export const usersRelations = relations(users, ({ one }) => ({
  role: one(roles, {
    fields: [users.roleId],
    references: [roles.id],
  }),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
  users: many(users),
  rolePermissions: many(rolePermissions),
}));

export const rolePermissionsRelations = relations(
  rolePermissions,
  ({ one }) => ({
    role: one(roles, {
      fields: [rolePermissions.roleId],
      references: [roles.id],
    }),
  })
);

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

// ================================
// TypeScript Types (inferred from schema)
// ================================

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type File = typeof files.$inferSelect;
export type NewFile = typeof files.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
export type RolePermission = typeof rolePermissions.$inferSelect;
export type NewRolePermission = typeof rolePermissions.$inferInsert;

// User with role included (for queries with relations)
export type UserWithRole = User & { role: Role | null };

export type RoleScopes = (typeof roleScopeValues)[number];
