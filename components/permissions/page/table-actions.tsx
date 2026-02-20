import { memo } from 'react';

import { type CoreRow } from '@tanstack/react-table';
import { EditIcon as _EditIcon } from 'lucide-react';

import { Link } from '@/components/ui/link';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import { Permission } from '../types';
import { DeleteAction } from './delete-action';

const EditIcon = memo(_EditIcon);

const TableActions = memo(
  ({ original: permission }: { original: CoreRow<Permission>['original'] }) => {
    return (
      <div className='flex items-center justify-end text-muted-foreground space-x-1'>
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href={`/dash/permissions/edit?id=${permission.id}`}
              variant='ghost'
              className='h-8 w-8 rounded-sm p-0 hover:bg-green-500/10 hover:text-green-600'
              aria-label='تعديل الصلاحية'
            >
              <EditIcon className='h-4 w-4' />
            </Link>
          </TooltipTrigger>
          <TooltipContent>
            <p className='text-sm'>تعديل الصلاحية</p>
          </TooltipContent>
        </Tooltip>
        <DeleteAction permission={permission} />
      </div>
    );
  }
);

TableActions.displayName = 'TableActions';

export { TableActions };
