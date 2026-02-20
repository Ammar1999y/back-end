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
};
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
  .partial();
export const pagePermissionSchema = z.preprocess(
  (data) => {
    if (typeof data !== 'object' || data === null) return data;

    const { name, permissions } = data as {
      name: DashboardPage;
      permissions: Record<PermissionAction, boolean>;
    };

    const available = getAvailablePermissions(name);
    const filtered = Object.fromEntries(
      Object.entries(permissions).filter(([key]) =>
        available.includes(key as PermissionAction)
      )
    );

    return {
      name,
      permissions: filtered,
    };
  },
  z.object({
    name: z.enum(Object.keys(DASHBOARD_PAGES) as DashboardPage[]),
    permissions: permissionSchema,
  })
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
    .max(PERMISSIONS_ARRAY_MAX, ERROR_MESSAGES.permissionsMaxLength),
  isActive: z.boolean(),
});

export const updatePermissionSchema = createPermissionSchema
  .extend({
    id: idSchema,
  })
  .partial({ permissions: true }); // Make permissions optional for updates

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
