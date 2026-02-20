// 🟥🟥🟥🟥 اي تغير اقوم به على الالوان، لازم يتم مزامنته معا global.css

import { ThemeEditorState } from '../types/theme';

// Font scale configuration
export const FONT_SCALE_CONFIG = {
  DEFAULT: 1,
  MIN: 0.875, // -12.5%
  MAX: 1.125, // +12.5%
  STEP: 0.025,
} as const;

// these are common between light and dark modes
// we can assume that light mode's value will be used for dark mode as well
export const COMMON_STYLES = [
  'font-mono',
  'radius',
  'spacing',
  'shadow-opacity',
  'shadow-blur',
  'shadow-spread',
  'shadow-offset-x',
  'shadow-offset-y',
];

// Default light theme styles
export const defaultLightThemeStyles = {
  background: '0 0% 100%',
  foreground: '0 0% 4%',
  card: '0 0% 98%',
  'card-foreground': '0 0% 4%',
  popover: '0 0% 100%',
  'popover-foreground': '0 0% 4%',
  primary: '172 98% 40%',
  'primary-light': '172 98% 48%',
  'primary-dark': '172 98% 32%',
  'primary-foreground': '0 0% 0%',
  secondary: '0 0% 96%',
  'secondary-foreground': '0 0% 9%',
  muted: '0 0% 96%',
  'muted-foreground': '0 0% 45%',
  accent: '0 0% 92%',
  'accent-foreground': '0 0% 9%',
  destructive: '357 100% 45%',
  'destructive-foreground': '223.81 -172.52% 100%',
  border: '0 0% 90%',
  input: '0 0% 94%',
  ring: '0 0% 63%',
  'chart-1': '18 100% 48%',
  'chart-2': '175 100% 29%',
  'chart-3': '196 72% 23%',
  'chart-4': '44 100% 50%',
  'chart-5': '36 100% 50%',
  sidebar: '0 0% 98%',
  'sidebar-foreground': '0 0% 4%',
  'sidebar-primary': '11 48% 35%',
  'sidebar-primary-foreground': '0 0% 0%',
  'sidebar-accent': '0 0% 92%',
  'sidebar-accent-foreground': '0 0% 9%',
  'sidebar-border': '0 0% 90%',
  'sidebar-ring': '0 0% 63%',

  'font-mono': `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`,

  radius: '0.625rem',
  spacing: '0.25rem',

  'shadow-color': '0 0% 0%',
  'shadow-opacity': '0.1',
  'shadow-blur': '3px',
  'shadow-spread': '0px',
  'shadow-offset-x': '0',
  'shadow-offset-y': '1px',
};

// Default dark theme styles
export const defaultDarkThemeStyles = {
  ...defaultLightThemeStyles,

  background: '0 0% 4%',
  foreground: '0 0% 98%',
  card: '0 0% 9%',
  'card-foreground': '0 0% 98%',
  popover: '0 0% 9%',
  'popover-foreground': '0 0% 98%',
  primary: '172 98% 40%',
  'primary-light': '172 98% 48%',
  'primary-dark': '172 98% 32%',
  'primary-foreground': '0 0% 0%',
  secondary: '0 0% 15%',
  'secondary-foreground': '0 0% 98%',
  muted: '0 0% 12%',
  'muted-foreground': '0 0% 63%',
  accent: '0 0% 18%',
  'accent-foreground': '0 0% 98%',
  destructive: '359 100% 70%',
  'destructive-foreground': '223.81 0% 98.03%',
  border: '0 0% 100% / 0.1',
  input: '0 0% 19.8916%',
  ring: '0 0% 45%',
  'chart-1': '225 84% 49%',
  'chart-2': '160 100% 37%',
  'chart-3': '36 100% 50%',
  'chart-4': '273 100% 64%',
  'chart-5': '345 100% 56%',
  sidebar: '0 0% 9%',
  'sidebar-foreground': '0 0% 98%',
  'sidebar-primary': '225 84% 49%',
  'sidebar-primary-foreground': '0 0% 0%',
  'sidebar-accent': '0 0% 18%',
  'sidebar-accent-foreground': '0 0% 98%',
  'sidebar-border': '0 0% 100% / 0.1',
  'sidebar-ring': '0 0% 45%',
};

// Default theme state
export const defaultThemeState: ThemeEditorState = {
  styles: {
    light: defaultLightThemeStyles,
    dark: defaultDarkThemeStyles,
  },
  currentMode:
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light',
  hslAdjustments: {
    hueShift: 0,
    saturationScale: 1,
    lightnessScale: 1,
  },
};
