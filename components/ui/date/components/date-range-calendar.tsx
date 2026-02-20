import type { DateRange } from '../hooks/use-date-range-state';

import { memo } from 'react';

import { Calendar } from '@/components/ui/calendar';

interface DateRangeCalendarProps {
  range: DateRange;
  isSmallScreen: boolean;
  month: Date;
  onMonthChange: (month: Date) => void;
  onRangeChange: (range: DateRange | ((prev: DateRange) => DateRange)) => void;
}

export const DateRangeCalendar = memo<DateRangeCalendarProps>(
  ({ range, isSmallScreen, month, onMonthChange, onRangeChange }) => (
    <Calendar
      mode='range'
      onSelect={(value: { from?: Date; to?: Date } | undefined) => {
        if (value?.from != null) {
          onRangeChange({ from: value.from, to: value?.to });
        }
      }}
      month={month}
      onMonthChange={onMonthChange}
      selected={range}
      numberOfMonths={isSmallScreen ? 1 : 2}
      className='mx-auto p-0 pt-2 lg:pe-2'
      defaultMonth={
        new Date(
          new Date().setMonth(new Date().getMonth() - (isSmallScreen ? 0 : 1))
        )
      }
    />
  )
);

DateRangeCalendar.displayName = 'DateRangeCalendar';
