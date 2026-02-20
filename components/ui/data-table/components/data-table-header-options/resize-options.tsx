import { memo } from 'react';

import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import AutoSizeColumn from '@/components/icons/autosize-column';

import { useOtherHandlers } from './hooks';
import { type ColumnOptionsProps } from './types';

const ResizeOptions = memo(({ column }: ColumnOptionsProps) => {
  const { handleResetSize } = useOtherHandlers(column);

  const canResize = column.getCanResize();

  if (!canResize) return null;

  return (
    <DropdownMenuItem onClick={handleResetSize}>
      <AutoSizeColumn className='ml-2 h-4 w-4' />
      <span>إعادة الحجم التلقائي</span>
    </DropdownMenuItem>
  );
});

ResizeOptions.displayName = 'ResizeOptions';

export { ResizeOptions };
