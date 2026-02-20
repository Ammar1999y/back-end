import type { Table } from '@tanstack/react-table';

import { memo } from 'react';

import { DataTableFilterList } from './filters/data-table-filter-list';
import { DataTableSearch } from './filters/data-table-search';
import { DataTableSortList } from './filters/data-table-sort-list';
import { DataTableViewOptions } from './view-options';

type DataTableToolbarProps<TData = any> = {
  table: Table<TData>;
  STORAGE_KEY: string;
};

const DataTableToolbar = memo(
  ({ table, STORAGE_KEY }: DataTableToolbarProps) => {
    return (
      <div
        role='toolbar'
        aria-orientation='horizontal'
        className='flex w-full items-center justify-start gap-2 p-1'
      >
        <DataTableSearch />
        <DataTableSortList table={table} align='start' />
        <DataTableFilterList table={table} align='start' />
        <div className='flex flex-1 justify-end'>
          <DataTableViewOptions table={table} storageKey={STORAGE_KEY} />
        </div>
      </div>
    );
  }
);

DataTableToolbar.displayName = 'DataTableToolbar';
export { DataTableToolbar };
