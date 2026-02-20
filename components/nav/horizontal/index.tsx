import type { NavProps } from '../types';

import { memo } from 'react';

import { cn } from '@/lib/utils';

import { NavGroup } from './nav-group';

const NavHorizontal = memo(({ data, className, ...props }: NavProps) => {
  return (
    <nav
      className={cn(
        'flex min-h-[--layout-nav-height-horizontal] items-center border-b border-dashed text-muted-foreground space-x-1',
        className
      )}
      {...props}
    >
      {data.map((group, index) => (
        <NavGroup
          key={group.name || index}
          name={group.name}
          items={group.items}
        />
      ))}
    </nav>
  );
});
NavHorizontal.displayName = 'NavHorizontal';

export { NavHorizontal };
