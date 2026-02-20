import type { EntityID } from '@/types';
import type { ProjectClient } from '@/types/projects';

import { generateUUIDv7 } from '@/utils';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ProjectsState {
  projects: ProjectClient[];
}

interface ProjectsActions {
  addProject: (
    project: Omit<ProjectClient, 'id' | 'createdAt' | 'updatedAt'>
  ) => ProjectClient;
  updateProject: (
    id: EntityID,
    data: Partial<Omit<ProjectClient, 'id'>>
  ) => ProjectClient | null;
  deleteProject: (id: EntityID) => boolean;
  getProjectById: (id: EntityID) => ProjectClient | undefined;
  getAllProjects: () => ProjectClient[];
}

type ProjectsStore = ProjectsState & ProjectsActions;

export const useProjectsStore = create<ProjectsStore>()(
  persist(
    (set, get) => ({
      // Initial state
      projects: [],

      // Actions
      addProject: (projectData) => {
        const newProject: ProjectClient = {
          ...projectData,
          id: generateUUIDv7(),
          createdAt: new Date().toISOString(),
        };

        set((state) => ({
          projects: [newProject, ...state.projects],
        }));

        return newProject;
      },

      updateProject: (id, data) => {
        const { projects } = get();
        const index = projects.findIndex((item) => item.id === id);

        if (index === -1) return null;

        const updatedProject: ProjectClient = {
          ...projects[index],
          ...data,
          id, // Ensure ID is not changed
          updatedAt: new Date().toISOString(),
        };

        set((state) => ({
          projects: state.projects.map((item) =>
            item.id === id ? updatedProject : item
          ),
        }));

        return updatedProject;
      },

      deleteProject: (id) => {
        const { projects } = get();
        const exists = projects.some((item) => item.id === id);

        if (!exists) return false;

        set((state) => ({
          projects: state.projects.filter((item) => item.id !== id),
        }));

        return true;
      },

      getProjectById: (id) => {
        return get().projects.find((item) => item.id === id);
      },

      getAllProjects: () => {
        return get().projects;
      },
    }),
    {
      name: 'projects-storage',
    }
  )
);
