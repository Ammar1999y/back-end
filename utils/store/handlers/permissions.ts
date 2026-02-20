import type {
  CreatePermissionOutput,
  UpdatePermissionOutput,
} from '@/utils/validation/permissions';

import { EntityID } from '@/types';
import { CUSTOM_ROLE_VALUE } from '@/lib/permissions/constants';

import { CustomError } from '@/utils/error-class';
import { registerLocalStorageHandler } from '@/utils/mutation';
import { registerLocalStorageQueryHandler } from '@/utils/query';
import { usePermissionsStore } from '@/utils/store/permissions';

// Register mutation handlers for permissions endpoints
registerLocalStorageHandler(/\/api\/dash\/permissions/, {
  create: async (data: CreatePermissionOutput) => {
    const newPermission = usePermissionsStore
      .getState()
      .addPermission({ ...data, scope: 'standard' });
    return {
      data: {
        id: newPermission.id,
        createdAt: newPermission.createdAt,
      },
      message: 'تم إنشاء الصلاحية بنجاح',
    };
  },

  update: async (id: EntityID, data: UpdatePermissionOutput) => {
    const updatedPermission = usePermissionsStore
      .getState()
      .updatePermission(id, data);
    if (!updatedPermission) {
      throw new CustomError('الصلاحية غير موجودة', 404);
    }
    return {
      data: {
        updatedAt: updatedPermission.updatedAt,
      },
      message: 'تم تحديث الصلاحية بنجاح',
    };
  },

  delete: async (id: EntityID) => {
    const deleted = usePermissionsStore.getState().deletePermission(id);
    if (!deleted) {
      throw new CustomError('الصلاحية غير موجودة', 404);
    }
    return {
      data: { id },
      message: 'تم حذف الصلاحية بنجاح',
    };
  },
});

// Register query handlers for permissions endpoints
registerLocalStorageQueryHandler(/\/api\/dash\/permissions/, {
  getAll: async () => {
    return usePermissionsStore.getState().getAllPermissions();
  },

  getById: async (id: EntityID) => {
    const permission = usePermissionsStore.getState().getPermissionById(id);
    if (!permission) {
      throw new CustomError('الصلاحية غير موجودة', 404);
    }
    return permission;
  },
});

// Register query handlers for roles endpoint (simplified permissions for combobox)
registerLocalStorageQueryHandler(/\/api\/dash\/roles/, {
  getAll: async () => {
    const permissions = usePermissionsStore.getState().getAllPermissions();
    // Return only active permissions as role options
    return [
      ...(permissions
        .filter((permission) => permission.isActive)
        .map((permission) => ({
          id: permission.id,
          value: permission.id,
          label: permission.roleName,
        })) || []),
      {
        value: CUSTOM_ROLE_VALUE,
        label: 'مخصص',
      },
    ];
  },
});
