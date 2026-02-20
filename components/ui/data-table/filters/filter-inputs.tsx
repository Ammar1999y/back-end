import type { ExtendedColumnFilter } from '@/types/data-table';
import type { Column, ColumnMeta } from '@tanstack/react-table';

import { cn } from '@/lib/utils';

import { DateRangePicker } from '@/components/ui/date/rang';
import { SingleDatePicker } from '@/components/ui/date/single';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { Button } from '../../button';
import { DataTableRangeFilter } from './data-table-range-filter';
import {
  Faceted,
  FacetedBadgeList,
  FacetedContent,
  FacetedEmpty,
  FacetedGroup,
  FacetedInput,
  FacetedItem,
  FacetedList,
  FacetedTrigger,
} from './faceted';

export interface FilterInputProps<TData> {
  filter: ExtendedColumnFilter<TData>;
  inputId: string;
  column: Column<TData>;
  columnMeta?: ColumnMeta<TData, unknown>;
  onFilterUpdate: (
    filterId: string,
    updates: Partial<Omit<ExtendedColumnFilter<TData>, 'filterId'>>
  ) => void;
  showValueSelector?: boolean;
  setShowValueSelector?: (value: boolean) => void;
}

function FilterEmptyState<TData>({
  inputId,
  columnMeta,
  filter,
}: Pick<FilterInputProps<TData>, 'inputId' | 'columnMeta' | 'filter'>) {
  return (
    <div
      id={inputId}
      role='status'
      aria-label={`${columnMeta?.label} filter is ${
        filter.operator === 'isEmpty' ? 'empty' : 'not empty'
      }`}
      aria-live='polite'
      className='h-8 w-full'
    />
  );
}

function FilterTextInput<TData>({
  filter,
  inputId,
  columnMeta,
  onFilterUpdate,
}: FilterInputProps<TData>) {
  const isNumber = filter.variant === 'number' || filter.variant === 'range';

  return (
    <Input
      id={inputId}
      type={isNumber ? 'number' : 'text'}
      aria-label={`${columnMeta?.label} filter value`}
      aria-describedby={`${inputId}-description`}
      inputMode={isNumber ? 'numeric' : undefined}
      placeholder={columnMeta?.placeholder ?? 'أدخل قيمة...'}
      className='!h-8 w-full rounded bg-transparent text-sm shadow-xs hover:shadow-sm'
      defaultValue={typeof filter.value === 'string' ? filter.value : undefined}
      onChange={(event) =>
        onFilterUpdate(filter.filterId, {
          value: event.target.value,
        })
      }
    />
  );
}

function FilterBooleanSelect<TData>({
  filter,
  inputId,
  columnMeta,
  onFilterUpdate,
  showValueSelector,
  setShowValueSelector,
}: FilterInputProps<TData>) {
  if (Array.isArray(filter.value)) return null;

  const inputListboxId = `${inputId}-listbox`;

  return (
    <Select
      open={showValueSelector}
      onOpenChange={setShowValueSelector}
      value={filter.value}
      onValueChange={(value) => onFilterUpdate(filter.filterId, { value })}
    >
      <SelectTrigger
        id={inputId}
        aria-controls={inputListboxId}
        aria-label={`${columnMeta?.label} boolean filter`}
        size='sm'
        className='!h-8 w-full rounded shadow-xs hover:shadow-sm'
      >
        <SelectValue placeholder={filter.value ? 'نعم' : 'لا'} />
      </SelectTrigger>
      <SelectContent id={inputListboxId}>
        <SelectItem value='true'>نعم</SelectItem>
        <SelectItem value='false'>لا</SelectItem>
      </SelectContent>
    </Select>
  );
}

