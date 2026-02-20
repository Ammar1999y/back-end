import { memo } from 'react';

import { AnimatePresence, motion, Variants } from 'framer-motion';
import { useShallow } from 'zustand/shallow';

import { useTabsStore } from './store';

const bgVariants: Variants = {
  initial: {
    opacity: 0,
  },
  hover: {
    opacity: 1,
    transition: {
      duration: 0.3,
    },
  },
  exit: {
    opacity: 0,
    transition: {
      duration: 0.3,
      delay: 0.2,
    },
  },
};

const MainTabsAnimatedBackground = memo(({ tab }: { tab: string }) => {
  const hoveredMainTab = useTabsStore(
    useShallow((state) => state.hoveredMainTab)
  );

  return (
    <AnimatePresence>
      {hoveredMainTab === tab && (
        <motion.span
          className='absolute inset-0 block h-full w-full rounded-md bg-accent'
          layoutId='hover-background-main-tabs'
          variants={bgVariants}
          initial='initial'
          animate='hover'
          exit='exit'
        />
      )}
    </AnimatePresence>
  );
});
MainTabsAnimatedBackground.displayName = 'MainTabsAnimatedBackground';

export { MainTabsAnimatedBackground };
