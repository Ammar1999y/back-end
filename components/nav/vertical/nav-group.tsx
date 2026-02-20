import type { NavGroupProps } from '../types';

import { memo, useCallback, useState } from 'react';

import { ChevronDown as _ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

import { NavList } from './nav-list';

// Memoize icon
const ChevronDown = memo(_ChevronDown);
ChevronDown.displayName = 'ChevronDown';

const Group = memo(
  ({
    name,
    open,
    onClick,
  }: {
    name?: string;
    open: boolean;
    onClick: (nextValue: boolean) => void;
  }) => {
    const handleClick = useCallback(() => {
      onClick(!open);
    }, [onClick, open]);

    return (
      name && (
        <Button
          className={cn(
            'group relative inline-flex w-full items-center justify-start px-0 py-2 pe-2 ps-3 text-muted-foreground transition-all duration-300 ease-in-out space-x-0 hover:ps-5 hover:text-foreground'
          )}
          variant={'none'}
          onClick={handleClick}
        >
          <ChevronDown
            className={cn(
              'absolute inline-flex size-4 shrink-0 transition-all duration-300 ease-in-out ltr:left-1 rtl:right-1',
              'rotate-90 opacity-0 group-hover:opacity-100',
              open && 'rotate-0'
            )}
            size={16}
          />
          <span
            className={cn('text-xs transition-all duration-300 ease-in-out')}
          >
            {name}
          </span>
        </Button>
      )
    );
  }
);
Group.displayName = 'Group';

const NavGroup = memo(({ name, items }: NavGroupProps) => {
  const [open, setOpen] = useState(true);
  const toggleOpen = useCallback(() => {
    setOpen((e) => !e);
  }, []);

  return (
    <Collapsible open={open} className='p-1'>
      <CollapsibleTrigger asChild>
        <Group name={name} open={open} onClick={toggleOpen} />
      </CollapsibleTrigger>
      <CollapsibleContent className='p-1'>
        <ul className='flex w-full flex-col space-y-1'>
          {items.map((item, index) => (
            <NavList key={item.title || index} data={item} depth={1} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
});
NavGroup.displayName = 'NavGroup';

export { NavGroup };
