/* eslint-disable unicorn/no-useless-collection-argument */
import type { Table } from '@tanstack/react-table';

import { memo, useCallback, useMemo, useState } from 'react';

import { Check, GripVertical } from 'lucide-react';
import { useShallow } from 'zustand/shallow';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import Setting from '@/components/icons/adjustment';
import {
  arrayMove,
  restrictToParentElement,
  restrictToVerticalAxis,
  SimpleSortableItem,
  SortableHandle,
  SortableList,
  useSortableList,
  verticalListSortingStrategy,
} from '@/components/sortable';

import {
  useColumnOrder,
  useColumnPinning,
  useColumnSizing,
  useColumnVisibility,
} from './store';

// ─── Types ───────────────────────────────────────────────────────────

interface ColumnItem {
  id: string;
  label: string;
  canHide: boolean;
}

type DataTableViewOptionsProps<TData = any> = {
  table: Table<TData>;
  storageKey?: string;
};

// ─── Modifiers ───────────────────────────────────────────────────────

const modifiers = [restrictToVerticalAxis, restrictToParentElement];

// ─── Main Component ──────────────────────────────────────────────────

const DataTableViewOptions = memo(
  ({ table, storageKey }: DataTableViewOptionsProps) => {
    const [search, setSearch] = useState('');
    const [open, setOpen] = useState(false);

    const columns: ColumnItem[] = useMemo(
      () =>
        table.getAllLeafColumns().map((col) => ({
          id: col.id,
          label: (col.columnDef.meta as any)?.title ?? col.id,
          canHide: col.getCanHide(),
        })),
      [table]
    );

    // Hidden count for "show all" button
    const hiddenCount = useColumnVisibility(
      useShallow(
        (s) =>
          Object.values(s.columnVisibility).filter((v) => v === false).length
      )
    );

    // Column order from store
    const columnOrder = useColumnOrder(useShallow((s) => s.columnOrder));

    // Ordered columns list
    const orderedColumns = useMemo(() => {
      if (!columnOrder.length) return columns;
      const orderMap = new Map(columnOrder.map((id, i) => [id, i]));
      return [...columns].sort((a, b) => {
        const aIdx = orderMap.get(a.id) ?? Infinity;
        const bIdx = orderMap.get(b.id) ?? Infinity;
        return aIdx - bIdx;
      });
    }, [columns, columnOrder]);

    // Filtered columns when searching
    const filteredColumns = useMemo(() => {
      if (!search.trim()) return orderedColumns;
      const s = search.trim().toLowerCase();
      return orderedColumns.filter((c) => c.label.toLowerCase().includes(s));
    }, [orderedColumns, search]);

    const isSearching = search.trim().length > 0;

    // Column IDs for sortable context
    const columnIds = useMemo(
      () => filteredColumns.map((c) => c.id),
      [filteredColumns]
    );

    // Drag state & handlers — mirrors data-table-content.tsx pinning logic
    const { activeId, sensors, handleDragStart, handleDragCancel } =
      useSortableList<string>({
        items: columnIds,
        onItemsChange: () => {}, // handled in custom handleDragEnd
      });

    const handleDragEnd = useCallback(
      (event: import('@dnd-kit/core').DragEndEvent) => {
        const { over } = event;
        if (!over || activeId == null) return;

        const activeColumnId = activeId as string;
        const overColumnId = over.id as string;
        if (activeColumnId === overColumnId) return;

        const { columnOrder: currentOrder, setColumnOrder } =
          useColumnOrder.getState();
        const { columnPinning, setColumnPinning } = useColumnPinning.getState();

        const leftPinned = new Set(columnPinning.left ?? []);
        const rightPinned = new Set(columnPinning.right ?? []);

        // Determine target zone based on the "over" column
        const isOverLeftPinned = leftPinned.has(overColumnId);
        const isOverRightPinned = rightPinned.has(overColumnId);

        // Reorder using arrayMove on the full column order
        const activeIdx = currentOrder.indexOf(activeColumnId);
        const overIdx = currentOrder.indexOf(overColumnId);
        const newColumnOrder = arrayMove(currentOrder, activeIdx, overIdx);

        // Build new pinning sets
        const newLeftSet = new Set(leftPinned);
        const newRightSet = new Set(rightPinned);

        // Remove active from its current pinning zone
        newLeftSet.delete(activeColumnId);
        newRightSet.delete(activeColumnId);

        // Add to the target zone if dropping on a pinned column
        if (isOverLeftPinned) {
          newLeftSet.add(activeColumnId);
        } else if (isOverRightPinned) {
          newRightSet.add(activeColumnId);
        }

        // Maintain columnOrder ordering for pinning arrays
        const newLeft = newColumnOrder.filter((id) => newLeftSet.has(id));
        const newRight = newColumnOrder.filter((id) => newRightSet.has(id));

        setColumnPinning({ left: newLeft, right: newRight });
        setColumnOrder(newColumnOrder);
      },
      [activeId]
    );

    // Active item for overlay
    const activeColumn = useMemo(
      () => (activeId ? columns.find((c) => c.id === activeId) : null),
      [activeId, columns]
    );

    const handleSearchChange = useCallback((value: string) => {
      setSearch(value);
    }, []);

    const handleShowAll = useCallback(() => {
      const { setColumnVisibility } = useColumnVisibility.getState();
      const newVisibility: Record<string, boolean> = {};
      for (const col of columns) {
        if (col.canHide) newVisibility[col.id] = true;
      }
      setColumnVisibility(newVisibility);
    }, [columns]);

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant='outline'
            className='border-dashed border-border px-3 py-1 text-sm font-medium max-lg:self-end'
          >
            <Setting className='size-4 opacity-70' />
            <span className='py-0.5'>العرض</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className='w-56 p-0' align='end'>
          <Command shouldFilter={false}>
            <CommandInput
              placeholder='بحث عن عمود...'
              value={search}
              onValueChange={handleSearchChange}
            />
            <CommandList>
              <CommandEmpty>لا توجد نتائج.</CommandEmpty>
              <CommandGroup>
                {isSearching ? (
                  // When searching: no drag, just list
                  filteredColumns.map((col) => (
                    <ColumnItem key={col.id} column={col} />
                  ))
                ) : (
                  // Normal mode: sortable list
                  <SortableList
                    sensors={sensors}
                    items={columnIds}
                    strategy={verticalListSortingStrategy}
                    modifiers={modifiers}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    onDragCancel={handleDragCancel}
                    useDragOverlay
                    overlay={
                      activeColumn ? (
                        <ColumnItem column={activeColumn} showHandle />
                      ) : null
                    }
                  >
                    {filteredColumns.map((col) => (
                      <SimpleSortableItem
                        key={col.id}
                        id={col.id}
                        useHandle
                        className='flex items-center'
                      >
                        <ColumnItem column={col} showHandle />
                      </SimpleSortableItem>
                    ))}
                  </SortableList>
                )}
              </CommandGroup>
              <CommandSeparator />
              {hiddenCount > 0 && (
                <>
                  <CommandGroup>
                    <CommandItem
                      onSelect={handleShowAll}
                      className='justify-center text-center'
                    >
                      اظهار الكل
                    </CommandItem>
                  </CommandGroup>
                </>
              )}
              <CommandGroup>
                <CommandItem
                  onSelect={() => {
                    useColumnSizing.setState({ columnSizing: {} });
                    useColumnOrder.setState({
                      columnOrder: table.initialState?.columnOrder || [],
                    });
                    useColumnVisibility.setState({
                      columnVisibility:
                        table.initialState?.columnVisibility || {},
                    });
                    useColumnPinning.setState({
                      columnPinning: table.initialState?.columnPinning || {
                        left: [],
                        right: [],
                      },
                    });
                    table.setColumnSizing({});
                    if (storageKey) {
                      localStorage.removeItem(storageKey);
                    }
                    setOpen(false);
                  }}
                  className='justify-center text-center'
                >
                  إعادة ضبط الاعمدة
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    );
  }
);

