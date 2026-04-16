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

/**
 * Returns the column index of the prerequisite (gate) permission, or -1 if none.
 * Write actions require their corresponding view action to be enabled first.
 * Future-proof: *_own actions would be gated by view_own.
 */
export function getGateIndex(colIndex: number): number {
  const action = ACTIONS_ARRAY[colIndex] as string;
  if (action.startsWith('view')) return -1;
  const gate = action.endsWith('_own') ? 'view_own' : 'view';
  const idx = ACTIONS_ARRAY.indexOf(gate as PermissionAction);
  return idx;
}

function getDependentIndices(colIndex: number): number[] {
  return ACTIONS_ARRAY.reduce<number[]>((acc, _, i) => {
    if (getGateIndex(i) === colIndex) acc.push(i);
    return acc;
  }, []);
}

export const usePermissionsTableStore = create<PermissionsTableStore>(
  (set) => ({
    checkboxStates: [],

    initializeStates: (pages: PagePermission[]) => {
      const states: boolean[][] = pages.map((page) => {
        const row = ACTIONS_ARRAY.map((action) =>
          Boolean(page.permissions[action])
        );
        // Sanitize: if a gate permission is off, force all dependents off
        for (let i = 0; i < row.length; i++) {
          const gate = getGateIndex(i);
          if (gate >= 0 && !row[gate]) row[i] = false;
        }
        return row;
      });
      set({ checkboxStates: states });
    },

    toggleCell: (rowIndex: number, colIndex: number, checked: boolean) => {
      set((state) => {
        const row = state.checkboxStates[rowIndex];
        if (!row) return state;

        if (checked) {
          const gate = getGateIndex(colIndex);
          if (gate >= 0 && !row[gate]) return state;
        }

        const newRow = [...row];
        newRow[colIndex] = checked;

        // Cascade off: disable all dependents when unchecking a gate permission
        if (!checked) {
          for (const dep of getDependentIndices(colIndex)) {
            newRow[dep] = false;
          }
        }

        return {
          checkboxStates: state.checkboxStates.map((r, i) =>
            i === rowIndex ? newRow : r
          ),
        };
      });
    },

    toggleAllColumn: (colIndex: number) => {
      set((state) => {
        const permissionType = ACTIONS_ARRAY[colIndex];
        const gate = getGateIndex(colIndex);
        const dependents = getDependentIndices(colIndex);

        const eligibleIndices = state.checkboxStates.reduce<number[]>(
          (acc, row, rowIndex) => {
            const page = DEFAULT_PAGE_PERMISSIONS[rowIndex];
            if (!page?.availablePermissions.includes(permissionType))
              return acc;
            if (gate >= 0 && !row[gate]) return acc;
            acc.push(rowIndex);
            return acc;
          },
          []
        );

        const newValue = eligibleIndices.some(
          (i) => !state.checkboxStates[i][colIndex]
        );

        return {
          checkboxStates: state.checkboxStates.map((row, rowIndex) => {
            if (!eligibleIndices.includes(rowIndex)) {
              // Still cascade dependents off when turning gate off
              if (!newValue && dependents.length > 0) {
                const page = DEFAULT_PAGE_PERMISSIONS[rowIndex];
                if (page?.availablePermissions.includes(permissionType)) {
                  const newRow = [...row];
                  newRow[colIndex] = false;
                  for (const dep of dependents) newRow[dep] = false;
                  return newRow;
                }
              }
              return row;
            }

            const newRow = [...row];
            newRow[colIndex] = newValue;

            if (!newValue) {
              for (const dep of dependents) newRow[dep] = false;
            }

            return newRow;
          }),
        };
      });
    },

    toggleAllRow: (rowIndex: number) => {
      set((state) => {
        const page = DEFAULT_PAGE_PERMISSIONS[rowIndex];
        const currentRow = state.checkboxStates[rowIndex];
        if (!page || !currentRow) return state;

        const availableIndices = ACTIONS_ARRAY.map((action, index) =>
          page.availablePermissions.includes(action) ? index : -1
        ).filter((i) => i !== -1);

        const hasAnyFalse = availableIndices.some((i) => !currentRow[i]);
        const newRow = [...currentRow];

        for (const i of availableIndices) {
          newRow[i] = hasAnyFalse;
        }

        return {
          checkboxStates: state.checkboxStates.map((row, rIndex) =>
            rIndex === rowIndex ? newRow : row
          ),
        };
      });
    },

    reset: () => set({ checkboxStates: [] }),
  })
);
