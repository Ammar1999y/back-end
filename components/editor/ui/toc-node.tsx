'use client';

import type { PlateElementProps } from 'platejs/react';

import { useTocElement, useTocElementState } from '@platejs/toc/react';
import { cva } from 'class-variance-authority';
import { PlateElement } from 'platejs/react';

import { Button } from '@/components/ui/button';

const headingItemVariants = cva(
  'block h-auto w-full cursor-pointer truncate rounded-none px-0.5 py-1.5 text-left font-medium text-muted-foreground underline decoration-[0.5px] underline-offset-4 hover:bg-accent hover:text-muted-foreground',
  {
    variants: {
      depth: {
        1: 'ps-0.5',
        2: 'ps-6',
        3: 'ps-12',
      },
    },
  }
);

export function TocElement(props: PlateElementProps) {
  const state = useTocElementState();
  const { props: btnProps } = useTocElement(state);
  const { headingList } = state;

  return (
    <PlateElement
      {...props}
      // @ts-ignore
      attributes={{
        ...props.attributes,
        'data-ltr-element': true,
      }}
      className='mb-1 p-0'
    >
      <div contentEditable={false}>
        {headingList.length > 0 ? (
          headingList.map((item) => (
            <Button
              aria-current
              className={headingItemVariants({
                depth: item.depth as 1 | 2 | 3,
              })}
              key={item.id}
              onClick={(e) => btnProps.onClick(e, item, 'smooth')}
              variant='ghost'
            >
              {item.title}
            </Button>
          ))
        ) : (
          <div className='text-sm text-gray-500'>
            Create a heading to display the table of contents.
          </div>
        )}
      </div>
      {props.children}
    </PlateElement>
  );
}
