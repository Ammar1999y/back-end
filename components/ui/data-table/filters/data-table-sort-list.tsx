import type { ColumnSort, SortDirection, Table } from '@tanstack/react-table';

import * as React from 'react';

import {
  ArrowDownUp,
  ChevronsUpDown,
  GripVertical,
  Plus,
  Trash2,
} from 'lucide-react';
import { useShallow } from 'zustand/shallow';
import { cn } from '@/lib/utils';

import { useDataTableStore } from '@/utils/store/data-table-store';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sortable,
  SortableContent,
  SortableItem,
  SortableItemHandle,
  SortableOverlay,
} from '@/components/ui/sortable';

import { dataTableConfig } from './config';

const SORT_SHORTCUT_KEY = 'j';
// eslint-disable-next-line unicorn/prefer-set-has
const REMOVE_SORT_SHORTCUTS = ['backspace', 'delete'];

interface DataTableSortListProps<TData> extends React.ComponentProps<
  typeof PopoverContent
> {
  table: Table<TData>;
  disabled?: boolean;
}

export function DataTableSortList<TData>({
  table,
  disabled,
  ...props
}: DataTableSortListProps<TData>) {
  const id = React.useId();
  const labelId = React.useId();
  const descriptionId = React.useId();
  const [open, setOpen] = React.useState(false);
  const addButtonRef = React.useRef<HTMLButtonElement>(null);

  const sorting = useDataTableStore(useShallow((s) => s.sort));

  // Draft state: local copy while popover is open
  const [draftSorting, setDraftSorting] = React.useState<ColumnSort[]>([]);

  // Sync draft from store when popover opens
  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      setDraftSorting(useDataTableStore.getState().sort);
    }
    setOpen(nextOpen);
  }, []);

  // Apply draft to store
  const onApply = React.useCallback(() => {
    useDataTableStore.getState().actions.setSorting(draftSorting);
    setOpen(false);
  }, [draftSorting]);

  const { columnLabels, columns } = React.useMemo(() => {
    const labels = new Map<string, string>();
    const sortingIds = new Set(draftSorting.map((s) => s.id));
    const availableColumns: { id: string; label: string }[] = [];

    for (const column of table.getAllColumns()) {
      if (!column.getCanSort()) continue;

      const label = column.columnDef.meta?.label ?? column.id;
      labels.set(column.id, label);

      if (!sortingIds.has(column.id)) {
        availableColumns.push({ id: column.id, label });
      }
    }

    return {
      columnLabels: labels,
      columns: availableColumns,
    };
  }, [draftSorting, table]);

  const onSortAdd = React.useCallback(() => {
    const firstColumn = columns[0];
    if (!firstColumn) return;

    setDraftSorting((prev) => [...prev, { id: firstColumn.id, desc: false }]);
  }, [columns]);

  const onSortUpdate = React.useCallback(
    (sortId: string, updates: Partial<ColumnSort>) => {
      setDraftSorting((prev) =>
        prev.map((s) => (s.id === sortId ? { ...s, ...updates } : s))
      );
    },
    []
  );

  const onSortRemove = React.useCallback((sortId: string) => {
    setDraftSorting((prev) => prev.filter((s) => s.id !== sortId));
  }, []);

  const onSortingReset = React.useCallback(
    () => setDraftSorting(table.initialState.sorting),
    [table.initialState.sorting]
  );

  const onSortingReorder = React.useCallback((newSorting: ColumnSort[]) => {
    setDraftSorting(newSorting);
  }, []);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement &&
          event.target.contentEditable === 'true')
      ) {
        return;
      }

      if (
        event.key.toLowerCase() === SORT_SHORTCUT_KEY &&
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey
      ) {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const onTriggerKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (
        REMOVE_SORT_SHORTCUTS.includes(event.key.toLowerCase()) &&
        sorting.length > 0
      ) {
        event.preventDefault();
        onSortingReset();
      }
    },
    [sorting.length, onSortingReset]
  );

  return (
    <Sortable
      value={draftSorting}
      onValueChange={onSortingReorder}
      getItemValue={(item) => item.id}
    >
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant='outline'
            size='sm'
            className='text-sm font-normal hover:shadow-md dark:bg-input/30 hover:dark:bg-input/45'
            onKeyDown={onTriggerKeyDown}
            disabled={disabled}
          >
            <ArrowDownUp className='size-4 text-muted-foreground' />
            <span>ترتيب</span>
            {sorting.length > 0 && (
              <Badge
                variant='secondary'
                className='h-4 rounded-xs px-1 font-mono text-xs font-normal'
              >
                {sorting.length}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          className='flex w-full max-w-[--radix-popover-content-available-width] flex-col gap-3.5 px-0 py-4 text-sm shadow-[0_5px_22px_-3px_rgba(0,0,0,0.12)] sm:min-w-80'
          {...props}
        >
          <h4
            id={labelId}
            className='border-b px-3 pb-3 text-base font-medium leading-none'
          >
            الترتيب
          </h4>
          <p
            id={descriptionId}
            className={cn(
              'my-5 px-3 text-center text-sm text-muted-foreground',
              draftSorting.length > 0 && 'sr-only'
            )}
          >
            {draftSorting.length > 0
              ? 'عدّل الترتيب لتنظيم الصفوف.'
              : 'لا يوجد ترتيب، أضف ترتيب لتنظيم الصفوف.'}
          </p>
          {draftSorting.length > 0 ? (
            <SortableContent asChild>
              <div
                role='list'
                className='my-2 flex max-h-80 flex-col gap-2 overflow-y-auto p-1 px-3'
              >
                {draftSorting.map((sort) => (
                  <DataTableSortItem
                    key={sort.id}
                    sort={sort}
                    sortItemId={`${id}-sort-${sort.id}`}
                    columns={columns}
                    columnLabels={columnLabels}
                    onSortUpdate={onSortUpdate}
                    onSortRemove={onSortRemove}
                  />
                ))}
              </div>
            </SortableContent>
          ) : null}
          <div className='flex w-full items-center justify-between gap-2 border-t px-3 pt-3'>
            {draftSorting.length > 0 ? (
              <Button
                variant='destructiveGhost'
                size='sm'
                className='rounded text-sm'
                onClick={onSortingReset}
              >
                إعادة تعيين
              </Button>
            ) : null}
            <div className='ms-auto flex items-center gap-2'>
              <Button
                variant='none'
                size='sm'
                className='rounded border border-dashed text-sm hover:bg-primary/10'
                ref={addButtonRef}
                onClick={onSortAdd}
                disabled={columns.length === 0}
              >
                <Plus className='size-4' />
                <span>إضافة ترتيب</span>
              </Button>
              <Button size='sm' className='rounded text-sm' onClick={onApply}>
                تطبيق
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <SortableOverlay>
        <div className='flex items-center gap-2'>
          <div className='h-8 w-32 rounded-sm bg-primary/10' />
          <div className='h-8 w-24 rounded-sm bg-primary/10' />
          <div className='size-8 shrink-0 rounded-sm bg-primary/10' />
          <div className='size-8 shrink-0 rounded-sm bg-primary/10' />
        </div>
      </SortableOverlay>
    </Sortable>
  );
}

interface DataTableSortItemProps {
  sort: ColumnSort;
  sortItemId: string;
  columns: { id: string; label: string }[];
  columnLabels: Map<string, string>;
  onSortUpdate: (sortId: string, updates: Partial<ColumnSort>) => void;
  onSortRemove: (sortId: string) => void;
}

function DataTableSortItem({
  sort,
  sortItemId,
  columns,
  columnLabels,
  onSortUpdate,
  onSortRemove,
}: DataTableSortItemProps) {
  const fieldListboxId = `${sortItemId}-field-listbox`;
  const fieldTriggerId = `${sortItemId}-field-trigger`;
  const directionListboxId = `${sortItemId}-direction-listbox`;

  const [showFieldSelector, setShowFieldSelector] = React.useState(false);
  const [showDirectionSelector, setShowDirectionSelector] =
    React.useState(false);

  const onItemKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (showFieldSelector || showDirectionSelector) {
        return;
      }

      if (REMOVE_SORT_SHORTCUTS.includes(event.key.toLowerCase())) {
        event.preventDefault();
        onSortRemove(sort.id);
      }
    },
    [sort.id, showFieldSelector, showDirectionSelector, onSortRemove]
  );

  return (
    <SortableItem value={sort.id} asChild>
      <div
        role='listitem'
        id={sortItemId}
        tabIndex={-1}
        className='flex items-center gap-2'
        onKeyDown={onItemKeyDown}
      >
        <Popover open={showFieldSelector} onOpenChange={setShowFieldSelector}>
          <PopoverTrigger asChild>
            <Button
              id={fieldTriggerId}
              aria-controls={fieldListboxId}
              variant='none'
              size='none'
              className='h-8 w-32 min-w-0 justify-between rounded-md border bg-transparent px-3 py-1 text-base font-normal shadow-sm hover:shadow-md dark:bg-input/30 hover:dark:bg-input/45 md:text-sm'
            >
              <span className='truncate'>{columnLabels.get(sort.id)}</span>
              <ChevronsUpDown className='size-4 opacity-40' />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            id={fieldListboxId}
            className='w-[--radix-popover-trigger-width] p-0'
          >
            <Command>
              <CommandInput placeholder='ابحث عن حقل...' />
              <CommandList>
                <CommandEmpty>لا توجد حقول.</CommandEmpty>
                <CommandGroup>
                  {columns.map((column) => (
                    <CommandItem
                      key={column.id}
                      value={column.id}
                      onSelect={(value) => onSortUpdate(sort.id, { id: value })}
                    >
                      <span className='truncate'>{column.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <Select
          open={showDirectionSelector}
          onOpenChange={setShowDirectionSelector}
          value={sort.desc ? 'desc' : 'asc'}
          onValueChange={(value: SortDirection) =>
            onSortUpdate(sort.id, { desc: value === 'desc' })
          }
        >
          <SelectTrigger
            aria-controls={directionListboxId}
            size='sm'
            className='!h-8 w-24 rounded shadow-sm'
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            id={directionListboxId}
            className='min-w-[--radix-select-trigger-width]'
          >
            {dataTableConfig.sortOrders.map((order) => (
              <SelectItem key={order.value} value={order.value}>
                {order.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          aria-controls={sortItemId}
          variant='destructiveGhost'
          size='icon'
          className='size-8 rounded text-muted-foreground hover:text-destructive'
          onClick={() => onSortRemove(sort.id)}
        >
          <Trash2 className='size-4' />
        </Button>
        <SortableItemHandle asChild>
          <Button
            variant='ghost'
            size='icon'
            className='size-8 rounded text-muted-foreground'
          >
            <GripVertical className='size-4' />
          </Button>
        </SortableItemHandle>
      </div>
    </SortableItem>
  );
}
