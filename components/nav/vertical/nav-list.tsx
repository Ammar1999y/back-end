import type { NavListProps } from '../types';

import { memo } from 'react';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

import { NavItem } from '../components/nav-item';
import { useNavItemState } from '../hooks/use-nav-item-state';

const NavList = memo(({ data, depth = 1 }: NavListProps) => {
  const { hasChild, open, setOpen, navItemProps } = useNavItemState(
    data,
    depth
  );

  if (data.hidden) {
    return null;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-nav-type='list'>
      <CollapsibleTrigger
        className='w-full rounded-md'
        tabIndex={hasChild ? 0 : -1}
        asChild
      >
        <NavItem variant='vertical' {...navItemProps} />
      </CollapsibleTrigger>
      {hasChild && (
        <CollapsibleContent className='pb-1 pe-1'>
          <div className='ms-4 mt-1 flex flex-col space-y-1'>
            {data.children?.map((child) => (
              <NavList key={child.title} data={child} depth={depth + 1} />
            ))}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
});
NavList.displayName = 'NavList';

export { NavList };
