import { create } from 'zustand';

type AuthState = {
  activeInput: string | null;
  setActiveInput: (input: string | null) => void;
};

const useAuthStore = create<AuthState>((set) => ({
  activeInput: null,
  setActiveInput: (input) => set({ activeInput: input }),
}));

export default useAuthStore;
