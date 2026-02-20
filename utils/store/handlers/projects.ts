import type {
  CreateProjectOutput,
  UpdateProjectOutput,
} from '@/utils/validation/projects';

import { EntityID } from '@/types';

import { CustomError } from '@/utils/error-class';
import { registerLocalStorageHandler } from '@/utils/mutation';
import { registerLocalStorageQueryHandler } from '@/utils/query';
import { useProjectsStore } from '@/utils/store/projects';

// Register mutation handlers for projects endpoints
// Match /api/dash/projects and /api/dash/projects/{id} but NOT /api/dash/projects/categories
registerLocalStorageHandler(/\/api\/dash\/projects(?!\/categories)/, {
  create: async (data: CreateProjectOutput) => {
    const newProject = useProjectsStore.getState().addProject(data);
    return {
      data: {
        id: newProject.id,
        createdAt: newProject.createdAt,
      },
      message: 'تم إنشاء المشروع بنجاح',
    };
  },

  update: async (id: EntityID, data: UpdateProjectOutput) => {
    const updatedProject = useProjectsStore.getState().updateProject(id, data);
    if (!updatedProject) {
      throw new CustomError('المشروع غير موجود', 404);
    }
    return {
      data: {
        updatedAt: updatedProject.updatedAt,
      },
      message: 'تم تحديث المشروع بنجاح',
    };
  },

  delete: async (id: EntityID) => {
    const deleted = useProjectsStore.getState().deleteProject(id);
    if (!deleted) {
      throw new CustomError('المشروع غير موجود', 404);
    }
    return {
      data: { id },
      message: 'تم حذف المشروع بنجاح',
    };
  },
});

// Register query handlers for projects endpoints
// Match /api/dash/projects and /api/dash/projects/{id} but NOT /api/dash/projects/categories
registerLocalStorageQueryHandler(/\/api\/dash\/projects(?!\/categories)/, {
  getAll: async () => {
    return useProjectsStore.getState().getAllProjects();
  },

  getById: async (id: EntityID) => {
    const project = useProjectsStore.getState().getProjectById(id);

    if (!project) {
      throw new CustomError('المشروع غير موجود', 404);
    }
    return project;
  },
});
