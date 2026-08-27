// Unique indexes follow 'ux_<table>_<column>' convention (e.g. ux_users_email).
// Violation resolvers match against the full index name — keep names unique across tables.
//
// ⚠️ IMPORTANT: When adding new columns that will be searchable via ILIKE in the
// data-table UI, you MUST also add a corresponding trigram (GIN) index in:
//   db/migrations/001_add_trgm_indexes.sql
// Without a trgm index, ILIKE '%text%' queries will cause full table scans.
import type {
  DashboardPage,
  PermissionAction,
  SessionMetadata,
} from '@/lib/permissions/constants';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { API_PATH_MAX, USER_AGENT_MAX } from '@/lib/audit/constants';
import { generateUuidV7 as generateId } from '@/lib/id';
import {
  CUSTOM_ROLE_VALUE,
  DASHBOARD_PAGES,
  REQUIRE_ROLE_FOR_LOGIN,
  ROLE_SCOPE,
} from '@/lib/permissions/constants';

import { CREDENTIAL_ISSUER } from '@/utils/api-messages';
import { PHONE_NUMBER_MODE, PHONE_REQUIRED } from '@/utils/config';
import {
  EMAIL_MAX,
  NAME_MAX,
  OTP_IDENTIFIER_MAX,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_DAILY_VERIFY_ATTEMPTS,
  OTP_MAX_VERIFY_ATTEMPTS,
  PHONE_NUMBER_MAX,
  ROLE_DESCRIPTION_MAX,
  ROLE_NAME_MAX,
  URL_MAX,
} from '@/utils/validation/constants';
import { OTP_CHANNELS, OTP_PURPOSES } from '@/utils/validation/otp';

/**
 * `jsonb`, replacing `drizzle-orm/pg-core`'s — which double-encodes under
 * `bun:sql`.
 *
 * Drizzle's own `jsonb` returns `JSON.stringify(value)` from
 * `mapToDriverValue`, because most PostgreSQL drivers want JSON *text* for a
 * jsonb parameter. `bun:sql` does not: it JSON-encodes whatever JS value it is
 * given, so an already-serialised string is encoded a second time and the column
 * stores a jsonb STRING SCALAR rather than an object. Measured on Bun 1.4.0:
 * `insert into t (j) values (${'{"a":1}'})` stores `"{\"a\":1}"`, while the
 * same statement with the object stores `{"a":1}`.
 *
 * Drizzle's read path hid it — `mapFromDriverValue` JSON-parses a string, so the
 * double encode round-tripped invisibly through the ORM. What did not survive
 * was every SQL-level jsonb operation, because none of them go through that
 * mapper. `refreshRoleSessions` and `refreshUserSessions`
 * (`lib/permissions/utils.ts`) merge with `metadata || $1::jsonb`, and `||` on
 * two jsonb strings CONCATENATES INTO AN ARRAY instead of merging objects:
 * reproduced, `sessions.metadata` became
 * `["{\"keepMe\":…}","{\"roleName\":…}"]` and the permission patch was lost.
 * Anything reading these columns outside Drizzle — `db.execute`, `->`/`->>`,
 * `@>`, a jsonb index, psql — saw the same.
 *
 * So the value is passed through and encoded exactly once, by the driver. This
 * shadows the drizzle export deliberately: every column here keeps its
 * declaration, and the broken one is no longer in scope to be used by accident.
 * `dataType` still reports `jsonb`, so the generated DDL is unchanged.
 *
 * NOTE it is `prepare: true` that makes the bug reachable — without a prepared
 * statement Bun does not know the parameter is jsonb and sends it as text, which
 * PostgreSQL then parses correctly. Do not read a passing test under
 * `prepare: false` as evidence that this helper is unnecessary.
 *
 * **`fromDriver` is a pass-through, and that is a decision.** Drizzle's builtin
 * JSON-parses a string on the way out, which is precisely what hid the double
 * encode above: write twice, read twice, same object back, nothing to see. This
 * reports what the column actually holds. So these five columns TRUST THEIR
 * WRITERS — a jsonb string scalar reaching one of them (a `psql` fix-up, a script
 * that pre-stringifies) reads back as a `string` wearing the column's declared
 * type, and nothing complains. On the permission path that fails CLOSED (a
 * lookup on a string yields `undefined`, which denies), but it fails quietly.
 *
 * Throwing here instead was considered and rejected. `mapFromDriverValue` runs on
 * READ, so one bad row would 500 every request that touches it — a role-wide
 * auth outage to report a write-time mistake — and three of these columns
 * (`audit_logs`' `old_data`, `new_data`, `changed_fields`) are typed `unknown`,
 * where jsonb legitimately admits arrays and scalars; `changed_fields` already
 * stores an array. Refusing a non-object on read would assert an invariant the
 * type does not carry. A database CHECK constraint is the correct boundary for
 * any write-time invariant added here.
 */
const jsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => 'jsonb',
  toDriver: (value) => value,
  fromDriver: (value) => value,
});

export type PermissionActions = Record<PermissionAction, boolean>;

// ================================
// Common Fields Helpers
// ================================

// bun:sql returns `timestamptz` as Date; string mode would reapply host offset.
const timestamps = {
  createdAt: timestamp('created_at', {
    withTimezone: true,
    precision: 2,
  })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {
    withTimezone: true,
    precision: 2,
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
export const otpChannel = pgEnum('otp_channel', OTP_CHANNELS);
export const otpPurpose = pgEnum('otp_purpose', OTP_PURPOSES);
// Whitelist of supported auth providers — extend here when adding OAuth.
// Constraining the column to a known set prevents direct writes from
// introducing provider IDs that downstream code cannot handle.
export const providerIdEnumValues = ['credential'] as const;
export const providerId = pgEnum('provider_id', providerIdEnumValues);
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
    id: uuid('id').primaryKey().$defaultFn(generateId),
    name: varchar('name', { length: NAME_MAX }).notNull(),
    email: varchar('email', { length: EMAIL_MAX }).notNull(),
    // Nullability is driven by PHONE_NUMBER_MODE (see @/utils/config). When the
    // mode is 'required' the column is NOT NULL; otherwise it is optional.
    phoneNumber: PHONE_REQUIRED
      ? varchar('phone_number', { length: PHONE_NUMBER_MAX }).notNull()
      : varchar('phone_number', { length: PHONE_NUMBER_MAX }),
    emailVerified: boolean('email_verified').default(false).notNull(),
    phoneNumberVerified: boolean('phone_number_verified')
      .default(false)
      .notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    roleId: uuid('role_id').references(() => roles.id, {
      onDelete: REQUIRE_ROLE_FOR_LOGIN ? 'restrict' : 'set null',
    }),
    createdBy: uuid('created_by').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    // TODO: Remove failedLoginAttempts & lockedUntil, and convert it to Redis or any KV store
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', {
      withTimezone: true,
      precision: 2,
    }),
    // Soft delete, and it stays soft. There is deliberately NO sweep that hard-
    // deletes these rows: `auditLogs.userId` is `onDelete: 'restrict'`, so a
    // purge would fail for exactly the users who did anything, and succeed only
    // for the ones with no history — the opposite of a useful rule. Every read
    // path already filters `isNull(deletedAt)`, and the partial unique indexes
    // below release the email and phone for reuse, so the row costs a row.
    // Erasing a user for real is a data-subject request, not a cron job: it has
    // to decide what happens to their audit trail, which is a policy question.
    deletedAt: timestamp('deleted_at', {
      withTimezone: true,
      precision: 2,
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('ux_users_email')
      .on(t.email)
      .where(sql`deleted_at IS NULL`),
    uniqueIndex('ux_users_phone_number')
      .on(t.phoneNumber)
      .where(sql`deleted_at IS NULL AND phone_number IS NOT NULL`),
    index('idx_users_role_active')
      .on(t.roleId)
      .where(sql`deleted_at IS NULL`),
    index('idx_users_created_at')
      .on(t.createdAt)
      .where(sql`deleted_at IS NULL`),
    index('idx_users_created_by')
      .on(t.createdBy)
      .where(sql`deleted_at IS NULL AND created_by IS NOT NULL`),
    check('chk_email_lowercase', sql`email = LOWER(email)`),
    check(
      'chk_failed_login_attempts_non_negative',
      sql`failed_login_attempts >= 0`
    ),
    check(
      'chk_deleted_user_inactive',
      sql`deleted_at IS NULL OR is_active = false`
    ),
    check(
      'chk_phone_number_format',
      sql`phone_number IS NULL OR phone_number ~ '^9665[0-9]{8}$'`
    ),
    // Phone-mode invariants (see @/utils/config PHONE_NUMBER_MODE):
    // - disabled: phone must never be set or verified.
    // - optional/required: a verified flag requires a present number, so the
    //   "verified but NULL phone" state (DATA-1) can never arise.
    ...(PHONE_NUMBER_MODE === 'disabled'
      ? [
          check(
            'chk_phone_disabled',
            sql`phone_number IS NULL AND phone_number_verified = false`
          ),
        ]
      : [
          check(
            'chk_phone_verified_requires_phone',
            sql`phone_number_verified = false OR phone_number IS NOT NULL`
          ),
        ]),
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
// Retention: `db/maintenance.ts` deletes rows 30 days past `expiresAt`, on the
// `/api/internal/db-sweep` schedule. Not a correctness boundary — every read
// already filters on `expiresAt` — so the sweep only reclaims disk, and the
// 30-day tail keeps a just-expired session inspectable while someone is asking
// why a user was logged out.
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().$defaultFn(generateId),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      precision: 2,
    }).notNull(),
    token: varchar('token', { length: 500 }).notNull(),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: varchar('user_agent', { length: USER_AGENT_MAX }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Session metadata for caching permissions
    metadata: jsonb('metadata').$type<SessionMetadata>(),
    ...timestamps,
  },
  (t) => [
    // The third column lets the per-user "active sessions ordered by
    // createdAt DESC" query satisfy its sort from the index instead of an
    // in-memory pass after the (userId, expiresAt) filter.
    index('idx_sessions_user_expires_created').on(
      t.userId,
      t.expiresAt,
      t.createdAt
    ),
    uniqueIndex('ux_sessions_token').on(t.token),
  ]
);

