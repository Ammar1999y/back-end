import { memo } from 'react';

import { type Column } from '@tanstack/react-table';
import { cn } from '@/lib/utils';

interface DataTableColumnHeaderProps<TData = any, TValue = any> {
  column: Column<TData, TValue>;
  title: string;
  className?: string;
}

const DataTableColumnHeader = memo(
  ({ title, className }: DataTableColumnHeaderProps) => {
    return (
      <p className={cn('h-full px-2 py-2 font-semibold', className)}>{title}</p>
    );
  }
);

DataTableColumnHeader.displayName = 'DataTableColumnHeader';

export { DataTableColumnHeader };
