import { useCallback } from 'react';

import { useShallow } from 'zustand/shallow';
import { cn } from '@/lib/utils';

import { useModules } from '@/utils/store/modules';

import {
  DialogContent,
  Dialog as DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog';

import { ModulesNames } from '../modules/modules-handler';
import { ScrollArea } from './scroll-area';

export default function DialogWrapper({
  name,
  children,
  title,
  className,
  onClose,
  TitleComponent,
  bodyClassName,
  Footer,
  side,
  ...props
}: {
  name: ModulesNames;
  children: React.ReactNode;
  title?: string;
  className?: string;
  onClose?: () => void;
  TitleComponent?: React.ReactNode;
  bodyClassName?: string;
  Footer?: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left' | 'center';
} & React.ComponentProps<typeof DialogRoot>) {
  const isOpen = useModules(
    useShallow((state) => state.openModules.includes(name))
  );
  const addModule = useModules(useShallow((state) => state.addModule));
  const removeModule = useModules(useShallow((state) => state.removeModule));
  const onOpenChange = useCallback(
    (isOpen: boolean) => {
      if (isOpen) addModule(name);
      else {
        if (typeof onClose === 'function') onClose();
        removeModule(name);
      }
    },
    [name, addModule, removeModule, onClose]
  );
  return (
    <DialogRoot open={isOpen} onOpenChange={onOpenChange} {...props}>
      <DialogContent
        className={cn(
          !Footer && (title || TitleComponent) && 'grid-rows-[auto_1fr]',
          !title && !TitleComponent && Footer && 'grid-rows-[1fr_auto]',
          !title && !TitleComponent && !Footer && 'grid-rows-[1fr]',
          className
        )}
        side={side}
      >
        {!!TitleComponent ? (
          TitleComponent
        ) : title ? (
          <DialogTitle className='max-w-[90%] pb-1 ps-6 pt-6'>
            {title}
          </DialogTitle>
        ) : null}
        <ScrollArea className={cn('h-full', bodyClassName)}>
          {children}
        </ScrollArea>
        {!!Footer && <>{Footer}</>}
      </DialogContent>
    </DialogRoot>
  );
}
