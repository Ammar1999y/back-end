/**
 * Shared data-table utilities used by both frontend components and backend queries.
 * Extracted from components/ui/data-table/utils/ to avoid backend → frontend coupling.
 */

export { escapeLike, filterColumns, getColumn } from '@/components/ui/data-table/utils/filter-columns';
