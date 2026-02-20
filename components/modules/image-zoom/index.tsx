import { memo, useCallback, useEffect } from 'react';

import { X as _X } from 'lucide-react';
import { useShallow } from 'zustand/shallow';

import { useModules } from '@/utils/store/modules';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';

import { useZoomImageStore } from './store';

const X = memo(_X);
export const MODULE_ID = 'imageZoom';

const ImageZoomDialog = () => {
  const isOpen = useModules(
    useShallow((state) => state.openModules.includes(MODULE_ID))
  );
  const addModule = useModules(useShallow((state) => state.addModule));
  const removeModule = useModules(useShallow((state) => state.removeModule));
  const onClose = useCallback(() => {
    setTimeout(() => {
      useZoomImageStore.getState().setActiveId(null);
    }, 500);
  }, []);
  const onOpenChange = useCallback(
    (isOpen: boolean) => {
      if (isOpen) addModule(MODULE_ID);
      else {
        if (typeof onClose === 'function') onClose();
        removeModule(MODULE_ID);
      }
    },
    [addModule, removeModule, onClose]
  );
  const activeId = useZoomImageStore(useShallow((state) => state.activeId));
  const zoomFile = useZoomImageStore(useShallow((state) => state.zoomFile));

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!activeId) useModules.getState().removeModule(MODULE_ID);
    }, 400);
    return () => clearTimeout(timeout);
  }, [activeId]);

  const close = useCallback(
    () => useModules.getState().removeModule(MODULE_ID),
    []
  );

  if (!activeId) return null;
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName='backdrop-blur-lg bg-black/70 backdrop-saturate-150 '
        className='noSelect h-full grid-rows-[1fr] overflow-hidden border-none bg-transparent p-0 px-12 shadow-none'
        onClick={close}
      >
        <div className='relative mx-auto flex h-full w-fit items-center justify-center'>
          {zoomFile && (
            <img
              src={
                zoomFile.preview ||
                (zoomFile.file instanceof File
                  ? URL.createObjectURL(zoomFile.file)
                  : '')
              }
              alt={zoomFile.file.name}
              className='h-[calc(100vh-40px-env(safe-area-inset-bottom)-env(safe-area-inset-top))] w-[calc(100vw-6rem-env(safe-area-inset-left)-env(safe-area-inset-right))] rounded-lg object-contain'
            />
          )}
          <Button
            className='absolute -right-2 top-3 translate-x-full rounded-full bg-accent text-accent-foreground backdrop-blur-lg'
            size='icon'
            variant={'none'}
            onClick={close}
          >
            <X className='size-5' strokeWidth='3' />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ImageZoomDialog;
