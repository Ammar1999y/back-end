import { memo, useCallback, useEffect, useState } from 'react';

import { RotateCcw as _RotateCcw, X as _X } from 'lucide-react';
import screenfull from 'screenfull';
import { useShallow } from 'zustand/shallow';

import { useModules } from '@/utils/store/modules';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import ExitFullscreen from '@/components/icons/exit-fullscreen';
import Fullscreen from '@/components/icons/fullscreen';
import Setting from '@/components/icons/setting';

import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { useEditorStore } from './store/editor-store';
import { ThemeTab } from './theme-tab';

export const MODULE_ID = 'theme-customizer';

// Memoize lucide icons
const RotateCcw = memo(_RotateCcw);
RotateCcw.displayName = 'RotateCcw';

const X = memo(_X);
X.displayName = 'X';

// Fullscreen button - isolates fullscreen state re-renders
const FullscreenButton = memo(() => {
  const [isFullscreen, setIsFullscreen] = useState(screenfull.isFullscreen);

  const toggleFullScreen = useCallback(() => {
    if (screenfull.isEnabled) screenfull.toggle();
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      if (screenfull.isEnabled) {
        setIsFullscreen(screenfull.isFullscreen);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        screenfull.isEnabled &&
        screenfull.isFullscreen
      )
        setIsFullscreen(false);
    };

    if (screenfull.isEnabled) {
      screenfull.on('change', onFullscreenChange);
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      if (screenfull.isEnabled) {
        screenfull.off('change', onFullscreenChange);
      }
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <Button
      variant='outline'
      size={'none'}
      className='w-full border-dashed px-2 py-1.5 hover:!border-primary hover:text-primary'
      onClick={toggleFullScreen}
      aria-label={isFullscreen ? 'الخروج من ملء الشاشة' : 'ملء الشاشة'}
    >
      {isFullscreen ? (
        <>
          <ExitFullscreen size={18} className='size-5 opacity-60' />
          <span className='ml-2'>الخروج من ملء الشاشة</span>
        </>
      ) : (
        <>
          <Fullscreen size={18} className='size-5 opacity-60' />
          <span className='ml-2'>ملء الشاشة</span>
        </>
      )}
    </Button>
  );
});
FullscreenButton.displayName = 'FullscreenButton';

// Main component
const ThemeCustomizer = memo(() => {
  const handleReset = useCallback(() => {
    useEditorStore.getState().reset();
  }, []);

  const handleClose = useCallback(() => {
    useModules.getState().removeModule(MODULE_ID);
  }, []);

  return (
    <DialogWrapper>
      <DialogContent side={'left'} className='w-[400px] gap-2 overflow-hidden'>
        {/* Decorative blur elements */}
        <div className='w-7h-80 pointer-events-none absolute right-0 top-0 h-80 -translate-y-1/2 translate-x-1/2 rounded-full bg-gradient-to-br from-cyan-400/30 to-cyan-600/30 opacity-30 blur-3xl' />
        <div className='w-7h-80 pointer-events-none absolute bottom-0 left-0 h-80 -translate-x-1/2 translate-y-1/2 rounded-full bg-gradient-to-tr from-red-400/30 to-pink-600/30 opacity-30 blur-3xl' />

        <DialogHeader className='p-4 pb-2 pt-[calc((var(--spacing)*4)+env(safe-area-inset-top))]'>
          <div className='flex items-center space-x-2'>
            <div className='rounded-lg bg-primary/10 p-2'>
              <Setting className='size-4' size={16} />
            </div>
            <DialogTitle className='text-lg font-semibold'>التخصيص</DialogTitle>
            <div className='ms-auto flex flex-1 items-center justify-end space-x-2'>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant='outline'
                    size='icon'
                    onClick={handleReset}
                    className='h-8 w-8'
                    aria-label='إعادة ضبط'
                  >
                    <RotateCcw className='h-4 w-4' />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>إعادة ضبط</TooltipContent>
              </Tooltip>
              <Button
                variant='outline'
                size='icon'
                onClick={handleClose}
                className='h-8 w-8'
              >
                <X className='h-4 w-4' />
              </Button>
            </div>
          </div>
          <DialogDescription className='sr-only text-sm text-muted-foreground'>
            تخصيص المظهر والتخطيط للوحة التحكم الخاصة بك.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className='h-full'>
          <ThemeTab />
        </ScrollArea>

        <DialogFooter className='border-t p-4 pb-[calc((var(--spacing)*4)+env(safe-area-inset-bottom))]'>
          <FullscreenButton />
        </DialogFooter>
      </DialogContent>
    </DialogWrapper>
  );
});
ThemeCustomizer.displayName = 'ThemeCustomizer';

export { ThemeCustomizer };

// DialogWrapper - not memoized because it receives children
function DialogWrapper({ children }: { children: React.ReactNode }) {
  const isOpen = useModules(
    useShallow((state) => state.openModules.includes(MODULE_ID))
  );
  const addModule = useModules(useShallow((state) => state.addModule));
  const removeModule = useModules(useShallow((state) => state.removeModule));

  const onOpenChange = useCallback(
    (isOpen: boolean) => {
      if (isOpen) addModule(MODULE_ID);
      else {
        removeModule(MODULE_ID);
      }
    },
    [addModule, removeModule]
  );

  return (
    <Dialog modal={false} open={isOpen} onOpenChange={onOpenChange}>
      {children}
    </Dialog>
  );
}
