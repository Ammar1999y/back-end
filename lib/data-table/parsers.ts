import type {
  ExtendedColumnFilter,
  ExtendedColumnSort,
  FilterOperator,
  FilterVariant,
  JoinOperator,
} from '@/types/data-table';

import { OUT_OF_RANGE, positiveInt } from '@/utils';

import { dataTableConfig } from './config';

export const MAX_SORT_RAW_LENGTH = 4096;
/** Filters carry values, so they get a larger raw budget than sorts. */
export const MAX_FILTERS_RAW_LENGTH = MAX_SORT_RAW_LENGTH * 2;
const MAX_ID_LENGTH = 64;
const MAX_VALUE_LENGTH = 512;
const MAX_SORT_ITEMS = 10;
const MAX_FILTER_ITEMS = 20;
/** Values inside one filter (`inArray` selections, range tuples). */
const MAX_FILTER_VALUES = 20;

const validOperators = new Set<string>(dataTableConfig.operators);
const VALID_JOIN_OPERATORS = new Set<string>(['and', 'or']);

/**
 * Trigram floor for quick search / text filter operators. Declared here — the
 * only data-table module both the browser and the server can import — so the
 * client can honour the same bound without pulling the db layer into its
 * bundle.
 */
export const MIN_SEARCH_LENGTH = 3;
export const MAX_SEARCH_LENGTH = 200;
const validVariants = new Set<string>(dataTableConfig.filterVariants);
/** Operators that are complete without a value. */
const VALUELESS_OPERATORS = new Set<string>(['isEmpty', 'isNotEmpty']);

const CONTROL_CHARACTERS = /\p{Cc}/gu;

