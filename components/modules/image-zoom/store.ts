import { create } from 'zustand';

import { FileWithPreview } from '@/components/file-upload';

export interface ZoomImageStore {
  zoomFile: FileWithPreview | null;
  activeId: string | null;
  setZoomFile: (file: FileWithPreview | null) => void;
  setActiveId: (id: string | null) => void;
}

const useZoomImageStore = create<ZoomImageStore>((set) => ({
  zoomFile: null,
  activeId: null,
  setZoomFile: (file) => set({ zoomFile: file }),
  setActiveId: (id) => set({ activeId: id }),
}));

export { useZoomImageStore };
