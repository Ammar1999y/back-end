import type {
  CreateSectionOutput,
  UpdateSectionOutput,
} from '@/utils/validation/sections';

import { EntityID } from '@/types';

import { CustomError } from '@/utils/error-class';
import { registerLocalStorageHandler } from '@/utils/mutation';
import { registerLocalStorageQueryHandler } from '@/utils/query';
import { useSectionsStore } from '@/utils/store/sections';

// Register mutation handlers for sections endpoints
registerLocalStorageHandler(/\/api\/dash\/sections/, {
  create: async (data: CreateSectionOutput) => {
    const newSection = useSectionsStore.getState().addSection(data);
    return {
      data: {
        id: newSection.id,
        createdAt: newSection.createdAt,
      },
      message: 'تم إنشاء القسم بنجاح',
    };
  },

  update: async (id: EntityID, data: UpdateSectionOutput) => {
    const updatedSection = useSectionsStore.getState().updateSection(id, data);
    if (!updatedSection) {
      throw new CustomError('القسم غير موجود', 404);
    }
    return {
      data: {
        updatedAt: updatedSection.updatedAt,
      },
      message: 'تم تحديث القسم بنجاح',
    };
  },

  delete: async (id: EntityID) => {
    const deleted = useSectionsStore.getState().deleteSection(id);
    if (!deleted) {
      throw new CustomError('القسم غير موجود', 404);
    }
    return {
      data: { id },
      message: 'تم حذف القسم بنجاح',
    };
  },
});

// Register query handlers for sections endpoints
registerLocalStorageQueryHandler(/\/api\/dash\/sections/, {
  getAll: async () => {
    return useSectionsStore.getState().getAllSections();
  },

  getById: async (id: EntityID) => {
    const section = useSectionsStore.getState().getSectionById(id);
    if (!section) {
      throw new CustomError('القسم غير موجود', 404);
    }
    return section;
  },
});
