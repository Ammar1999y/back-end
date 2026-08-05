import type { FilterColumnSpecs } from '@/lib/data-table/column-specs';
import type { ExtendedColumnSort } from '@/types/data-table';
import type { AnyColumn, SQL, Table } from 'drizzle-orm';

import { and, asc, desc, ilike, or } from 'drizzle-orm';

import {
  escapeLike,
  filterColumns,
  getColumn,
  MSG_INVALID_FILTER,
} from '@/lib/data-table/filter-columns';
import {
  MAX_PER_PAGE,
  MAX_SEARCH_LENGTH,
  MIN_SEARCH_LENGTH,
  parseSearchParams,
} from '@/lib/data-table/parsers';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

interface DataTableQueryParams {
  /**
   * Server-owned descriptors for every filterable/sortable column. Its keys
   * ARE the allowlist — a column with no descriptor can be neither filtered
   * nor sorted, and an unknown one is rejected rather than dropped.
   */
  url: string;
  filterableColumns: FilterColumnSpecs;
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
  {
    url,
    filterableColumns,
    searchableColumns,
    defaultSort,
  }: DataTableQueryParams
): DataTableQueryResult<T> {
  const { searchParams } = new URL(url);

  const params: Record<string, string | undefined> = {};
  for (const [key, value] of searchParams.entries()) {
    params[key] = value;
  }

  // A filter the parser could not read is a client error, not a filter to
  // ignore: dropping it silently broadens an `and` query and narrows an `or`
  // one, so the caller gets rows they never asked for with a 200.
  const parsed = parseSearchParams(params, defaultSort, () => {
    throw new CustomError(MSG_INVALID_FILTER, HTTP_STATUS.UNPROCESSABLE);
  });

  // Clamp perPage to MAX_PER_PAGE ceiling
  const safePerPage = Math.min(parsed.perPage, MAX_PER_PAGE);

  // --- Filters ---
  // Validation lives in `filterColumns`: an unknown column, an operator the
  // column's type can't support, or a sub-trigram search term is a 422, not a
  // silently discarded predicate.
  const filterWhere =
    parsed.filters.length > 0
      ? filterColumns({
          table,
          filters: parsed.filters,
          joinOperator: parsed.joinOperator,
          specs: filterableColumns,
        })
      : undefined;

  // --- Quick search (mutually exclusive with filters on the client) ---
  // An explicitly supplied term outside the accepted length is REJECTED, not
  // ignored. The debounce that makes 1–2 characters a normal in-progress state
  // lives on the client, which already omits the parameter below the trigram
  // floor (`utils/query.ts`) — so a short term arriving here is not a user
  // mid-keystroke, it is a request whose search this endpoint cannot honour.
  // Answering it with unfiltered rows and a 200 is the same fail-open the filter
  // path rejects.
  const rawSearch = searchParams.get('search')?.trim() ?? '';
  if (
    rawSearch.length > 0 &&
    (rawSearch.length < MIN_SEARCH_LENGTH ||
      rawSearch.length > MAX_SEARCH_LENGTH)
  )
    throw new CustomError(MSG_INVALID_FILTER, HTTP_STATUS.UNPROCESSABLE);
  const search = rawSearch;

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
  // Sorting stays lenient: an unknown sort key only changes row ORDER, never
  // which rows are returned, so dropping it can't mislead the caller.
  // `Object.hasOwn`, not `in` — `in` walks the prototype chain, so a sort id of
  // `constructor` would be treated as allowlisted.
  const safeSorts = parsed.sort.filter((s) =>
    Object.hasOwn(filterableColumns, s.id)
  );

  function applySorting(t: T) {
    const orderBy: ReturnType<typeof asc>[] = [];
    for (const s of safeSorts) {
      const col = getColumn(t, s.id as keyof T);
      if (col) orderBy.push(s.desc ? desc(col) : asc(col));
    }
    // Deterministic tiebreaker: append the unique primary key so rows sharing
    // a sort value (low-cardinality columns like isActive/scope, or createdAt
    // stored at centisecond precision) keep a stable order across LIMIT/OFFSET
    // pages — without it a tied row can be skipped or shown twice between
    // pages. UUID v7 is time-sortable, so desc(id) aligns with the createdAt
    // desc default. Skipped if the caller already sorts by id.
    if (!safeSorts.some((s) => s.id === 'id')) {
      const idCol = getColumn(t, 'id' as keyof T);
      if (idCol) orderBy.push(desc(idCol));
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
