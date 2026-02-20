/* eslint-disable unicorn/prefer-export-from */
import type {
  DashboardPage,
  PermissionAction,
} from '@/lib/permissions/constants';

// Re-export types from single source of truth
export type { PermissionAction, DashboardPage };

export interface PagePermission {
  name: DashboardPage;
  permissions: Partial<Record<PermissionAction, boolean>>;
}

export interface PermissionsTableProps {
  onPermissionsChange?: (permissions: PagePermission[]) => void;
  className?: string;
  setInitPermissions?: boolean;
}
