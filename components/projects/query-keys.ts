/**
 * Centralized query keys for projects feature
 * Modify these keys in one place to update all usages
 */

import { EntityID } from '@/types';

export const PROJECTS_QUERY_KEYS = {
  /** Query key for projects list */
  list: ['projects'],

  /** Query key for project detail with dynamic ID */
  detail: (id: string | EntityID) => ['projects', id],

  /** Base query key for all project details (for invalidation) */
  detailBase: ['projects'],
};
