import { usePathname } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

import { NavItemDataProps } from '../types';

export function useNavItemState(data: NavItemDataProps, depth: number = 0) {
  const pathname = usePathname();

  const isActive = useMemo(() => {
    if (!pathname) return false;

    // Force exact match if specified
    if (data.exactMatch) {
      return pathname === data.path;
    }

    const hasChildren = data.children && data.children.length > 0;

    if (hasChildren) {
      return pathname === data.path || pathname.startsWith(data.path + '/');
    }

    return pathname === data.path;
  }, [pathname, data.path, data.children, data.exactMatch]);

  const hasChild = useMemo(
    () =>
      data.children && data.children.length > 0 && !data.hideChildrenDropdown,
    [data.children, data.hideChildrenDropdown]
  );

  const [open, setOpen] = useState(isActive);

  const handleClick = useCallback(() => {
    if (hasChild) {
      setOpen((prev) => !prev);
    }
  }, [hasChild]);

  const navItemProps = useMemo(
    () => ({
      // data
      path: data.path,
      title: data.title,
      caption: data.caption,
      info: data.info,
      icon: data.icon,
      auth: data.auth,
      blink: data.blink,
      // state
      disabled: data.disabled,
      active: isActive,
      open,
      // options
      hasChild,
      depth,
      // event
      onClick: handleClick,
    }),
    [
      data.path,
      data.title,
      data.caption,
      data.info,
      data.icon,
      data.auth,
      data.disabled,
      data.blink,
      isActive,
      open,
      hasChild,
      depth,
      handleClick,
    ]
  );

  return {
    isActive,
    hasChild,
    open,
    setOpen,
    handleClick,
    navItemProps,
  };
}