/** Coerce any value to a trimmed string, or null if invalid/empty */
function safeString(v: unknown, maxLen: number): string | null {
  if (typeof v === 'string') {
    const trimmed = v.replaceAll(CONTROL_CHARACTERS, '').trim();
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

/**
 * `JSON.parse` in the narrowest possible `try`, returning `null` for anything
 * that is not a JSON array.
 *
 * Nothing caller-supplied may run inside that `try`. When the reporting callback
 * was invoked from within it, the 422 it throws was caught by the parser's own
 * `catch`, which then called the callback a second time — and the once-guard
 * refused that second call, so the request fell through to an empty filter list
 * and an unfiltered 200. A guard meant to stop double-counting turned an
 * intended rejection into a silent success; the `try` being wide enough to catch
 * our own control flow is the actual defect.
 */
function parseJsonArray(value: string): unknown[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

function parseSortingState<TData>(
  value: string | null | undefined,
  columnIds?: string[] | Set<string>,
  /**
   * Reports a MALFORMED or over-cap sort, for the same reason filters report
   * one. Dropping a sort is not cosmetic under pagination: it changes which
   * rows land on page one, so a request whose ordering was silently discarded
   * returns a different result set from the one that was asked for.
   *
   * An unknown column id is deliberately NOT reported — a renamed column in a
   * bookmarked URL is a compatibility case, and the caller decides that
   * separately (see `parseDataTableParams`).
   */
  onDropped?: () => void
): ExtendedColumnSort<TData>[] {
  if (!value) return [];
  if (value.length > MAX_SORT_RAW_LENGTH) {
    onDropped?.();
    return [];
  }

  const parsed = parseJsonArray(value);
  if (!parsed) {
    onDropped?.();
    return [];
  }

  const validKeys = toKeySet(columnIds);
  const items: ExtendedColumnSort<TData>[] = [];

  if (parsed.length > MAX_SORT_ITEMS) onDropped?.();

  for (const raw of parsed.slice(0, MAX_SORT_ITEMS)) {
    const item = parseSortItem(raw);
    if (!item) {
      onDropped?.();
      continue;
    }
    if (validKeys && !validKeys.has(item.id)) continue;
    items.push(item as ExtendedColumnSort<TData>);
  }

  return items;
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

/**
 * Positions are preserved, empty slots included: `isBetween` reads
 * `[lower, upper]` positionally, so compacting turned an upper-only range ("up
 * to X") into a lower bound ("from X") — an inverted filter, not a narrower
 * one. Operators with set semantics (`inArray`) drop the empty slots
 * themselves.
 *
 * A member that is PRESENT but uncoercible (an object, an over-long string)
 * invalidates the whole filter instead of becoming `''`. Coercing it produced an
 * all-empty array, which the validator then classified as an unexpressed filter
 * and skipped — so malformed input still ended up as no predicate and a 200.
 * Over-length is rejected for the same reason, not truncated.
 */
function safeArrayValue(raw: unknown[]): string[] | null {
  if (raw.length > MAX_FILTER_VALUES) return null;
  const values: string[] = [];
  for (const item of raw) {
    // ONLY the empty string is a legitimate cleared slot. `null` and
    // `undefined` were folded into it as well, which is how `[null]` became
    // `['']` — an array the validator then read as an unexpressed filter and
    // skipped, so malformed input still produced an unfiltered 200. No UI emits
    // them: the range inputs build their tuple from a helper that returns `''`.
    if (item === '') {
      values.push('');
      continue;
    }
    const value = safeValue(item);
    if (value === null) return null;
    values.push(value);
  }
  return values;
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
    const values = safeArrayValue(obj.value);
    if (!values) return null;
    value = values;
  } else {
    const s = safeValue(obj.value);
    // isEmpty / isNotEmpty carry no value by definition — the UI submits an
    // empty string for them. Dropping the whole filter on an empty value made
    // those two operators permanently unreachable.
    if (s === null) {
      if (!VALUELESS_OPERATORS.has(obj.operator)) return null;
      value = '';
    } else {
      value = s;
    }
  }

  return {
    id,
    value,
    variant: obj.variant as FilterVariant,
    operator: obj.operator as FilterOperator,
    filterId,
  };
}

function parseFiltersState<TData>(
  value: string | null | undefined,
  columnIds?: string[] | Set<string>,
  /**
   * Called once per discarded item. The client leaves this unset and stays
   * lenient; the server passes a handler that rejects, because a malformed
   * filter silently vanishing here never reached the strict validator and came
   * back as an unfiltered 200 instead of a 422.
   */
  onDropped?: () => void
): ExtendedColumnFilter<TData>[] {
  if (!value) return [];
  // Over the raw cap the whole predicate set vanished without a word — the one
  // discard path that skipped `onDropped`, so the request the server was meant
  // to reject came back as an unfiltered 200.
  if (value.length > MAX_FILTERS_RAW_LENGTH) {
    onDropped?.();
    return [];
  }

  const parsed = parseJsonArray(value);
  if (!parsed) {
    onDropped?.();
    return [];
  }

  const validKeys = toKeySet(columnIds);
  const items: ExtendedColumnFilter<TData>[] = [];

  // Report the overflow, then parse the first N. Truncating a filter list is
  // not a safe default: dropping an `and` condition widens the result set.
  if (parsed.length > MAX_FILTER_ITEMS) onDropped?.();

  for (const raw of parsed.slice(0, MAX_FILTER_ITEMS)) {
    const item = parseFilterItem(raw);
    if (!item) {
      onDropped?.();
      continue;
    }
    if (validKeys && !validKeys.has(item.id)) {
      onDropped?.();
      continue;
    }
    items.push(item as ExtendedColumnFilter<TData>);
  }

  return items;
}

// ─── Search Params ──────────────────────────────────────────────────

export const MAX_PAGE = 10_000;
export const MAX_PER_PAGE = 100;

export interface GetDataSchema<T = Record<string, unknown>> {
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

/**
 * Every top-level key this parser reads.
 *
 * Exported so the caller that owns the URL can refuse the ones it does NOT
 * read. A misspelled `filtres` was accepted and ignored, and the response was a
 * broad 200 that looked like a filtered result — the same failure the
 * `onFilterDropped` contract exists to prevent, arriving one layer earlier.
 */
export const DATA_TABLE_PARAM_KEYS = new Set([
  'maxPerPage',
  'page',
  'perPage',
  'sort',
  'filters',
  'joinOperator',
]);

export function parseSearchParams<T = Record<string, unknown>>(
  params: Record<string, string | string[] | undefined>,
  defaultSort?: ExtendedColumnSort<T>,
  onFilterDropped?: () => void
): GetDataSchema<T> {
  // Reported at most once per request. A throwing handler exits on the first
  // call anyway, but a counting or logging one was invoked several times for a
  // single malformed parameter.
  let reported = false;
  const reportOnce = onFilterDropped
    ? () => {
        if (reported) return;
        reported = true;
        onFilterDropped();
      }
    : undefined;

  // Absent and unreadable are different answers. `positiveInt` returns 0 for
  // both, so `?perPage=abc` and `?page=` used to serve the DEFAULT page size
  // with a 200 — indistinguishable from a request that asked for no page size
  // at all, and a caller who mistyped a bound got rows they never asked for.
  const boundedInt = (
    raw: string | string[] | undefined,
    maxValue: number,
    fallback: number
  ): number => {
    const supplied = safeParam(raw);
    const parsed = positiveInt(supplied, maxValue);
    if (parsed === OUT_OF_RANGE || (supplied !== null && parsed === 0)) {
      reportOnce?.();
      return fallback;
    }
    return parsed || fallback;
  };

  const maxPerPage = boundedInt(params.maxPerPage, MAX_PER_PAGE, MAX_PER_PAGE);
  const page = boundedInt(params.page, MAX_PAGE, 1);
  const perPage = boundedInt(params.perPage, maxPerPage, 10);

  const sort = parseSortingState<T>(
    safeParam(params.sort),
    undefined,
    reportOnce
  );
  const filters = parseFiltersState<T>(
    safeParam(params.filters),
    undefined,
    reportOnce
  );

  // `and` is the default when absent, but anything else supplied is a client
  // error, not a synonym for `and`: silently switching `or` semantics to `and`
  // returns a different row set from the one that was requested.
  const joinOperatorRaw = safeParam(params.joinOperator);
  if (joinOperatorRaw !== null && !VALID_JOIN_OPERATORS.has(joinOperatorRaw))
    reportOnce?.();
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
