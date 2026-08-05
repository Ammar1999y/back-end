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
      {/* Editing one bound must never INVENT the other. An open-ended range
          ("from Aug 1 onwards" / "up to Aug 5") is a meaningful filter the
          server supports, and materialising the missing side silently
          collapsed it to a single day — changing what the filter means
          without the user touching that side. Clamping still applies when
          both bounds actually exist. */}
      <DateInput
        value={range.from}
        onChange={(date) => {
          // Clearing removes ONLY this bound; the other side stays put.
          if (!date) {
            onRangeChange((prevRange) => ({ ...prevRange, from: undefined }));
            return;
          }
          const toDate =
            range.to == null
              ? null
              : new Date(Math.max(date.getTime(), range.to.getTime()));
          onRangeChange((prevRange) => ({
            ...prevRange,
            from: date,
            ...(toDate === null ? {} : { to: toDate }),
          }));
        }}
      />
      <DateInput
        value={range.to}
        onChange={(date) => {
          if (!date) {
            onRangeChange((prevRange) => ({ ...prevRange, to: undefined }));
            return;
          }
          const fromDate = range.from
            ? new Date(Math.min(date.getTime(), range.from.getTime()))
            : null;
          onRangeChange((prevRange) => ({
            ...prevRange,
            ...(fromDate === null ? {} : { from: fromDate }),
            to: new Date(date),
          }));
        }}
      />
    </div>
  )
);

DateRangeInputs.displayName = 'DateRangeInputs';