DataTableViewOptions.displayName = 'DataTableViewOptions';

// ─── Column Item ─────────────────────────────────────────────────────

interface ColumnItemProps {
  column: ColumnItem;
  showHandle?: boolean;
}

const ColumnItem = memo(({ column, showHandle }: ColumnItemProps) => {
  const isVisible = useColumnVisibility(
    useShallow((s) => s.columnVisibility[column.id] !== false)
  );

  const handleSelect = useCallback(() => {
    if (!column.canHide) return;
    const { columnVisibility, setColumnVisibility } =
      useColumnVisibility.getState();
    setColumnVisibility({
      ...columnVisibility,
      [column.id]: !isVisible,
    });
  }, [column.id, column.canHide, isVisible]);

  return (
    <CommandItem
      onSelect={handleSelect}
      className={cn('w-full gap-2', !column.canHide && 'opacity-60')}
    >
      <div
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-sm border border-primary',
          isVisible
            ? 'bg-primary text-primary-foreground'
            : 'opacity-50 [&_svg]:invisible'
        )}
      >
        <Check className='size-3.5 text-background' />
      </div>
      <span className='flex-1 truncate'>{column.label}</span>
      {showHandle && (
        <SortableHandle
          as='div'
          className='flex shrink-0 cursor-grab items-center text-muted-foreground hover:text-foreground'
        >
          <GripVertical className='size-4' />
        </SortableHandle>
      )}
    </CommandItem>
  );
});

ColumnItem.displayName = 'ColumnItem';

export { DataTableViewOptions };
