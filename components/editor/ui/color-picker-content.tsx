'use client';

import type { ChangeEvent } from 'react';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { HexAlphaColorPicker, HexColorPicker } from 'react-colorful';
import { cn } from '@/lib/utils';

import {
  hexToRgb,
  hexToRgba,
  hslaToRgba,
  hslToRgb,
  rgbaToHex,
  rgbaToHsla,
  rgbToHex,
  rgbToHsl,
} from '@/utils/color-converter';
import { getColorSchema } from '@/utils/validation/rules';

import styles from '@/components/ui/color-picker.module.css';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface ColorPickerContentProps {
  value?: string;
  onChange?: (value: string) => void;
  onBlur?: () => void;
  className?: string;
  alpha?: boolean;
}

interface ColorValues {
  hex: string;
  rgb: { r: number; g: number; b: number };
  hsl: { h: number; s: number; l: number };
  rgba?: { r: number; g: number; b: number; a: number };
  hsla?: { h: number; s: number; l: number; a: number };
}

const defaultColor = '#FF0000';

export const ColorPickerContent = memo(
  ({
    value,
    onChange,
    onBlur,
    className = '',
    alpha = true,
  }: ColorPickerContentProps) => {
    const [colorFormat, setColorFormat] = useState('HEX');
    const [colorValues, setColorValues] = useState<ColorValues>(() => {
      if (alpha) {
        const rgba = hexToRgba(value || defaultColor);
        const hsla = rgbaToHsla(rgba.r, rgba.g, rgba.b, rgba.a);
        return {
          hex: value || defaultColor.slice(0, 7),
          rgb: { r: rgba.r, g: rgba.g, b: rgba.b },
          hsl: rgbToHsl(rgba.r, rgba.g, rgba.b),
          rgba,
          hsla,
        };
      } else {
        const rgb = hexToRgb(value || defaultColor);
        const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
        return {
          hex: value || defaultColor,
          rgb,
          hsl,
        };
      }
    });

    const [hexInputValue, setHexInputValue] = useState<string>(
      value || defaultColor
    );

    // Max length for hex input memoized
    const maxLength = useMemo(() => (alpha ? 9 : 7), [alpha]);

    // Update all color formats when color changes
    const updateColorValues = useCallback(
      (newColor: string) => {
        if (alpha) {
          const rgba = hexToRgba(newColor);
          const hsla = rgbaToHsla(rgba.r, rgba.g, rgba.b, rgba.a);
          setColorValues({
            hex: newColor.length === 9 ? newColor.slice(0, 7) : newColor,
            rgb: { r: rgba.r, g: rgba.g, b: rgba.b },
            hsl: rgbToHsl(rgba.r, rgba.g, rgba.b),
            rgba,
            hsla,
          });
          setHexInputValue(newColor.toUpperCase());
        } else {
          const rgb = hexToRgb(newColor);
          const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
          setColorValues({
            hex: newColor.toUpperCase(),
            rgb,
            hsl,
          });
          setHexInputValue(newColor.toUpperCase());
        }
      },
      [alpha]
    );

    // Handle color picker change
    const handleColorChange = useCallback(
      (newColor: string) => {
        updateColorValues(newColor);
        onChange?.(newColor);
      },
      [updateColorValues, onChange]
    );

    // Handle HEX input change
    const handleHexChange = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        let formattedValue = e.target.value.toUpperCase();
        if (!formattedValue.startsWith('#')) {
          formattedValue = '#' + formattedValue;
        }

        if (
          formattedValue.length <= maxLength &&
          /^#[0-9A-Fa-f]*$/.test(formattedValue)
        ) {
          setHexInputValue(formattedValue);

          // Only update color if it's valid
          try {
            if (formattedValue.length === maxLength) {
              getColorSchema().parse(formattedValue);
              onChange?.(formattedValue);
              updateColorValues(formattedValue);
            }
          } catch {
            // Invalid color, will be reset on blur
          }
        }
      },
      [maxLength, onChange, updateColorValues]
    );

    // Validate and reset to default if invalid
    const validateAndResetColor = useCallback(() => {
      try {
        getColorSchema().parse(hexInputValue);
      } catch {
        // Invalid color, reset to default red
        onChange?.(defaultColor);
        updateColorValues(defaultColor);
        setHexInputValue(defaultColor);
      }
    }, [hexInputValue, onChange, updateColorValues]);

    // Handle RGB/RGBA input change
    const handleRgbChange = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        const component = e.target.name;
        const inputValue = e.target.value;

        const numValue = Number.parseFloat(inputValue) || 0;
        const clampedValue =
          component === 'a' && alpha && colorValues.rgba
            ? Math.max(0, Math.min(1, numValue))
            : Math.max(0, Math.min(255, Math.floor(numValue)));
        if (alpha && colorValues.rgba) {
          const newRgba = { ...colorValues.rgba, [component]: clampedValue };
          const hex = rgbaToHex(newRgba.r, newRgba.g, newRgba.b, newRgba.a);
          const hsla = rgbaToHsla(newRgba.r, newRgba.g, newRgba.b, newRgba.a);

          setColorValues({
            ...colorValues,
            hex: hex.slice(0, 7),
            rgb: { r: newRgba.r, g: newRgba.g, b: newRgba.b },
            hsl: rgbToHsl(newRgba.r, newRgba.g, newRgba.b),
            rgba: newRgba,
            hsla,
          });
          onChange?.(hex);
          return;
        }

        const newRgb = { ...colorValues.rgb, [component]: clampedValue };
        const hex = rgbToHex(newRgb.r, newRgb.g, newRgb.b);
        const hsl = rgbToHsl(newRgb.r, newRgb.g, newRgb.b);

        setColorValues({ ...colorValues, hex, rgb: newRgb, hsl });
        onChange?.(hex);
      },
      [alpha, colorValues, onChange]
    );

    // Handle HSL/HSLA input change
    const handleHslChange = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        const component = e.target.name;
        const inputValue = e.target.value;

        const numValue = Number.parseFloat(inputValue) || 0;
        // Handle alpha mode
        let clampedValue: number;

        if (component === 'a' && alpha && colorValues.hsla)
          clampedValue = Math.max(0, Math.min(1, numValue));
        else if (component === 'h')
          clampedValue = Math.max(0, Math.min(360, numValue));
        else clampedValue = Math.max(0, Math.min(100, numValue));

        if (alpha && colorValues.hsla) {
          const newHsla = { ...colorValues.hsla, [component]: clampedValue };
          const rgba = hslaToRgba(newHsla.h, newHsla.s, newHsla.l, newHsla.a);
          const hex = rgbaToHex(rgba.r, rgba.g, rgba.b, rgba.a);

          setColorValues({
            ...colorValues,
            hex: hex.slice(0, 7),
            rgb: { r: rgba.r, g: rgba.g, b: rgba.b },
            hsl: { h: newHsla.h, s: newHsla.s, l: newHsla.l },
            rgba,
            hsla: newHsla,
          });
          onChange?.(hex);
          return;
        }

        const newHsl = { ...colorValues.hsl, [component]: clampedValue };
        const rgb = hslToRgb(newHsl.h, newHsl.s, newHsl.l);
        const hex = rgbToHex(rgb.r, rgb.g, rgb.b);

        setColorValues({ ...colorValues, hex, rgb, hsl: newHsl });
        onChange?.(hex);
      },
      [alpha, colorValues, onChange]
    );

    // Handle close/blur
    const handleBlur = useCallback(() => {
      validateAndResetColor();
      setColorFormat('HEX');
      onBlur?.();
    }, [validateAndResetColor, onBlur]);

    useEffect(() => {
      updateColorValues(value || defaultColor);
      setHexInputValue((value || defaultColor).toUpperCase());
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    // Get current hex value for display
    const getCurrentHexValue = useMemo(() => {
      if (colorFormat === 'HEX') {
        return hexInputValue;
      }
      if (alpha && colorValues.rgba) {
        return rgbaToHex(
          colorValues.rgba.r,
          colorValues.rgba.g,
          colorValues.rgba.b,
          colorValues.rgba.a
        );
      }
      return colorValues.hex;
    }, [colorFormat, hexInputValue, alpha, colorValues]);

    return (
      <div className={cn(styles.colorPicker, 'w-72 space-y-3', className)}>
        {alpha ? (
          <HexAlphaColorPicker
            color={value || hexInputValue}
            onChange={handleColorChange}
          />
        ) : (
          <HexColorPicker
            color={value || hexInputValue}
            onChange={handleColorChange}
          />
        )}
        <div className='flex gap-2'>
          <ColorSelector
            colorFormat={colorFormat}
            setColorFormat={setColorFormat}
          />
          <div className='flex flex-1 items-center [&>input]:h-7 [&>input]:flex-1 [&>input]:!cursor-text [&>input]:px-1 [&>input]:py-1 [&>input]:text-center [&>input]:text-sm'>
            {colorFormat === 'HEX' ? (
              <Input
                className='rounded-sm'
                dir='ltr'
                value={getCurrentHexValue}
                onChange={handleHexChange}
                onBlur={handleBlur}
                placeholder={defaultColor}
                maxLength={maxLength}
              />
            ) : colorFormat === 'RGB' ? (
              <>
                <Input
                  type='number'
                  dir='ltr'
                  className='num bidi-isolate ltr:rounded-l-sm ltr:rounded-r-none rtl:rounded-l-none rtl:rounded-r-sm'
                  value={
                    alpha && colorValues.rgba
                      ? colorValues.rgba.r
                      : colorValues.rgb.r
                  }
                  name='r'
                  onChange={handleRgbChange}
                  placeholder='255'
                  min={0}
                  max={255}
                  step={1}
                />
                <Input
                  type='number'
                  dir='ltr'
                  className='num bidi-isolate rounded-none border-x-0'
                  value={
                    alpha && colorValues.rgba
                      ? colorValues.rgba.g
                      : colorValues.rgb.g
                  }
                  name='g'
                  onChange={handleRgbChange}
                  placeholder='255'
                  min={0}
                  max={255}
                  step={1}
                />
                <Input
                  type='number'
                  dir='ltr'
                  className={cn(
                    'num bidi-isolate border-x-0',
                    alpha && colorValues.rgba
                      ? 'rounded-none'
                      : 'ltr:rounded-l-none ltr:rounded-r-sm rtl:rounded-l-sm rtl:rounded-r-none'
                  )}
                  value={
                    alpha && colorValues.rgba
                      ? colorValues.rgba.b
                      : colorValues.rgb.b
                  }
                  name='b'
                  onChange={handleRgbChange}
                  placeholder='255'
                  min={0}
                  max={255}
                  step={1}
                />
                {alpha && colorValues.rgba && (
                  <Input
                    type='number'
                    dir='ltr'
                    className='num bidi-isolate ltr:rounded-l-none ltr:rounded-r-sm rtl:rounded-l-sm rtl:rounded-r-none'
                    value={colorValues.rgba.a.toFixed(2)}
                    name='a'
                    onChange={handleRgbChange}
                    placeholder='1.00'
                    min={0}
                    max={1}
                    step={0.01}
                  />
                )}
              </>
            ) : colorFormat === 'HSL' ? (
              <>
                <Input
                  type='number'
                  dir='ltr'
                  className='num bidi-isolate ltr:rounded-l-sm ltr:rounded-r-none rtl:rounded-l-none rtl:rounded-r-sm'
                  value={
                    alpha && colorValues.hsla
                      ? colorValues.hsla.h
                      : colorValues.hsl.h
                  }
                  name='h'
                  onChange={handleHslChange}
                  placeholder='360'
                  min={0}
                  max={360}
                  step={1}
                />
                <Input
                  type='number'
                  dir='ltr'
                  className='num bidi-isolate rounded-none border-x-0'
                  value={
                    alpha && colorValues.hsla
                      ? colorValues.hsla.s
                      : colorValues.hsl.s
                  }
                  name='s'
                  onChange={handleHslChange}
                  placeholder='100'
                  min={0}
                  max={100}
                  step={1}
                />
                <Input
                  type='number'
                  dir='ltr'
                  className={cn(
                    'num bidi-isolate border-x-0',
                    alpha && colorValues.hsla
                      ? 'rounded-none'
                      : 'ltr:rounded-l-none ltr:rounded-r-sm rtl:rounded-l-sm rtl:rounded-r-none'
                  )}
                  value={
                    alpha && colorValues.hsla
                      ? colorValues.hsla.l
                      : colorValues.hsl.l
                  }
                  name='l'
                  onChange={handleHslChange}
                  placeholder='100'
                  min={0}
                  max={100}
                  step={1}
                />
                {alpha && colorValues.hsla && (
                  <Input
                    type='number'
                    dir='ltr'
                    className='num bidi-isolate ltr:rounded-l-none ltr:rounded-r-sm rtl:rounded-l-sm rtl:rounded-r-none'
                    name='a'
                    value={colorValues.hsla.a.toFixed(2)}
                    onChange={handleHslChange}
                    placeholder='1.00'
                    min={0}
                    max={1}
                    step={0.01}
                  />
                )}
              </>
            ) : null}
          </div>
        </div>
      </div>
    );
  }
);

ColorPickerContent.displayName = 'ColorPickerContent';

const ColorSelector = memo(
  ({
    colorFormat,
    setColorFormat,
  }: {
    colorFormat: string;
    setColorFormat: (value: string) => void;
  }) => {
    return (
      <Select value={colorFormat} onValueChange={setColorFormat}>
        <SelectTrigger className='!h-7 w-20 rounded-sm py-1 pe-1 ps-2 text-sm dark:bg-input/30'>
          <SelectValue placeholder='Color' />
        </SelectTrigger>
        <SelectContent className='min-w-20'>
          <SelectItem value='HEX' className='h-7 text-sm'>
            HEX
          </SelectItem>
          <SelectItem value='RGB' className='h-7 text-sm'>
            RGB
          </SelectItem>
          <SelectItem value='HSL' className='h-7 text-sm'>
            HSL
          </SelectItem>
        </SelectContent>
      </Select>
    );
  }
);

ColorSelector.displayName = 'ColorSelector';
