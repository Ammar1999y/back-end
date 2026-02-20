import type { DateRange } from '../hooks/use-date-range-state';

import { memo } from 'react';

import { DateInput } from '@/components/ui/date/date-input';

interface DateRangeInputsProps {
  range: DateRange;
  onRangeChange: (range: DateRange | ((prev: DateRange) => DateRange)) => void;
}

export const DateRangeInputs = memo<DateRangeInputsProps>(
  ({ range, onRangeChange }) => (
    <div className='flex justify-around space-x-2'>
      <DateInput
        value={range.from}
        onChange={(date) => {
          const toDate = range.to == null || date > range.to ? date : range.to;
          onRangeChange((prevRange) => ({
            ...prevRange,
            from: date,
            to: toDate,
          }));
        }}
      />
      <DateInput
        value={range.to}
        onChange={(date) => {
          const fromDate = range.from
            ? Math.min(date.getTime(), range.from.getTime())
            : date.getTime();
          onRangeChange((prevRange) => ({
            ...prevRange,
            from: new Date(fromDate),
            to: new Date(date),
          }));
        }}
      />
    </div>
  )
);

DateRangeInputs.displayName = 'DateRangeInputs';
