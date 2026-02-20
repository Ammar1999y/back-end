import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { useShallow } from 'zustand/shallow';

import { ThemeLayout } from '@/components/theme-customizer/types/enum';

export type SettingsType = {
  themeLayout: ThemeLayout;
};
type SettingStore = {
  settings: SettingsType;
  actions: {
    setSettings: (settings: SettingsType) => void;
    clearSettings: () => void;
  };
};

const STORAGE_KEY = 'settings';

export const useSettingStore = create<SettingStore>()(
  persist(
    (set) => ({
      settings: {
        themeLayout: ThemeLayout.Vertical,
      },
      actions: {
        setSettings: (settings) => {
          set({ settings });
        },
        clearSettings() {
          useSettingStore.persist.clearStorage();
        },
      },
    }),
    {
      name: STORAGE_KEY, // name of the item in the storage (must be unique)
      storage: createJSONStorage(() => localStorage), // (optional) by default, 'localStorage' is used
      partialize: (state) => ({ [STORAGE_KEY]: state.settings }),
    }
  )
);

export const useSettings = () => useSettingStore((state) => state.settings);
export const useSettingActions = () =>
  useSettingStore(useShallow((state) => state.actions));
