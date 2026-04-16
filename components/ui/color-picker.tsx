// https://github.com/vatsalpipalava/shadcn-input-color/blob/main/src/components/input-color.tsx
import {
  ChangeEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

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

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Label from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import styles from './color-picker.module.css';

interface ColorPickerProps {
  value?: string | null;
  onChange?: (value: string) => void;
  onBlur?: () => void;
  label: string;
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

const defaultColor = '';

const InputColor = memo(
  ({
    value,
    onChange,
    onBlur,
    label,
    className = '',
    alpha = true,
  }: ColorPickerProps) => {
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

    const [hexInputValue, setHexInputValue] = useState<string>(value || '');

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
        setHexInputValue(newColor.toUpperCase()); // ضمان تحديث النص
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
        const value = e.target.value;

        const numValue = Number.parseFloat(value) || 0;
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
        const value = e.target.value;

        const numValue = Number.parseFloat(value) || 0;
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

    // Handle popover close
    const handlePopoverChange = useCallback(
      (open: boolean) => {
        if (!open) {
          validateAndResetColor();
          setColorFormat('HEX');
          onBlur?.();
        }
      },
      [validateAndResetColor, onBlur]
    );

    // Handle blur on main input
    const handleMainInputBlur = useCallback(() => {
      validateAndResetColor();
      onBlur?.();
    }, [validateAndResetColor, onBlur]);

    useEffect(() => {
      // نقوم بالتحديث فقط إذا جاءت قيمة جديدة (ليست فارغة) ومختلفة عن الحالية
      if (value && value !== hexInputValue && value !== defaultColor) {
        updateColorValues(value);
        setHexInputValue(value.toUpperCase());
      }
    }, [value]);
    // Get current hex value for display
    const getCurrentHexValue = useMemo(() => {
      if (!hexInputValue) return ''; // شرط جديد: إذا كان فارغاً أعد فارغاً
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
      <div className={cn(className)}>
        <Label title={label} />
        <div className='relative h-input'>
          <Input
            dir='ltr'
            // يظهر "اختر لون" فقط إذا كان النص فارغاً
            placeholder={!hexInputValue ? 'اختر لون' : label}
            // الربط مع الدالة المحسوبة وليس الـ prop
            value={getCurrentHexValue}
            onChange={handleHexChange}
            onBlur={handleMainInputBlur}
            // إضافة كلاس لجعل النص يمين في حالة البليس هولدر
            className={`!h-input pe-14 uppercase placeholder:text-right`}
          />
          <Popover onOpenChange={handlePopoverChange}>
            <PopoverTrigger asChild>
              <Button
                className={cn(
                  'absolute right-0 top-1/2 h-full w-12 -translate-y-1/2 overflow-hidden border border-border opacity-90 shadow-none saturate-[.7] ltr:rounded-r-none rtl:rounded-l-none',
                  !hexInputValue && 'border-0'
                )}
                size={'icon'}
                style={{
                  // الخلفية: إما اللون المختار أو التدرج اللوني
                  background:
                    hexInputValue ||
                    'conic-gradient(red,orange,yellow,lime,cyan,blue,magenta,red)',
                  // الحيلة هنا: تكبير الخلفية لـ 150% أو 200% وقص الأطراف (الزر لديه overflow-hidden)
                  // هذا يجعل التدرج يبدو "ناعماً" وكأنه جزء من عجلة ألوان كبيرة
                }}
              >
                {/* شرط ظهور الشفافية: يجب أن يكون هناك لون مختار */}
                {hexInputValue &&
                  alpha &&
                  colorValues.rgba &&
                  colorValues.rgba.a < 1 && (
                    <div
                      className='absolute inset-0 opacity-20'
                      style={{
                        backgroundImage: `linear-gradient(45deg, #ccc 25%, transparent 25%), 
                                      linear-gradient(-45deg, #ccc 25%, transparent 25%), 
                                      linear-gradient(45deg, transparent 75%, #ccc 75%), 
                                      linear-gradient(-45deg, transparent 75%, #ccc 75%)`,
                        backgroundSize: '8px 8px',
                        backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0px',
                      }}
                    />
                  )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className='w-auto p-3'>
              <div className={cn(styles.colorPicker, 'w-72 space-y-3')}>
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
                <div className='flex space-x-2'>
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
            </PopoverContent>
          </Popover>
        </div>
      </div>
    );
  }
);

InputColor.displayName = 'InputColor';

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
        <ColorSelectorContent />
      </Select>
    );
  }
);

ColorSelector.displayName = 'ColorSelector';

const ColorSelectorContent = memo(() => (
  <>
    <SelectTrigger className='!h-7 w-20 rounded-sm py-1 pe-1 ps-2 text-sm dark:bg-input/30'>
      <SelectValue placeholder='Color' />
    </SelectTrigger>
    <SelectContent className='min-w-24'>
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
  </>
));

ColorSelectorContent.displayName = 'ColorSelectorContent';

export default InputColor;
