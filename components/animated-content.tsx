import { AnimatePresence, motion, Transition, Variants } from 'framer-motion';

interface AnimatedContentProps {
  children: React.ReactNode;
  keyValue: string | number;
}
const variants: Variants = {
  initial: {
    opacity: 0,
    x: 20,
    filter: 'blur(4px)',
  },
  animate: {
    opacity: 1,
    x: 0,
    filter: 'blur(0px)',
  },
  exit: {
    opacity: 0,
    x: -20,
    filter: 'blur(4px)',
  },
};

const transition: Transition = {
  duration: 0.3,
  ease: [0.4, 0, 0.2, 1],
};

export const AnimatedContent = ({
  children,
  keyValue,
}: AnimatedContentProps) => {
  return (
    <AnimatePresence mode='wait'>
      <motion.div
        key={keyValue}
        variants={variants}
        initial='initial'
        animate='animate'
        exit='exit'
        transition={transition}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
};
