import type { NavProps } from '@/components/nav/types';

import { memo } from 'react';

import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { NavHorizontal } from '@/components/nav';

const NavHorizontalLayout = memo(({ data }: NavProps) => {
  return (
    <nav
      data-slot='slash-layout-nav'
      className={
        'sticky left-0 right-0 top-[--layout-header-height] z-app-bar w-full shrink-0 grow-0'
      }
    >
      <ScrollArea className='whitespace-nowrap bg-background px-2'>
        <NavHorizontal data={data} />
        <ScrollBar orientation='horizontal' />
      </ScrollArea>
    </nav>
  );
});

NavHorizontalLayout.displayName = 'NavHorizontalLayout';
export { NavHorizontalLayout };
