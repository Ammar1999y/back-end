import type { Column, FilterFn, Table } from '@tanstack/react-table';

export type ColumnMeta = {
  title: string;
  filterType?: 'search' | 'select';
  filterVariant?: 'text' | 'dateRange' | 'number' | 'numberRange' | 'select';
  options?: { label: string; value: string }[];
};

export interface SearchableColumn {
  id: string;
  label: string;
  filterVariant: 'text' | 'dateRange' | 'number' | 'numberRange';
  column: Column<any, unknown> | null;
}

export interface SelectFilter {
  column: Column<any, unknown>;
  columnId: string;
  title: string;
}

export const getSearchableColumns = <TData>(
  table: Table<TData>
): SearchableColumn[] => {
  return table
    .getAllColumns()
    .filter((column) => {
      const meta = column.columnDef.meta as ColumnMeta | undefined;
      return meta?.filterType === 'search' && meta?.filterVariant !== 'select';
    })
    .map((column) => ({
      id: column.id,
      label: (column.columnDef.meta as ColumnMeta)?.title || column.id,
      filterVariant:
        (column.columnDef.meta as ColumnMeta)?.filterVariant || 'text',
      column,
    })) as SearchableColumn[];
};

export const getSelectFilters = <TData>(
  table: Table<TData>
): SelectFilter[] => {
  return table
    .getAllColumns()
    .filter((column) => {
      const meta = column.columnDef.meta as ColumnMeta | undefined;
      return meta?.filterType === 'select';
    })
    .map((column) => ({
      column,
      columnId: column.id,
      title: (column.columnDef.meta as ColumnMeta)?.title || column.id,
    }));
};

export const getAvailableSearchColumns = (
  searchableColumns: SearchableColumn[],
  globalSearch: boolean
): SearchableColumn[] => {
  return globalSearch
    ? [
        {
          id: 'all',
          label: 'الكل',
          filterVariant: 'text' as const,
          column: null,
        },
        ...searchableColumns,
      ]
    : searchableColumns;
};

export const dateBetweenFilterFn: FilterFn<any> = (row, columnId, value) => {
  const date = row.getValue(columnId) as string;
  if (!date) return false;
  const [start, end] = value ?? [];
  if (!start && !end) return true;

  const rowDate = new Date(date);
  if (start && !end) return rowDate >= new Date(start);
  else if (!start && end) return rowDate <= new Date(end);
  else if (start && end)
    return rowDate >= new Date(start) && rowDate <= new Date(end);
  return true;
};
