'use client';

import type {
  ExtendedColumnFilter,
  FilterOperator,
  FilterVariant,
} from '@/types/data-table';
import type { Column } from '@tanstack/react-table';

import { memo, useCallback, useId, useState } from 'react';

import { Filter } from 'lucide-react';

import { useDataTableStore } from '@/utils/store/data-table-store';

import { Button } from '../../button';
import { Popover, PopoverContent, PopoverTrigger } from '../../popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../select';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../tooltip';
import {
  getDefaultFilterOperator,
  getFilterOperators,
} from '../utils/data-table';
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

interface ColumnFilterPopoverProps<TData> {
  column: Column<TData>;
}

function ColumnFilterPopoverInner<TData>({
  column,
}: ColumnFilterPopoverProps<TData>) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [showValueSelector, setShowValueSelector] = useState(false);

  const columnId = column.id;
  const variant: FilterVariant = column.columnDef.meta?.variant ?? 'text';
  const filterOperators = getFilterOperators(variant);

  const [draftOperator, setDraftOperator] = useState<FilterOperator>(
    getDefaultFilterOperator(variant)
  );
  const [draftValue, setDraftValue] = useState<string | string[]>('');
  const [draftFilterId, setDraftFilterId] = useState('');

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        const filters = useDataTableStore.getState()
          .filters as ExtendedColumnFilter<TData>[];
        const existing = filters.find((f) => f.id === columnId);
        if (existing) {
          setDraftOperator(existing.operator);
          setDraftValue(existing.value);
          setDraftFilterId(existing.filterId);
        } else {
          setDraftOperator(getDefaultFilterOperator(variant));
          setDraftValue('');
          setDraftFilterId('');
        }
      }
      setOpen(nextOpen);
    },
    [columnId, variant]
  );

  const onDraftUpdate = useCallback(
    (
      _filterId: string,
      updates: Partial<Omit<ExtendedColumnFilter<TData>, 'filterId'>>
    ) => {
      if (updates.operator !== undefined) {
        setDraftOperator(updates.operator);
      }
      if (updates.value !== undefined) {
        setDraftValue(updates.value);
      }
    },
    []
  );

  const onApply = useCallback(() => {
    const { setFilters } = useDataTableStore.getState().actions;
    const filters = [
      ...(useDataTableStore.getState()
        .filters as ExtendedColumnFilter<TData>[]),
    ];

    const existingIndex = filters.findIndex((f) => f.id === columnId);

    const newFilter: ExtendedColumnFilter<TData> = {
      id: columnId as Extract<keyof TData, string>,
      value: draftValue,
      variant,
      operator: draftOperator,
      filterId: draftFilterId || generateId({ length: 8 }),
    };

    if (existingIndex !== -1) {
      filters[existingIndex] = newFilter;
    } else {
      filters.push(newFilter);
    }

    setFilters(filters);
    setOpen(false);
  }, [columnId, variant, draftOperator, draftValue, draftFilterId]);

  const onReset = useCallback(() => {
    const { setFilters } = useDataTableStore.getState().actions;
    const filters = (
      useDataTableStore.getState().filters as ExtendedColumnFilter<TData>[]
    ).filter((f) => f.id !== columnId);

    setFilters(filters.length > 0 ? filters : null);
    setDraftOperator(getDefaultFilterOperator(variant));
    setDraftValue('');
    setDraftFilterId('');
    setOpen(false);
  }, [columnId, variant]);

  const draftFilter: ExtendedColumnFilter<TData> = {
    id: columnId as Extract<keyof TData, string>,
    value: draftValue,
    variant,
    operator: draftOperator,
    filterId: draftFilterId || 'draft',
  };

  const stopPropagation = useCallback(
    (e: React.PointerEvent) => e.stopPropagation(),
    []
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type='button'
              variant='ghost'
              className='h-7 w-7 shrink-0 rounded bg-accent p-1 text-accent-foreground opacity-0 transition-opacity duration-200 hover:!opacity-100 group-hover/header:opacity-80 touch:opacity-80'
              onPointerDown={stopPropagation}
            >
              <Filter className='size-4' />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p className='text-sm'>بحث/تصفية</p>
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align='start'
        className='flex w-64 flex-col gap-3 p-3'
        onPointerDown={stopPropagation}
      >
        <Select
          value={draftOperator}
          onValueChange={(value: FilterOperator) => {
            setDraftOperator(value);
            if (value === 'isEmpty' || value === 'isNotEmpty') {
              setDraftValue('');
            }
          }}
        >
          <SelectTrigger
            size='sm'
            className='!h-8 w-full rounded bg-transparent lowercase shadow-xs'
          >
            <div className='truncate'>
              <SelectValue placeholder={draftOperator} />
            </div>
          </SelectTrigger>
          <SelectContent>
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

        <FilterInput
          filter={draftFilter}
          inputId={inputId}
          column={column}
          columnMeta={column.columnDef.meta}
          onFilterUpdate={onDraftUpdate}
          showValueSelector={showValueSelector}
          setShowValueSelector={setShowValueSelector}
        />

        <div className='flex items-center justify-between gap-2 border-t pt-3'>
          <Button
            variant='outline'
            size='sm'
            className='rounded text-sm'
            onClick={onReset}
          >
            إعادة تعيين
          </Button>
          <Button size='sm' className='rounded text-sm' onClick={onApply}>
            تطبيق
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const ColumnFilterPopover = memo(ColumnFilterPopoverInner);
ColumnFilterPopover.displayName = 'ColumnFilterPopover';

export { ColumnFilterPopover };
