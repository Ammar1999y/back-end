import type {
  DashboardPage,
  PermissionAction,
} from '@/lib/permissions/constants';

import * as z from 'zod';
import {
  DASHBOARD_PAGES,
  getAvailablePermissions,
  PERMISSION_ACTIONS,
} from '@/lib/permissions/constants';

import {
  PERMISSIONS_ARRAY_MAX,
  ROLE_DESCRIPTION_MAX,
  ROLE_NAME_MAX,
  ROLE_NAME_MIN,
} from './constants';
import { idSchema, sanitizeStrict, sanitizeStrictSingleLine } from './rules';

const ERROR_MESSAGES = {
  roleNameMaxLength: `اسم الدور يجب أن لا يتجاوز ${ROLE_NAME_MAX} حرفاً`,
  descriptionMaxLength: `الوصف يجب أن لا يتجاوز ${ROLE_DESCRIPTION_MAX} حرفاً`,
  pageNameRequired: 'اسم الصفحة مطلوب',
  roleNameRequired: 'اسم الدور مطلوب',
  descriptionRequired: 'الوصف مطلوب',
  pagePermissionRequired: 'الصلاحيات مطلوبه',
  permissionsMaxLength: `عدد الصلاحيات يجب أن لا يتجاوز ${PERMISSIONS_ARRAY_MAX} صلاحيات`,
  permissionsRequired: 'الصلاحيات مطلوبه',
  duplicatePageNames: 'أسماء الصفحات يجب أن لا تتكرر',
  viewRequiredForWrite:
    'يجب تفعيل صلاحية العرض عند تفعيل أي صلاحية كتابة (إنشاء، تعديل، حذف)',
};
// `.strict()`: a misspelled `dleete` used to be stripped and answered with 200,
// so the operator believed they had granted something that was never written.
// Real-but-unavailable actions are handled by value in `normalizeActionsForPage`.
const permissionSchema = z
  .object(
    Object.keys(PERMISSION_ACTIONS).reduce(
      (acc, action) => {
        acc[action as PermissionAction] = z.boolean();
        return acc;
      },
      {} as Record<PermissionAction, z.ZodBoolean>
    )
  )
  .partial()
  .strict();
/**
 * The RAW wire shape, validated before anything is rebuilt.
 *
 * Normalization used to run first, in a `z.preprocess` that reconstructed
 * `{ name, permissions }` from scratch. Because the object handed to `.strict()`
 * was the rebuilt one, strictness never saw what the client actually sent:
 * `{ name, permissionz: {...} }` and `{ name, permissions: null }` both arrived
 * at the schema as `{ name, permissions: {} }` and were ACCEPTED — and an
 * accepted empty matrix is destructive here, because the update handler writes
 * it and prunes the role's other pages. Validate first, normalize after.
 */
const rawPagePermissionSchema = z
  .object({
    name: z.enum(Object.keys(DASHBOARD_PAGES) as DashboardPage[]),
    // Required and non-nullable: an absent or null matrix is ambiguous between
    // "no permissions" and "field forgotten", and the destructive reading was
    // the one it silently got.
    permissions: permissionSchema,
  })
  .strict();

/**
 * An action the page does not offer: 422 when granted, dropped when not.
 * Rejecting `edit: false` would fail a uniform matrix over a no-op, and
 * `sanitizePermissions` forces unavailable actions to false on read anyway.
 */
function normalizeActionsForPage(
  value: z.output<typeof rawPagePermissionSchema>,
  ctx: z.RefinementCtx
): z.output<typeof rawPagePermissionSchema> {
  const { name, permissions } = value;
  const available = getAvailablePermissions(name);
  // Safe to write by key: `permissionSchema` is `.strict()` over
  // `PERMISSION_ACTIONS`, so every surviving key is one of ours.
  const kept: Partial<Record<PermissionAction, boolean>> = {};

  for (const [action, granted] of Object.entries(permissions)) {
    if (available.includes(action as PermissionAction)) {
      kept[action as PermissionAction] = granted;
      continue;
    }
    if (granted !== true) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['permissions', action],
      message: `الصلاحية "${action}" غير متاحة لصفحة "${name}"`,
    });
  }

  return { name, permissions: kept };
}

