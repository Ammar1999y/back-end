/**
 * Centralized query keys for sections feature
 * Modify these keys in one place to update all usages
 */

import { EntityID } from '@/types';

export const SECTIONS_QUERY_KEYS = {
  /** Query key for sections list */
  list: ['sections'],

  /** Query key for section detail with dynamic ID */
  detail: (id: string | EntityID) => ['sections', id],

  /** Base query key for all section details (for invalidation) */
  detailBase: ['sections'],
};
