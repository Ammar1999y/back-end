import type { Row } from '@tanstack/react-table';

import { memo } from 'react';

import { useShallow } from 'zustand/react/shallow';

import {
  useColumnOrder,
  useColumnPinning,
  useColumnVisibility,
} from '../store';
import { TableRow } from './data-table';
import { DataTableBodyCell } from './data-table-body-cell';

interface DataTableBodyRowProps<TData = unknown> {
  row: Row<TData>;
}

const DataTableBodyRow = memo(({ row }: DataTableBodyRowProps) => {
  useColumnVisibility(useShallow((s) => s.columnVisibility));
  useColumnPinning(useShallow((s) => s.columnPinning));
  useColumnOrder((s) => s.columnOrder);
  return (
    <TableRow className='group/row transition-colors duration-300 even:bg-muted/50 hover:bg-muted/70'>
      {row.getVisibleCells().map((cell) => (
        <DataTableBodyCell key={cell.id} cell={cell} />
      ))}
    </TableRow>
  );
});

DataTableBodyRow.displayName = 'DataTableBodyRow';

export { DataTableBodyRow };
