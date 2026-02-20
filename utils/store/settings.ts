import type { SettingsClient } from '@/types/settings';

import { generateUUIDv7 } from '@/utils';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SettingsState {
  settings: SettingsClient | null;
}

interface SettingsActions {
  setSettings: (
    data: Omit<SettingsClient, 'id' | 'createdAt' | 'updatedAt'>
  ) => SettingsClient;
  getSettings: () => SettingsClient | null;
}

type SettingsStore = SettingsState & SettingsActions;

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      // Initial state
      settings: null,

      // Actions
      setSettings: (data) => {
        const { settings } = get();
        const newSettings: SettingsClient = {
          ...data,
          id: settings?.id || generateUUIDv7(), // Keep existing ID or generate new UUID v7
          createdAt: settings?.createdAt || new Date().toISOString(),
          updatedAt: settings ? new Date().toISOString() : undefined,
        };

        set({ settings: newSettings });
        return newSettings;
      },

      getSettings: () => {
        return get().settings;
      },
    }),
    {
      name: 'app-settings-storage',
    }
  )
);
