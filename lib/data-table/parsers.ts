import type {
  ExtendedColumnFilter,
  ExtendedColumnSort,
  FilterOperator,
  FilterVariant,
  JoinOperator,
} from '@/types/data-table';

import { positiveInt } from '@/utils';

import { dataTableConfig } from './config';

const MAX_RAW_LENGTH = 4096;
const MAX_ID_LENGTH = 64;
const MAX_VALUE_LENGTH = 512;
const MAX_SORT_ITEMS = 10;
const MAX_FILTER_ITEMS = 20;

const validOperators = new Set<string>(dataTableConfig.operators);
const validVariants = new Set<string>(dataTableConfig.filterVariants);

/** Coerce any value to a trimmed string, or null if invalid/empty */
function safeString(v: unknown, maxLen: number): string | null {
  if (typeof v === 'string') {
    const trimmed = v.trim();
    return trimmed.length > 0 && trimmed.length <= maxLen ? trimmed : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    const str = String(v);
    return str.length <= maxLen ? str : null;
  }
  return null;
}

function toKeySet(
  columnIds: string[] | Set<string> | undefined
): Set<string> | null {
  if (!columnIds) return null;
  return columnIds instanceof Set ? columnIds : new Set(columnIds);
}

// ─── Sorting ────────────────────────────────────────────────────────

interface ParsedSortItem {
  id: string;
  desc: boolean;
}

function parseSortItem(raw: unknown): ParsedSortItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const id = safeString(obj.id, MAX_ID_LENGTH);
  if (!id) return null;
  if (typeof obj.desc !== 'boolean') return null;

  return { id, desc: obj.desc };
}

export function parseSortingState<TData>(
  value: string | null | undefined,
  columnIds?: string[] | Set<string>
): ExtendedColumnSort<TData>[] {
  if (!value || value.length > MAX_RAW_LENGTH) return [];

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    const validKeys = toKeySet(columnIds);
    const items: ExtendedColumnSort<TData>[] = [];

    for (const raw of parsed.slice(0, MAX_SORT_ITEMS)) {
      const item = parseSortItem(raw);
      if (!item) continue;
      if (validKeys && !validKeys.has(item.id)) continue;
      items.push(item as ExtendedColumnSort<TData>);
    }

    return items;
  } catch {
    return [];
  }
}

// ─── Filters ────────────────────────────────────────────────────────

export interface FilterItemSchema {
  id: string;
  value: string | string[];
  variant: FilterVariant;
  operator: FilterOperator;
  filterId: string;
}

/** Sanitize a single value string, returning null if invalid */
function safeValue(v: unknown): string | null {
  return safeString(v, MAX_VALUE_LENGTH) || null;
}

function parseFilterItem(raw: unknown): FilterItemSchema | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const id = safeString(obj.id, MAX_ID_LENGTH);
  const filterId = safeString(obj.filterId, MAX_ID_LENGTH);
  if (
    !id ||
    !filterId ||
    typeof obj.variant !== 'string' ||
    !validVariants.has(obj.variant) ||
    typeof obj.operator !== 'string' ||
    !validOperators.has(obj.operator)
  )
    return null;

  // Value: string or string[]
  let value: string | string[];

  if (Array.isArray(obj.value)) {
    const arr: string[] = [];
    for (const item of obj.value.slice(0, MAX_FILTER_ITEMS)) {
      const s = safeValue(item);
      if (s) arr.push(s);
    }
    value = arr;
  } else {
    const s = safeValue(obj.value);
    if (s === null) return null;
    value = s;
  }

  return {
    id,
    value,
    variant: obj.variant as FilterVariant,
    operator: obj.operator as FilterOperator,
    filterId,
  };
}

export function parseFiltersState<TData>(
  value: string | null | undefined,
  columnIds?: string[] | Set<string>
): ExtendedColumnFilter<TData>[] {
  if (!value || value.length > MAX_RAW_LENGTH * 2) return [];

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    const validKeys = toKeySet(columnIds);
    const items: ExtendedColumnFilter<TData>[] = [];

    for (const raw of parsed.slice(0, MAX_FILTER_ITEMS)) {
      const item = parseFilterItem(raw);
      if (!item) continue;
      if (validKeys && !validKeys.has(item.id)) continue;
      items.push(item as ExtendedColumnFilter<TData>);
    }

    return items;
  } catch {
    return [];
  }
}

// ─── Search Params ──────────────────────────────────────────────────

export const MAX_PAGE = 10_000;
export const MAX_PER_PAGE = 100;

export interface GetDataSchema<T = any> {
  page: number;
  perPage: number;
  sort: ExtendedColumnSort<T>[];
  filters: ExtendedColumnFilter<T>[];
  joinOperator: JoinOperator;
  maxPerPage?: number;
}

/** Extract a single string value from params, ignoring arrays */
function safeParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

export function parseSearchParams<T = any>(
  params: Record<string, string | string[] | undefined>,
  defaultSort?: ExtendedColumnSort<T>
): GetDataSchema<T> {
  const maxPerPage =
    positiveInt(params.maxPerPage, MAX_PER_PAGE) || MAX_PER_PAGE;
  const page = positiveInt(params.page, MAX_PAGE) || 1;
  const perPage = positiveInt(params.perPage, maxPerPage) || 10;

  const sort = parseSortingState<T>(safeParam(params.sort));
  const filters = parseFiltersState<T>(safeParam(params.filters));

  const joinOperatorRaw = safeParam(params.joinOperator);
  const joinOperator: JoinOperator = joinOperatorRaw === 'or' ? 'or' : 'and';

  return {
    page,
    perPage,
    sort:
      sort.length > 0
        ? sort
        : [
            defaultSort ||
              ({ id: 'createdAt', desc: true } as ExtendedColumnSort<T>),
          ],
    filters,
    joinOperator,
  };
}
