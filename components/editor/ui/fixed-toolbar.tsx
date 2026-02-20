'use client';

import { cn } from '@/lib/utils';

import { Toolbar } from '@/components/ui/toolbar';

export function FixedToolbar(props: React.ComponentProps<typeof Toolbar>) {
  return (
    <Toolbar
      {...props}
      className={cn(
        'sticky left-0 top-0 z-50 w-full justify-between rounded-t-md border-b border-b-border bg-background text-muted-foreground',
        props.className
      )}
    />
  );
}
