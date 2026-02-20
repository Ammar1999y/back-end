import { memo, useCallback } from 'react';

import { motion, Transition } from 'framer-motion';
import { useShallow } from 'zustand/shallow';
import { cn } from '@/lib/utils';

import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';

import { MainTabsAnimatedBackground } from './main-tabs-animated-background';
import { useTabsStore } from './store';

export interface TabConfig {
  id: string;
  label: string;
}

const underlineTransition: Transition = {
  duration: 0.3,
  type: 'spring',
  stiffness: 200,
  damping: 20,
  mass: 1,
};

const MainTabs = memo(({ tabs }: { tabs: TabConfig[] }) => {
  return (
    <ScrollArea viewportClassName='pb-3 pt-1 px-1'>
      <div className='relative flex items-center space-x-e-2'>
        <div
          data-ignore
          className='absolute -bottom-1.5 left-0 right-0 h-0.5 w-full bg-border'
        />

        {tabs.map((tab, i) => (
          <TabButton key={tab.id} tab={tab} index={i} />
        ))}
      </div>
      <ScrollBar orientation='horizontal' />
    </ScrollArea>
  );
});
MainTabs.displayName = 'MainTabs';

export { MainTabs };

const TabButton = memo(({ tab, index }: { tab: TabConfig; index: number }) => {
  const isActive = useTabsStore(
    useShallow(
      (s) => s.activeMainTab === tab.id || (index === 0 && !s.activeMainTab)
    )
  );

  const handleClick = useCallback(() => {
    useTabsStore.getState().setActiveMainTab(tab.id);
  }, [tab.id]);

  const onHover = useCallback(() => {
    useTabsStore.getState().setHoveredMainTab(tab.id);
  }, [tab.id]);

  const onLeave = useCallback(() => {
    useTabsStore.getState().setHoveredMainTab(null);
  }, []);

  return (
    <button
      onClick={handleClick}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      className={cn(
        'relative h-8 whitespace-nowrap rounded-md px-3 py-2 transition-all duration-300',
        !isActive && 'hover:text-foreground',
        isActive ? 'text-foreground' : 'text-muted-foreground'
      )}
      type='button'
    >
      {/* Hover background */}
      {!isActive && <MainTabsAnimatedBackground tab={tab.id} />}

      {/* Text */}

      {/* Active underline */}
      {isActive && (
        <motion.div
          layoutId='underline-main-tabs'
          className='absolute -bottom-1.5 left-0 h-0.5 w-full bg-foreground'
          transition={underlineTransition}
        />
      )}
      <span className='relative z-[1] flex h-full items-center justify-center whitespace-nowrap text-sm font-medium leading-5'>
        {tab.label}
      </span>
    </button>
  );
});
TabButton.displayName = 'TabButton';
