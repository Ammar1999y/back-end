import type { PermissionAction } from '@/lib/permissions/constants';

import { DEFAULT_PAGE_PERMISSIONS } from '@/lib/permissions/constants';

const permissionPages = DEFAULT_PAGE_PERMISSIONS.map((page) => {
  // Only include permissions that are available for this page
  const permissions: Partial<Record<PermissionAction, boolean>> = {};

  for (const action of page.availablePermissions) permissions[action] = true;

  return {
    name: page.name,
    permissions,
  };
});

export default permissionPages;