function FilterFacetedSelect<TData>({
  filter,
  inputId,
  columnMeta,
  onFilterUpdate,
  showValueSelector,
  setShowValueSelector,
}: FilterInputProps<TData>) {
  const inputListboxId = `${inputId}-listbox`;
  const multiple = filter.variant === 'multiSelect';

  const selectedValues = multiple
    ? Array.isArray(filter.value)
      ? filter.value
      : []
    : typeof filter.value === 'string'
      ? filter.value
      : undefined;

  return (
    <Faceted
      open={showValueSelector}
      onOpenChange={setShowValueSelector}
      value={selectedValues}
      onValueChange={(value) => onFilterUpdate(filter.filterId, { value })}
      multiple={multiple}
    >
      <FacetedTrigger asChild>
        <Button
          id={inputId}
          aria-controls={inputListboxId}
          aria-label={`${columnMeta?.label} filter value${multiple ? 's' : ''}`}
          variant='none'
          size='none'
          className='h-8 w-full min-w-0 justify-between rounded border bg-transparent px-3 py-1 text-sm font-normal shadow-xs hover:shadow-sm dark:bg-input/30 hover:dark:bg-input/45'
        >
          <FacetedBadgeList
            options={columnMeta?.options}
            placeholder={
              columnMeta?.placeholder ??
              `اختر ${multiple ? 'خيارات' : 'خيار'}...`
            }
          />
        </Button>
      </FacetedTrigger>
      <FacetedContent id={inputListboxId} className='w-52'>
        <FacetedInput
          aria-label={`Search ${columnMeta?.label} options`}
          placeholder={columnMeta?.placeholder ?? 'ابحث عن خيار...'}
        />
        <FacetedList>
          <FacetedEmpty>لا توجد خيارات.</FacetedEmpty>
          <FacetedGroup>
            {columnMeta?.options?.map((option) => (
              <FacetedItem key={option.value} value={option.value}>
                <span>{option.label}</span>
                {option.count && (
                  <span className='ms-auto font-mono text-xs'>
                    {option.count}
                  </span>
                )}
              </FacetedItem>
            ))}
          </FacetedGroup>
        </FacetedList>
      </FacetedContent>
    </Faceted>
  );
}

function FilterDateInput<TData>({
  filter,
  onFilterUpdate,
}: FilterInputProps<TData>) {
  const dateValue = Array.isArray(filter.value)
    ? filter.value.filter(Boolean)
    : [filter.value, filter.value].filter(Boolean);

  if (filter.operator === 'isBetween') {
    const startDate = dateValue[0] ? new Date(Number(dateValue[0])) : undefined;
    const endDate = dateValue[1] ? new Date(Number(dateValue[1])) : undefined;

    return (
      <DateRangePicker
        initialDateFrom={startDate}
        initialDateTo={endDate}
        align='start'
        placeholder='اختر تاريخ'
        triggerClassName={cn(
          'h-8 w-full min-w-0 justify-start rounded border bg-transparent px-3 py-1 text-sm font-normal shadow-xs hover:shadow-sm dark:bg-input/30 hover:dark:bg-input/45',
          !filter.value && 'text-muted-foreground'
        )}
        onChange={(range) => {
          onFilterUpdate(filter.filterId, {
            value: range.from
              ? [
                  (range.from.getTime() ?? '').toString(),
                  (range.to?.getTime() ?? '').toString(),
                ]
              : [],
          });
        }}
      />
    );
  }

  const startDate = dateValue[0] ? new Date(Number(dateValue[0])) : undefined;

  return (
    <SingleDatePicker
      initialDate={startDate}
      align='start'
      placeholder='اختر تاريخ'
      triggerClassName={cn(
        'h-8 w-full min-w-0 justify-start rounded border bg-transparent px-3 py-1 text-sm font-normal shadow-xs hover:shadow-sm dark:bg-input/30 hover:dark:bg-input/45',
        !filter.value && 'text-muted-foreground'
      )}
      onChange={(date) => {
        onFilterUpdate(filter.filterId, {
          value: (date?.getTime() ?? '').toString(),
        });
      }}
    />
  );
}

function FilterInput<TData>(props: FilterInputProps<TData>) {
  const { filter, inputId, column, onFilterUpdate } = props;

  if (filter.operator === 'isEmpty' || filter.operator === 'isNotEmpty') {
    return <FilterEmptyState {...props} />;
  }

  switch (filter.variant) {
    case 'text':
    case 'number':
    case 'range': {
      if (
        (filter.variant === 'range' && filter.operator === 'isBetween') ||
        filter.operator === 'isBetween'
      ) {
        return (
          <DataTableRangeFilter
            filter={filter}
            column={column}
            inputId={inputId}
            onFilterUpdate={onFilterUpdate}
          />
        );
      }
      return <FilterTextInput {...props} />;
    }
    case 'boolean':
      return <FilterBooleanSelect {...props} />;
    case 'select':
    case 'multiSelect':
      return <FilterFacetedSelect {...props} />;
    case 'date':
      return <FilterDateInput {...props} />;
    default:
      return null;
  }
}

export {
  FilterInput,
  FilterEmptyState,
  FilterTextInput,
  FilterBooleanSelect,
  FilterFacetedSelect,
  FilterDateInput,
};
