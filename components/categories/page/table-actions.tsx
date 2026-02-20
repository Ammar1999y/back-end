import type { Category } from '../types';

import { memo } from 'react';

import { type CoreRow } from '@tanstack/react-table';
import { EditIcon as _EditIcon } from 'lucide-react';

import { Link } from '@/components/ui/link';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import { DeleteAction } from './delete-action';

const EditIcon = memo(_EditIcon);

const TableActions = memo(
  ({ original: category }: { original: CoreRow<Category>['original'] }) => {
    return (
      <div className='flex items-center justify-end text-muted-foreground space-x-1'>
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href={`/dash/projects/categories/edit?categoryId=${category.id}`}
              variant='defaultGhost'
              size={'icon'}
              aria-label='تعديل التصنيف'
            >
              <EditIcon className='h-4 w-4' />
            </Link>
          </TooltipTrigger>
          <TooltipContent>
            <p className='text-sm'>تعديل التصنيف</p>
          </TooltipContent>
        </Tooltip>
        <DeleteAction category={category} />
      </div>
    );
  }
);

TableActions.displayName = 'CategoryTableActions';
export { TableActions };
