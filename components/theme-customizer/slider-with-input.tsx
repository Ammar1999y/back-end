import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { Input } from '@/components/ui/input';
import Label from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';

export const SliderWithInput = memo(
  ({
    value,
    onChange,
    min,
    max,
    step = 1,
    label,
    unit,
  }: {
    value: number;
    onChange: (value: number) => void;
    min: number;
    max: number;
    step?: number;
    label: string;
    unit?: string;
  }) => {
    const [localValue, setLocalValue] = useState(value.toString());

    // Memoize the normalized label ID
    const labelId = useMemo(
      () => label.replace(/\s+/g, '-').toLowerCase(),
      [label]
    );

    useEffect(() => {
      setLocalValue(value.toString());
    }, [value]);

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const raw = e.target.value;
        setLocalValue(raw);
        const num = Number.parseFloat(raw.replace(',', '.'));
        if (!Number.isNaN(num)) {
          onChange(Math.max(min, Math.min(max, num)));
        }
      },
      [min, max, onChange]
    );

    const handleBlur = useCallback(() => {
      setLocalValue(value.toString());
    }, [value]);

    const handleSliderChange = useCallback(
      (values: number[]) => {
        const newValue = values[0];
        setLocalValue(newValue.toString());
        onChange(newValue);
      },
      [onChange]
    );

    return (
      <div className='mb-3'>
        <div className='mb-1.5 flex items-center justify-between'>
          <Label
            htmlFor={`input-${labelId}`}
            className='mb-0 font-medium'
            title={label}
          />
          <div className='flex items-center space-x-1'>
            <Input
              id={`input-${labelId}`}
              type='number'
              value={localValue}
              onChange={handleChange}
              onBlur={handleBlur}
              min={min}
              max={max}
              step={step}
              className='w-18 !h-7 px-2 text-xs'
            />
            {!!unit && (
              <span className='text-xs text-muted-foreground'>{unit}</span>
            )}
          </div>
        </div>
        <Slider
          value={[value]}
          min={min}
          max={max}
          step={step}
          onValueChange={handleSliderChange}
          className='py-1'
        />
      </div>
    );
  }
);

SliderWithInput.displayName = 'SliderWithInput';
