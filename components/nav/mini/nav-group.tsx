import type { NavGroupProps } from '../types';

import { memo } from 'react';

import { NavList } from './nav-list';

const NavGroup = memo(({ items }: NavGroupProps) => {
  return (
    <li>
      <ul className='flex flex-col space-y-1'>
        {items.map((item, index) => (
          <NavList key={item.title || index} data={item} depth={1} />
        ))}
      </ul>
    </li>
  );
});
NavGroup.displayName = 'NavGroup';

export { NavGroup };
