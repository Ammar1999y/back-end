import { memo, useCallback } from 'react';

import { useShallow } from 'zustand/shallow';
import { cn } from '@/lib/utils';

import { useSettings, useSettingStore } from '@/utils/store/setting';

import Label from '@/components/ui/label';
import { ThemeLayout } from '@/components/theme-customizer/types/enum';

import { useEditorStore } from '../store/editor-store';
import { StretchToggle } from './stretch-toggle';

const LayoutSelector = memo(() => {
  const settings = useSettings();
  const { themeLayout } = settings;
  const containerStretch = useEditorStore(
    useShallow((s) => s.containerStretch)
  );

  const updateLayout = useCallback((layout: ThemeLayout) => {
    const settings = useSettingStore.getState().settings;
    const setSettings = useSettingStore.getState().actions.setSettings;
    setSettings({
      ...settings,
      themeLayout: layout,
    });
  }, []);

  const handleVerticalLayout = useCallback(() => {
    updateLayout(ThemeLayout.Vertical);
  }, [updateLayout]);

  const handleMiniLayout = useCallback(() => {
    updateLayout(ThemeLayout.Mini);
  }, [updateLayout]);

  const handleHorizontalLayout = useCallback(() => {
    updateLayout(ThemeLayout.Horizontal);
  }, [updateLayout]);

  return (
    <div className='space-y-3'>
      <Label className='font-medium' title='التخطيط' />

      <div className='grid grid-cols-3 gap-4'>
        {/* vertical */}
        <button
          type='button'
          onClick={handleVerticalLayout}
          className={cn(
            'flex h-16 flex-1 cursor-pointer flex-row overflow-hidden rounded-xl border text-card-foreground opacity-65 shadow-sm transition duration-300 space-x-1',
            themeLayout === ThemeLayout.Vertical
              ? 'opacity-100'
              : 'bg-card hover:bg-transparent'
          )}
        >
          <div className='flex h-full w-5 flex-col p-1 space-y-1'>
            <div
              className={cn(
                'h-2 w-2 shrink-0 rounded',
                themeLayout === ThemeLayout.Vertical
                  ? 'bg-primary'
                  : 'bg-gray-500'
              )}
            />
            <div
              className={cn(
                'h-1 w-full shrink-0 rounded opacity-50',

                themeLayout === ThemeLayout.Vertical
                  ? 'bg-primary'
                  : 'bg-gray-500'
              )}
            />
            <div
              className={cn(
                'h-1 max-w-3 shrink-0 rounded opacity-20',

                themeLayout === ThemeLayout.Vertical
                  ? 'bg-primary'
                  : 'bg-gray-500'
              )}
            />
          </div>
          <div className='flex h-full w-full flex-1 grow flex-col p-1 space-y-1'>
            <div
              className={cn(
                'h-1.5 w-full rounded opacity-20',
                themeLayout === ThemeLayout.Vertical
                  ? 'bg-primary'
                  : 'bg-gray-500'
              )}
            />
            <div
              className={cn(
                'mx-auto w-full flex-1 rounded opacity-20 transition-all duration-300 ease-in-out',
                !containerStretch && 'w-10',
                themeLayout === ThemeLayout.Vertical
                  ? 'bg-primary'
                  : 'bg-gray-500'
              )}
            />
          </div>
        </button>

        {/* mini */}
        <button
          type='button'
          onClick={handleMiniLayout}
          className={cn(
            'flex h-16 flex-1 cursor-pointer flex-row overflow-hidden rounded-xl border text-card-foreground opacity-65 shadow-sm transition duration-300 space-x-1',
            themeLayout === ThemeLayout.Mini
              ? 'opacity-100'
              : 'bg-card hover:bg-transparent'
          )}
        >
          <div className='flex-0 flex h-full w-3 flex-col items-center p-1 space-y-1'>
            <div
              className={cn(
                'h-2 w-2 shrink-0 rounded',
                themeLayout === ThemeLayout.Mini ? 'bg-primary' : 'bg-gray-500'
              )}
            />
            <div
              className={cn(
                'h-1 w-full shrink-0 rounded opacity-50',

                themeLayout === ThemeLayout.Mini ? 'bg-primary' : 'bg-gray-500'
              )}
            />
            <div
              className={cn(
                'h-1 w-full shrink-0 rounded opacity-20',

                themeLayout === ThemeLayout.Mini ? 'bg-primary' : 'bg-gray-500'
              )}
            />
          </div>
          <div className='flex h-full w-full flex-1 grow flex-col p-1 space-y-1'>
            <div
              className={cn(
                'h-1.5 w-full rounded opacity-20',

                themeLayout === ThemeLayout.Mini ? 'bg-primary' : 'bg-gray-500'
              )}
            />
            <div
              className={cn(
                'mx-auto w-full flex-1 rounded opacity-20 transition-all duration-300 ease-in-out',
                !containerStretch && 'w-10',

                themeLayout === ThemeLayout.Mini ? 'bg-primary' : 'bg-gray-500'
              )}
            />
          </div>
        </button>

        {/* horizontal */}
        <button
          type='button'
          onClick={handleHorizontalLayout}
          className={cn(
            'flex h-16 flex-1 cursor-pointer flex-col overflow-hidden rounded-xl border text-card-foreground opacity-65 shadow-sm transition duration-300 space-x-1',
            themeLayout === ThemeLayout.Horizontal
              ? 'opacity-100'
              : 'bg-card hover:bg-transparent'
          )}
        >
          <div className='flex-0 flex w-full items-center p-1 space-x-1'>
            <div
              className={cn(
                'h-2 w-2 shrink-0 rounded',
                themeLayout === ThemeLayout.Horizontal
                  ? 'bg-primary'
                  : 'bg-gray-500'
              )}
            />
            <div
              className={cn(
                'h-1 w-4 shrink-0 rounded opacity-50',
                themeLayout === ThemeLayout.Horizontal
                  ? 'bg-primary'
                  : 'bg-gray-500'
              )}
            />
            <div
              className={cn(
                'h-1 w-3 shrink-0 rounded opacity-20',
                themeLayout === ThemeLayout.Horizontal
                  ? 'bg-primary'
                  : 'bg-gray-500'
              )}
            />
            <div
              className={cn(
                'h-1 w-3 shrink-0 rounded opacity-20',
                themeLayout === ThemeLayout.Horizontal
                  ? 'bg-primary'
                  : 'bg-gray-500'
              )}
            />
          </div>
          <div
            className={cn(
              'mx-1 h-1.5 rounded opacity-20',
              themeLayout === ThemeLayout.Horizontal
                ? 'bg-primary'
                : 'bg-gray-500'
            )}
          />
          <div className='flex h-full w-full flex-1 grow flex-col p-1 space-y-1'>
            <div
              className={cn(
                'mx-auto h-full w-full rounded opacity-20 transition-all duration-300 ease-in-out',
                !containerStretch && 'w-10',
                themeLayout === ThemeLayout.Horizontal
                  ? 'bg-primary'
                  : 'bg-gray-500'
              )}
            />
          </div>
        </button>
      </div>

      {/* Container stretch toggle */}
      <StretchToggle containerStretch={containerStretch} />
    </div>
  );
});
LayoutSelector.displayName = 'LayoutSelector';

export { LayoutSelector };
