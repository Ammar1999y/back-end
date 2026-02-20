import type { NavItemProps } from '../types';

import Link from 'next/link';

import { cn } from '@/lib/utils';

type NavItemRendererProps = {
  item: NavItemProps;
  className: string;
  children: React.ReactNode;
};

/**
 * Renderer for Navigation Items.
 * Handles disabled, external link, clickable child container, and internal link logic.
 */
export const NavItemRenderer: React.FC<NavItemRendererProps> = ({
  item,
  className,
  children,
}) => {
  const { disabled, hasChild, path, onClick, blink } = item;

  return disabled || hasChild ? (
    <button
      type='button'
      tabIndex={disabled ? -1 : 0}
      className={cn(className, disabled && 'disabled')}
      onClick={onClick as any}
    >
      {children}
    </button>
  ) : (
    <Link
      href={path}
      className={className}
      target={blink ? '_blank' : undefined}
    >
      {children}
    </Link>
  );
};
