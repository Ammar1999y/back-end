import type {
  CreateUserOutput,
  UpdateUserOutput,
} from '@/utils/validation/auth';

import { EntityID } from '@/types';

import { CustomError } from '@/utils/error-class';
import { registerLocalStorageHandler } from '@/utils/mutation';
import { registerLocalStorageQueryHandler } from '@/utils/query';
import { useUsersStore } from '@/utils/store/users';

// Register mutation handlers for users endpoints
registerLocalStorageHandler(/\/api\/dash\/users/, {
  create: async (data: CreateUserOutput) => {
    const { password, ...rest } = data;
    const newUser = useUsersStore
      .getState()
      .addUser({ ...rest, role: null, password });
    return {
      data: {
        id: newUser.id,
        createdAt: newUser.createdAt,
      },
      message: 'تم إنشاء المستخدم بنجاح',
    };
  },

  update: async (id: EntityID, data: UpdateUserOutput) => {
    // Filter out empty password on update
    const updateData = { ...data };
    if (!updateData.password) {
      delete updateData.password;
    }

    const updatedUser = useUsersStore.getState().updateUser(id, updateData);
    if (!updatedUser) {
      throw new CustomError('المستخدم غير موجود', 404);
    }
    return {
      data: {
        updatedAt: updatedUser.updatedAt,
      },
      message: 'تم تحديث المستخدم بنجاح',
    };
  },

  delete: async (id: EntityID) => {
    const deleted = useUsersStore.getState().deleteUser(id);
    if (!deleted) {
      throw new CustomError('المستخدم غير موجود', 404);
    }
    return {
      data: { id },
      message: 'تم حذف المستخدم بنجاح',
    };
  },
});

// Register query handlers for users endpoints
registerLocalStorageQueryHandler(/\/api\/dash\/users/, {
  getAll: async () => {
    // Return users without password for security
    return useUsersStore
      .getState()
      .getAllUsers()
      .map(({ password: _, ...user }) => user);
  },

  getById: async (id: EntityID) => {
    const user = useUsersStore.getState().getUserById(id);
    if (!user) {
      throw new CustomError('المستخدم غير موجود', 404);
    }
    // Return user without password for security
    const { password: _, ...userWithoutPassword } = user;
    return userWithoutPassword;
  },
});
