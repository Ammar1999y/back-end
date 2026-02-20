import type { NavListProps } from '../types';

import { memo, useCallback, useMemo } from 'react';

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';

import { NavItem } from '../components/nav-item';
import { useNavItemState } from '../hooks/use-nav-item-state';

const NavList = memo(({ data, depth = 0 }: NavListProps) => {
  const { hasChild, navItemProps } = useNavItemState(data, depth);

  const navItem = useMemo(
    () => <NavItem variant='horizontal' {...navItemProps} />,
    [navItemProps]
  );

  const renderWithHoverCard = useCallback(() => {
    return (
      <HoverCard openDelay={100}>
        <HoverCardTrigger>{navItem}</HoverCardTrigger>
        <HoverCardContent
          side={depth === 1 ? 'bottom' : 'left'}
          sideOffset={10}
          className='p-1'
        >
          {data.children?.map((child) => (
            <NavList key={child.title} data={child} depth={depth + 1} />
          ))}
        </HoverCardContent>
      </HoverCard>
    );
  }, [navItem, depth, data.children]);
  if (data.hidden) {
    return null;
  }

  return <li>{hasChild ? renderWithHoverCard() : navItem}</li>;
});
NavList.displayName = 'NavList';

export { NavList };
