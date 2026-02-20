import type { NavProps } from '@/components/nav/types';

import { useCallback } from 'react';

import { APP_NAME } from '@/constants';
import { ArrowLeftToLine, ArrowRightToLine } from 'lucide-react';
import { useShallow } from 'zustand/shallow';
import { cn } from '@/lib/utils';

import { useSettingStore } from '@/utils/store/setting';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import Logo from '@/components/logo';
import { NavMini, NavVertical } from '@/components/nav';
import { ThemeLayout } from '@/components/theme-customizer/types/enum';

type Props = {
  data: NavProps['data'];
  className?: string;
};

export function NavVerticalLayout({ data, className }: Props) {
  const themeLayout = useSettingStore(
    useShallow((s) => s.settings.themeLayout)
  );

  const navWidth =
    themeLayout === ThemeLayout.Vertical
      ? 'var(--layout-nav-width)'
      : 'var(--layout-nav-width-mini)';
  const handleToggle = useCallback(() => {
    useSettingStore.getState().actions.setSettings({
      ...useSettingStore.getState().settings,
      themeLayout:
        useSettingStore.getState().settings.themeLayout === ThemeLayout.Mini
          ? ThemeLayout.Vertical
          : ThemeLayout.Mini,
    });
  }, []);
  return (
    <nav
      data-slot='slash-layout-nav'
      className={cn(
        'fixed inset-y-0 z-nav h-full flex-col border-e border-dashed bg-background transition-[width] duration-300 ease-in-out ltr:left-[var(--removed-body-scroll-bar-size,0px)] rtl:right-[var(--removed-body-scroll-bar-size,0px)]',
        className
      )}
      style={{
        width: navWidth,
      }}
    >
      <div
        className={cn(
          'relative flex h-[--layout-header-height] items-center pe-2 ps-6 pt-[calc((var(--spacing)*4)+env(safe-area-inset-top))]',
          themeLayout === ThemeLayout.Mini && 'justify-center'
        )}
      >
        <div className='flex h-full items-center justify-center py-1 space-x-4'>
          <Logo size={50} className='h-full max-w-16' />

          <span
            className='text-xl font-bold transition-all duration-300 ease-in-out'
            style={{
              opacity: themeLayout === ThemeLayout.Mini ? 0 : 1,
              maxWidth: themeLayout === ThemeLayout.Mini ? 0 : 'auto',
              whiteSpace: 'nowrap',
              marginLeft: themeLayout === ThemeLayout.Mini ? 0 : '8px',
            }}
          >
            {APP_NAME}
          </span>
        </div>

        <Button
          variant='outline'
          size='icon'
          onClick={handleToggle}
          className='absolute top-1/2 size-7 -translate-y-1/2 bg-background ltr:right-0 ltr:translate-x-1/2 rtl:left-0 rtl:-translate-x-1/2 rtl:rotate-180'
        >
          {themeLayout === ThemeLayout.Mini ? (
            <ArrowRightToLine
              size={10}
              color='currentColor'
              className='size-3'
            />
          ) : (
            <ArrowLeftToLine
              size={10}
              color='currentColor'
              className='size-3'
            />
          )}
        </Button>
      </div>

      <ScrollArea
        className={cn(
          'h-[calc(100vh-var(--layout-header-height))] bg-background px-2 text-muted-foreground'
        )}
      >
        {themeLayout === ThemeLayout.Mini ? (
          <NavMini data={data} />
        ) : (
          <NavVertical data={data} />
        )}
      </ScrollArea>
    </nav>
  );
}
