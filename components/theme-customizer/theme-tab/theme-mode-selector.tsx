import { memo, useCallback } from 'react';

import { cn } from '@/lib/utils';

import Label from '@/components/ui/label';
import Moon from '@/components/icons/moon';
import Sun from '@/components/icons/sun';
import { useTheme } from '@/components/theme-customizer/theme-provider';

const ThemeModeSelector = memo(() => {
  const { theme, toggleTheme } = useTheme();
  const isDarkMode = theme === 'dark';

  const handleLightMode = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (isDarkMode === false) return;
      const { clientX: x, clientY: y } = event;
      toggleTheme({ x, y });
    },
    [isDarkMode, toggleTheme]
  );

  const handleDarkMode = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (isDarkMode === true) return;
      const { clientX: x, clientY: y } = event;
      toggleTheme({ x, y });
    },
    [isDarkMode, toggleTheme]
  );

  return (
    <div className='space-y-3'>
      <Label className='font-medium' title='الوضع' />

      <div className='flex space-x-4'>
        <button
          type='button'
          aria-label='الوضع النهاري'
          onClick={handleLightMode}
          className={cn(
            'flex h-20 flex-1 cursor-pointer items-center justify-center rounded-xl border bg-transparent py-6 text-card-foreground opacity-65 shadow-sm transition duration-300',
            isDarkMode
              ? 'bg-card'
              : 'pointer-events-none select-none text-primary opacity-100'
          )}
          disabled={!isDarkMode}
        >
          <Sun size={24} className='size-7' />
        </button>
        <button
          type='button'
          aria-label='الوضع الليلي'
          onClick={handleDarkMode}
          className={cn(
            'flex h-20 flex-1 cursor-pointer items-center justify-center rounded-xl border bg-transparent py-6 text-card-foreground opacity-65 shadow-sm transition duration-300',
            isDarkMode
              ? 'pointer-events-none select-none text-primary opacity-100'
              : 'bg-card hover:bg-transparent'
          )}
          disabled={isDarkMode}
        >
          <Moon size={24} className='size-7' />
        </button>
      </div>
    </div>
  );
});
ThemeModeSelector.displayName = 'ThemeModeSelector';

export { ThemeModeSelector };
