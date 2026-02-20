import type { Table } from '@tanstack/react-table';

import { memo } from 'react';

import { TableBodyContent } from './components/data-table-body-content';
import { DataTableHeaderGroup } from './components/data-table-header-group';

interface DataTableContentProps<TData = any> {
  activeIndex: number;
  table: Table<TData>;
  isLoading: boolean;
  error?: Error | null;
  refetch: () => void;
  columnCount: number;
}

const DataTableContainer = memo(
  ({
    activeIndex,
    table,
    isLoading,
    error,
    refetch,
    columnCount,
  }: DataTableContentProps) => {
    return (
      <div
        data-slot='table-container'
        data-lenis-prevent
        className='relative max-h-[70vh] w-full overflow-x-auto rounded-md text-sm'
      >
        <div data-slot='table' className='totalSizeTable'>
          <div
            data-slot='table-header'
            className='sticky top-0 z-[1] rounded-t-lg bg-background'
          >
            <div className='rounded-t-lg bg-muted/70'>
              <DataTableHeaderGroup table={table} activeIndex={activeIndex} />
            </div>
          </div>

          <div data-slot='table-body'>
            <TableBodyContent
              table={table}
              isLoading={isLoading}
              error={error}
              refetch={refetch}
              columnCount={columnCount}
            />
          </div>
        </div>
      </div>
    );
  }
);

DataTableContainer.displayName = 'DataTableContainer';

export { DataTableContainer };
