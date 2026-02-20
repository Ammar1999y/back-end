import type { Section } from '../types';

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
  ({ original: section }: { original: CoreRow<Section>['original'] }) => {
    return (
      <div className='flex items-center justify-end text-muted-foreground space-x-1'>
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href={`/dash/sections/edit?sectionId=${section.id}`}
              variant='defaultGhost'
              aria-label='تعديل القسم'
              size={'icon'}
            >
              <EditIcon className='h-4 w-4' />
            </Link>
          </TooltipTrigger>
          <TooltipContent>
            <p className='text-sm'>تعديل القسم</p>
          </TooltipContent>
        </Tooltip>
        <DeleteAction section={section} />
      </div>
    );
  }
);

TableActions.displayName = 'SectionTableActions';
export { TableActions };
