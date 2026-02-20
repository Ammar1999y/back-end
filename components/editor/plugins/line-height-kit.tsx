'use client';

import { LineHeightPlugin } from '@platejs/basic-styles/react';
import { KEYS } from 'platejs';

export const LineHeightKit = [
  LineHeightPlugin.configure({
    inject: {
      nodeProps: {
        defaultNodeValue: 'unset',
        validNodeValues: ['unset', 1, 1.2, 1.5, 2, 3],
      },
      targetPlugins: [...KEYS.heading, KEYS.p],
    },
  }),
];
