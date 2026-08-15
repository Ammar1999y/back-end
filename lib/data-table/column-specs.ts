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

export interface FilterColumnSpec {
  /** Actual database type of the column. Drives coercion and operators. */
  type: FilterColumnType;
  /**
   * Minimum input length for substring-search operators. Below the trigram
   * length pg_trgm's GIN index can't be used and the predicate degrades to a
   * full scan — the same floor quick search applies.
   */
  minSearchLength?: number;
  /**
   * Allow operators that can never use an index (`notILike`). Off by default:
   * up to MAX_FILTER_ITEMS of them multiply into a very expensive query.
   */
  allowScanOnly?: boolean;
}

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
