import { CSSProperties, useCallback } from 'react';

import { Drawer as DrawerPrimitive } from 'vaul';
import { useShallow } from 'zustand/shallow';
import { cn } from '@/lib/utils';

import { useModules } from '@/utils/store/modules';

import { ModulesNames } from '../modules/modules-handler';

const Drawer = ({
  name,
  children,
  title,
  autoFocus = true,
  classNames,
  onClose,
  style,
  Footer,
  ...props
}: {
  name: ModulesNames;
  children: React.ReactNode;
  title: string;
  isAutoFocus?: boolean;
  Footer?: React.ReactNode;
  classNames?: {
    content?: string;
    title?: string;
    description?: string;
    handle?: string;
    main?: string;
  };
  style?: CSSProperties;
  onClose?: () => void;
} & React.ComponentProps<typeof DrawerPrimitive.Root>) => {
  const isOpen = useModules(
    useShallow((state) => state.openModules.includes(name))
  );
  const addModule = useModules(useShallow((state) => state.addModule));
  const removeModule = useModules(useShallow((state) => state.removeModule));
  const onOpenChange = useCallback(
    (isOpen: boolean) => {
      if (isOpen) addModule(name);
      else {
        onClose?.();
        removeModule(name);
      }
    },
    [name, addModule, removeModule, onClose]
  );

  const focusRef = useCallback((el: HTMLDivElement) => el?.focus(), []);
  return (
    <DrawerPrimitive.Root
      data-slot='drawer'
      open={isOpen}
      onOpenChange={onOpenChange}
      {...props}
    >
      <DrawerPrimitive.Portal data-slot='drawer-portal'>
        <DrawerPrimitive.Overlay
          data-slot='drawer-overlay'
          aria-hidden
          // 🔴 added pointer-events-none select-none to prevent close it by clicking outside
          className='pointer-events-none fixed inset-0 z-50 h-screen w-screen select-none bg-border/50 backdrop-blur-md backdrop-saturate-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
        />
        <DrawerPrimitive.Content
          data-slot='drawer-content'
          className={cn(
            'group/drawer-content bg-module fixed inset-x-0 bottom-0 z-50 grid !h-auto max-h-[90vh] grid-rows-[auto_auto_1fr_auto] rounded-t-xl border-t pb-[calc(env(safe-area-inset-bottom,0px)+var(--pb))] font-main',
            classNames?.content
          )}
          // 🔴 if want to prevent close it by clicking outside
          onInteractOutside={(e) => {
            e.preventDefault();
          }}
          style={style}
        >
          <DrawerPrimitive.Handle
            data-slot='drawer-handle'
            className='mb-5 mt-4 !h-2 !w-24'
          />
          <DrawerPrimitive.Title
            data-slot='drawer-title'
            className={cn(
              'pb-3 font-semibold text-foreground',
              classNames?.title
            )}
          >
            {title}
          </DrawerPrimitive.Title>
          <div
            data-lenis-prevent
            {...(autoFocus && {
              autoFocus: true,
              ref: focusRef,
              tabIndex: -1,
            })}
            className={cn(
              'min-h-0 overflow-y-auto pb-10 !outline-none !outline-0',
              classNames?.main
            )}
          >
            {children}
          </div>
          {!!Footer && <>{Footer}</>}
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.Root>
  );
};

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot='drawer-description'
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export { Drawer, DrawerDescription };
