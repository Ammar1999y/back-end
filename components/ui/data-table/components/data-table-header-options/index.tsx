import { memo, useState } from 'react';

import { type Column } from '@tanstack/react-table';
import { MoreVertical } from 'lucide-react';
import { cn } from '@/lib/utils';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { Button } from '../../../button';
import { HideOptions } from './hide-options';
import { OrderingOptions } from './ordering-options';
import { PinningOptions } from './pinning-options';
import { ResizeOptions } from './resize-options';
import { SortingOptions } from './sorting-options';
import { type HeaderOptionsProps } from './types';

const HeaderOptions = memo(({ column, className }: HeaderOptionsProps) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <DropdownMenu modal={false} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          className={cn(
            'shrink-0 rounded p-1',
            className,
            isOpen && '!opacity-100'
          )}
          variant='ghost'
          aria-label='خيارات العمود'
          onPointerDown={(e) => e.stopPropagation()}
        >
          <MoreVertical className='h-4 w-4' />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-48'>
        <Content column={column} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const Content = memo(({ column }: { column: Column<any, any> }) => {
  const canSort = column.getCanSort();
  const canPin = column.getCanPin();
  const canResize = column.getCanResize();
  const canHide = column.getCanHide();
  const enableOrdering = (column.columnDef.meta as any)?.enableOrdering ?? true;

  return (
    <>
      <SortingOptions column={column} />

      {canPin && (
        <>
          {canSort && <DropdownMenuSeparator />}
          <PinningOptions column={column} />
        </>
      )}

      {enableOrdering && (
        <>
          {(canPin || canSort) && <DropdownMenuSeparator />}
          <OrderingOptions column={column} />
        </>
      )}

      {canResize && (
        <>
          {(canPin || canSort || enableOrdering) && <DropdownMenuSeparator />}
          <ResizeOptions column={column} />
        </>
      )}

      {canHide && (
        <>
          {(canPin || canSort || enableOrdering || canResize) && (
            <DropdownMenuSeparator />
          )}
          <HideOptions column={column} />
        </>
      )}
    </>
  );
});

Content.displayName = 'Content';

HeaderOptions.displayName = 'HeaderOptions';

export { HeaderOptions };
