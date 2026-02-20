import type {
  CreateProjectInput,
  UpdateProjectInput,
} from '@/utils/validation/projects';

import { memo } from 'react';

import { useFormContext } from 'react-hook-form';
import { ACCEPT_IMAGES_WITH_SVG } from '@/lib/constants';

import { MAX_IMAGE_SIZE } from '@/utils/images/config';

import { AutosizeTextarea } from '@/components/ui/auto-resize-textarea';
import { Input } from '@/components/ui/input';
import Label from '@/components/ui/label';
import SectionStatusSwitch from '@/components/ui/switch-larg';
import { FileUpload } from '@/components/file-upload';
import { ErrorMessage } from '@/components/form/error-message';

import CategoryCombobox from './category-combobox';

const ProjectForm = memo(() => {
  const { register } = useFormContext<
    CreateProjectInput | UpdateProjectInput
  >();
  // LANGUAGES-TODOS
  // const activeLang = useTabsStore(useShallow((s) => s.activeLang));
  // const nativeLang = activeLang?.english;
  // const inputDir = activeLang?.dir || 'auto';
  const nativeLang = null;
  const inputDir = 'rtl';

  return (
    <div className='px-1 pb-10 pt-4 space-y-6'>
      {/* LANGUAGES-TODOS */}
      {/* <LangTabs /> */}

      <div className='grid grid-cols-3 items-center gap-6'>
        <div className='col-span-2'>
          <Label
            title={`العنوان${nativeLang ? ` (${nativeLang}) ` : ''}`}
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
        <div className='col-span-1 flex flex-col gap-4'>
          <Label
            title='الحاله'
            className='mb-0'
            htmlFor={register('isActive').name}
          />
          <SectionStatusSwitch name='isActive' ariaLabel='تبديل حالة المشروع' />
          <ErrorMessage path={register('isActive').name} />
        </div>
      </div>

      <div>
        <Label
          title={`الوصف${nativeLang ? ` (${nativeLang}) ` : ''}`}
          htmlFor={register('description').name}
        />
        <AutosizeTextarea
          {...register('description')}
          id={register('description').name}
          placeholder=''
          dir={inputDir}
          className='px-3 pb-2 pt-3'
          minRows={3}
          maxRows={8}
        />
        <ErrorMessage path={register('description').name} />
      </div>

      <div className='grid grid-cols-1 gap-4 xs2:grid-cols-8'>
        <div className='xs2:col-span-5'>
          <Label title='الرابط' htmlFor={register('link').name} />
          <Input
            {...register('link')}
            id={register('link').name}
            dir='ltr'
            type='text'
            placeholder='https://example.com'
            autoComplete='off'
            className='placeholder:!text-left'
          />
          <ErrorMessage path={register('link').name} />
        </div>
        <div className='xs2:col-span-3'>
          <CategoryCombobox />
          <ErrorMessage path={register('categoryId').name} />
        </div>
      </div>

      {/* Images */}
      <div>
        <Label title='الصور' htmlFor='project-images' />
        <FileUpload
          maxFiles={5}
          maxSizeMB={MAX_IMAGE_SIZE}
          accept={ACCEPT_IMAGES_WITH_SVG}
          inputID='project-images'
          dropzoneText='اسحب وأفلت الصور هنا، أو'
        />
      </div>
    </div>
  );
});

ProjectForm.displayName = 'ProjectForm';

export { ProjectForm };
