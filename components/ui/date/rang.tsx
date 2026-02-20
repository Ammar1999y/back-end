import type { FC } from 'react';

import { memo } from 'react';

import { cn } from '@/lib/utils';

import { Popover, PopoverContent } from '@/components/ui/popover';

import { DateRangeActions } from './components/date-range-actions';
import { DateRangeCalendar } from './components/date-range-calendar';
import { DateRangeInputs } from './components/date-range-inputs';
import { DateRangeTrigger } from './components/date-range-trigger';
import { PresetList } from './components/preset-list';
import { PresetSelect } from './components/preset-select';
import { useDateRangeState } from './hooks/use-date-range-state';
import { formatDate } from './utils';

export interface DateRangePickerProps {
  initialDateFrom?: Date | string;
  initialDateTo?: Date | string;
  align?: 'start' | 'center' | 'end';
  locale?: string;
  onChange?: (range: { from: Date | undefined; to: Date | undefined }) => void;
  title?: string;
  triggerClassName?: string;
  contentClassName?: string;
  placeholder?: string;
  showIcon?: boolean;
}

export const DateRangePicker: FC<DateRangePickerProps> & {
  filePath?: string;
} = memo(
  ({
    initialDateFrom,
    initialDateTo,
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
      range,
      setRange,
      month,
      setMonth,
      selectedPreset,
      setPreset,
      isSmallScreen,
      handleOpenChange,
      handleSave,
      handleCancel,
    } = useDateRangeState({ initialDateFrom, initialDateTo, onChange });

    return (
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <DateRangeTrigger
          range={range}
          locale={locale}
          triggerClassName={triggerClassName}
          placeholder={placeholder}
          title={title}
          showIcon={showIcon}
          formatDate={formatDate}
        />
        <PopoverContent
          align={align}
          className={cn('w-auto px-3 py-5', contentClassName)}
        >
          <div className='flex'>
            {!isSmallScreen && (
              <PresetList
                selectedPreset={selectedPreset}
                onPresetSelect={setPreset}
              />
            )}
            <div className='flex flex-col'>
              <DateRangeInputs range={range} onRangeChange={setRange} />
              {isSmallScreen && (
                <PresetSelect
                  selectedPreset={selectedPreset}
                  onPresetSelect={setPreset}
                />
              )}
              <div>
                <DateRangeCalendar
                  range={range}
                  isSmallScreen={isSmallScreen}
                  month={month}
                  onMonthChange={setMonth}
                  onRangeChange={setRange}
                />
              </div>
            </div>
          </div>
          <DateRangeActions onCancel={handleCancel} onSave={handleSave} />
        </PopoverContent>
      </Popover>
    );
  }
);

DateRangePicker.displayName = 'DateRangePicker';

export default DateRangePicker;
