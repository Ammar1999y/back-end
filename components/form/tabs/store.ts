// import { Language } from '@/types/language';
import { create } from 'zustand';

// LANGUAGES-TODOS

interface TabsStoreState {
  activeMainTab: string | null;
  hoveredMainTab: string | null;
  // activeLang: Language | null;
}

interface TabsStoreActions {
  setActiveMainTab: (tab: string) => void;
  setHoveredMainTab: (tab: string | null) => void;
  // setActiveLang: (lang: Language | null) => void;
  reset: () => void;
}

const initialTabsStoreState: TabsStoreState = {
  activeMainTab: null,
  hoveredMainTab: null,
  // activeLang: null,
};

export const useTabsStore = create<TabsStoreState & TabsStoreActions>(
  (set) => ({
    ...initialTabsStoreState,

    setActiveMainTab: (tab) => set({ activeMainTab: tab }),
    setHoveredMainTab: (tab) => set({ hoveredMainTab: tab }),
    // setActiveLang: (lang) => set({ activeLang: lang }),
    reset: () => set({ ...initialTabsStoreState }),
  })
);
