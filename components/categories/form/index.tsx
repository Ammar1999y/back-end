import type {
  CreateCategoryInput,
  UpdateCategoryInput,
} from '@/utils/validation/categories';

import { memo } from 'react';

import { useFormContext } from 'react-hook-form';

import { Input } from '@/components/ui/input';
import Label from '@/components/ui/label';
import StatusSwitch from '@/components/ui/switch-larg';
import { ErrorMessage } from '@/components/form/error-message';

const CategoryForm = memo(() => {
  const { register } = useFormContext<
    CreateCategoryInput | UpdateCategoryInput
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
      {/* <LangTabs className='!mb-0' /> */}
      {/* Title Field */}
      <div className='grid grid-cols-1 gap-6 lg:grid-cols-2'>
        <div>
          <Label
            title={`العنوان${nativeLang ? ` (${nativeLang}) ` : ''}`}
            require
            htmlFor={register('title').name}
          />
          <Input
            {...register('title')}
            id={register('title').name}
            type='text'
            placeholder=''
            dir={inputDir}
            autoComplete='off'
          />
          <ErrorMessage path={register('title').name} />
        </div>

        {/* Active Status Field */}
        <div className='flex items-center gap-6 sm:flex-col sm:items-start sm:gap-4'>
          <Label
            title='الحالة'
            htmlFor={register('isActive').name}
            className='mb-0'
          />
          <StatusSwitch name='isActive' ariaLabel='تبديل الحاله' />
          <ErrorMessage path={register('isActive').name} />
        </div>
      </div>
    </div>
  );
});

CategoryForm.displayName = 'CategoryForm';

export { CategoryForm };
