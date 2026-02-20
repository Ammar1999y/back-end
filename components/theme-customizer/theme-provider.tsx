import { memo } from 'react';

import {
  ThemeProvider as NextThemeProvider,
  useTheme as useNextTheme,
} from 'next-themes';

import useIsomorphicLayoutEffect from '@/hooks/use-layout-effect';
// import './circular-transition.css';

import { useEditorStore } from '@/components/theme-customizer/store/editor-store';
import { applyThemeToElement } from '@/components/theme-customizer/utils/apply-theme';

type ThemeProviderProps = {
  children: React.ReactNode;
};

type Coords = { x: number; y: number };

const ThemeSync = memo(() => {
  const { resolvedTheme } = useNextTheme();

  useIsomorphicLayoutEffect(() => {
    if (
      resolvedTheme &&
      (resolvedTheme === 'dark' || resolvedTheme === 'light')
    ) {
      const storeMode = useEditorStore.getState().themeState;
      if (storeMode.currentMode !== resolvedTheme)
        useEditorStore.getState().setThemeState({
          ...useEditorStore.getState().themeState,
          currentMode: resolvedTheme,
        });
    }
  }, [resolvedTheme]);

  return null;
});

ThemeSync.displayName = 'ThemeSync';

export function ThemeProvider({ children }: ThemeProviderProps) {
  const { themeState, containerStretch, fontScale } = useEditorStore();

  useIsomorphicLayoutEffect(() => {
    const root = document.documentElement;
    if (!root) return;
    applyThemeToElement(themeState, root);
  }, [themeState]);

  useIsomorphicLayoutEffect(() => {
    const root = document.documentElement;
    if (!root) return;
    root.style.setProperty(
      '--container-max-width',
      containerStretch ? '100%' : '1200px'
    );
  }, [containerStretch]);

  useIsomorphicLayoutEffect(() => {
    const root = document.documentElement;
    if (!root) return;
    root.style.setProperty('--font-scale', fontScale.toString());
  }, [fontScale]);

  return (
    <NextThemeProvider attribute={['class', 'data-theme']}>
      <ThemeSync />
      {children}
    </NextThemeProvider>
  );
}

export const useTheme = () => {
  const { theme, setTheme, resolvedTheme } = useNextTheme();

  const toggleTheme = (coords?: Coords) => {
    const currentTheme = resolvedTheme || theme;
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';

    if (!document.startViewTransition) {
      setTheme(newTheme);
      return;
    }

    if (coords) {
      const root = document.documentElement;
      root.style.setProperty('--x', `${coords.x}px`);
      root.style.setProperty('--y', `${coords.y}px`);
    }

    document.startViewTransition(() => {
      setTheme(newTheme);
    });
  };

  return {
    theme: resolvedTheme,
    setTheme,
    toggleTheme,
  };
};
