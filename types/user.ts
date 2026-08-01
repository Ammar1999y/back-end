import { RoleScopes } from '@/db/schema';

import { EntityID } from '.';
import { PagePermission } from './permission';
import { CUSTOM_ROLE_VALUE } from '@/lib/permissions/constants';

export interface UserRole {
  id: EntityID;
  roleName: string;
  scope?: RoleScopes;
}

export interface UserClient {
  id: EntityID;
  name: string;
  email: string;
  emailVerified?: boolean;
  phoneNumber?: string | null;
  phoneNumberVerified?: boolean;
  isActive: boolean;
  roleId: EntityID | typeof CUSTOM_ROLE_VALUE | null;
  role: UserRole | null;
  createdAt?: string; // timestamp with time zone in Postgres
  updatedAt?: string; // timestamp with time zone in Postgres
  permissions?: PagePermission[];
}
