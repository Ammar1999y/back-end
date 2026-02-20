import type { Table } from '@tanstack/react-table';

import { memo } from 'react';

import { useShallow } from 'zustand/react/shallow';

import {
  useColumnOrder,
  useColumnPinning,
  useColumnVisibility,
} from '../store';
import { DataTableHeaderRow } from './data-table-header-row';

interface DataTableHeaderGroupProps {
  table: Table<any>;
  activeIndex: number;
}

const DataTableHeaderGroup = memo(
  ({ table, activeIndex }: DataTableHeaderGroupProps) => {
    useColumnVisibility(useShallow((s) => s.columnVisibility));
    useColumnPinning(useShallow((s) => s.columnPinning));
    useColumnOrder((s) => s.columnOrder);
    return table
      .getHeaderGroups()
      .map((headerGroup) => (
        <DataTableHeaderRow
          key={headerGroup.id}
          headerGroup={headerGroup}
          activeIndex={activeIndex}
        />
      ));
  }
);

DataTableHeaderGroup.displayName = 'DataTableHeaderGroup';

export { DataTableHeaderGroup };
