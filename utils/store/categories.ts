import type { EntityID } from '@/types';
import type { CategoryClient } from '@/types/categories';

import { generateUUIDv7 } from '@/utils';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface CategoriesState {
  categories: CategoryClient[];
}

interface CategoriesActions {
  addCategory: (
    category: Omit<CategoryClient, 'id' | 'createdAt' | 'updatedAt'>
  ) => CategoryClient;
  updateCategory: (
    id: EntityID,
    data: Partial<Omit<CategoryClient, 'id'>>
  ) => CategoryClient | null;
  deleteCategory: (id: EntityID) => boolean;
  getCategoryById: (id: EntityID) => CategoryClient | undefined;
  getAllCategories: () => CategoryClient[];
}

type CategoriesStore = CategoriesState & CategoriesActions;

export const useCategoriesStore = create<CategoriesStore>()(
  persist(
    (set, get) => ({
      // Initial state
      categories: [],

      // Actions
      addCategory: (categoryData) => {
        const newCategory: CategoryClient = {
          ...categoryData,
          id: generateUUIDv7(),
          createdAt: new Date().toISOString(),
        };

        set((state) => ({
          categories: [newCategory, ...state.categories],
        }));

        return newCategory;
      },

      updateCategory: (id, data) => {
        const { categories } = get();
        const index = categories.findIndex((item) => item.id === id);

        if (index === -1) return null;

        const updatedCategory: CategoryClient = {
          ...categories[index],
          ...data,
          id, // Ensure ID is not changed
          updatedAt: new Date().toISOString(),
        };

        set((state) => ({
          categories: state.categories.map((item) =>
            item.id === id ? updatedCategory : item
          ),
        }));

        return updatedCategory;
      },

      deleteCategory: (id) => {
        const { categories } = get();
        const exists = categories.some((item) => item.id === id);

        if (!exists) return false;

        set((state) => ({
          categories: state.categories.filter((item) => item.id !== id),
        }));

        return true;
      },

      getCategoryById: (id) => {
        return get().categories.find((item) => item.id === id);
      },

      getAllCategories: () => {
        return get().categories;
      },
    }),
    {
      name: 'categories-storage',
    }
  )
);
