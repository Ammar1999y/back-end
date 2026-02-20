import { memo } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';

import { useErrors } from '@/utils/store/errors';

const inputMessageVariants = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: 'auto' },
  exit: { opacity: 0, height: 0 },
  transition: { duration: 0.2 },
};

export const ErrorMessage = memo(
  ({ path, tip }: { path: string; tip?: string }) => {
    const errorMessage = useErrors(useShallow((state) => state.errors[path]));
    return (
      <AnimatePresence mode='wait'>
        {errorMessage && (
          <motion.div
            variants={inputMessageVariants}
            initial='initial'
            animate='animate'
            exit='exit'
            key={'error'}
            className='select-none text-sm text-red-700'
          >
            <p className='pt-1.5'>{errorMessage}</p>
          </motion.div>
        )}
        {!!tip && !errorMessage && (
          <motion.div
            variants={inputMessageVariants}
            initial='initial'
            animate='animate'
            exit='exit'
            key='tip'
            className='select-none text-sm text-muted-foreground'
          >
            <p className='pt-1.5'>{tip}</p>
          </motion.div>
        )}
      </AnimatePresence>
    );
  }
);

ErrorMessage.displayName = 'ErrorMessage';
