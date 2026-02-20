import type { PagePermission, PermissionAction } from './types';

import { memo, useEffect } from 'react';

import {
  DEFAULT_PAGE_PERMISSIONS,
  PERMISSION_ACTIONS,
} from '@/lib/permissions/constants';

import permissionPages from './data';
import { usePermissionsTableStore } from './store';

interface PermissionsChangeHandlerProps {
  onPermissionsChange?: (permissions: PagePermission[]) => void;
}

const ACTIONS_ARRAY = Object.keys(PERMISSION_ACTIONS) as PermissionAction[];

const PermissionsChangeHandler = memo(
  ({ onPermissionsChange }: PermissionsChangeHandlerProps) => {
    const checkboxStates = usePermissionsTableStore((s) => s.checkboxStates);
    useEffect(() => {
      if (onPermissionsChange) {
        const permissionsData: PagePermission[] = permissionPages.map(
          (page, index) => {
            const pageConfig = DEFAULT_PAGE_PERMISSIONS[index];
            const permissions: Partial<Record<PermissionAction, boolean>> = {};

            ACTIONS_ARRAY.forEach((action, colIndex) => {
              if (pageConfig?.availablePermissions.includes(action)) {
                permissions[action] =
                  checkboxStates[index]?.[colIndex] ?? false;
              }
            });

            return {
              name: page.name,
              permissions,
            };
          }
        );

        onPermissionsChange(permissionsData);
      }
    }, [checkboxStates, onPermissionsChange]);
    return null;
  }
);

PermissionsChangeHandler.displayName = 'PermissionsChangeHandler';

export default PermissionsChangeHandler;
