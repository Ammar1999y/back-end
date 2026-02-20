import type { Cell } from '@tanstack/react-table';

import { memo, useMemo, useRef } from 'react';

import { flexRender } from '@tanstack/react-table';

import { TableCell } from './data-table';
import { PinningHandler } from './pinning-handler';

interface DataTableBodyCellProps<TData = unknown> {
  cell: Cell<TData, unknown>;
}

const DataTableBodyCell = memo(({ cell }: DataTableBodyCellProps) => {
  const cellRef = useRef<HTMLDivElement>(null);
  const style = useMemo(
    () => ({ width: `calc(var(--col-${cell?.column?.id}-size) * 1px)` }),
    [cell?.column?.id]
  );

  return (
    <TableCell
      style={style}
      ref={cellRef}
      className='relative transition duration-300'
    >
      <PinningHandler cellRef={cellRef} column={cell.column} />
      {flexRender(cell.column.columnDef.cell, cell.getContext())}
    </TableCell>
  );
});

DataTableBodyCell.displayName = 'DataTableBodyCell';

export { DataTableBodyCell };
