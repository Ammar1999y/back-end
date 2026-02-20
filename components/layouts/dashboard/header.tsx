import type { ReactNode } from 'react';

import { memo } from 'react';

import { cn } from '@/lib/utils';

import AccountDropdown from '../components/account-dropdown';
import BreadCrumb from '../components/bread-crumb';
import RefreshButton from '../components/refresh-button';
import SettingButton from '../components/setting-button';

interface HeaderProps {
  leftSlot?: ReactNode;
}

export default memo(function Header({ leftSlot }: HeaderProps) {
  return (
    <header
      data-slot='slash-layout-header'
      className={cn(
        'sticky left-0 right-0 top-0 z-app-bar bg-background/60 backdrop-blur-xl',
        'flex shrink-0 grow-0 flex-col items-start justify-between px-4 pb-4 pt-[calc((var(--spacing)*4)+env(safe-area-inset-top))] space-y-2 md:pe-8 md:ps-3',
        'h-[--layout-header-height]'
      )}
    >
      <div className='flex h-full w-full flex-1 items-center justify-between'>
        <div className='flex h-full items-center'>
          {leftSlot}

          <div className='ms-4 hidden md:block'>
            <BreadCrumb />
          </div>
        </div>

        <div className='flex items-center space-x-3'>
          <RefreshButton />
          <SettingButton />
          <AccountDropdown />
        </div>
      </div>
      <div className='ms-2 md:hidden'>
        <BreadCrumb />
      </div>
    </header>
  );
});
