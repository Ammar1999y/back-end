import type { HeaderGroup } from '@tanstack/react-table';

import { memo, useMemo } from 'react';

import {
  horizontalListSortingStrategy,
  SortableContext,
} from '@dnd-kit/sortable';
import { useShallow } from 'zustand/react/shallow';

import { useColumnVisibility } from '../store';
import { DataTableHeaderCell } from './data-table-header-cell';

interface DataTableHeaderRowProps<TData = unknown> {
  headerGroup: HeaderGroup<TData>;
  activeIndex: number;
}

const DataTableHeaderRow = memo(
  ({ headerGroup, activeIndex }: DataTableHeaderRowProps) => {
    useColumnVisibility(useShallow((s) => s.columnVisibility));

    const columnIds = useMemo(
      () => headerGroup.headers.map((header) => header.column.id),
      [headerGroup.headers]
    );

    return (
      <SortableContext
        items={columnIds}
        strategy={horizontalListSortingStrategy}
      >
        <div data-slot='table-row' className='flex min-h-10 w-fit'>
          {headerGroup.headers.map((header) => (
            <DataTableHeaderCell
              key={header.id}
              header={header}
              activeIndex={activeIndex}
            />
          ))}
        </div>
      </SortableContext>
    );
  }
);

DataTableHeaderRow.displayName = 'DataTableHeaderRow';

export { DataTableHeaderRow };
