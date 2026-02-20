import type {
  CreateCategoryOutput,
  UpdateCategoryOutput,
} from '@/utils/validation/categories';

import { EntityID } from '@/types';

import { CustomError } from '@/utils/error-class';
import { registerLocalStorageHandler } from '@/utils/mutation';
import { registerLocalStorageQueryHandler } from '@/utils/query';
import { useCategoriesStore } from '@/utils/store/categories';

// Register mutation handlers for categories endpoints
registerLocalStorageHandler(/\/api\/dash\/projects\/categories/, {
  create: async (data: CreateCategoryOutput) => {
    const newCategory = useCategoriesStore.getState().addCategory(data);
    return {
      data: {
        id: newCategory.id,
        createdAt: newCategory.createdAt,
      },
      message: 'تم إنشاء القسم بنجاح',
    };
  },

  update: async (id: EntityID, data: UpdateCategoryOutput) => {
    const updatedCategory = useCategoriesStore
      .getState()
      .updateCategory(id, data);
    if (!updatedCategory) {
      throw new CustomError('القسم غير موجود', 404);
    }
    return {
      data: {
        updatedAt: updatedCategory.updatedAt,
      },
      message: 'تم تحديث القسم بنجاح',
    };
  },

  delete: async (id: EntityID) => {
    const deleted = useCategoriesStore.getState().deleteCategory(id);
    if (!deleted) {
      throw new CustomError('القسم غير موجود', 404);
    }
    return {
      data: { id },
      message: 'تم حذف القسم بنجاح',
    };
  },
});

// Register query handlers for categories endpoints
registerLocalStorageQueryHandler(/\/api\/dash\/projects\/categories/, {
  getAll: async () => {
    return useCategoriesStore.getState().getAllCategories();
  },

  getById: async (id: EntityID) => {
    const category = useCategoriesStore.getState().getCategoryById(id);
    if (!category) {
      throw new CustomError('القسم غير موجود', 404);
    }
    return category;
  },
});
