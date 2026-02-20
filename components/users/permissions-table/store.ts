import type { PagePermission, PermissionAction } from './types';

import { create } from 'zustand';
import {
  DEFAULT_PAGE_PERMISSIONS,
  PERMISSION_ACTIONS,
} from '@/lib/permissions/constants';

interface PermissionsTableStore {
  checkboxStates: boolean[][];
  initializeStates: (pages: PagePermission[]) => void;
  toggleCell: (rowIndex: number, colIndex: number, checked: boolean) => void;
  toggleAllColumn: (colIndex: number) => void;
  toggleAllRow: (rowIndex: number) => void;
  reset: () => void;
}

const ACTIONS_ARRAY = Object.keys(PERMISSION_ACTIONS) as PermissionAction[];

export const usePermissionsTableStore = create<PermissionsTableStore>(
  (set) => ({
    checkboxStates: [],

    initializeStates: (pages: PagePermission[]) => {
      const states: boolean[][] = pages.map((page) =>
        ACTIONS_ARRAY.map((action) => Boolean(page.permissions[action]))
      );
      set({ checkboxStates: states });
    },

    toggleCell: (rowIndex: number, colIndex: number, checked: boolean) => {
      set((state) => ({
        checkboxStates: state.checkboxStates.map((row, rIndex) =>
          rIndex === rowIndex
            ? row.map((cell, cIndex) => (cIndex === colIndex ? checked : cell))
            : row
        ),
      }));
    },

    toggleAllColumn: (colIndex: number) => {
      set((state) => {
        const permissionType = ACTIONS_ARRAY[colIndex];

        // Only check rows where this permission is available
        const visibleRows = state.checkboxStates.filter((_, rowIndex) => {
          const page = DEFAULT_PAGE_PERMISSIONS[rowIndex];
          return page?.availablePermissions.includes(permissionType);
        });

        const hasAnyFalse = visibleRows.some((row) => !row[colIndex]);

        return {
          checkboxStates: state.checkboxStates.map((row, rowIndex) => {
            const page = DEFAULT_PAGE_PERMISSIONS[rowIndex];
            const isAvailable =
              page?.availablePermissions.includes(permissionType);

            return row.map((cell, cIndex) =>
              cIndex === colIndex && isAvailable ? hasAnyFalse : cell
            );
          }),
        };
      });
    },

    toggleAllRow: (rowIndex: number) => {
      set((state) => {
        const page = DEFAULT_PAGE_PERMISSIONS[rowIndex];
        const currentRow = state.checkboxStates[rowIndex];

        // Only check available permissions for this row
        const availableIndices = ACTIONS_ARRAY.map((action, index) =>
          page?.availablePermissions.includes(action) ? index : -1
        ).filter((i) => i !== -1);

        const hasAnyFalse = availableIndices.some((i) => !currentRow[i]);

        return {
          checkboxStates: state.checkboxStates.map((row, rIndex) =>
            rIndex === rowIndex
              ? row.map((cell, cIndex) =>
                  availableIndices.includes(cIndex) ? hasAnyFalse : cell
                )
              : row
          ),
        };
      });
    },

    reset: () => set({ checkboxStates: [] }),
  })
);
