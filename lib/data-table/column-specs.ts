import type { FilterOperator } from '@/types/data-table';

import { dataTableConfig } from './config';

/**
 * Server-owned description of what may be filtered, and how.
 *
 * The client sends `{ id, variant, operator, value }` and each part used to be
 * validated independently — so a text operator could reach a boolean or
 * timestamp column and produce an invalid PostgreSQL cast (a deterministic
 * 500 any authorized caller could trigger), and short `ILIKE` patterns could
 * force repeated sequential scans that quick search already refuses.
 *
 * These descriptors bind column -> DB type -> allowed operators -> value rules
 * in one place, on the server, where the client can't influence them.
 *
 * `variant` is deliberately NOT bound here: it describes how the CLIENT renders
 * a control, is validated for membership in `parsers.ts` and then never read,
 * so it reaches no SQL. `type` below is the only authority.
 */

export type FilterColumnType =
  'text' | 'number' | 'boolean' | 'date' | 'select' | 'multiSelect';

/** The types whose members are NOT enumerable up front. */
type OpenColumnType = 'text' | 'number' | 'boolean' | 'date';
/** The types that name a value set rather than a storage type. */
type ClosedColumnType = 'select' | 'multiSelect';

interface FilterColumnSpecBase {
  /**
   * Minimum input length for substring-search operators. Below the trigram
   * length pg_trgm's GIN index can't be used and the predicate degrades to a
   * full scan — the same floor quick search applies. The length is a proxy;
   * `isTrigramIndexable` is the property, and applies on top of this.
   */
  minSearchLength?: number;
  /**
   * Allow operators that can never use an index (`notILike`). Off by default:
   * up to MAX_FILTER_ITEMS of them multiply into a very expensive query.
   */
  allowScanOnly?: boolean;
}

/**
 * A union, not one optional field, because `values` is not optional where it
 * matters and the type has to say so.
 *
 * `select` / `multiSelect` name a VALUE SET; in this codebase that set is
 * always a PostgreSQL enum or a closed lookup. Without `values` the validator
 * has nothing to check membership against, so it admitted any string and the
 * column was treated as string-like — which made `isEmpty` emit
 * `enum_column = ''`, a `22P02` cast error surfacing as a 500 that any
 * authorized caller could trigger. Every registered spec already supplies the
 * set; this is what stops the next one from forgetting.
 */
export type FilterColumnSpec =
  | (FilterColumnSpecBase & {
      /** Actual database type of the column. Drives coercion and operators. */
      type: OpenColumnType;
      /** Not applicable: these types have no enumerable member set. */
      values?: undefined;
    })
  | (FilterColumnSpecBase & {
      type: ClosedColumnType;
      /**
       * The closed set this column can hold. Membership is checked before any
       * SQL is built, so an unknown member is a 422 rather than a PostgreSQL
       * cast error, and `''` is never one of them — emptiness is NULL.
       */
      values: readonly string[];
    });

export type FilterColumnSpecs = Record<string, FilterColumnSpec>;

const toOperatorSet = (
  entries: ReadonlyArray<{ value: FilterOperator }>
): ReadonlySet<FilterOperator> => new Set(entries.map((e) => e.value));

/**
 * Operators offered by the UI for each variant — the single source of truth is
 * `dataTableConfig`, so server and client can't drift apart.
 */
const OPERATORS_BY_TYPE: Record<
  FilterColumnType,
  ReadonlySet<FilterOperator>
> = {
  text: toOperatorSet(dataTableConfig.textOperators),
  number: toOperatorSet(dataTableConfig.numericOperators),
  date: toOperatorSet(dataTableConfig.dateOperators),
  // A boolean column is rendered as a multiSelect of 'true'/'false' in some
  // tables, so it accepts both the boolean and the multi-select operators.
  boolean: new Set([
    ...toOperatorSet(dataTableConfig.booleanOperators),
    ...toOperatorSet(dataTableConfig.multiSelectOperators),
  ]),
  select: toOperatorSet(dataTableConfig.selectOperators),
  multiSelect: toOperatorSet(dataTableConfig.multiSelectOperators),
};

/** Operators whose value is an array. */
const ARRAY_VALUE_OPERATORS = new Set<FilterOperator>([
  'inArray',
  'notInArray',
  'isBetween',
]);

/** Operators that take no value at all. */
const NO_VALUE_OPERATORS = new Set<FilterOperator>(['isEmpty', 'isNotEmpty']);

/** Substring searches that need the trigram floor. */
const SEARCH_OPERATORS = new Set<FilterOperator>([
  'iLike',
  'notILike',
  'startsWith',
  'endsWith',
]);

/** Operators PostgreSQL can never satisfy from an index. */
const SCAN_ONLY_OPERATORS = new Set<FilterOperator>(['notILike']);

export function isArrayValueOperator(operator: FilterOperator): boolean {
  return ARRAY_VALUE_OPERATORS.has(operator);
}

export function isNoValueOperator(operator: FilterOperator): boolean {
  return NO_VALUE_OPERATORS.has(operator);
}

export function isSearchOperator(operator: FilterOperator): boolean {
  return SEARCH_OPERATORS.has(operator);
}

export function isScanOnlyOperator(operator: FilterOperator): boolean {
  return SCAN_ONLY_OPERATORS.has(operator);
}

export function operatorAllowedForType(
  type: FilterColumnType,
  operator: FilterOperator
): boolean {
  return OPERATORS_BY_TYPE[type].has(operator);
}

/**
 * Operators one DESCRIPTOR accepts, in the order the UI offers them.
 *
 * Keyed on the spec rather than the type alone because `allowScanOnly` removes
 * operators from a column of an otherwise identical type: `notILike` is offered
 * on `users.name` and refused with a 422 on `media.displayName`. A list built
 * from the type alone would publish the second as available.
 */
export function operatorsForSpec(
  spec: FilterColumnSpec
): readonly FilterOperator[] {
  return [...OPERATORS_BY_TYPE[spec.type]].filter(
    (operator) => spec.allowScanOnly || !isScanOnlyOperator(operator)
  );
}

/**
 * The filter contract of one descriptor map, as published prose.
 *
 * Derived, never transcribed. The route table used to carry a hand-written list
 * of allowed ids per route, maintained separately from the map the handler
 * actually passes to `parseDataTableParams` — two sources of truth for one
 * allowlist, with nothing to notice when a column was added to one and not the
 * other. Operators and closed-set members were not published at all, so a
 * generated client could offer `iLike` on a timestamp and read the 422 as a
 * server fault.
 */
export function describeFilterColumns(
  specs: FilterColumnSpecs,
  defaultMinSearchLength: number
): string {
  return Object.entries(specs)
    .map(([id, spec]) => {
      const parts: string[] = [spec.type];
      if (spec.values) parts.push(`one of ${spec.values.join('|')}`);
      const floor = spec.minSearchLength ?? defaultMinSearchLength;
      if (operatorsForSpec(spec).some(isSearchOperator))
        parts.push(
          `substring searches need ${floor}+ characters including letters or digits the trigram index can key on`
        );
      parts.push(`operators: ${operatorsForSpec(spec).join(', ')}`);
      return `\`${id}\` (${parts.join('; ')})`;
    })
    .join('. ');
}

/** Just the ids, for the parameters that take no operator. */
export function filterColumnIds(specs: FilterColumnSpecs): string {
  return Object.keys(specs)
    .map((id) => `\`${id}\``)
    .join(', ');
}
