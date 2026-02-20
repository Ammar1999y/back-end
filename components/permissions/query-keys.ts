/**
 * Centralized query keys for permissions feature
 * Modify these keys in one place to update all usages
 */

import { EntityID } from '@/types';

export const PERMISSIONS_QUERY_KEYS = {
  /** Query key for permissions list */
  list: ['permissions'],

  /** Query key for permission detail with dynamic ID */
  detail: (id: number | string | EntityID) => ['permissions', id],

  /** Base query key for all permission details (for invalidation) */
  detailBase: ['permissions'],
};
