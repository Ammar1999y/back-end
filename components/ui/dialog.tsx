import * as React from 'react';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

import { Button } from './button';

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;

const DialogOverlay = React.memo(
  ({
    className,
    ...props
  }: React.ComponentProps<typeof DialogPrimitive.Overlay>) => {
    return (
      <DialogPrimitive.Overlay
        data-lenis-prevent
        aria-hidden
        // 🔴 added pointer-events-none select-none to prevent close it by clicking outside
        /* backdrop-blur-md backdrop-saturate-150 */
        className={cn(
          'fixed inset-0 z-50 h-screen w-screen select-none bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          className
        )}
        {...props}
      />
    );
  }
);

DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

function DialogContent({
  className,
  overlayClassName,
  children,
  side = 'center',
  showCloseButton = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  side?: 'top' | 'right' | 'bottom' | 'left' | 'center';
  showCloseButton?: boolean;
  overlayClassName?: string;
}) {
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-lenis-prevent
        data-disable-drawer
        // 🔴 if want to prevent close it by clicking outside
        // onInteractOutside={(e) => {
        //   e.preventDefault();
        // }}
        data-slot='sheet-content'
        className={cn(
          'fixed z-50 grid max-w-[calc(100vw-env(safe-area-inset-left)-env(safe-area-inset-right))] grid-rows-[auto_1fr_auto] gap-4 bg-background shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out',
          side === 'right' &&
            'inset-y-0 right-0 h-full w-3/4 border-l pr-[env(safe-area-inset-right)] data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
          side === 'left' &&
            'inset-y-0 left-0 h-full w-3/4 border-r pl-[env(safe-area-inset-left)] data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left',
          side === 'top' &&
            'inset-x-0 top-0 h-auto border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
          side === 'bottom' &&
            'inset-x-0 bottom-0 h-auto border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
          side === 'center' &&
            'left-[50%] top-[50%] max-h-[calc(100vh-40px-env(safe-area-inset-bottom)-env(safe-area-inset-top))] w-[calc(100%-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))] -translate-x-1/2 -translate-y-1/2 overflow-x-hidden rounded-lg border duration-200 data-[state=closed]:duration-200 data-[state=open]:duration-200 data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close asChild>
            <Button
              variant='ghost'
              className='absolute left-4 top-4 h-fit px-2 py-2 text-gray-500 hover:text-gray-700'
            >
              <X size={20} className='size-5' />
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('font-semibold text-foreground', className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='sheet-header'
      className={cn('flex flex-col p-4 space-y-1.5', className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='sheet-footer'
      className={cn('mt-auto flex flex-col p-4 space-y-2', className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogHeader,
  DialogFooter,
};
