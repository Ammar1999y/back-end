import type { NavProps } from '../types';

import { memo } from 'react';

import { cn } from '@/lib/utils';

import { NavGroup } from './nav-group';

const NavVertical = memo(({ data, className, ...props }: NavProps) => {
  return (
    <nav className={cn('flex w-full flex-col space-y-1', className)} {...props}>
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
NavVertical.displayName = 'NavVertical';

export { NavVertical };
