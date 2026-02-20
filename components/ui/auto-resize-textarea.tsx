import * as React from 'react';
import { useEffect, useMemo, useRef } from 'react';

import { cn } from '@/lib/utils';

import useIsomorphicLayoutEffect from '@/hooks/use-layout-effect';

function parsePx(value: string | null): number {
  if (!value) return 0;
  const n = Number.parseFloat(value);
  return Number.isNaN(n) ? 0 : n;
}

function measureAndSetHeight(
  textarea: HTMLTextAreaElement,
  options: {
    minRows?: number;
    maxRows?: number;
    minHeight?: number;
    maxHeight?: number;
  }
) {
  const { minRows, maxRows, minHeight, maxHeight } = options;

  // Reset to auto to measure the intrinsic scroll height
  textarea.style.height = 'auto';

  const style = window.getComputedStyle(textarea);
  const borderHeight =
    parsePx(style.borderTopWidth) + parsePx(style.borderBottomWidth);
  const paddingHeight =
    parsePx(style.paddingTop) + parsePx(style.paddingBottom);

  // Some browsers may return 'normal' for line-height; fall back to ~1.2 * font-size
  const lineHeightRaw = parsePx(style.lineHeight);
  const fontSize = parsePx(style.fontSize) || 16;
  const lineHeight = lineHeightRaw || fontSize * 1.2;

  const minHeightPx =
    typeof minHeight === 'number'
      ? minHeight
      : typeof minRows === 'number'
        ? minRows * lineHeight + borderHeight + paddingHeight
        : 0;

  const maxHeightPx =
    typeof maxHeight === 'number'
      ? maxHeight
      : typeof maxRows === 'number'
        ? maxRows * lineHeight + borderHeight + paddingHeight
        : Number.POSITIVE_INFINITY;

  // scrollHeight includes padding but not borders
  const scrollHeight = textarea.scrollHeight;
  const next = Math.max(
    minHeightPx,
    Math.min(scrollHeight + borderHeight, maxHeightPx)
  );
  textarea.style.height = `${next}px`;

  // Toggle vertical scrollbar only when exceeding the cap
  textarea.style.overflowY =
    scrollHeight + borderHeight > maxHeightPx ? 'auto' : 'hidden';
}

export type AutosizeTextareaProProps =
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    minRows?: number;
    maxRows?: number;
    minHeight?: number;
    maxHeight?: number;
    ref?: React.Ref<HTMLTextAreaElement>;
  };

export const AutosizeTextarea = React.memo(
  ({
    className,
    minRows = 4,
    maxRows = 6,
    minHeight = 70,
    maxHeight,
    onChange,
    onBlur = () => {},
    value,
    defaultValue,
    rows,
    ref,
    ...props
  }: AutosizeTextareaProProps) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const lastObservedWidth = useRef<number | null>(null);

    const constraints = useMemo(
      () => ({ minRows, maxRows, minHeight, maxHeight }),
      [minRows, maxRows, minHeight, maxHeight]
    );

    const adjust = React.useCallback(() => {
      const el = textareaRef.current;
      if (!el) return;
      measureAndSetHeight(el, constraints);
    }, [constraints]);

    const mergedRef = React.useCallback(
      (node: HTMLTextAreaElement | null) => {
        textareaRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      },
      [ref]
    );

    // Initial adjustment (SSR-safe)
    useIsomorphicLayoutEffect(() => {
      adjust();
    }, []);

    // Re-adjust whenever the controlled value changes
    useEffect(() => {
      adjust();
    }, [value, adjust]);

    // Also handle uncontrolled defaultValue changes in dev or hot reload
    useEffect(() => {
      adjust();
    }, [defaultValue, adjust]);

    // Re-measure on width changes to accommodate reflow/wrap
    useEffect(() => {
      const el = textareaRef.current;
      if (!el) return;

      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver((entries) => {
          const entry = entries[0];
          const width = entry.contentRect.width;
          if (
            lastObservedWidth.current === null ||
            Math.abs(width - lastObservedWidth.current) > 0.5
          ) {
            lastObservedWidth.current = width;
            adjust();
          }
        });
        ro.observe(el);
        return () => ro.disconnect();
      }

      const handle = () => adjust();
      window.addEventListener('resize', handle);
      return () => window.removeEventListener('resize', handle);
    }, [adjust]);

    return (
      <textarea
        data-lenis-prevent
        ref={mergedRef}
        rows={rows ?? minRows}
        className={cn(
          'block w-full min-w-0 resize-none rounded-md border bg-input text-sm caret-primary transition duration-300 placeholder:text-muted-foreground hover:shadow-md dark:bg-input/30',
          className,
          props.disabled && 'disabled'
        )}
        value={value}
        defaultValue={defaultValue}
        onChange={(e) => {
          onChange?.(e);
          adjust();
        }}
        onBlur={onBlur}
        {...props}
      />
    );
  }
);

AutosizeTextarea.displayName = 'AutosizeTextarea';
