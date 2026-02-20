/**
 * Centralized query keys for users feature
 * Modify these keys in one place to update all usages
 */

import { EntityID } from '@/types';

export const USERS_QUERY_KEYS = {
  /** Query key for users list */
  list: ['dash-users'],

  /** Query key for user detail with dynamic ID */
  detail: (id: number | string | EntityID) => ['dash-users', id],

  /** Base query key for all user details (for invalidation) */
  detailBase: ['dash-users'],
};

export const ROLES_QUERY_KEYS = {
  /** Query key for roles list */
  list: ['roles'],
};
