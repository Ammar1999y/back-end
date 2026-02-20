import type { NavItemProps } from '../types';

import { memo } from 'react';

import {
  ChevronDown as _ChevronDown,
  ChevronRight as _ChevronRight,
  Info as _Info,
} from 'lucide-react';
import { cn } from '@/lib/utils';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import { navItemClasses } from '../nav-item-classes';
import { NavItemRenderer } from './index';

// Memoize lucide icons
const ChevronRight = memo(_ChevronRight);
ChevronRight.displayName = 'ChevronRight';

const ChevronDown = memo(_ChevronDown);
ChevronDown.displayName = 'ChevronDown';

const Info = memo(_Info);
Info.displayName = 'Info';

type NavItemVariant = 'vertical' | 'horizontal' | 'mini-root' | 'mini-sub';

interface NavItemComponentProps extends NavItemProps {
  variant: NavItemVariant;
  isBlink?: boolean;
}

const NavItem = memo(({ variant, ...item }: NavItemComponentProps) => {
  const {
    title,
    icon,
    info,
    caption,
    open,
    active,
    disabled,
    depth,
    hasChild,
  } = item;

  // Vertical variant
  if (variant === 'vertical') {
    return (
      <NavItemRenderer
        item={item}
        className={cn(
          navItemClasses.base,
          navItemClasses.hover,
          'min-h-11',
          active && depth === 1 && navItemClasses.active,
          active && depth !== 1 && 'bg-accent text-accent-foreground',
          disabled && navItemClasses.disabled
        )}
      >
        <span className='me-3 inline-flex h-5 w-5 shrink-0 items-center justify-center'>
          {icon}
        </span>

        <span className='inline-flex min-h-6 flex-auto flex-col justify-center overflow-hidden'>
          <span className='overflow-hidden text-ellipsis whitespace-nowrap text-start text-sm font-medium leading-[1.5]'>
            {title}
          </span>

          {caption && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className='overflow-hidden text-ellipsis whitespace-nowrap text-start text-xs font-normal leading-[1.5]'>
                  {caption}
                </span>
              </TooltipTrigger>
              <TooltipContent side='top' align='start'>
                {caption}
              </TooltipContent>
            </Tooltip>
          )}
        </span>

        {info && (
          <span className='ms-1.5 inline-flex shrink-0 items-center justify-center'>
            {info}
          </span>
        )}

        {hasChild && (
          <ChevronRight
            className={cn(
              'ms-1.5 inline-flex h-4 w-4 shrink-0 items-center justify-center transition-all duration-300 ease-in-out',
              open ? 'rotate-90' : 'ltr:rotate-0 rtl:rotate-180'
            )}
          />
        )}
      </NavItemRenderer>
    );
  }

  // Horizontal variant
  if (variant === 'horizontal') {
    return (
      <NavItemRenderer
        item={item}
        className={cn(
          navItemClasses.base,
          navItemClasses.hover,
          'min-h-8 max-w-64 text-muted-foreground',
          active && depth === 1 && navItemClasses.active,
          active && depth !== 1 && 'bg-accent text-accent-foreground',
          disabled && navItemClasses.disabled
        )}
      >
        <span className='inline-flex h-5 w-5 shrink-0 items-center justify-center'>
          {icon}
        </span>

        <span className='ms-2 !block !flex-auto overflow-hidden text-ellipsis whitespace-nowrap text-start text-sm font-medium leading-[1.5]'>
          {title}
        </span>

        {caption && (
          <Tooltip>
            <TooltipTrigger>
              <Info size={16} className='ms-1.5 size-4 opacity-70' />
            </TooltipTrigger>
            <TooltipContent side='bottom'>{caption}</TooltipContent>
          </Tooltip>
        )}

        {info && (
          <span className='ms-1.5 inline-flex shrink-0 items-center justify-center'>
            {info}
          </span>
        )}

        {hasChild && (
          <ChevronDown
            className={cn(
              'ms-1.5 inline-flex h-4 w-4 shrink-0 items-center justify-center transition-all duration-300 ease-in-out',
              depth !== 1 && 'ltr:-rotate-90 rtl:rotate-90'
            )}
          />
        )}
      </NavItemRenderer>
    );
  }

  // Mini Root variant
  if (variant === 'mini-root') {
    return (
      <NavItemRenderer
        item={item}
        className={cn(
          navItemClasses.base,
          navItemClasses.hover,
          'relative min-h-12 flex-col px-1 pb-1.5 pt-2',
          active && depth === 1 && navItemClasses.active,
          active && depth !== 1 && 'bg-accent text-accent-foreground',
          disabled && navItemClasses.disabled
        )}
      >
        {caption && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className='absolute top-2 inline-flex ltr:left-1 rtl:right-1'>
                <Info size={16} className='size-4 opacity-70' />
              </span>
            </TooltipTrigger>
            <TooltipContent side='right'>{caption}</TooltipContent>
          </Tooltip>
        )}

        <span className='inline-flex h-5 w-5 shrink-0 items-center justify-center'>
          {icon}
        </span>

        {hasChild && (
          <ChevronRight className='absolute top-2 h-4 w-4 transition-all duration-300 ease-in-out ltr:right-1 rtl:left-1 rtl:rotate-180' />
        )}

        <span className='mt-1 line-clamp-2 w-full overflow-hidden whitespace-normal break-words text-center text-sm font-medium leading-[1.5]'>
          {title}
        </span>
      </NavItemRenderer>
    );
  }

  // Mini Sub variant
  return (
    <NavItemRenderer
      item={item}
      className={cn(
        navItemClasses.base,
        navItemClasses.hover,
        active && depth === 1 && navItemClasses.active,
        active && depth !== 1 && 'bg-accent text-accent-foreground',
        disabled && navItemClasses.disabled
      )}
    >
      <span className='mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center'>
        {icon}
      </span>

      <span className='flex-auto overflow-hidden text-ellipsis whitespace-nowrap text-start text-sm font-medium leading-[1.5]'>
        {title}
      </span>

      {caption && (
        <Tooltip>
          <TooltipTrigger>
            <Info size={16} className='size-4 opacity-70' />
          </TooltipTrigger>
          <TooltipContent>
            <p>{caption}</p>
          </TooltipContent>
        </Tooltip>
      )}

      {info && (
        <span className='ms-1.5 inline-flex shrink-0 items-center justify-center'>
          {info}
        </span>
      )}

      {hasChild && (
        <ChevronRight className='ms-1.5 inline-flex h-4 w-4 shrink-0 items-center justify-center transition-all duration-300 ease-in-out rtl:rotate-180' />
      )}
    </NavItemRenderer>
  );
});

NavItem.displayName = 'NavItem';

export { NavItem };
