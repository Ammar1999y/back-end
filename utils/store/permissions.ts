import type { EntityID } from '@/types';
import type { PermissionClient } from '@/types/permission';

import { generateUUIDv7 } from '@/utils';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface PermissionsState {
  permissions: PermissionClient[];
}

interface PermissionsActions {
  addPermission: (
    permission: Omit<PermissionClient, 'id' | 'createdAt' | 'updatedAt'>
  ) => PermissionClient;
  updatePermission: (
    id: EntityID,
    data: Partial<Omit<PermissionClient, 'id'>>
  ) => PermissionClient | null;
  deletePermission: (id: EntityID) => boolean;
  getPermissionById: (id: EntityID) => PermissionClient | undefined;
  getAllPermissions: () => PermissionClient[];
}

type PermissionsStore = PermissionsState & PermissionsActions;

export const usePermissionsStore = create<PermissionsStore>()(
  persist(
    (set, get) => ({
      // Initial state
      permissions: [],

      // Actions
      addPermission: (permissionData) => {
        const newPermission: PermissionClient = {
          ...permissionData,
          id: generateUUIDv7(),
          createdAt: new Date().toISOString(),
        };

        set((state) => ({
          permissions: [newPermission, ...state.permissions],
        }));

        return newPermission;
      },

      updatePermission: (id, data) => {
        const { permissions } = get();
        const index = permissions.findIndex((item) => item.id === id);

        if (index === -1) return null;

        const updatedPermission: PermissionClient = {
          ...permissions[index],
          ...data,
          id, // Ensure ID is not changed
          updatedAt: new Date().toISOString(),
        };

        set((state) => ({
          permissions: state.permissions.map((item) =>
            item.id === id ? updatedPermission : item
          ),
        }));

        return updatedPermission;
      },

      deletePermission: (id) => {
        const { permissions } = get();
        const exists = permissions.some((item) => item.id === id);

        if (!exists) return false;

        set((state) => ({
          permissions: state.permissions.filter((item) => item.id !== id),
        }));

        return true;
      },

      getPermissionById: (id) => {
        return get().permissions.find((item) => item.id === id);
      },

      getAllPermissions: () => {
        return get().permissions;
      },
    }),
    {
      name: 'permissions-storage',
    }
  )
);
