'use client';

import type { SortableContextProps } from '@dnd-kit/sortable';

import * as React from 'react';

import { SortableContext } from '@dnd-kit/sortable';
import { Slot } from '@radix-ui/react-slot';

import { CONTENT_NAME } from './constants';
import { SortableContentContext, useSortableContext } from './sortable-context';

interface SortableContentProps extends React.ComponentProps<'div'> {
  strategy?: SortableContextProps['strategy'];
  children: React.ReactNode;
  asChild?: boolean;
  withoutSlot?: boolean;
}

function SortableContent(props: SortableContentProps) {
  const {
    strategy: strategyProp,
    asChild,
    withoutSlot,
    children,
    ref,
    ...contentProps
  } = props;

  const context = useSortableContext(CONTENT_NAME);

  const ContentPrimitive = React.useMemo(
    () => (asChild ? Slot : 'div'),
    [asChild]
  );

  return (
    <SortableContentContext.Provider value={true}>
      <SortableContext
        items={context.items}
        strategy={strategyProp ?? context.strategy}
      >
        {withoutSlot ? (
          children
        ) : (
          <ContentPrimitive
            data-slot='sortable-content'
            {...contentProps}
            ref={ref}
          >
            {children}
          </ContentPrimitive>
        )}
      </SortableContext>
    </SortableContentContext.Provider>
  );
}

export { SortableContent };
export type { SortableContentProps };
