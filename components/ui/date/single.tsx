import type { FC } from 'react';

import { memo, useCallback } from 'react';

import { CalendarIcon, ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

import { DateInput } from './date-input';
import { useSingleDateState } from './hooks/use-single-date-state';
import { formatDate } from './utils';

export interface SingleDatePickerProps {
  initialDate?: Date | string;
  align?: 'start' | 'center' | 'end';
  locale?: string;
  onChange?: (date: Date | undefined) => void;
  title?: string;
  triggerClassName?: string;
  contentClassName?: string;
  placeholder?: string;
  showIcon?: boolean;
}

export const SingleDatePicker: FC<SingleDatePickerProps> = memo(
  ({
    initialDate,
    align = 'center',
    locale = 'ar-u-ca-gregory',
    onChange,
    title,
    triggerClassName,
    contentClassName,
    placeholder,
    showIcon = false,
  }) => {
    const {
      isOpen,
      date,
      setDate,
      month,
      setMonth,
      handleOpenChange,
      handleSave,
      handleCancel,
    } = useSingleDateState({ initialDate, onChange });

    const displayText = date
      ? formatDate(date, locale)
      : placeholder || title || 'اختر التاريخ';

    const handleSelect = useCallback(
      (value: Date | undefined) => {
        if (value) {
          setDate(value);
        }
      },
      [setDate]
    );

    return (
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
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
              <span className='truncate text-right'>{displayText}</span>
              {!triggerClassName && (
                <ChevronDownIcon className='ml-2 h-4 w-4 opacity-50' />
              )}
            </div>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align={align}
          className={cn('w-auto px-3 py-5', contentClassName)}
        >
          <div className='flex flex-col'>
            <div className='flex justify-center'>
              <DateInput value={date} onChange={setDate} />
            </div>
            <Calendar
              mode='single'
              selected={date}
              onSelect={handleSelect}
              month={month}
              onMonthChange={setMonth}
              numberOfMonths={1}
              className='mx-auto p-0 pt-2'
            />
          </div>
          <div className='flex justify-end pb-2 pr-4 pt-4 space-x-2'>
            <Button onClick={handleCancel} variant='ghost'>
              الغاء
            </Button>
            <Button onClick={handleSave}>حفظ</Button>
          </div>
        </PopoverContent>
      </Popover>
    );
  }
);

SingleDatePicker.displayName = 'SingleDatePicker';

export default SingleDatePicker;
