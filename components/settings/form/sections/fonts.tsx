import type { SettingsInput } from '@/utils/validation/settings';

import { memo, useCallback } from 'react';

import { returnNumberOrNull } from '@/utils';
import { useFormContext, useWatch } from 'react-hook-form';

import { Input } from '@/components/ui/input';
import Label from '@/components/ui/label';
import { FontCombobox } from '@/components/fonts/form/font-combobox';
import { FontPreview } from '@/components/fonts/form/font-preview';
import { ErrorMessage } from '@/components/form/error-message';

const FontsSection = memo(() => {
  const { setValue, control } = useFormContext<SettingsInput>();

  // LANGUAGES-TODOS
  // const activeLang = useTabsStore(useShallow((s) => s.activeLang));
  // const nativeLang = activeLang?.english;
  // const inputDir = activeLang?.dir || 'auto';
  const inputDir = 'rtl';

  // Watch fonts values
  const fonts = useWatch({
    control,
    name: 'fonts',
  });

  const currentGoogleFont = fonts?.googleFont ?? null;
  const currentLetterSpacing = returnNumberOrNull(fonts?.letterSpacing) ?? 0;
  const currentLineHeight = returnNumberOrNull(fonts?.lineHeight) ?? 1;
  const currentFontSizeMultiplier =
    returnNumberOrNull(fonts?.fontSizeMultiplier) ?? 1;

  // Field handlers
  const handleFontChange = useCallback(
    (value: string | null) => {
      setValue('fonts.googleFont', value);
    },
    [setValue]
  );

  const handleLetterSpacingChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseFloat(e.target.value) || 0;
      setValue('fonts.letterSpacing', value);
    },
    [setValue]
  );

  const handleLineHeightChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseFloat(e.target.value) || 1;
      setValue('fonts.lineHeight', value);
    },
    [setValue]
  );

  const handleFontSizeMultiplierChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseFloat(e.target.value) || 1;
      setValue('fonts.fontSizeMultiplier', value);
    },
    [setValue]
  );

  return (
    <div className='space-y-6'>
      {/* LANGUAGES-TODOS */}
      {/* <LangTabs /> */}

      {/* Font Selection */}
      <div className='grid grid-cols-1 gap-6 md:grid-cols-2'>
        <div>
          <FontCombobox value={currentGoogleFont} onChange={handleFontChange} />
          <ErrorMessage path='fonts.googleFont' />
        </div>
      </div>

      {/* Spacing & Size Settings */}
      <div className='grid grid-cols-1 gap-6 sm:grid-cols-3'>
        {/* Letter Spacing */}
        <div>
          <Label title='تباعد الأحرف' htmlFor='letterSpacing' />
          <Input
            id='letterSpacing'
            type='number'
            step='0.5'
            min='-10'
            max='50'
            value={currentLetterSpacing}
            onChange={handleLetterSpacingChange}
            dir='ltr'
            className='text-center'
          />
          <p className='mt-1 text-xs text-muted-foreground'>
            القيمة بالبكسل (0 = طبيعي)
          </p>
          <ErrorMessage path='fonts.letterSpacing' />
        </div>

        {/* Line Height */}
        <div>
          <Label title='تباعد الأسطر' htmlFor='lineHeight' />
          <Input
            id='lineHeight'
            type='number'
            step='0.1'
            min='0.5'
            max='5'
            value={currentLineHeight}
            onChange={handleLineHeightChange}
            dir='ltr'
            className='text-center'
          />
          <p className='mt-1 text-xs text-muted-foreground'>
            القيمة الافتراضية 1
          </p>
          <ErrorMessage path='fonts.lineHeight' />
        </div>

        {/* Font Size Multiplier */}
        <div>
          <Label title='مضاعف حجم الخط' htmlFor='fontSizeMultiplier' />
          <Input
            id='fontSizeMultiplier'
            type='number'
            step='0.1'
            min='0.5'
            max='3'
            value={currentFontSizeMultiplier}
            onChange={handleFontSizeMultiplierChange}
            dir='ltr'
            className='text-center'
          />
          <p className='mt-1 text-xs text-muted-foreground'>
            القيمة الافتراضية 1 (يتم ضربها في حجم الخط الأساسي)
          </p>
          <ErrorMessage path='fonts.fontSizeMultiplier' />
        </div>
      </div>

      {/* Font Preview */}
      <FontPreview
        fontName={currentGoogleFont}
        letterSpacing={currentLetterSpacing}
        lineHeight={currentLineHeight}
        fontSizeMultiplier={currentFontSizeMultiplier}
        dir={inputDir}
      />
    </div>
  );
});

FontsSection.displayName = 'FontsSection';

export { FontsSection };
