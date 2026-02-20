import { motion } from 'framer-motion';
import useMeasure from 'react-use-measure';
import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';
import { cn } from '@/lib/utils';

interface SmoothHeightContainerProps {
  children: React.ReactNode;
  motionClassName?: string;
  className?: string;
}

export const useStore = create<{
  disabled: boolean;
  setDisabled: (disabled: boolean) => void;
}>((set) => ({
  disabled: false,
  setDisabled: (disabled) => set({ disabled }),
}));

const SmoothHeightContainer = ({
  children,
  motionClassName,
  className,
}: SmoothHeightContainerProps) => {
  const [ref, bounds] = useMeasure();
  const disabled = useStore(useShallow((s) => s.disabled));
  return (
    <motion.div
      className={cn('relative overflow-hidden', motionClassName)}
      animate={{ height: disabled ? 'auto' : bounds.height || 'auto' }}
    >
      <div ref={ref} className={className}>
        {children}
      </div>
    </motion.div>
  );
};

export { SmoothHeightContainer };
