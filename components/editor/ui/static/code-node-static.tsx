import type { SlateLeafProps } from 'platejs/static';

import { SlateLeaf } from 'platejs/static';

export function CodeLeafStatic(props: SlateLeafProps) {
  return (
    <SlateLeaf
      {...props}
      as='code'
      className='whitespace-pre-wrap rounded-md bg-muted px-1.5 py-1 font-mono text-sm'
    >
      {props.children}
    </SlateLeaf>
  );
}
