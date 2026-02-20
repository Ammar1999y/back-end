import { RoleScopes } from '@/db/schema';

import { PagePermission } from '@/components/users/permissions-table';

import { EntityID } from '.';

export interface UserRole {
  id: EntityID;
  roleName: string;
  scope?: RoleScopes;
}

export interface UserClient {
  id: EntityID;
  name: string;
  email: string;
  isActive: boolean;
  roleId: EntityID | null;
  role: UserRole | null;
  createdAt?: string; // timestamp with time zone in Postgres
  updatedAt?: string; // timestamp with time zone in Postgres
  permissions?: PagePermission[];
}
