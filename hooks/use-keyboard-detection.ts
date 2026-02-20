'use client';

import { useEffect, useState } from 'react';

interface KeyboardDetection {
  hasKeyboard: boolean;
  isMac: boolean;
  modKey: string;
  formatShortcut: (label: string, shortcut?: string) => string;
}

export function useKeyboardDetection(): KeyboardDetection {
  const [hasKeyboard, setHasKeyboard] = useState(true);
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    // Detect if device has keyboard (desktop vs mobile/tablet)
    const checkKeyboard = () => {
      // Check if device is touch-primary (mobile/tablet)
      const isTouchDevice =
        'ontouchstart' in window ||
        navigator.maxTouchPoints > 0 ||
        // @ts-ignore
        navigator.msMaxTouchPoints > 0;

      // Check media query for pointer type
      const hasCoarsePointer = window.matchMedia('(pointer: coarse)').matches;

      // If touch device with coarse pointer, likely no physical keyboard
      setHasKeyboard(!(isTouchDevice && hasCoarsePointer));
    };

    // Detect operating system
    const checkOS = () => {
      const platform = navigator.platform.toLowerCase();
      const userAgent = navigator.userAgent.toLowerCase();

      const isMacOS =
        platform.includes('mac') ||
        userAgent.includes('mac') ||
        /iphone|ipad|ipod/.test(userAgent);

      setIsMac(isMacOS);
    };

    checkKeyboard();
    checkOS();
  }, []);

  const modKey = isMac ? '⌘' : 'Ctrl';

  const formatShortcut = (label: string, shortcut?: string): string => {
    // لو ما فيه keyboard أو ما فيه اختصار، ارجع الـ label فقط
    if (!hasKeyboard || !shortcut) return label;

    // لو فيه keyboard واختصار، ارجع: label (modKey+shortcut)
    return `${label} (${modKey}+${shortcut})`;
  };

  return {
    hasKeyboard,
    isMac,
    modKey,
    formatShortcut,
  };
}
