import { memo } from 'react';

import { ArrowDown, ArrowUp } from 'lucide-react';

import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import ClearSort from '@/components/icons/clear-sort';

import { useSortingHandlers } from './hooks';
import { type ColumnOptionsProps } from './types';

const SortingOptions = memo(({ column }: ColumnOptionsProps) => {
  const {
    handleSortAscending,
    handleSortDescending,
    handleClearSort,
    isSorted,
  } = useSortingHandlers(column);

  const canSort = column.getCanSort();

  if (!canSort) return null;

  return (
    <>
      {isSorted()?.desc !== false && (
        <DropdownMenuItem onClick={handleSortAscending}>
          <ArrowUp className='ml-2 h-4 w-4' />
          <span>ترتيب تصاعدي</span>
        </DropdownMenuItem>
      )}
      {isSorted()?.desc !== true && (
        <DropdownMenuItem onClick={handleSortDescending}>
          <ArrowDown className='ml-2 h-4 w-4' />
          <span>ترتيب تنازلي</span>
        </DropdownMenuItem>
      )}
      {isSorted() && (
        <DropdownMenuItem onClick={handleClearSort}>
          <ClearSort className='ml-2 h-4 w-4' />
          <span>الغاء الترتيب</span>
        </DropdownMenuItem>
      )}
    </>
  );
});

SortingOptions.displayName = 'SortingOptions';

export { SortingOptions };
