import type { EntityID } from '@/types';
import type { UserClient } from '@/types/user';

import { generateUUIDv7 } from '@/utils';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Extended type to include password for demo storage
interface UserWithPassword extends UserClient {
  password?: string | null;
}

interface UsersState {
  users: UserWithPassword[];
}

interface UsersActions {
  addUser: (
    user: Omit<UserWithPassword, 'id' | 'createdAt' | 'updatedAt'>
  ) => UserWithPassword;
  updateUser: (
    id: EntityID,
    data: Partial<Omit<UserWithPassword, 'id'>>
  ) => UserWithPassword | null;
  deleteUser: (id: EntityID) => boolean;
  getUserById: (id: EntityID) => UserWithPassword | undefined;
  getAllUsers: () => UserWithPassword[];
}

type UsersStore = UsersState & UsersActions;

export const useUsersStore = create<UsersStore>()(
  persist(
    (set, get) => ({
      // Initial state
      users: [],

      // Actions
      addUser: (userData) => {
        const newUser: UserWithPassword = {
          ...userData,
          id: generateUUIDv7(),
          createdAt: new Date().toISOString(),
        };

        set((state) => ({
          users: [newUser, ...state.users],
        }));

        return newUser;
      },

      updateUser: (id, data) => {
        const { users } = get();
        const index = users.findIndex((item) => item.id === id);

        if (index === -1) return null;

        const updatedUser: UserWithPassword = {
          ...users[index],
          ...data,
          id, // Ensure ID is not changed
          updatedAt: new Date().toISOString(),
        };

        set((state) => ({
          users: state.users.map((item) =>
            item.id === id ? updatedUser : item
          ),
        }));

        return updatedUser;
      },

      deleteUser: (id) => {
        const { users } = get();
        const exists = users.some((item) => item.id === id);

        if (!exists) return false;

        set((state) => ({
          users: state.users.filter((item) => item.id !== id),
        }));

        return true;
      },

      getUserById: (id) => {
        return get().users.find((item) => item.id === id);
      },

      getAllUsers: () => {
        return get().users;
      },
    }),
    {
      name: 'users-storage',
    }
  )
);
