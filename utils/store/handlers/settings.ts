import type { SettingsOutput } from '@/utils/validation/settings';

import { registerLocalStorageHandler } from '@/utils/mutation';
import { registerLocalStorageQueryHandler } from '@/utils/query';
import { useSettingsStore } from '@/utils/store/settings';

// Register mutation handlers for settings endpoint (singleton pattern)
registerLocalStorageHandler(/\/api\/dash\/settings/, {
  // Create/Update (upsert) - Always uses POST
  create: async (data: SettingsOutput) => {
    const settings = useSettingsStore.getState().setSettings(data);
    return {
      data: {
        id: settings.id,
        createdAt: settings.createdAt,
        updatedAt: settings.updatedAt,
      },
      message: 'تم حفظ الإعدادات بنجاح',
    };
  },
});

// Register query handlers for settings endpoint
registerLocalStorageQueryHandler(/\/api\/dash\/settings/, {
  // Get settings (singleton - returns single object or null)
  getAll: async () => {
    return useSettingsStore.getState().getSettings();
  },
});
