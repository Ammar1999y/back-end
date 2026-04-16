import type {
  DashboardPage,
  PermissionAction,
} from '@/lib/permissions/constants';

import { RoleScopes } from '@/db/schema';

import { EntityID } from '.';

export interface PagePermission {
  name: DashboardPage;
  permissions: Partial<Record<PermissionAction, boolean>>;
}

export interface PermissionClient {
  id: EntityID;
  roleName: string;
  description?: string | null;
  isActive: boolean;
  scope: RoleScopes;
  usersCount?: number;
  createdAt?: string; // timestamp with time zone in Postgres
  updatedAt?: string; // timestamp with time zone in Postgres
  permissions: PagePermission[];
}
