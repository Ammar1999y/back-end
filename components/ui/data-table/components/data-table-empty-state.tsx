import { memo } from 'react';

import EmptyIcon from '@/components/icons/empty';

import { TableCell, TableRow } from './data-table';

const DataTableEmptyState = memo(() => {
  return (
    <TableRow className='max-w-[95vw] justify-center fade-in'>
      <TableCell className='min-h-24 text-center'>
        <div className='flex flex-col items-center justify-center py-6 text-foreground space-y-6'>
          <EmptyIcon />
          <span>لا توجد نتائج.</span>
        </div>
      </TableCell>
    </TableRow>
  );
});

DataTableEmptyState.displayName = 'DataTableEmptyState';

export { DataTableEmptyState };
