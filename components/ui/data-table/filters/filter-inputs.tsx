import type { ExtendedColumnFilter } from '@/types/data-table';
import type { Column, ColumnMeta } from '@tanstack/react-table';

import { cn } from '@/lib/utils';
import { calendarDayInZone, safeDate } from '@/utils/time';

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

/**
 * Date filters travel as a plain `YYYY-MM-DD` calendar day, not as an instant.
 * Sending `getTime()` meant sending *local* midnight, which the server then
 * re-bounded in its own timezone — so a picked day could query the previous or
 * next one. The server resolves the calendar day in the configured business
 * timezone (see `BUSINESS_TIMEZONE`).
 */
function toCalendarDateValue(date: Date | undefined): string {
  if (!date) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parse a calendar day back into a local Date for the picker's display. */
function fromCalendarDateValue(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) {
    const [year, month, day] = [match[1], match[2], match[3]].map(Number);
    const parsed = new Date(year, month - 1, day);
    // Round-trip check: `new Date(2026, 1, 30)` rolls over to Mar 2, so a
    // malformed bookmarked value rendered as a real (wrong) day while the
    // server correctly rejected it with 422. Show nothing rather than a date
    // the server will not accept.
    return parsed.getFullYear() === year &&
      parsed.getMonth() === month - 1 &&
      parsed.getDate() === day
      ? parsed
      : undefined;
  }

  // Legacy epoch-ms value from a bookmarked URL. Resolve it to a calendar day
  // the SAME way the server does — in the business timezone — so the picker
  // never shows a different day from the one being filtered on.
  //
  // `safeDate`, not `Number.isFinite`: a finite-but-out-of-range epoch (1e20)
  // yields an Invalid Date, and formatting one throws a RangeError that takes
  // the whole filter UI down during render.
  const parsed = safeDate(Number(value));
  if (!parsed) return undefined;
  const [year, month, day] = calendarDayInZone(parsed).split('-').map(Number);
  return new Date(year, month - 1, day);
}

function FilterDateInput<TData>({
  filter,
  onFilterUpdate,
}: FilterInputProps<TData>) {
  // Positions are preserved here for the same reason the parser preserves
  // them: `isBetween` is a [lower, upper] tuple, so compacting turned
  // ["", "2026-08-05"] — "up to Aug 5" — into a lower bound of Aug 5.
  const dateValue = Array.isArray(filter.value)
    ? filter.value
    : [filter.value, filter.value];

  if (filter.operator === 'isBetween') {
    const startDate = fromCalendarDateValue(dateValue[0]);
    const endDate = fromCalendarDateValue(dateValue[1]);

    return (
      <DateRangePicker
        // Keyed on the column. Both date pickers read `initialDate*` only in
        // their `useState` initialiser and never resync, and switching a
        // filter's column keeps the same row (same `filterId`) while resetting
        // its value — so the previous column's date stayed visible in the
        // picker and could be re-applied to the new column. Remounting is the
        // safe fix here: syncing inside the hooks risks clobbering an edit
        // that is in progress while the popover is open.
        key={filter.id}
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
            // Gated on EITHER bound. Checking only `range.from` discarded an
            // upper-only range entirely on save, so reading the tuple
            // correctly wasn't enough — it was thrown away on the way out.
            value:
              range.from || range.to
                ? [
                    toCalendarDateValue(range.from),
                    toCalendarDateValue(range.to),
                  ]
                : [],
          });
        }}
      />
    );
  }

  const startDate = fromCalendarDateValue(dateValue[0]);

  return (
    <SingleDatePicker
      // See the range picker above — same stale-initial-prop remount.
      key={filter.id}
      initialDate={startDate}
      align='start'
      placeholder='اختر تاريخ'
      triggerClassName={cn(
        'h-8 w-full min-w-0 justify-start rounded border bg-transparent px-3 py-1 text-sm font-normal shadow-xs hover:shadow-sm dark:bg-input/30 hover:dark:bg-input/45',
        !filter.value && 'text-muted-foreground'
      )}
      onChange={(date) => {
        onFilterUpdate(filter.filterId, {
          value: toCalendarDateValue(date),
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
