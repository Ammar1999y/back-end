import type { PagePermission } from '@/types/permission';


// Re-export from single source of truth (types/permission.ts)
export type {
  PermissionAction,
  DashboardPage,
} from '@/lib/permissions/constants';
export type { PagePermission } from '@/types/permission';

export interface PermissionsTableProps {
  onPermissionsChange?: (permissions: PagePermission[]) => void;
  className?: string;
  setInitPermissions?: boolean;
}