// ================================
// Accounts Table
// ================================
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().$defaultFn(generateId),
    accountId: varchar('account_id', { length: 255 }).notNull(),
    // Better Auth 1.7 identifies an account by (issuer, accountId); `provider_id`
    // alone no longer resolves one. `/sign-in/email` requires this to equal
    // `local:credential` and answers a plain 401 otherwise, so the column is NOT
    // NULL with a default rather than nullable: a row that reaches this table
    // without it is an unauthenticatable user. See CREDENTIAL_ISSUER.
    issuer: varchar('issuer', { length: 255 })
      .notNull()
      .default(CREDENTIAL_ISSUER),
    providerId: providerId('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    password: varchar('password', { length: 255 }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('ux_accounts_provider_user').on(t.providerId, t.userId),
    uniqueIndex('ux_accounts_provider_account').on(t.providerId, t.accountId),
    // The uniqueness Better Auth itself assumes over the pair it looks accounts
    // up by. Redundant with ux_accounts_provider_account while `provider_id` has
    // one possible value; the two diverge as soon as a second provider exists,
    // and only this one matches the library's own index.
    uniqueIndex('ux_accounts_issuer_account').on(t.issuer, t.accountId),
    index('idx_accounts_user_id').on(t.userId),
    check(
      'chk_password_hash_length',
      sql`password IS NULL OR char_length(password) >= 50`
    ),
    // Credential-provider records must have a password hash
    check(
      'chk_credential_password',
      sql`provider_id <> 'credential' OR password IS NOT NULL`
    ),
    // Pins the pair the sign-in lookup matches on. The column default already
    // supplies the value; this is what stops a caller from writing a different
    // one, which would be a silent login outage rather than an error.
    //
    // The literals are duplicated from CREDENTIAL_PROVIDER_ID / CREDENTIAL_ISSUER
    // deliberately, and this is the one place that cannot be deduplicated:
    // drizzle-kit DROPS interpolated params from a check constraint instead of
    // inlining them. `sql\`... = ${CREDENTIAL_ISSUER}\`` generates
    // `CHECK (provider_id <>  OR issuer = )` — measured — which is invalid DDL
    // the migration only fails on when applied. Same reason the sibling
    // constraints above spell 'credential' out.
    check(
      'chk_credential_issuer',
      sql`provider_id <> 'credential' OR issuer = 'local:credential'`
    ),
  ]
);

