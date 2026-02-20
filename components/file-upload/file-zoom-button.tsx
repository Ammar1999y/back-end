import { memo, useCallback } from 'react';

import { Expand as _Expand } from 'lucide-react';
import { useShallow } from 'zustand/shallow';

import { MODULE_ID as IMAGE_MODULE_ID } from '@/components/modules/image-zoom';
import { useZoomImageStore } from '@/components/modules/image-zoom/store';
import ModuleTrigger from '@/components/modules/module-trigger';

import { FileWithPreview } from './file-types';

const Expand = memo(_Expand);
Expand.displayName = 'Expand';

interface FileZoomButtonProps {
  file: FileWithPreview;
  onZoom: (file: FileWithPreview) => void;
}

const FileZoomButton = memo(({ file, onZoom }: FileZoomButtonProps) => {
  const isActive = useZoomImageStore(useShallow((s) => s.activeId === file.id));

  const handleZoom = useCallback(() => {
    onZoom(file);
  }, [file, onZoom]);

  return (
    <ModuleTrigger
      name={IMAGE_MODULE_ID}
      variant='ghost'
      size='icon'
      onClick={handleZoom}
      disableFocus={!isActive}
      className='h-8 w-8 rounded-full bg-white/20 text-white hover:bg-white/30'
      title='تكبير'
    >
      <Expand className='h-4 w-4' />
    </ModuleTrigger>
  );
});

FileZoomButton.displayName = 'FileZoomButton';

export { FileZoomButton as FileZoomButton };
