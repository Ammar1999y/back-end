import { memo } from 'react';

import { Separator } from '@/components/ui/separator';

import { LayoutSelector } from './layout-selector';
import { PresetSelector } from './preset-selector';
import { StyleControls } from './style-controls';
import { ThemeModeSelector } from './theme-mode-selector';

export const ThemeTab = memo(() => {
  return (
    <div className='p-4 space-y-6'>
      <PresetSelector />
      <Separator />
      <StyleControls />
      <Separator />
      <ThemeModeSelector />
      <Separator />
      <LayoutSelector />
    </div>
  );
});

ThemeTab.displayName = 'ThemeTab';
