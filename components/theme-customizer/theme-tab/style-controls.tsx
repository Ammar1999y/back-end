import { memo, useCallback, useMemo } from 'react';

import { useShallow } from 'zustand/shallow';

import {
  COMMON_STYLES,
  defaultThemeState,
  FONT_SCALE_CONFIG,
} from '../config/theme';
import { SliderWithInput } from '../slider-with-input';
import { useEditorStore } from '../store/editor-store';

const StyleControls = memo(() => {
  const themeState = useEditorStore(useShallow((s) => s.themeState));
  const fontScale = useEditorStore(useShallow((s) => s.fontScale));
  const setFontScale = useEditorStore(useShallow((s) => s.setFontScale));

  const currentMode = themeState.currentMode;
  const styles = themeState.styles;

  const currentStyles = useMemo(
    () => ({
      ...defaultThemeState.styles[currentMode],
      ...styles?.[currentMode],
    }),
    [currentMode, styles]
  );

  const updateStyle = useCallback(
    <K extends keyof typeof currentStyles>(
      key: K,
      value: (typeof currentStyles)[K]
    ) => {
      const { themeState: currentThemeState, setThemeState } =
        useEditorStore.getState();
      const currentStyles = {
        ...defaultThemeState.styles[currentThemeState.currentMode],
        ...currentThemeState.styles?.[currentThemeState.currentMode],
      };

      // apply common styles to both light and dark modes
      if (COMMON_STYLES.includes(key as string)) {
        setThemeState({
          ...currentThemeState,
          styles: {
            ...currentThemeState.styles,
            light: { ...currentThemeState.styles.light, [key]: value },
            dark: { ...currentThemeState.styles.dark, [key]: value },
          },
        });
        return;
      }

      setThemeState({
        ...currentThemeState,
        styles: {
          ...currentThemeState.styles,
          [currentThemeState.currentMode]: {
            ...currentStyles,
            [key]: value,
          },
        },
      });
    },
    []
  );

  const handleRadiusChange = useCallback(
    (value: number) => {
      updateStyle('radius', `${value}rem`);
    },
    [updateStyle]
  );

  const handleSpacingChange = useCallback(
    (value: number) => {
      updateStyle('spacing', `${value}rem`);
    },
    [updateStyle]
  );

  const radiusValue = useMemo(
    () => Number.parseFloat(currentStyles.radius.replace('rem', '')),
    [currentStyles.radius]
  );

  const spacingValue = useMemo(
    () => Number.parseFloat(currentStyles?.spacing?.replace('rem', '') || '0'),
    [currentStyles.spacing]
  );

  return (
    <div className='space-y-1'>
      <SliderWithInput
        value={radiusValue}
        onChange={handleRadiusChange}
        min={0}
        max={2}
        step={0.025}
        label='استدارة الحواف'
      />
      <SliderWithInput
        value={fontScale}
        onChange={setFontScale}
        min={FONT_SCALE_CONFIG.MIN}
        max={FONT_SCALE_CONFIG.MAX}
        step={FONT_SCALE_CONFIG.STEP}
        label='حجم الخط'
      />
      <SliderWithInput
        value={spacingValue}
        onChange={handleSpacingChange}
        min={0.15}
        max={0.35}
        step={0.01}
        label='المسافات'
      />
    </div>
  );
});
StyleControls.displayName = 'StyleControls';

export { StyleControls };
