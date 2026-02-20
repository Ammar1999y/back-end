import { memo } from 'react';

import { EyeOff } from 'lucide-react';

import { DropdownMenuItem } from '@/components/ui/dropdown-menu';

import { useOtherHandlers } from './hooks';
import { type ColumnOptionsProps } from './types';

const HideOptions = memo(({ column }: ColumnOptionsProps) => {
  const { handleHideColumn } = useOtherHandlers(column);

  const canHide = column.getCanHide();

  if (!canHide) return null;

  return (
    <DropdownMenuItem onClick={handleHideColumn}>
      <EyeOff className='ml-2 h-4 w-4' />
      <span>اخفاء العامود</span>
    </DropdownMenuItem>
  );
});

HideOptions.displayName = 'HideOptions';

export { HideOptions };
