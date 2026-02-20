import { RoleScopes } from '@/db/schema';

import { PagePermission } from '@/components/users/permissions-table';

import { EntityID } from '.';

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
