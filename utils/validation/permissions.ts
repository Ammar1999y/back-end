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
// `.strict()`: an action key that is not a real action is a client error, not
// something to drop. The preprocess below removes actions a page does not offer
// (the UI submits the full matrix for every page, so that part is normalisation)
// but leaves anything unrecognised in place for this schema to reject — a
// misspelled `dleete` used to be stripped and answered with 200, so the operator
// believed they had granted a permission that was never written.
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
 * An action the page does not offer is REJECTED, not dropped.
 *
 * It used to be normalised away, which meant `{name: 'home', permissions:
 * {edit: true}}` returned 200 while granting nothing — the API confirming a
 * change it had silently discarded. `home` has no `edit` column, so no client
 * produces that payload: the UI builds each page's matrix from that page's own
 * available actions, so there is no compatibility case to preserve and nothing
 * to normalise.
 */
function assertActionsAvailableForPage(
  { name, permissions }: z.output<typeof rawPagePermissionSchema>,
  ctx: z.RefinementCtx
) {
  const available = getAvailablePermissions(name);
  for (const action of Object.keys(permissions)) {
    if (available.includes(action as PermissionAction)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['permissions', action],
      message: `الصلاحية "${action}" غير متاحة لصفحة "${name}"`,
    });
  }
}

export const pagePermissionSchema = rawPagePermissionSchema
  .superRefine(assertActionsAvailableForPage)
  .superRefine(({ permissions }, ctx) => {
    // `create` alone needs no read access (per product spec).
    // `edit`/`delete` (all-scope) require `view`.
    // `editOwn`/`deleteOwn` require `view` OR `viewOwn`.
    const hasAllWrite = permissions.edit === true || permissions.delete === true;
    const hasOwnWrite =
      permissions.editOwn === true || permissions.deleteOwn === true;

    if (hasAllWrite && permissions.view !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permissions', 'view'],
        message: ERROR_MESSAGES.viewRequiredForWrite,
      });
      return;
    }

    if (
      hasOwnWrite &&
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

export const updatePermissionSchema = createPermissionSchema
  .extend({
    id: idSchema,
  })
  .partial({ permissions: true }); // Make permissions optional for updates

/**
 * Server wire contracts. Same fields, but unknown keys are REJECTED instead of
 * stripped: a misspelled `permissionz` or `descriptionn` used to be dropped and
 * answered with 200, so the client believed a change had been applied that was
 * never written.
 *
 * Separate from the schemas above rather than `.strict()` on them, because those
 * two double as react-hook-form resolvers, whose state legitimately carries
 * response-only fields (`createdAt`, `usersCount`) that would then fail
 * client-side validation before a request was ever made.
 */
export const adminCreatePermissionSchema = createPermissionSchema.strict();
export const adminUpdatePermissionSchema = updatePermissionSchema.strict();

// Type inference
export type CreatePermissionInput = z.input<typeof createPermissionSchema>;
export type UpdatePermissionInput = z.input<typeof updatePermissionSchema>;
export type CreatePermissionOutput = z.output<typeof createPermissionSchema>;
export type UpdatePermissionOutput = z.output<typeof updatePermissionSchema>;
export type PagePermission = z.input<typeof pagePermissionSchema>;

/** @deprecated Use CreatePermissionInput instead */
export type CreatePermissionFormData = CreatePermissionInput;
/** @deprecated Use UpdatePermissionInput instead */
export type UpdatePermissionFormData = UpdatePermissionInput;
