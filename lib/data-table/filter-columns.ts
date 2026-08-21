import type { FilterColumnSpec, FilterColumnSpecs } from './column-specs';
import type { ExtendedColumnFilter, JoinOperator } from '@/types/data-table';
import type { AnyColumn, SQL, Table } from 'drizzle-orm';

import {
  and,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  notIlike,
  notInArray,
  or,
} from 'drizzle-orm';

import { isEmpty } from '@/db/queries';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import { toCalendarDate, zonedDayStart, zonedNextDayStart } from '@/utils/time';

import {
  isArrayValueOperator,
  isNoValueOperator,
  isScanOnlyOperator,
  isSearchOperator,
  operatorAllowedForType,
} from './column-specs';
import { MIN_SEARCH_LENGTH } from './parsers';

export const MSG_INVALID_FILTER = 'أحد عوامل التصفية غير صالح، أعد ضبط التصفية';
const MSG_SHORT_SEARCH = `نص البحث في التصفية يجب أن يكون ${MIN_SEARCH_LENGTH} أحرف على الأقل`;

/**
 * Reject instead of silently dropping. A dropped filter does not merely
 * "ignore" the client's request — under `and` it broadens the result set and
 * under `or` it narrows it, so the caller is shown data they did not ask for
 * while receiving a 200.
 */
function invalidFilter(message = MSG_INVALID_FILTER): never {
  throw new CustomError(message, HTTP_STATUS.UNPROCESSABLE);
}

const STRING_LIKE_TYPES: ReadonlySet<FilterColumnSpec['type']> = new Set([
  'text',
  'select',
  'multiSelect',
]);

/**
 * Types whose column can actually hold an empty string. ⚠️ `select` /
 * `multiSelect` name a value set, not a storage type — every registered one is
 * text today. Backing one with a PostgreSQL enum makes `isEmpty` generate
 * `enum_column = ''`, a cast error; carry the DB type on the descriptor first.
 */
function isStringLike(type: FilterColumnSpec['type']): boolean {
  return STRING_LIKE_TYPES.has(type);
}

function safeNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/** Escape SQL LIKE/ILIKE wildcards to prevent wildcard injection */
export function escapeLike(value: string): string {
  return value.replaceAll(/[%_\\]/g, String.raw`\$&`);
}

/** Half-open UTC bounds for one calendar day in the business timezone. */
function dayBounds(raw: unknown): { start: Date; next: Date } {
  const calendarDate = toCalendarDate(raw);
  if (!calendarDate) invalidFilter();
  const start = zonedDayStart(calendarDate);
  const next = zonedNextDayStart(calendarDate);
  if (!start || !next) invalidFilter();
  return { start, next };
}

/**
 * Validate one filter against its column descriptor. Runs before any SQL is
 * built so an impossible combination becomes a 422, never a PostgreSQL cast
 * error surfacing as a 500.
 */
function assertFilterAllowed(
  filter: ExtendedColumnFilter<Table>,
  spec: FilterColumnSpec
): 'apply' | 'skip' {
  if (!operatorAllowedForType(spec.type, filter.operator)) invalidFilter();

  if (isNoValueOperator(filter.operator)) return 'apply';

  const valueIsArray = Array.isArray(filter.value);
  if (isArrayValueOperator(filter.operator) !== valueIsArray) invalidFilter();

  // `isBetween` is a fixed [lower, upper] pair. A third slot used to be read as
  // far as index 1 and the rest ignored, so `['1','2','3']` answered a question
  // nobody asked with a 200 instead of reporting the malformed range.
  if (
    filter.operator === 'isBetween' &&
    (filter.value as string[]).length !== 2
  )
    invalidFilter();

  // No value chosen yet — not an invalid filter, an unexpressed one. The
  // parse layer already drops empty scalars for the same reason; treating the
  // array case differently would 422 the whole list on a half-filled chip.
  // Checked on content, not length: positional slots mean a cleared range
  // arrives as ['', ''] rather than [].
  //
  // Not the dropped-predicate case elsewhere in this file: there a real
  // condition vanished; an empty set was never a condition.
  if (valueIsArray && !(filter.value as string[]).some(Boolean)) return 'skip';

  if (isScanOnlyOperator(filter.operator) && !spec.allowScanOnly)
    invalidFilter();

  if (isSearchOperator(filter.operator)) {
    if (typeof filter.value !== 'string') invalidFilter();
    const min = spec.minSearchLength ?? MIN_SEARCH_LENGTH;
    if (filter.value.length < min) invalidFilter(MSG_SHORT_SEARCH);
  }

  return 'apply';
}

