import type { SettingsInput } from '@/utils/validation/settings';

import { memo } from 'react';

import { HelpCircle } from 'lucide-react';
import { FieldPath, useFormContext } from 'react-hook-form';

import { Input } from '@/components/ui/input';
import Label from '@/components/ui/label';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ErrorMessage } from '@/components/form/error-message';

interface KeyInputProps {
  name: FieldPath<SettingsInput>;
  className?: string;
}

const KeyInput = memo(({ name, className }: KeyInputProps) => {
  const { register } = useFormContext<SettingsInput>();

  return (
    <div className={className}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className='flex w-fit items-center gap-2'>
            <Label title='المفتاح' htmlFor={name} className='mb-0' />
            <HelpCircle className='h-4 w-4 cursor-help text-muted-foreground' />
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p className='text-xs'>
            يقبل الأحرف الإنجليزية الصغيرة والأرقام والشرطات (-).
          </p>
        </TooltipContent>
      </Tooltip>
      <Input
        {...register(name)}
        id={name}
        type='text'
        placeholder=''
        dir='ltr'
        className='mt-2'
        autoComplete='off'
      />
      <ErrorMessage path={name} />
    </div>
  );
});

KeyInput.displayName = 'KeyInput';

export { KeyInput };
