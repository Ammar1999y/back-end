import type { ExtendedColumnFilter, JoinOperator } from '@/types/data-table';
import type { AnyColumn, SQL, Table } from 'drizzle-orm';

import {
  and,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  ne,
  not,
  notIlike,
  notInArray,
  or,
} from 'drizzle-orm';

import { isEmpty } from '@/db/queries';

import { safeDate } from '@/utils/time';

/** Escape SQL LIKE/ILIKE wildcards to prevent wildcard injection */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

export function filterColumns<T extends Table>({
  table,
  filters,
  joinOperator,
}: {
  table: T;
  filters: ExtendedColumnFilter<T>[];
  joinOperator: JoinOperator;
}): SQL | undefined {
  const joinFn = joinOperator === 'and' ? and : or;

  const conditions = filters.map((filter) => {
    const column = safeGetColumn(table, filter.id);
    if (!column) return undefined;

    switch (filter.operator) {
      case 'iLike':
        return filter.variant === 'text' && typeof filter.value === 'string'
          ? ilike(column, `%${escapeLike(filter.value)}%`)
          : undefined;
      case 'endsWith':
        return filter.variant === 'text' && typeof filter.value === 'string'
          ? ilike(column, `%${escapeLike(filter.value)}`)
          : undefined;
      case 'startsWith':
        return filter.variant === 'text' && typeof filter.value === 'string'
          ? ilike(column, `${escapeLike(filter.value)}%`)
          : undefined;
      case 'notILike':
        return filter.variant === 'text' && typeof filter.value === 'string'
          ? notIlike(column, `%${escapeLike(filter.value)}%`)
          : undefined;

      case 'eq':
        if (column.dataType === 'boolean' && typeof filter.value === 'string') {
          return eq(column, filter.value === 'true');
        }
        if (filter.variant === 'date') {
          const date = safeDate(Number(filter.value));
          if (!date) return undefined;
          date.setHours(0, 0, 0, 0);
          const end = new Date(date);
          end.setHours(23, 59, 59, 999);
          return and(gte(column, date), lte(column, end));
        }
        return eq(column, filter.value);

      case 'ne':
        if (column.dataType === 'boolean' && typeof filter.value === 'string') {
          return ne(column, filter.value === 'true');
        }
        if (filter.variant === 'date') {
          const date = safeDate(Number(filter.value));
          if (!date) return undefined;
          date.setHours(0, 0, 0, 0);
          const end = new Date(date);
          end.setHours(23, 59, 59, 999);
          return or(lt(column, date), gt(column, end));
        }
        return ne(column, filter.value);

      case 'inArray':
        if (Array.isArray(filter.value)) {
          return inArray(column, filter.value);
        }
        return undefined;

      case 'notInArray':
        if (Array.isArray(filter.value)) {
          return notInArray(column, filter.value);
        }
        return undefined;

      case 'lt': {
        if (filter.variant === 'number' || filter.variant === 'range')
          return lt(column, filter.value);
        if (filter.variant === 'date' && typeof filter.value === 'string') {
          const date = safeDate(Number(filter.value));
          if (!date) return undefined;
          date.setHours(23, 59, 59, 999);
          return lt(column, date);
        }
        return undefined;
      }

      case 'lte': {
        if (filter.variant === 'number' || filter.variant === 'range')
          return lte(column, filter.value);
        if (filter.variant === 'date' && typeof filter.value === 'string') {
          const date = safeDate(Number(filter.value));
          if (!date) return undefined;
          date.setHours(23, 59, 59, 999);
          return lte(column, date);
        }
        return undefined;
      }

      case 'gt': {
        if (filter.variant === 'number' || filter.variant === 'range')
          return gt(column, filter.value);
        if (filter.variant === 'date' && typeof filter.value === 'string') {
          const date = safeDate(Number(filter.value));
          if (!date) return undefined;
          date.setHours(0, 0, 0, 0);
          return gt(column, date);
        }
        return undefined;
      }

      case 'gte': {
        if (filter.variant === 'number' || filter.variant === 'range')
          return gte(column, filter.value);
        if (filter.variant === 'date' && typeof filter.value === 'string') {
          const date = safeDate(Number(filter.value));
          if (!date) return undefined;
          date.setHours(0, 0, 0, 0);
          return gte(column, date);
        }
        return undefined;
      }

      case 'isBetween':
        if (
          filter.variant === 'date' &&
          Array.isArray(filter.value) &&
          filter.value.length === 2
        ) {
          const start = filter.value[0]
            ? safeDate(Number(filter.value[0]))
            : null;
          const end = filter.value[1]
            ? safeDate(Number(filter.value[1]))
            : null;

          if (start) start.setHours(0, 0, 0, 0);
          if (end) end.setHours(23, 59, 59, 999);

          return and(
            start ? gte(column, start) : undefined,
            end ? lte(column, end) : undefined
          );
        }

        if (
          (filter.variant === 'number' || filter.variant === 'range') &&
          Array.isArray(filter.value) &&
          filter.value.length === 2
        ) {
          const firstValue =
            filter.value[0] && filter.value[0].trim() !== ''
              ? Number(filter.value[0])
              : null;
          const secondValue =
            filter.value[1] && filter.value[1].trim() !== ''
              ? Number(filter.value[1])
              : null;

          if (firstValue === null && secondValue === null) {
            return undefined;
          }

          if (firstValue !== null && secondValue === null) {
            return eq(column, firstValue);
          }

          if (firstValue === null && secondValue !== null) {
            return eq(column, secondValue);
          }

          return and(
            firstValue !== null ? gte(column, firstValue) : undefined,
            secondValue !== null ? lte(column, secondValue) : undefined
          );
        }
        return undefined;

      case 'isEmpty':
        return isEmpty(column);

      case 'isNotEmpty':
        return not(isEmpty(column));

      default:
        return undefined;
    }
  });

  const validConditions = conditions.filter(
    (condition) => condition !== undefined
  );

  return validConditions.length > 0 ? joinFn(...validConditions) : undefined;
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
  const col = table[columnKey as keyof T];
  if (!col || typeof col !== 'object' || !('dataType' in col)) return null;
  return col as unknown as AnyColumn;
}
