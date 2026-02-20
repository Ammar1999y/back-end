import type { Header } from '@tanstack/react-table';

import { memo, useCallback, useMemo, useRef } from 'react';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { flexRender } from '@tanstack/react-table';
import { ArrowDown, ArrowDownUp, ArrowUp } from 'lucide-react';
import { useShallow } from 'zustand/shallow';
import { cn } from '@/lib/utils';

import { useDataTableStore } from '@/utils/store/data-table-store';

import { Button } from '../../button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../tooltip';
import { ColumnFilterPopover } from '../filters/column-filter-popover';
import { HeaderOptions } from './data-table-header-options';
import { PinningHandler } from './pinning-handler';

enum Position {
  Before = -1,
  After = 1,
}

const stopPropagation = (e: React.PointerEvent) => e.stopPropagation();

// Isolated sort button component - only re-renders when sort state changes
interface SortButtonProps {
  columnId: string;
}

const SortButton = memo(({ columnId }: SortButtonProps) => {
  const currentSort = useDataTableStore(
    useShallow((s) => s.sort?.find((s) => s.id === columnId))
  );

  const handleSort = useCallback(() => {
    const sort = useDataTableStore.getState().sort;
    const setSorting = useDataTableStore.getState().actions.setSorting;
    const current = sort?.find((s) => s.id === columnId);

    let newSorting: { id: string; desc: boolean }[];

    if (!current) {
      // No sort → ascending
      newSorting = [{ id: columnId, desc: false }];
    } else if (current.desc === false) {
      // Ascending → descending
      newSorting = [{ id: columnId, desc: true }];
    } else {
      // Descending → back to ascending (clear sort disabled)
      // newSorting = sort.filter((s) => s.id !== columnId);
      newSorting = [{ id: columnId, desc: false }];
    }

    setSorting(newSorting);
  }, [columnId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleSort();
      }
    },
    [handleSort]
  );

  const isSorted = !!currentSort;
  const isAscending = currentSort?.desc === false;
  const isDescending = currentSort?.desc === true;

  const tooltipText = useMemo(() => {
    if (!currentSort) return 'ترتيب تصاعدي';
    if (isAscending) return 'ترتيب تنازلي';
    return 'ترتيب تصاعدي';
  }, [currentSort, isAscending]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type='button'
          variant='ghost'
          className={cn(
            'h-7 w-7 shrink-0 rounded p-1 transition-opacity duration-200',
            'bg-accent text-accent-foreground',
            isSorted
              ? 'opacity-100'
              : 'opacity-0 hover:!opacity-100 group-hover/header:opacity-80 touch:opacity-80'
          )}
          onClick={handleSort}
          onKeyDown={handleKeyDown}
          onPointerDown={stopPropagation}
        >
          {!isSorted && <ArrowDownUp className='size-4' />}
          {isAscending && <ArrowUp className='size-4' />}
          {isDescending && <ArrowDown className='size-4' />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p className='text-xs'>{tooltipText}</p>
      </TooltipContent>
    </Tooltip>
  );
});

SortButton.displayName = 'SortButton';

interface DataTableHeaderCellProps<TData = unknown> {
  header: Header<TData, unknown>;
  isDraggable?: boolean;
  activeIndex: number;
}

const DataTableHeaderCell = memo(
  ({ header, isDraggable = true, activeIndex }: DataTableHeaderCellProps) => {
    const headerRef = useRef<HTMLDivElement>(null);

    const enableOrdering =
      (header.column.columnDef.meta as any)?.enableOrdering ?? true;
    const isOrderingEnabled = isDraggable && enableOrdering;

    const column = header.column;
    const columnId = column.id;
    const canSort = column.getCanSort();
    const canPin = column.getCanPin();
    const canResize = column.getCanResize();
    const canHide = column.getCanHide();
    const canFilter = column.getCanFilter();
    const hasOptions = canSort || canPin || canHide;

    const {
      attributes,
      listeners,
      index,
      isDragging,
      isSorting,
      over,
      setNodeRef,
      transform,
      transition,
    } = useSortable({
      id: columnId,
      disabled: !isOrderingEnabled,
    });

    const combinedRef = useCallback(
      (node: HTMLDivElement | null) => {
        headerRef.current = node;
        setNodeRef(node);
      },
      [setNodeRef]
    );

    const style = useMemo(
      () => ({
        width: `calc(var(--header-${header?.id}-size) * 1px)`,
        transition,
        transform: isSorting ? undefined : CSS.Translate.toString(transform),
      }),
      [header?.id, transition, isSorting, transform]
    );

    const insertPosition = useMemo(() => {
      if (!over || over.id !== columnId || activeIndex === -1) {
        return undefined;
      }
      return index >= activeIndex ? Position.After : Position.Before;
    }, [over, columnId, index, activeIndex]);

    const handleResetSize = useCallback(() => {
      column.resetSize();
    }, [column]);

    return (
      <div
        data-slot='table-head'
        className={cn(
          'group/header relative flex min-h-10 select-none flex-col content-center justify-center p-2 align-middle font-medium text-foreground transition-shadow duration-300 touch:justify-between',
          isDragging && 'z-[1] opacity-50',
          isOrderingEnabled && 'cursor-grab active:cursor-grabbing',
          insertPosition !== undefined &&
            !isDragging &&
            "after:absolute after:bottom-0 after:top-0 after:w-0.5 after:bg-primary after:content-['']",
          insertPosition === Position.Before && 'after:right-0.5',
          insertPosition === Position.After && 'after:left-0.5'
        )}
        style={style}
        ref={combinedRef}
        {...(isOrderingEnabled ? attributes : {})}
        {...(isOrderingEnabled ? listeners : {})}
      >
        <PinningHandler cellRef={headerRef} column={column} />
        {header.isPlaceholder
          ? null
          : flexRender(header.column.columnDef.header, header.getContext())}

        {/* Floating buttons container - absolute on hover devices, static on touch */}
        {(canSort || hasOptions || canFilter) && (
          <div className='me-1 flex items-center gap-0.5 self-end hover-device:absolute hover-device:left-3 hover-device:top-1/2 hover-device:me-0 hover-device:-translate-y-1/2 hover-device:self-auto'>
            {canFilter && <ColumnFilterPopover column={column} />}
            {canSort && <SortButton columnId={columnId} />}
            {hasOptions && (
              <HeaderOptions
                column={column}
                className='h-7 w-7 bg-accent text-accent-foreground opacity-0 transition-opacity duration-200 hover:!opacity-100 group-hover/header:opacity-80 touch:opacity-80'
              />
            )}
          </div>
        )}

        {canResize && (
          <button
            tabIndex={-1}
            type='button'
            onPointerDown={stopPropagation}
            onDoubleClick={handleResetSize}
            onMouseDown={header.getResizeHandler()}
            onTouchStart={header.getResizeHandler()}
            className='noSelect resize-handler absolute top-1/2 h-4/6 w-1 -translate-y-1/2 cursor-col-resize rounded bg-border opacity-50 !outline-0 transition-all duration-300 hover:opacity-100 active:bg-primary active:opacity-100'
            aria-label='مقبض تغيير حجم العمود'
          />
        )}
      </div>
    );
  }
);

DataTableHeaderCell.displayName = 'DataTableHeaderCell';

export { DataTableHeaderCell };
