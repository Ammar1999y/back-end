import { memo } from 'react';

import ErrorMessage from '@/components/error-message';

import { TableCell, TableRow } from './data-table';

interface DataTableErrorStateProps {
  error: Error | null;
  refetch: () => void;
}

const DataTableErrorState = memo(
  ({ error, refetch }: DataTableErrorStateProps) => {
    return (
      <TableRow className='min-h-52'>
        <TableCell className='flex-1 text-center text-red-600'>
          <ErrorMessage error={error} refetch={refetch} />
        </TableCell>
      </TableRow>
    );
  }
);

DataTableErrorState.displayName = 'DataTableErrorState';

export { DataTableErrorState };
