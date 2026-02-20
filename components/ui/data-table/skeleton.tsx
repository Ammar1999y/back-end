import type { Table } from '@tanstack/react-table';

import { memo } from 'react';

import { TableCell, TableRow } from './components/data-table';

interface DataTableSkeletonProps {
  table: Table<any>;
  columnCount: number;
  rowCount?: number;
}

const DataTableSkeleton = memo(
  ({ table, rowCount = 5 }: DataTableSkeletonProps) => {
    return (
      <>
        {Array.from({ length: rowCount }, (_, rowIndex) => (
          <TableRow
            key={`skeleton-row-${rowIndex}`}
            className={'animate-pulse'}
          >
            {table.getHeaderGroups()[0].headers.map((header) => (
              <TableCell
                key={`skeleton-cell-${rowIndex}-${header.id}`}
                style={{
                  width: `calc(var(--col-${header?.column?.id}-size) * 1px)`,
                }}
              >
                <div className='my-2 h-5 w-full rounded-sm bg-accent' />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </>
    );
  }
);

DataTableSkeleton.displayName = 'DataTableSkeleton';
export { DataTableSkeleton };
