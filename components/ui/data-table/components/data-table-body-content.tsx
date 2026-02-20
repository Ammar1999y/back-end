import type { Table } from '@tanstack/react-table';

import { memo } from 'react';

import { useShallow } from 'zustand/shallow';

import { DataTableSkeleton } from '../skeleton';
import { useColumnPinning, useTableData, useUpdateRows } from '../store';
import { DataTableBodyRow } from './data-table-body-row';
import { DataTableEmptyState } from './data-table-empty-state';
import { DataTableErrorState } from './data-table-error-state';

const getSaveRowLength = (table: Table<any>) => {
  try {
    return table.getRowModel().rows.length;
  } catch {
    return undefined;
  }
};

const TableBodyContent = memo(
  ({
    table,
    isLoading,
    error,
    refetch,
    columnCount,
  }: {
    table: Table<any>;
    isLoading: boolean;
    error: Error | null | undefined;
    refetch: () => void;
    columnCount: number;
  }) => {
    useUpdateRows(useShallow((s) => s.reRender));
    const data = useTableData(useShallow((s) => s.data));
    return data?.length && getSaveRowLength(table) ? (
      <DateTableRows table={table} />
    ) : isLoading ? (
      <DataTableSkeleton table={table} columnCount={columnCount} rowCount={5} />
    ) : error ? (
      <DataTableErrorState error={error || null} refetch={refetch} />
    ) : (
      <DataTableEmptyState />
    );
  }
);

const DateTableRows = memo(({ table }: { table: Table<any> }) => {
  useUpdateRows(useShallow((s) => s.reRender));
  useColumnPinning(useShallow((s) => s.columnPinning));
  return table
    .getRowModel()
    .rows.map((row) => <DataTableBodyRow key={row.id} row={row} />);
});

DateTableRows.displayName = 'DateTableRows';

TableBodyContent.displayName = 'TableBodyContent';

export { TableBodyContent };
