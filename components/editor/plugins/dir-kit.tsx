'use client';

import { KEYS } from 'platejs';
import { createPlatePlugin } from 'platejs/react';

// Custom plugin for text direction (dir) attribute on block elements
// Uses inject.nodeProps to apply direction style based on 'dir' property
export const DirPlugin = createPlatePlugin({
  key: 'dir',
  inject: {
    nodeProps: {
      defaultNodeValue: 'auto',
      nodeKey: 'dir',
      styleKey: 'direction',
      validNodeValues: ['auto', 'ltr', 'rtl'],
    },
    targetPlugins: [
      ...KEYS.heading,
      KEYS.p,
      KEYS.blockquote,
      KEYS.callout,
      KEYS.codeBlock,
      KEYS.toggle,
      KEYS.li,
    ],
  },
});

export const DirKit = [DirPlugin];
