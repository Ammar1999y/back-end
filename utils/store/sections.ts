import type { Section } from '@/components/sections/types';
import type { EntityID } from '@/types';

import { generateUUIDv7 } from '@/utils';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SectionsState {
  sections: Section[];
}

interface SectionsActions {
  addSection: (
    section: Omit<Section, 'id' | 'createdAt' | 'updatedAt'>
  ) => Section;
  updateSection: (
    id: EntityID,
    data: Partial<Omit<Section, 'id'>>
  ) => Section | null;
  deleteSection: (id: EntityID) => boolean;
  getSectionById: (id: EntityID) => Section | undefined;
  getAllSections: () => Section[];
}

type SectionsStore = SectionsState & SectionsActions;

export const useSectionsStore = create<SectionsStore>()(
  persist(
    (set, get) => ({
      // Initial state
      sections: [],

      // Actions
      addSection: (sectionData) => {
        const newSection: Section = {
          ...sectionData,
          id: generateUUIDv7(),
          createdAt: new Date().toISOString(),
        };

        set((state) => ({
          sections: [newSection, ...state.sections],
        }));

        return newSection;
      },

      updateSection: (id, data) => {
        const { sections } = get();
        const sectionIndex = sections.findIndex((section) => section.id === id);

        if (sectionIndex === -1) return null;

        const updatedSection: Section = {
          ...sections[sectionIndex],
          ...data,
          id, // Ensure ID is not changed
          updatedAt: new Date().toISOString(),
        };

        set((state) => ({
          sections: state.sections.map((section) =>
            section.id === id ? updatedSection : section
          ),
        }));

        return updatedSection;
      },

      deleteSection: (id) => {
        const { sections } = get();
        const sectionExists = sections.some((section) => section.id === id);

        if (!sectionExists) return false;

        set((state) => ({
          sections: state.sections.filter((section) => section.id !== id),
        }));

        return true;
      },

      getSectionById: (id) => {
        return get().sections.find((section) => section.id === id);
      },

      getAllSections: () => {
        return get().sections;
      },
    }),
    {
      name: 'sections-storage',
    }
  )
);
