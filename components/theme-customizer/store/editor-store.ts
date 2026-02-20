import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { defaultThemeState } from '../config/theme';
import { ThemeEditorState } from '../types/theme';
import { getPresetThemeStyles } from '../utils/theme-preset-helper';

interface EditorState {
  themeState: ThemeEditorState;
  containerStretch: boolean;
  fontScale: number;
}

interface EditorActions {
  setThemeState: (state: ThemeEditorState) => void;
  setContainerStretch: (value: boolean) => void;
  setFontScale: (value: number) => void;
  applyThemePreset: (preset: string) => void;
  reset: () => void;
}

const initialState: EditorState = {
  themeState: defaultThemeState,
  containerStretch: false,
  fontScale: 1,
};

export const useEditorStore = create<EditorActions & EditorState>()(
  persist(
    (set, get) => ({
      ...initialState,
      setThemeState: (newState: ThemeEditorState) => {
        set({ themeState: newState });
      },
      setContainerStretch: (value: boolean) => {
        set({ containerStretch: value });
      },
      setFontScale: (value: number) => {
        set({ fontScale: value });
      },
      applyThemePreset: (preset: string) => {
        const currentThemeState = get().themeState;
        const newStyles = getPresetThemeStyles(preset);
        const newThemeState: ThemeEditorState = {
          ...currentThemeState,
          preset,
          styles: newStyles,
          hslAdjustments: defaultThemeState.hslAdjustments,
        };

        set({
          themeState: newThemeState,
        });
      },
      reset: () => {
        set({ ...initialState });
      },
    }),
    {
      name: 'editor-storage-2',
    }
  )
);
