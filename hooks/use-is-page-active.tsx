import { useEffect, useRef } from 'react';

/**
 * Custom hook to track if the user is currently present (active) on the page.
 * @param {object} options
 * @param {function} options.onLeave - Called when user leaves the page or tab.
 * @param {function} [options.onReturn] - Called when user returns to the page or tab.
 */
export function useUserPresence({ onLeave, onReturn }) {
  const isPresentRef = useRef(
    typeof document !== 'undefined' && !document.hidden
  );
  useEffect(() => {
    const handleStateChange = (isCurrentlyPresent) => {
      if (isCurrentlyPresent === isPresentRef.current) return;
      isPresentRef.current = isCurrentlyPresent;
      if (isCurrentlyPresent) {
        if (onReturn) onReturn();
      } else {
        onLeave();
      }
    };

    const handleVisibilityChange = () => {
      handleStateChange(!document.hidden);
    };

    const handleBlur = () => {
      handleStateChange(false);
    };

    const handleFocus = () => {
      handleStateChange(true);
    };

    const handlePageHide = () => {
      handleStateChange(false);
    };

    const handleBeforeUnload = () => {
      handleStateChange(false);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [onLeave, onReturn]);
}
