import type { Project } from '../types';

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
  ({ original: project }: { original: CoreRow<Project>['original'] }) => {
    return (
      <div className='flex items-center justify-end text-muted-foreground space-x-1'>
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href={`/dash/projects/edit?projectId=${project.id}`}
              variant='defaultGhost'
              aria-label='تعديل المشروع'
              size={'icon'}
            >
              <EditIcon className='h-4 w-4' />
            </Link>
          </TooltipTrigger>
          <TooltipContent>
            <p className='text-sm'>تعديل المشروع</p>
          </TooltipContent>
        </Tooltip>
        <DeleteAction project={project} />
      </div>
    );
  }
);

TableActions.displayName = 'ProjectTableActions';
export { TableActions };
