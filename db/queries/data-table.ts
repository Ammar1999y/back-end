import type { ExtendedColumnSort } from '@/types/data-table';
import type { AnyColumn, SQL, Table } from 'drizzle-orm';

import { and, asc, desc, ilike, or } from 'drizzle-orm';

import {
  escapeLike,
  filterColumns,
  getColumn,
} from '@/lib/data-table/filter-columns';
import {
  MAX_PER_PAGE,
  parseSearchParams,
} from '@/lib/data-table/parsers';

const MAX_SEARCH_LENGTH = 200;

interface DataTableQueryParams {
  url: string;
  allowedColumns: Set<string>;
  /** Columns to match against for quick search (?search=) */
  searchableColumns?: string[];
  defaultSort?: ExtendedColumnSort<any>;
}

interface DataTableQueryResult<T extends Table> {
  where: SQL | undefined;
  orderBy: ReturnType<typeof asc>[];
  limit: number;
  offset: number;
  page: number;
  perPage: number;
  buildPageCount: (total: number) => number;
  applySorting: (table: T) => ReturnType<typeof asc>[];
}

/**
 * Parses URL search params and builds Drizzle-compatible
 * where, orderBy, limit, and offset values for data-table queries.
 */
export function parseDataTableParams<T extends Table>(
  table: T,
  { url, allowedColumns, searchableColumns, defaultSort }: DataTableQueryParams
): DataTableQueryResult<T> {
  const { searchParams } = new URL(url);

  const params: Record<string, string | undefined> = {};
  for (const [key, value] of searchParams.entries()) {
    params[key] = value;
  }

  const parsed = parseSearchParams(params, defaultSort);

  // Clamp perPage to MAX_PER_PAGE ceiling
  const safePerPage = Math.min(parsed.perPage, MAX_PER_PAGE);

  // --- Filters ---
  const safeFilters = parsed.filters.filter((f) => allowedColumns.has(f.id));

  const filterWhere =
    safeFilters.length > 0
      ? filterColumns({
          table,
          filters: safeFilters,
          joinOperator: parsed.joinOperator,
        })
      : undefined;

  // --- Quick search (mutually exclusive with filters on the client) ---
  const rawSearch = searchParams.get('search')?.trim() ?? '';
  const search =
    rawSearch.length > 0 && rawSearch.length <= MAX_SEARCH_LENGTH
      ? rawSearch
      : '';

  let searchWhere: SQL | undefined;
  if (search && searchableColumns?.length) {
    const escaped = escapeLike(search);
    const conditions: SQL[] = [];
    for (const colName of searchableColumns) {
      const col = getColumn(table, colName as keyof T);
      if (col) conditions.push(ilike(col as AnyColumn, `%${escaped}%`));
    }
    if (conditions.length > 0) searchWhere = or(...conditions);
  }

  // Combine: filters and search are mutually exclusive on the client,
  // but we handle both defensively with AND.
  const where = and(filterWhere, searchWhere) || filterWhere || searchWhere;

  // --- Sorting ---
  const safeSorts = parsed.sort.filter((s) => allowedColumns.has(s.id));

  function applySorting(t: T) {
    const orderBy: ReturnType<typeof asc>[] = [];
    for (const s of safeSorts) {
      const col = getColumn(t, s.id as keyof T);
      if (col) orderBy.push(s.desc ? desc(col) : asc(col));
    }
    return orderBy;
  }

  const offset = (parsed.page - 1) * safePerPage;

  return {
    where,
    orderBy: applySorting(table),
    limit: safePerPage,
    offset,
    page: parsed.page,
    perPage: safePerPage,
    buildPageCount: (total: number) =>
      Math.max(1, Math.ceil(total / safePerPage)),
    applySorting,
  };
}
