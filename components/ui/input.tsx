import * as React from 'react';

import { cn } from '@/lib/utils';

interface InputProps extends React.ComponentProps<'input'> {
  ref?: React.Ref<HTMLInputElement>;
}

const Input = React.memo(({ className, type, ref, ...props }: InputProps) => {
  return (
    <input
      type={type}
      className={cn(
        'flex h-input w-full min-w-0 rounded-md border bg-input px-3 py-1 text-base caret-primary transition duration-300 placeholder:text-muted-foreground hover:shadow-md dark:bg-input/30 hover:dark:bg-input/45 md:text-sm',
        props.disabled && 'disabled !cursor-not-allowed',
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = 'Input';

export { Input };
