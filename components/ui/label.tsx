import type { LabelHTMLAttributes } from 'react';

import { memo } from 'react';

import { cn } from '@/lib/utils';

interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  require?: boolean;
  title: string;
}

const Label = memo(
  ({ className, require = false, title, ...props }: LabelProps) => {
    return (
      <label
        className={cn(
          'mb-2 block text-sm font-semibold text-foreground' /* leading-none */,
          className
        )}
        {...props}
      >
        {title} {require && <span className='text-destructive'>*</span>}
      </label>
    );
  }
);

Label.displayName = 'Label';
export default Label;
