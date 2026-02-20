/**
 * Centralized query keys for categories feature
 * Modify these keys in one place to update all usages
 */

import { EntityID } from '@/types';

export const CATEGORIES_QUERY_KEYS = {
  /** Query key for categories list */
  list: ['projects-categories'],

  /** Query key for category detail with dynamic ID */
  detail: (id: string | EntityID) => ['projects-categories', id],

  /** Base query key for all category details (for invalidation) */
  detailBase: ['projects-categories'],
};
