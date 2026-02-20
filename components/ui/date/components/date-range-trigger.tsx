import type { DateRange } from '../hooks/use-date-range-state';

import { memo } from 'react';

import { CalendarIcon, ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

import { PopoverTrigger } from '../../popover';

interface DateRangeTriggerProps {
  range: DateRange;
  locale: string;
  triggerClassName?: string;
  placeholder?: string;
  title?: string;
  showIcon?: boolean;
  formatDate: (date: Date, locale: string) => string;
}

export const DateRangeTrigger = memo<DateRangeTriggerProps>(
  ({
    range,
    locale,
    triggerClassName,
    placeholder,
    title,
    showIcon,
    formatDate,
  }) => {
    const getDisplayText = () => {
      if (range.from && range.to) {
        const fromText = formatDate(range.from, locale);
        const toText = formatDate(range.to, locale);
        return fromText === toText ? fromText : `${fromText} - ${toText}`;
      }
      if (range.from) return formatDate(range.from, locale);
      return placeholder || title || 'اختر التاريخ';
    };

    return (
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn('relative flex h-9 items-center', triggerClassName)}
          aria-label='اختر التاريخ'
        >
          {showIcon && (
            <CalendarIcon className='absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground' />
          )}
          <div
            className={cn(
              'flex h-full w-full items-center justify-between',
              !triggerClassName &&
                'rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground'
            )}
          >
            <span className='truncate text-right'>{getDisplayText()}</span>
            {!triggerClassName && (
              <ChevronDownIcon className='ml-2 h-4 w-4 opacity-50' />
            )}
          </div>
        </button>
      </PopoverTrigger>
    );
  }
);

DateRangeTrigger.displayName = 'DateRangeTrigger';
