import * as React from 'react';

import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import { cn } from '@/lib/utils';

interface ScrollAreaProps extends React.ComponentPropsWithoutRef<
  typeof ScrollAreaPrimitive.Root
> {
  ref?: React.Ref<React.ComponentRef<typeof ScrollAreaPrimitive.Root>>;
  viewportClassName?: string;
}

function ScrollArea({
  className,
  viewportClassName,
  children,
  ref,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      ref={ref}
      className={cn('relative overflow-hidden', className)}
      data-lenis-prevent
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        className={cn('!block h-full w-full', viewportClassName)}
        asChild
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar className='z-scrollbar' />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

interface ScrollBarProps extends React.ComponentPropsWithoutRef<
  typeof ScrollAreaPrimitive.ScrollAreaScrollbar
> {
  ref?: React.Ref<
    React.ComponentRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
  >;
}

function ScrollBar({
  className,
  orientation = 'vertical',
  ref,
  ...props
}: ScrollBarProps) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      ref={ref}
      orientation={orientation}
      className={cn(
        'flex cursor-default touch-none select-none transition-colors',
        orientation === 'vertical' && 'h-full w-2.5 p-px',
        orientation === 'horizontal' && 'h-2.5 flex-col p-px',
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-lenis-prevent
        className='relative flex-1 rounded-full bg-border'
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
