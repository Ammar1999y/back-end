import type {
  CreateSectionInput,
  UpdateSectionInput,
} from '@/utils/validation/sections';

import dynamic from 'next/dynamic';
import { memo, useCallback, useMemo } from 'react';

import { useFormContext } from 'react-hook-form';

import { AutosizeTextarea } from '@/components/ui/auto-resize-textarea';
import { Input } from '@/components/ui/input';
import Label from '@/components/ui/label';
import SectionStatusSwitch from '@/components/ui/switch-larg';
import { ErrorMessage } from '@/components/form/error-message';
import { SlugInput } from '@/components/form/slug';

const Editor = dynamic(() => import('@/components/editor/plate-editor'), {
  ssr: false,
});

const BasicInfoSection = memo(() => {
  const { register, setValue, getValues } = useFormContext<
    CreateSectionInput | UpdateSectionInput
  >();
  // LANGUAGES-TODOS
  // const activeLang = useTabsStore(useShallow((s) => s.activeLang));
  // const nativeLang = activeLang?.english;
  // const inputDir = activeLang?.dir || 'auto';
  const nativeLang = null;
  const inputDir = 'rtl';
  const handleDescriptionChange = useCallback(
    (value: any) => {
      setValue('description', value);
    },
    [setValue]
  );

  const initialDescription = useMemo(
    () => getValues('description'),
    [getValues]
  );

  return (
    <div className='space-y-6'>
      {/* LANGUAGES-TODOS */}
      {/* <LangTabs /> */}

      <div className='grid grid-cols-3 gap-6'>
        <SlugInput className='col-span-2' />
        <div className='col-span-1 flex flex-col items-start gap-4 sm:flex-row sm:items-center'>
          <Label
            title='الحاله'
            className='mb-0'
            htmlFor={register('isActive').name}
          />
          <SectionStatusSwitch name='isActive' ariaLabel='تبديل حالة القسم' />
          <ErrorMessage path={register('isActive').name} />
        </div>
      </div>

      <div className='grid grid-cols-8 gap-6'>
        {/* Title */}
        <div className='col-span-8 xs2:col-span-4'>
          <Label
            title={`العنوان الرئيسي${nativeLang ? ` (${nativeLang}) ` : ''}`}
            require
            htmlFor={register('title').name}
          />
          <Input
            {...register('title')}
            id={register('title').name}
            dir={inputDir}
            type='text'
            placeholder=''
            autoComplete='off'
          />
          <ErrorMessage path={register('title').name} />
        </div>

        {/* Subtitle */}
        <div className='col-span-8 xs2:col-span-4'>
          <Label
            title={`العنوان الفرعي${nativeLang ? ` (${nativeLang}) ` : ''}`}
            htmlFor={register('subtitle').name}
          />
          <Input
            {...register('subtitle')}
            id={register('subtitle').name}
            dir={inputDir}
            type='text'
            placeholder=''
            autoComplete='off'
          />
          <ErrorMessage path={register('subtitle').name} />
        </div>
      </div>

      {/* Short Description */}
      <div>
        <Label
          title={`وصف مختصر${nativeLang ? ` (${nativeLang}) ` : ''}`}
          htmlFor={register('shortDescription').name}
        />
        <AutosizeTextarea
          {...register('shortDescription')}
          id={register('shortDescription').name}
          placeholder=''
          dir={inputDir}
          className='px-3 pb-2 pt-3'
          minRows={2}
          minHeight={50}
          maxRows={6}
        />
        <ErrorMessage path={register('shortDescription').name} />
      </div>

      {/* Rich Text Description */}
      <div>
        <Label title={`الوصف الغني${nativeLang ? ` (${nativeLang}) ` : ''}`} />

        <Editor
          onChange={handleDescriptionChange}
          content={initialDescription}
        />
        <ErrorMessage path={register('description').name} />
      </div>
    </div>
  );
});

BasicInfoSection.displayName = 'BasicInfoSection';

export { BasicInfoSection };
