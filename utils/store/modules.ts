import { create } from 'zustand';

import { ModulesNames } from '@/components/modules/modules-handler';

interface ModulesStore {
  openModules: ModulesNames[];
  showDrawer: boolean;
  setShowDrawer: (show: boolean) => void;
  addModule: (module: ModulesNames) => void;
  removeModule: (module: ModulesNames) => void;
  setOpenModules: (modules: ModulesNames[]) => void;
  removeLastModule: () => void;
  resetModules: () => void;
}

const EMPTY_ARRAY = [];
export const useModules = create<ModulesStore>((set) => ({
  openModules: [],
  showDrawer: false,
  setShowDrawer: (show) => set({ showDrawer: show }),
  addModule: (module) =>
    set((state) => ({ openModules: [...state.openModules, module] })),
  removeModule: (module) =>
    set((state) => ({
      openModules: state.openModules.filter((d) => d !== module),
    })),
  setOpenModules: (modules) => set({ openModules: modules }),
  removeLastModule: () =>
    set((state) => ({
      openModules: state.openModules.slice(0, -1),
    })),
  resetModules: () => set({ openModules: EMPTY_ARRAY }),
}));
