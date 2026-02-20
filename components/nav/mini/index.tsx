import type { NavProps } from '../types';

import { memo } from 'react';

import { cn } from '@/lib/utils';

import { NavGroup } from './nav-group';

const NavMini = memo(({ data, className, ...props }: NavProps) => {
  return (
    <nav className={cn('flex flex-col', className)} {...props}>
      <ul className='flex flex-col space-y-1'>
        {data.map((item, index) => (
          <NavGroup key={item.name || index} items={item.items} />
        ))}
      </ul>
    </nav>
  );
});
NavMini.displayName = 'NavMini';

export { NavMini };
