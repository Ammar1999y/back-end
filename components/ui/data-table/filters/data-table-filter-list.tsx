import type {
  ExtendedColumnFilter,
  FilterOperator,
  JoinOperator,
} from '@/types/data-table';
import type { Column, Table } from '@tanstack/react-table';

import * as React from 'react';

import {
  Check,
  ChevronDownIcon,
  Filter,
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

import {
  getDefaultFilterOperator,
  getFilterOperators,
} from '../utils/data-table';
import { dataTableConfig } from './config';
import { FilterInput } from './filter-inputs';

const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function generateId({ length = 12 }: { length?: number } = {}) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let id = '';
  for (let i = 0; i < length; i++) {
    id += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return id;
}

const FILTER_SHORTCUT_KEY = 'f';

const joinOperatorLabels: Record<JoinOperator, string> = {
  and: 'و',
  or: 'أو',
};
// eslint-disable-next-line unicorn/prefer-set-has
const REMOVE_FILTER_SHORTCUTS = ['backspace', 'delete'];

interface DataTableFilterListProps<TData> extends React.ComponentProps<
  typeof PopoverContent
> {
  table: Table<TData>;
  disabled?: boolean;
}

export function DataTableFilterList<TData>({
  table,
  disabled,
  ...props
}: DataTableFilterListProps<TData>) {
  const id = React.useId();
  const labelId = React.useId();
  const descriptionId = React.useId();
  const [open, setOpen] = React.useState(false);
  const addButtonRef = React.useRef<HTMLButtonElement>(null);

  const columns = React.useMemo(
    () =>
      table
        .getAllColumns()
        .filter((column) => column.columnDef.enableColumnFilter),
    [table]
  );

  const filters = useDataTableStore(
    useShallow((s) => s.filters as ExtendedColumnFilter<TData>[])
  );

  // Draft state: local copy while popover is open
  const [draftFilters, setDraftFilters] = React.useState<
    ExtendedColumnFilter<TData>[]
  >([]);
  const [draftJoinOperator, setDraftJoinOperator] =
    React.useState<JoinOperator>('and');

  // Sync draft from store when popover opens
  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      const state = useDataTableStore.getState();
      setDraftFilters(state.filters as ExtendedColumnFilter<TData>[]);
      setDraftJoinOperator(state.joinOperator);
    }
    setOpen(nextOpen);
  }, []);

  // Apply draft to store
  const onApply = React.useCallback(() => {
    const { setFilters, setJoinOperator } =
      useDataTableStore.getState().actions;
    setFilters(draftFilters.length > 0 ? draftFilters : null);
    setJoinOperator(draftJoinOperator);
    setOpen(false);
  }, [draftFilters, draftJoinOperator]);

  const onFilterAdd = React.useCallback(() => {
    const column = columns[0];

    if (!column) return;

    setDraftFilters((prev) => [
      ...prev,
      {
        id: column.id as Extract<keyof TData, string>,
        value: '',
        variant: column.columnDef.meta?.variant ?? 'text',
        operator: getDefaultFilterOperator(
          column.columnDef.meta?.variant ?? 'text'
        ),
        filterId: generateId({ length: 8 }),
      },
    ]);
  }, [columns]);

  const onFilterUpdate = React.useCallback(
    (
      filterId: string,
      updates: Partial<Omit<ExtendedColumnFilter<TData>, 'filterId'>>
    ) => {
      setDraftFilters((prev) =>
        prev.map((filter) =>
          filter.filterId === filterId
            ? ({ ...filter, ...updates } as ExtendedColumnFilter<TData>)
            : filter
        )
      );
    },
    []
  );

  const onFilterRemove = React.useCallback((filterId: string) => {
    setDraftFilters((prev) =>
      prev.filter((filter) => filter.filterId !== filterId)
    );
    requestAnimationFrame(() => {
      addButtonRef.current?.focus();
    });
  }, []);

  const onFiltersReset = React.useCallback(() => {
    setDraftFilters([]);
    setDraftJoinOperator('and');
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
        event.key.toLowerCase() === FILTER_SHORTCUT_KEY &&
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
        REMOVE_FILTER_SHORTCUTS.includes(event.key.toLowerCase()) &&
        draftFilters.length > 0
      ) {
        event.preventDefault();
        onFilterRemove(draftFilters[draftFilters.length - 1]?.filterId ?? '');
      }
    },
    [draftFilters, onFilterRemove]
  );

  return (
    <Sortable
      value={draftFilters}
      onValueChange={(value) =>
        setDraftFilters(value as ExtendedColumnFilter<TData>[])
      }
      getItemValue={(item) => item.filterId}
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
            <Filter className='size-4 text-muted-foreground' />
            <span>تصفية</span>
            {filters.length > 0 && (
              <Badge
                variant='secondary'
                className='h-4 rounded-xs px-1 font-mono text-xs font-normal'
              >
                {filters.length}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          aria-describedby={descriptionId}
          aria-labelledby={labelId}
          className='flex w-full max-w-[--radix-popover-content-available-width] flex-col gap-3.5 px-0 py-4 text-sm shadow-[0_5px_22px_-3px_rgba(0,0,0,0.12)] sm:min-w-96'
          {...props}
        >
          <h4
            id={labelId}
            className='border-b px-3 pb-3 text-base font-medium leading-none'
          >
            التصفيات
          </h4>
          <p
            id={descriptionId}
            className={cn(
              'my-5 px-3 text-center text-sm text-muted-foreground',
              draftFilters.length > 0 && 'sr-only'
            )}
          >
            {draftFilters.length > 0
              ? 'عدّل التصفيات لتحسين النتائج.'
              : 'لاتوجد تصفيات، أضف تصفيات لتحسين النتائج.'}
          </p>
          {draftFilters.length > 0 ? (
            <SortableContent asChild>
              <div
                role='list'
                className='my-2 flex max-h-80 flex-col gap-2 overflow-y-auto p-1 px-3'
              >
                {draftFilters.map((filter, index) => (
                  <DataTableFilterItem<TData>
                    key={filter.filterId}
                    filter={filter}
                    index={index}
                    filterItemId={`${id}-filter-${filter.filterId}`}
                    joinOperator={draftJoinOperator}
                    setJoinOperator={setDraftJoinOperator}
                    columns={columns}
                    onFilterUpdate={onFilterUpdate}
                    onFilterRemove={onFilterRemove}
                  />
                ))}
              </div>
            </SortableContent>
          ) : null}
          <div className='flex w-full items-center justify-between gap-2 border-t px-3 pt-3'>
            {draftFilters.length > 0 ? (
              <Button
                variant='destructiveGhost'
                size='sm'
                className='rounded text-sm'
                onClick={onFiltersReset}
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
                onClick={onFilterAdd}
              >
                <Plus className='size-4' />
                <span>إضافة تصفية</span>
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
          <div className='h-8 min-w-20 rounded-sm bg-primary/10' />
          <div className='flex flex-1 flex-col gap-2 md:flex-row md:items-center'>
            <div className='h-8 rounded-sm bg-primary/10 md:w-32' />
            <div className='h-8 rounded-sm bg-primary/10 md:w-32' />
            <div className='h-8 w-full min-w-36 flex-1 rounded-sm bg-primary/10' />
          </div>
          <div className='size-8 shrink-0 rounded-sm bg-primary/10' />
          <div className='size-8 shrink-0 rounded-sm bg-primary/10' />
        </div>
      </SortableOverlay>
    </Sortable>
  );
}

interface DataTableFilterItemProps<TData> {
  filter: ExtendedColumnFilter<TData>;
  index: number;
  filterItemId: string;
  joinOperator: JoinOperator;
  setJoinOperator: (value: JoinOperator) => void;
  columns: Column<TData>[];
  onFilterUpdate: (
    filterId: string,
    updates: Partial<Omit<ExtendedColumnFilter<TData>, 'filterId'>>
  ) => void;
  onFilterRemove: (filterId: string) => void;
}

function DataTableFilterItem<TData>({
  filter,
  index,
  filterItemId,
  joinOperator,
  setJoinOperator,
  columns,
  onFilterUpdate,
  onFilterRemove,
}: DataTableFilterItemProps<TData>) {
  const [showFieldSelector, setShowFieldSelector] = React.useState(false);
  const [showOperatorSelector, setShowOperatorSelector] = React.useState(false);
  const [showValueSelector, setShowValueSelector] = React.useState(false);

  const column = columns.find((column) => column.id === filter.id);

  const joinOperatorListboxId = `${filterItemId}-join-operator-listbox`;
  const fieldListboxId = `${filterItemId}-field-listbox`;
  const operatorListboxId = `${filterItemId}-operator-listbox`;
  const inputId = `${filterItemId}-input`;

  const columnMeta = column?.columnDef.meta;
  const filterOperators = getFilterOperators(filter.variant);

  const onItemKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (showFieldSelector || showOperatorSelector || showValueSelector) {
        return;
      }

      if (REMOVE_FILTER_SHORTCUTS.includes(event.key.toLowerCase())) {
        event.preventDefault();
        onFilterRemove(filter.filterId);
      }
    },
    [
      filter.filterId,
      showFieldSelector,
      showOperatorSelector,
      showValueSelector,
      onFilterRemove,
    ]
  );

  if (!column) return null;

  return (
    <SortableItem value={filter.filterId} asChild>
      <div
        role='listitem'
        id={filterItemId}
        tabIndex={-1}
        className='flex items-center gap-2'
        onKeyDown={onItemKeyDown}
      >
        <div className='min-w-20'>
          {index === 0 ? (
            <span className='ps-3 text-sm text-muted-foreground'>حيث</span>
          ) : index === 1 ? (
            <Select
              value={joinOperator}
              onValueChange={(value: JoinOperator) => setJoinOperator(value)}
            >
              <SelectTrigger
                aria-label='Select join operator'
                aria-controls={joinOperatorListboxId}
                size='sm'
                className='!h-8 w-full rounded lowercase'
              >
                <SelectValue
                  placeholder={joinOperatorLabels[joinOperator] ?? joinOperator}
                />
              </SelectTrigger>
              <SelectContent
                id={joinOperatorListboxId}
                position='popper'
                className='min-w-[--radix-select-trigger-width] lowercase'
              >
                {dataTableConfig.joinOperators.map((joinOperator) => (
                  <SelectItem key={joinOperator} value={joinOperator}>
                    {joinOperatorLabels[joinOperator] ?? joinOperator}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className='ps-3 text-sm text-muted-foreground'>
              {joinOperatorLabels[joinOperator] ?? joinOperator}
            </span>
          )}
        </div>
        <div className='flex flex-1 flex-col gap-2 md:flex-row md:items-center'>
          <Popover open={showFieldSelector} onOpenChange={setShowFieldSelector}>
            <PopoverTrigger asChild>
              <Button
                aria-controls={fieldListboxId}
                variant='none'
                size='none'
                className='h-8 min-w-0 justify-between rounded border bg-transparent px-3 py-1 text-sm font-normal shadow-xs hover:shadow-sm dark:bg-input/30 hover:dark:bg-input/45 md:w-32'
              >
                <span className='truncate'>
                  {columns.find((column) => column.id === filter.id)?.columnDef
                    .meta?.label ?? 'اختر حقل'}
                </span>
                <ChevronDownIcon className='size-4 text-muted-foreground opacity-80' />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              id={fieldListboxId}
              align='start'
              className='w-40 p-0'
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
                        onSelect={(value) => {
                          onFilterUpdate(filter.filterId, {
                            id: value as Extract<keyof TData, string>,
                            variant: column.columnDef.meta?.variant ?? 'text',
                            operator: getDefaultFilterOperator(
                              column.columnDef.meta?.variant ?? 'text'
                            ),
                            value: '',
                          });

                          setShowFieldSelector(false);
                        }}
                        className='justify-between'
                      >
                        <span className='truncate'>
                          {column.columnDef.meta?.label}
                        </span>
                        <Check
                          className={cn(
                            column.id === filter.id
                              ? 'opacity-100'
                              : 'opacity-0'
                          )}
                        />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <Select
            open={showOperatorSelector}
            onOpenChange={setShowOperatorSelector}
            value={filter.operator}
            onValueChange={(value: FilterOperator) =>
              onFilterUpdate(filter.filterId, {
                operator: value,
                value:
                  value === 'isEmpty' || value === 'isNotEmpty'
                    ? ''
                    : filter.value,
              })
            }
          >
            <SelectTrigger
              aria-controls={operatorListboxId}
              size='sm'
              className='!h-8 w-full rounded bg-transparent lowercase shadow-xs hover:shadow-sm md:w-32'
            >
              <div className='truncate'>
                <SelectValue placeholder={filter.operator} />
              </div>
            </SelectTrigger>
            <SelectContent id={operatorListboxId}>
              {filterOperators.map((operator) => (
                <SelectItem
                  key={operator.value}
                  value={operator.value}
                  className='lowercase'
                >
                  {operator.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className='min-w-36 max-w-60 flex-1'>
            <FilterInput
              filter={filter}
              inputId={inputId}
              column={column}
              columnMeta={columnMeta}
              onFilterUpdate={onFilterUpdate}
              showValueSelector={showValueSelector}
              setShowValueSelector={setShowValueSelector}
            />
          </div>
        </div>

        <Button
          aria-controls={filterItemId}
          variant='destructiveGhost'
          size='icon'
          className='size-8 rounded text-muted-foreground hover:text-destructive'
          onClick={() => onFilterRemove(filter.filterId)}
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