function buildCondition(
  column: AnyColumn,
  filter: ExtendedColumnFilter<Table>,
  spec: FilterColumnSpec
): SQL | undefined {
  const value = filter.value;

  switch (filter.operator) {
    case 'iLike': {
      return ilike(column, `%${escapeLike(value as string)}%`);
    }
    case 'notILike': {
      return notIlike(column, `%${escapeLike(value as string)}%`);
    }
    case 'startsWith': {
      return ilike(column, `${escapeLike(value as string)}%`);
    }
    case 'endsWith': {
      return ilike(column, `%${escapeLike(value as string)}`);
    }

    case 'eq':
    case 'ne': {
      const negated = filter.operator === 'ne';

      if (spec.type === 'boolean') {
        const bool = parseBoolean(value);
        if (bool === null) invalidFilter();
        return negated ? ne(column, bool) : eq(column, bool);
      }
      if (spec.type === 'date') {
        const { start, next } = dayBounds(value);
        return negated
          ? or(lt(column, start), gte(column, next))
          : and(gte(column, start), lt(column, next));
      }
      if (spec.type === 'number') {
        const num = safeNumber(value);
        if (num === null) invalidFilter();
        return negated ? ne(column, num) : eq(column, num);
      }
      return negated ? ne(column, value) : eq(column, value);
    }

    case 'inArray':
    case 'notInArray': {
      const negated = filter.operator === 'notInArray';
      // Set semantics: empty positional slots carry no meaning here.
      const values = (value as string[]).filter(Boolean);
      if (values.length === 0) invalidFilter();

      if (spec.type === 'boolean') {
        const bools = values.map(parseBoolean);
        if (bools.includes(null)) invalidFilter();
        return negated
          ? notInArray(column, bools as boolean[])
          : inArray(column, bools as boolean[]);
      }
      if (spec.type === 'number') {
        const nums = values.map(safeNumber);
        if (nums.includes(null)) invalidFilter();
        return negated
          ? notInArray(column, nums as number[])
          : inArray(column, nums as number[]);
      }
      return negated ? notInArray(column, values) : inArray(column, values);
    }

    // Comparison operators. For dates the labels are calendar-relative:
    // "before X" excludes X's day, "on or before X" includes all of it.
    case 'lt': {
      if (spec.type === 'date') return lt(column, dayBounds(value).start);
      return compareNumber(column, value, lt);
    }
    case 'lte': {
      if (spec.type === 'date') return lt(column, dayBounds(value).next);
      return compareNumber(column, value, lte);
    }
    case 'gt': {
      if (spec.type === 'date') return gte(column, dayBounds(value).next);
      return compareNumber(column, value, gt);
    }
    case 'gte': {
      if (spec.type === 'date') return gte(column, dayBounds(value).start);
      return compareNumber(column, value, gte);
    }

    case 'isBetween': {
      const [rawStart, rawEnd] = value as string[];

      if (spec.type === 'date') {
        const from = rawStart ? dayBounds(rawStart).start : null;
        const to = rawEnd ? dayBounds(rawEnd).next : null;
        if (!from && !to) invalidFilter();
        return and(
          from ? gte(column, from) : undefined,
          to ? lt(column, to) : undefined
        );
      }

      const from = rawStart?.trim() ? safeNumber(rawStart) : null;
      const to = rawEnd?.trim() ? safeNumber(rawEnd) : null;
      if (from === null && to === null) invalidFilter();
      return and(
        from === null ? undefined : gte(column, from),
        to === null ? undefined : lte(column, to)
      );
    }

    // `isEmpty` compares against '' and casts to text, which PostgreSQL
    // rejects outright on boolean/timestamp/numeric columns ("invalid input
    // syntax for type boolean: \"\"") — a 500, not a filter. For those types
    // the only meaningful emptiness is NULL.
    case 'isEmpty': {
      return isStringLike(spec.type) ? isEmpty(column) : isNull(column);
    }
    case 'isNotEmpty': {
      return isStringLike(spec.type) ? not(isEmpty(column)) : isNotNull(column);
    }

    default: {
      return invalidFilter();
    }
  }
}

function compareNumber(
  column: AnyColumn,
  value: unknown,
  op: typeof lt | typeof lte | typeof gt | typeof gte
): SQL {
  const num = safeNumber(value);
  if (num === null) invalidFilter();
  return op(column, num);
}

export function filterColumns<T extends Table>({
  table,
  filters,
  joinOperator,
  specs,
}: {
  table: T;
  filters: ExtendedColumnFilter<T>[];
  joinOperator: JoinOperator;
  /** Server-owned descriptors; a column without one is not filterable. */
  specs: FilterColumnSpecs;
}): SQL | undefined {
  const joinFn = joinOperator === 'and' ? and : or;

  const conditions: SQL[] = [];
  for (const filter of filters) {
    // `Object.hasOwn`, not `specs[id]`: the column id is attacker-controlled,
    // and a plain object resolves inherited members. `constructor`,
    // `toString`, `hasOwnProperty` and `__proto__` all return a truthy value,
    // slip past the unknown-column check, and then blow up further down as a
    // 500 — the exact defect this validator exists to remove.
    const spec = Object.hasOwn(specs, filter.id) ? specs[filter.id] : undefined;
    if (!spec) invalidFilter();

    const column = safeGetColumn(table, filter.id);
    // A descriptor without a matching column is a server-side mismatch, not
    // something the client did — surface it as 500, not 422.
    if (!column)
      throw new Error(`Filterable column "${filter.id}" is not on the table`);

    const decision = assertFilterAllowed(
      filter as ExtendedColumnFilter<Table>,
      spec
    );
    if (decision === 'skip') continue;

    const condition = buildCondition(
      column,
      filter as ExtendedColumnFilter<Table>,
      spec
    );
    if (condition) conditions.push(condition);
  }

  return conditions.length > 0 ? joinFn(...conditions) : undefined;
}

export function getColumn<T extends Table>(
  table: T,
  columnKey: keyof T
): AnyColumn | null {
  return safeGetColumn(table, columnKey as string);
}

/** Returns the column if it exists on the table, otherwise null */
function safeGetColumn<T extends Table>(
  table: T,
  columnKey: string
): AnyColumn | null {
  // Client-supplied key: a plain lookup resolves inherited members.
  if (!Object.hasOwn(table, columnKey)) return null;
  const col = table[columnKey as keyof T];
  if (!col || typeof col !== 'object' || !('dataType' in col)) return null;
  return col as unknown as AnyColumn;
}