// ================================
// User Tracking Fields (after users is defined)
// ================================

// ================================
// Files Table
// ================================
export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().$defaultFn(generateId),
    r2Key: varchar('r2_key', { length: URL_MAX }).notNull(),
    bucketType: bucketType('bucket_type').notNull(),
    contextTable: fileContextTable('context_table'),
    contextId: uuid('context_id'),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    width: integer('width'),
    height: integer('height'),
    blurhash: varchar('blurhash', { length: 100 }),
    sortOrder: integer('sort_order').notNull().default(0),
    // An upload starts unclaimed. `db/maintenance.ts` deletes rows still flagged
    // after 24h along with their R2 objects, so whatever eventually attaches an
    // upload to a record MUST clear this in the same transaction that writes
    // that record — otherwise the sweep deletes the image out from under it.
    // Nothing clears it today, which is why the sweep is currently the only
    // thing bounding bucket growth.
    isTemporary: boolean('is_temporary').notNull().default(true),
    uploadedBy: uuid('uploaded_by').references(() => users.id, {
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
 * Retention: NOTHING deletes from this table, and that is a decision, not a gap.
 *
 * The retention sweep in `db/maintenance.ts` deliberately skips it. Two reasons,
 * and either alone is sufficient:
 *
 * 1. **It is the trail everything else is measured against.** The
 *    `verification_sessions` sweep is only safe because every flow that consumes
 *    a proof writes its row here — contact change, password reset, passwordless
 *    sign-in. Expiring these rows at 30 days would delete the history that
 *    justifies expiring those, leaving neither.
 * 2. **`userId` is `onDelete: 'restrict'`**, so these rows are also what pins a
 *    soft-deleted user's identity in place. See `users.deletedAt`.
 *
 * If volume ever forces the issue, the options in preference order are
 * partitioning with `pg_partman` and detaching cold partitions, or archiving to
 * R2 before deletion — never a bare `DELETE`. Revisit on measured table size,
 * not on a calendar.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().$defaultFn(generateId),
    userId: uuid('user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    userEmail: varchar('user_email', { length: EMAIL_MAX }).notNull(),
    tableName: varchar('table_name', { length: 50 }).notNull(),
    recordId: varchar('record_id', { length: 100 }).notNull(),
    action: auditLogAction('action').notNull(),
    oldData: jsonb('old_data'),
    newData: jsonb('new_data'),
    changedFields: jsonb('changed_fields'),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: varchar('user_agent', { length: USER_AGENT_MAX }),
    apiPath: varchar('api_path', { length: API_PATH_MAX }),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      precision: 2,
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
    id: uuid('id').primaryKey().$defaultFn(generateId),
    roleName: varchar('role_name', { length: ROLE_NAME_MAX })
      .notNull()
      .unique('ux_roles_role_name'),
    description: varchar('description', { length: ROLE_DESCRIPTION_MAX }),
    isActive: boolean('is_active').default(true).notNull(),
    scope: roleScope('scope').notNull().default(ROLE_SCOPE.STANDARD),
    createdBy: uuid('created_by').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => [
    index('idx_roles_scope_active_created').on(
      t.scope,
      t.isActive,
      t.createdAt
    ),
    index('idx_roles_created_by')
      .on(t.createdBy)
      .where(sql`created_by IS NOT NULL`),
    check(
      'chk_custom_prefix_scope',
      sql.raw(
        `(role_name ILIKE '${CUSTOM_ROLE_VALUE}-%' AND scope = '${CUSTOM_ROLE_VALUE}') OR (role_name NOT ILIKE '${CUSTOM_ROLE_VALUE}-%' AND scope <> '${CUSTOM_ROLE_VALUE}')`
      )
    ),
  ]
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    id: uuid('id').primaryKey().$defaultFn(generateId),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    pageName: pageName('page_name').notNull(),
    permissions: jsonb('permissions').$type<PermissionActions>().notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      precision: 2,
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
// Verification Sessions (OTP rate-limiting & attempts tracking)
// ================================
export const verificationSessions = pgTable(
  'verification_sessions',
  {
    id: uuid('id').primaryKey().$defaultFn(generateId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Delivery transport of the most recent code. Informational after the fact:
    // nothing reads it to decide behaviour, and it is NOT part of the key.
    channel: otpChannel('channel').notNull(),
    // What is actually being proven, derived from the transport so the two can
    // never disagree. sms and whatsapp reach the same phone number, so keying
    // sessions on the transport gave each one its own send cycle, its own
    // 5-guess budget and its own 6-hour block — switching transport reset all
    // three. Generated rather than written by the app: an INSERT cannot set it,
    // so no code path can produce a row whose kind contradicts its channel.
    contactKind: text('contact_kind')
      .notNull()
      .generatedAlwaysAs(
        sql`CASE WHEN channel = 'email' THEN 'email' ELSE 'phone' END`
      ),
    identifier: varchar('identifier', { length: OTP_IDENTIFIER_MAX }).notNull(),
    // Binds the session to a single reason so a code proven for one purpose can
    // never authorize a different sensitive action.
    purpose: otpPurpose('purpose').notNull().default('verify_contact'),
    // For change_email / change_phone: the NEW contact whose ownership is being
    // proven and which is committed to the user on success. NULL for every
    // other purpose (the target is the user's existing contact in `identifier`).
    targetIdentifier: varchar('target_identifier', {
      length: OTP_IDENTIFIER_MAX,
    }),
    attemptNumber: integer('attempt_number').notNull().default(0),
    verifyAttemptNumber: integer('verify_attempt_number').notNull().default(0),
    // Failed verifies in a 24h window ANCHORED at verifyAttemptWindowStart —
    // a fixed window, not a rolling one: every failure on this row ages out
    // together when the anchor passes 24h. Unlike verifyAttemptNumber it is
    // NOT reset on resend, which closes the send-cycle-reset bypass. It lives
    // on the proof row, so it is also lost when the row is deleted (a
    // verify_contact success, or a credential rotation).
    verifyAttemptDaily: integer('verify_attempt_daily').notNull().default(0),
    verifyAttemptWindowStart: timestamp('verify_attempt_window_start', {
      withTimezone: true,
      precision: 2,
    })
      .notNull()
      .defaultNow(),
    lastSentAt: timestamp('last_sent_at', {
      withTimezone: true,
      precision: 2,
    }),
    nextAllowedAt: timestamp('next_allowed_at', {
      withTimezone: true,
      precision: 2,
    }),
    isBlocked: boolean('is_blocked').notNull().default(false),
    blockedUntil: timestamp('blocked_until', {
      withTimezone: true,
      precision: 2,
    }),
    // Single-use proof lifecycle for sensitive-action OTPs (change_email/phone).
    // `verifiedAt` is stamped when the code matches; `consumedAt` when the proof
    // is spent to commit the action. Both are written in the SAME transaction as
    // the action, so there is no verify→action replay window.
    verifiedAt: timestamp('verified_at', {
      withTimezone: true,
      precision: 2,
    }),
    consumedAt: timestamp('consumed_at', {
      withTimezone: true,
      precision: 2,
    }),
    ...timestamps,
  },
  (t) => [
    // One in-flight session per (user, CONTACT KIND, purpose). Keyed on the
    // contact kind, not the transport, so sms and whatsapp for one phone share
    // a single cycle, block and verify budget. `purpose` stays in the key or a
    // change_email send would clobber an in-flight verify_contact code. The
    // send upsert's onConflict target MUST match this key.
    uniqueIndex('ux_verification_sessions_user_contact_purpose').on(
      t.userId,
      t.contactKind,
      t.purpose
    ),
    check('chk_attempt_number_non_negative', sql`attempt_number >= 0`),
    check(
      'chk_attempt_number_max',
      sql.raw(`attempt_number <= ${OTP_MAX_ATTEMPTS}`)
    ),
    check(
      'chk_verify_attempt_number_max',
      sql.raw(`verify_attempt_number <= ${OTP_MAX_VERIFY_ATTEMPTS}`)
    ),
    check(
      'chk_verify_attempt_daily_max',
      sql.raw(`verify_attempt_daily <= ${OTP_MAX_DAILY_VERIFY_ATTEMPTS}`)
    ),
    check(
      'chk_verify_attempt_number_non_negative',
      sql`verify_attempt_number >= 0`
    ),
    check(
      'chk_verify_attempt_daily_non_negative',
      sql`verify_attempt_daily >= 0`
    ),
    check(
      'chk_blocked_has_until',
      sql`is_blocked = false OR blocked_until IS NOT NULL`
    ),
    check(
      'chk_unblocked_no_until',
      sql`is_blocked = true OR blocked_until IS NULL`
    ),
    // A target identifier exists iff the purpose is a contact-change. Keeps the
    // "new contact to commit" coherent with the reason it was collected.
    check(
      'chk_change_purpose_has_target',
      sql`(purpose IN ('change_email', 'change_phone')) = (target_identifier IS NOT NULL)`
    ),
    // consumedAt cannot precede verifiedAt existing — a proof must be verified
    // before it can be spent.
    check(
      'chk_consumed_requires_verified',
      sql`consumed_at IS NULL OR verified_at IS NOT NULL`
    ),
  ]
);

// ================================
// Verification Codes (OTP codes linked to sessions)
// ================================
export const verificationCodes = pgTable(
  'verification_codes',
  {
    id: uuid('id').primaryKey().$defaultFn(generateId),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => verificationSessions.id, { onDelete: 'cascade' }),
    // Stored as an Argon2id hash via hashOtpCode, never plaintext.
    code: varchar('code', { length: 255 }).notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      precision: 2,
    }).notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      precision: 2,
    })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex('ux_verification_codes_session').on(t.sessionId)]
);

// ================================
// Relations
// ================================

export const verificationSessionsRelations = relations(
  verificationSessions,
  ({ many }) => ({
    codes: many(verificationCodes),
  })
);

export const verificationCodesRelations = relations(
  verificationCodes,
  ({ one }) => ({
    session: one(verificationSessions, {
      fields: [verificationCodes.sessionId],
      references: [verificationSessions.id],
    }),
  })
);

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
export type VerificationSession = typeof verificationSessions.$inferSelect;
export type NewVerificationSession = typeof verificationSessions.$inferInsert;
export type VerificationCode = typeof verificationCodes.$inferSelect;
export type NewVerificationCode = typeof verificationCodes.$inferInsert;

// User with role included (for queries with relations)
export type UserWithRole = User & { role: Role | null };

export type RoleScopes = (typeof roleScopeValues)[number];