export const pagePermissionSchema = rawPagePermissionSchema
  .transform(normalizeActionsForPage)
  .superRefine(({ permissions }, ctx) => {
    // `create` alone needs no read access (per product spec).
    // `edit`/`delete` (all-scope) require `view`.
    // `editOwn`/`deleteOwn` require `view` OR `viewOwn`.
    const hasAllWrite =
      permissions.edit === true || permissions.delete === true;

    if (hasAllWrite && permissions.view !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permissions', 'view'],
        message: ERROR_MESSAGES.viewRequiredForWrite,
      });
      return;
    }

    if (
      (permissions.editOwn === true || permissions.deleteOwn === true) &&
      permissions.view !== true &&
      permissions.viewOwn !== true
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permissions', 'viewOwn'],
        message: ERROR_MESSAGES.viewRequiredForWrite,
      });
    }
  });
function noDuplicatePageNames(items: { name: string }[], ctx: z.RefinementCtx) {
  const names = items.map((p) => p.name);
  if (new Set(names).size !== names.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: ERROR_MESSAGES.duplicatePageNames,
    });
  }
}

// Bounded like the role-create matrix: without a cap a custom-role payload
// could carry an unbounded number of page entries, each one an INSERT and an
// audit-payload entry.
export const permissionsArraySchema = z
  .array(pagePermissionSchema)
  .max(PERMISSIONS_ARRAY_MAX, ERROR_MESSAGES.permissionsMaxLength)
  .superRefine((items, ctx) =>
    noDuplicatePageNames(items as { name: string }[], ctx)
  );

export const createPermissionSchema = z.object({
  roleName: z.preprocess(
    sanitizeStrictSingleLine,
    z
      .string()
      .min(ROLE_NAME_MIN, ERROR_MESSAGES.roleNameRequired)
      .max(ROLE_NAME_MAX, ERROR_MESSAGES.roleNameMaxLength)
  ),
  description: z
    .preprocess(
      sanitizeStrict,
      z
        .string()
        .max(ROLE_DESCRIPTION_MAX, ERROR_MESSAGES.descriptionMaxLength)
        .optional()
        .nullish()
    )
    .optional()
    .nullish(),
  permissions: z
    .array(pagePermissionSchema)
    .min(1, ERROR_MESSAGES.permissionsRequired)
    .max(PERMISSIONS_ARRAY_MAX, ERROR_MESSAGES.permissionsMaxLength)
    .superRefine((items, ctx) =>
      noDuplicatePageNames(items as { name: string }[], ctx)
    ),
  isActive: z.boolean(),
});

const updatePermissionSchema = createPermissionSchema
  .extend({
    id: idSchema,
  })
  .partial({ permissions: true }); // Make permissions optional for updates

/**
 * UPDATE rejects unknown top-level keys instead of stripping them: a misspelled
 * `descriptionn` was dropped and answered with 200, so the client believed a
 * change had been applied that was never written.
 *
 * CREATE stays lenient, matching `createUserSchema` — every field it writes is
 * required, so a misspelled key fails as a MISSING field rather than as a silent
 * no-op, and the endpoint's documented contract is that a client may post back a
 * response object carrying server-owned extras (`createdAt`, `usersCount`) and
 * have them stripped. Nested page/action objects are strict in both.
 *
 * Kept separate from the schemas above rather than `.strict()` on them, because
 * those double as react-hook-form resolvers whose state legitimately carries
 * those response-only fields.
 */
export const adminUpdatePermissionSchema = updatePermissionSchema.strict();

// Type inference, used in the front end
// type CreatePermissionInput = z.input<typeof createPermissionSchema>;
// type UpdatePermissionInput = z.input<typeof updatePermissionSchema>;
// type CreatePermissionOutput = z.output<typeof createPermissionSchema>;
// type UpdatePermissionOutput = z.output<typeof updatePermissionSchema>;
// type PagePermission = z.input<typeof pagePermissionSchema>;
