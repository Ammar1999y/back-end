import { useEffect, useMemo, useState } from 'react';

import { breakpointsTokens } from '@/utils/breakpoints';

/**
 * remove px unit
 * @param value example: "16px"
 * @returns example: 16
 */
/**
 * remove px unit and convert to number
 * @param value example: "16px", "16.5px", "-16px", "16", 16
 * @returns example: 16, 16.5, -16, 16, 16
 * @throws Error if value is invalid
 */
export const removePx = (value: string | number): number => {
  if (typeof value === 'number') return value;

  if (!value) {
    throw new Error('Invalid value: empty string');
  }

  const trimmed = value.trim();

  const hasPx = /px$/i.test(trimmed);

  const num = hasPx ? trimmed.slice(0, -2) : trimmed;

  const result = Number.parseFloat(num);

  if (Number.isNaN(result)) {
    throw new TypeError(`Invalid value: ${value}`);
  }

  return result;
};

type MediaQueryConfig = {
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  orientation?: 'portrait' | 'landscape';
  prefersColorScheme?: 'dark' | 'light';
  prefersReducedMotion?: boolean;
  devicePixelRatio?: number;
  pointerType?: 'coarse' | 'fine';
};

const buildMediaQuery = (config: MediaQueryConfig | string): string => {
  if (typeof config === 'string') return config;

  const conditions: string[] = [];

  if (config.minWidth) conditions.push(`(min-width: ${config.minWidth}px)`);
  if (config.maxWidth) conditions.push(`(max-width: ${config.maxWidth}px)`);
  if (config.minHeight) conditions.push(`(min-height: ${config.minHeight}px)`);
  if (config.maxHeight) conditions.push(`(max-height: ${config.maxHeight}px)`);
  if (config.orientation)
    conditions.push(`(orientation: ${config.orientation})`);
  if (config.prefersColorScheme)
    conditions.push(`(prefers-color-scheme: ${config.prefersColorScheme})`);
  if (config.devicePixelRatio)
    conditions.push(
      `(-webkit-min-device-pixel-ratio: ${config.devicePixelRatio})`
    );
  if (config.pointerType) conditions.push(`(pointer: ${config.pointerType})`);

  return conditions.join(' and ');
};

/**
 * React hook for handling media queries
 *
 * @param config - Media query configuration object or query string
 * @returns boolean - Returns true if the media query matches
 *
 * @example
 * // Basic usage - Mobile detection
 * const isMobile = useMediaQuery({ maxWidth: 768 });
 *
 * @example
 * // Using predefined breakpoints
 * const isDesktop = useMediaQuery(up('lg'));
 *
 * @example
 * // Complex query - Tablet in landscape mode
 * const isTabletLandscape = useMediaQuery({
 *   minWidth: 768,
 *   maxWidth: 1024,
 *   orientation: 'landscape'
 * });
 *
 * @example
 * // User preferences
 * const isDarkMode = useMediaQuery({ prefersColorScheme: 'dark' });
 * const prefersReducedMotion = useMediaQuery({ prefersReducedMotion: true });
 *
 * @example
 * // Device capabilities
 * const isTouchDevice = useMediaQuery({ pointerType: 'coarse' });
 * const isRetina = useMediaQuery({ devicePixelRatio: 2 });
 *
 * @example
 * // Range queries using helpers
 * const isTablet = useMediaQuery(between('sm', 'md'));
 *
 * @example
 * // Raw media query string
 * const isPortrait = useMediaQuery('(orientation: portrait)');
 *
 * @see {@link MediaQueryConfig} for all supported configuration options
 */
export const useMediaQuery = (config: MediaQueryConfig | string) => {
  const [matches, setMatches] = useState(false);

  const mediaQueryString = useMemo(() => buildMediaQuery(config), [config]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(mediaQueryString);
    setMatches(mediaQuery.matches);

    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handler);
    } else {
      mediaQuery.addListener(handler);
    }

    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', handler);
      } else {
        mediaQuery.removeListener(handler);
      }
    };
  }, [mediaQueryString]);

  return matches;
};

type Breakpoints = typeof breakpointsTokens;
type BreakpointsKeys = keyof Breakpoints;
export const up = (key: BreakpointsKeys) => ({
  minWidth: removePx(breakpointsTokens[key]),
});

export const down = (key: BreakpointsKeys) => ({
  maxWidth: removePx(breakpointsTokens[key]) - 0.05, // 减去0.05px避免断点重叠
});

export const between = (start: BreakpointsKeys, end: BreakpointsKeys) => ({
  minWidth: removePx(breakpointsTokens[start]),
  maxWidth: removePx(breakpointsTokens[end]) - 0.05,
});
