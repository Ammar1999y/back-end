'use client';

import { createPlatePlugin } from 'platejs/react';

import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { FixedToolbar } from '@/components/editor/ui/fixed-toolbar';
import { FixedToolbarButtons } from '@/components/editor/ui/fixed-toolbar-buttons';

export const FixedToolbarKit = [
  createPlatePlugin({
    key: 'fixed-toolbar',
    render: {
      beforeEditable: () => (
        <FixedToolbar>
          <ScrollArea viewportClassName='p-1 pb-3'>
            <div className='absolute inset-0 h-full w-full bg-muted/50'></div>
            <FixedToolbarButtons />
            <ScrollBar orientation='horizontal' />
          </ScrollArea>
        </FixedToolbar>
      ),
    },
  }),
];
