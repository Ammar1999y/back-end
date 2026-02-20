import { memo } from 'react';

import { cn } from '@/lib/utils';

const FloatingLabelInput = memo(
  ({
    name,
    label,
    type,
    dir,
    className,
    ref,
    ...props
  }: {
    name: string;
    label: string;
    type: string;
    dir: string;
    ref?: React.Ref<HTMLInputElement>;
  } & React.InputHTMLAttributes<HTMLInputElement>) => {
    return (
      <div className='relative'>
        <input
          ref={ref}
          dir={dir}
          id={name}
          name={name}
          type={type}
          className={cn(
            'peer w-full rounded-md border border-[#6DC8C0] px-4 py-2 caret-primary transition duration-300 placeholder:text-transparent hover:shadow-sm focus-visible:border-transparent focus-visible:ring-[3px] focus-visible:ring-primary/30',
            className
          )}
          placeholder=''
          {...props}
        />
        <label
          htmlFor={name}
          className='pointer-events-none absolute top-0 ms-2 w-max -translate-y-1/2 scale-[.8] select-none bg-background px-2 text-base font-medium transition-all duration-300 peer-placeholder-shown:top-1/2 peer-placeholder-shown:scale-100 peer-focus:top-0 peer-focus:scale-[.8] peer-focus:text-primary ltr:left-0 rtl:right-0'
        >
          {label}
        </label>
      </div>
    );
  }
);
const LabeledInput = memo(
  ({
    name,
    label,
    type,
    dir,
    placeholder,
    containerClassName,
    Icon,
    Icon2,
  }: {
    name: string;
    label: string;
    type: string;
    dir: string;
    placeholder: string;
    containerClassName?: string;
    Icon?: React.ElementType;
    Icon2?: React.ElementType;
  }) => {
    return (
      <div className={cn('relative', containerClassName)}>
        <label
          htmlFor={name}
          className='mb-2 block text-sm font-medium text-gray-700'
        >
          {label}
        </label>
        <div className='relative'>
          {Icon && (
            <Icon className='absolute left-3 top-1/2 -translate-y-1/2 text-gray-700' />
          )}
          <input
            dir={dir}
            id={name}
            name={name}
            type={type}
            className={cn(
              `w-full rounded-lg border border-gray-500 px-4 py-2 text-base font-medium caret-primary transition duration-300 placeholder:text-gray-500 hover:border-primary/80 hover:shadow-sm focus-visible:ring-4 focus-visible:ring-primary/30`,
              Icon && 'pl-10'
            )}
            placeholder={placeholder}
          />
          {Icon2 && <Icon2 />}
        </div>
      </div>
    );
  }
);

LabeledInput.displayName = 'LabeledInput';
export { LabeledInput };

FloatingLabelInput.displayName = 'FloatingLabelInput';

export default FloatingLabelInput;
