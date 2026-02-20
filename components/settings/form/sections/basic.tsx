import type { SettingsInput } from '@/utils/validation/settings';

import { memo, useCallback } from 'react';

import { useFormContext } from 'react-hook-form';

import { AutosizeTextarea } from '@/components/ui/auto-resize-textarea';
import InputColor from '@/components/ui/color-picker';
import { Input } from '@/components/ui/input';
import Label from '@/components/ui/label';
import { ErrorMessage } from '@/components/form/error-message';

const BasicInfoSection = memo(() => {
  const { register, setValue, getValues } = useFormContext<SettingsInput>();

  // LANGUAGES-TODOS
  // const activeLang = useTabsStore(useShallow((s) => s.activeLang));
  // const nativeLang = activeLang?.english;
  // const inputDir = activeLang?.dir || 'auto';
  const inputDir = 'rtl';

  const handleColorChange = useCallback(
    (value: string) => {
      setValue('primaryColor', value);
    },
    [setValue]
  );

  return (
    <div className='space-y-6'>
      {/* LANGUAGES-TODOS */}
      {/* <LangTabs /> */}

      <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
        {/* Site Title */}
        <div>
          <Label title='عنوان الموقع' htmlFor={register('siteTitle').name} />
          <Input
            {...register('siteTitle')}
            id={register('siteTitle').name}
            dir={inputDir}
            type='text'
            placeholder='اسم الموقع'
            autoComplete='off'
          />
          <ErrorMessage path={register('siteTitle').name} />
        </div>

        {/* Primary Color */}
        <div>
          <InputColor
            label='اللون الرئيسي'
            onChange={handleColorChange}
            value={getValues('primaryColor')}
            alpha={false}
          />
          <ErrorMessage path={register('primaryColor').name} />
        </div>
      </div>

      {/* Site Description */}
      <div>
        <Label title='وصف الموقع' htmlFor={register('siteDescription').name} />
        <AutosizeTextarea
          {...register('siteDescription')}
          id={register('siteDescription').name}
          placeholder='وصف مختصر للموقع'
          dir={inputDir}
          className='px-3 pb-2 pt-3'
          minRows={2}
          minHeight={50}
          maxRows={4}
        />
        <ErrorMessage path={register('siteDescription').name} />
      </div>

      {/* Footer Description */}
      <div>
        <Label
          title='وصف الفوتر'
          htmlFor={register('footerDescription').name}
        />
        <AutosizeTextarea
          {...register('footerDescription')}
          id={register('footerDescription').name}
          placeholder='نص يظهر في أسفل الموقع'
          dir={inputDir}
          className='px-3 pb-2 pt-3'
          minRows={2}
          minHeight={50}
          maxRows={4}
        />
        <ErrorMessage path={register('footerDescription').name} />
      </div>

      {/* Copyright Text */}
      <div>
        <Label title='نص الحقوق' htmlFor={register('copyrightText').name} />
        <Input
          {...register('copyrightText')}
          id={register('copyrightText').name}
          dir={inputDir}
          type='text'
          placeholder='جميع الحقوق محفوظة © 2024'
          autoComplete='off'
        />
        <ErrorMessage path={register('copyrightText').name} />
      </div>
    </div>
  );
});

BasicInfoSection.displayName = 'BasicInfoSection';

export { BasicInfoSection };
