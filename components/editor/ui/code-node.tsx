'use client';

import type { PlateLeafProps } from 'platejs/react';

import { PlateLeaf } from 'platejs/react';

export function CodeLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf
      {...props}
      as='code'
      className='whitespace-pre-wrap rounded-md bg-muted px-1.5 py-1 font-mono text-sm'
    >
      {props.children}
    </PlateLeaf>
  );
}
