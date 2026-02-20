import { create } from 'zustand';

export const useErrors = create<{
  errors: { [key: string]: string };
  setErrors: (errors: { [key: string]: string }) => void;
}>((set) => ({
  errors: {},
  setErrors: (errors) => set({ errors }),
}));
