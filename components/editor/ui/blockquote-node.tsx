'use client';

import type { PlateElementProps } from 'platejs/react';

import { PlateElement } from 'platejs/react';

export function BlockquoteElement(props: PlateElementProps) {
  return (
    <PlateElement
      as='blockquote'
      className='my-1 border-s-2 ps-6 italic'
      {...props}
      // @ts-ignore
      attributes={{
        ...props.attributes,
        'data-ltr-element': true,
      }}
    />
  );
}
