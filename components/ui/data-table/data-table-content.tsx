import type { MeasuringConfiguration } from '@dnd-kit/core';
import type { Table } from '@tanstack/react-table';

import { memo, RefObject, useEffect } from 'react';

import {
  closestCenter,
  defaultDropAnimationSideEffects,
  DndContext,
  DragOverlay,
  DropAnimation,
  MeasuringStrategy,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';

import { DataTableContainer } from './data-table-container';
import { useColumnDnd } from './hooks/use-column-dnd';
import { DataTablePagination } from './pagination';
import { PaginationSkeleton } from './pagination-skeleton';
import { cleaner } from './store';
import { DataTableToolbar } from './toolbar';
import { ToolbarSkeleton } from './toolbar-skeleton';

interface DataTableContentProps<TData = any> {
  table: Table<TData>;
  data: TData[] | undefined;
  isLoading: boolean;
  error?: Error | null;
  refetch: () => void;
  tableContainerRef?: RefObject<HTMLDivElement | null>;
  STORAGE_KEY: string;
}

const measuring: MeasuringConfiguration = {
  droppable: {
    strategy: MeasuringStrategy.Always,
  },
};

const dropAnimation: DropAnimation = {
  keyframes({ transform }) {
    return [
      { transform: CSS.Transform.toString(transform.initial) },
      {
        transform: CSS.Transform.toString({
          scaleX: 0.98,
          scaleY: 0.98,
          x: transform.final.x - 10,
          y: transform.final.y + 10,
        }),
        opacity: 0,
      },
    ];
  },
  sideEffects: defaultDropAnimationSideEffects({
    className: {
      active: 'opacity-100',
    },
  }),
};

const DataTableContent = memo(
  ({
    table,
    data,
    isLoading,
    error,
    refetch,
    tableContainerRef,
    STORAGE_KEY,
  }: DataTableContentProps) => {
    const columnCount = table.getVisibleLeafColumns().length;

    useEffect(() => {
      return () => cleaner();
    }, []);

    const {
      activeIndex,
      activeHeader,
      sensors,
      handleDragStart,
      handleDragEnd,
      handleDragCancel,
    } = useColumnDnd(table);

    return (
      <DndContext
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
        sensors={sensors}
        collisionDetection={closestCenter}
        measuring={measuring}
      >
        <div
          className={cn(
            'relative transition-opacity duration-300 space-y-4',
            isLoading && 'pointer-events-none select-none opacity-50'
          )}
          ref={tableContainerRef}
          inert={isLoading}
        >
          {isLoading ? (
            <ToolbarSkeleton />
          ) : (
            <DataTableToolbar table={table} STORAGE_KEY={STORAGE_KEY} />
          )}
          <DataTableContainer
            activeIndex={activeIndex}
            table={table}
            isLoading={isLoading}
            error={error}
            refetch={refetch}
            columnCount={columnCount}
          />
          {isLoading ? (
            <PaginationSkeleton />
          ) : data?.length ? (
            <DataTablePagination table={table} />
          ) : null}
        </div>
        <DragOverlay dropAnimation={dropAnimation}>
          {activeHeader != null ? (
            <div className='flex min-h-10 max-w-32 translate-x-2.5 translate-y-2.5 animate-dnd-pop cursor-grabbing items-center rounded bg-card p-2 text-foreground shadow-lg'>
              {(activeHeader.column.columnDef.meta as any)?.label ??
                activeHeader.column.id}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    );
  }
);

DataTableContent.displayName = 'DataTableContent';

export { DataTableContent };
