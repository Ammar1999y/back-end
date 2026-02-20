import type { CoreRow } from '@tanstack/react-table';

import { memo } from 'react';

import { EditIcon as _EditIcon } from 'lucide-react';

import { Link } from '@/components/ui/link';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import { User } from '../types';
import { DeleteAction } from './delete-action';

const EditIcon = memo(_EditIcon);

const TableActions = memo(
  ({ original: user }: { original: CoreRow<User>['original'] }) => {
    return (
      <div className='flex items-center justify-end text-muted-foreground space-x-1'>
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href={`/dash/users/edit?id=${user.id}`}
              variant='defaultGhost'
              size={'icon'}
              aria-label='تعديل المستخدم'
            >
              <EditIcon className='h-4 w-4' />
            </Link>
          </TooltipTrigger>
          <TooltipContent>
            <p className='text-sm'>تعديل المستخدم</p>
          </TooltipContent>
        </Tooltip>
        <DeleteAction user={user} />
      </div>
    );
  }
);

TableActions.displayName = 'TableActions';

export { TableActions };
