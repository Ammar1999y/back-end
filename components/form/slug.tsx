import { memo } from 'react';

import { HelpCircle } from 'lucide-react';
import { useFormContext } from 'react-hook-form';

import { Input } from '@/components/ui/input';
import Label from '@/components/ui/label';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import { ErrorMessage } from './error-message';

export const SlugInput = memo(
  ({ isEdit = false, className }: { isEdit?: boolean; className?: string }) => {
    const { register } = useFormContext();

    return (
      <div className={className}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className='flex w-fit items-center gap-2'>
              <Label
                title='المفتاح (slug)'
                htmlFor={register('slug').name}
                className='mb-0'
              />
              <HelpCircle className='h-4 w-4 cursor-help text-muted-foreground' />
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p className='text-xs'>
              يقبل الأحرف الإنجليزية الصغيرة والأرقام والشرطات (-).
              <br />
              لا يمكن أن يكون أرقاماً فقط.
            </p>
          </TooltipContent>
        </Tooltip>
        <Input
          {...register('slug')}
          id={register('slug').name}
          type='text'
          placeholder=''
          dir='ltr'
          className='mt-2'
          autoComplete='off'
          disabled={isEdit}
        />
        <p className='mt-1.5 text-xs leading-snug text-muted-foreground'>
          سيتم استخدام هذا النص في رابط الصفحة. (مثال: site.com/slug)
          <br />
          لا يمكن تعديله لاحقاً. في حال عدم توفره، سيتم استخدام المعرف (ID)
          تلقائياً.
        </p>
        <ErrorMessage path={register('slug').name} />
      </div>
    );
  }
);

SlugInput.displayName = 'SlugInput';
