import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

function TableRow({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot='table-row'
      className={cn('flex min-h-10 content-center align-middle', className)}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot='table-cell'
      className={cn(
        'relative min-h-10 content-center px-2 py-3 align-middle text-foreground',
        className
      )}
      {...props}
    />
  );
}

export { TableRow, TableCell };
