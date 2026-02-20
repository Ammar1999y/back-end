'use client';

import type { PlateElementProps } from 'platejs/react';

import { useEffect, useRef } from 'react';

import { useToggleButton, useToggleButtonState } from '@platejs/toggle/react';
import { ChevronRight } from 'lucide-react';
import { PlateElement } from 'platejs/react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import styles from '@/components/editor/ui/editor-elements.module.css';

export function ToggleElement(props: PlateElementProps) {
  const element = props.element;
  const state = useToggleButtonState(element.id as string);
  const { buttonProps, open } = useToggleButton(state);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const setDir = () => {
      const dir = el.getAttribute('dir');
      if (!dir || dir !== 'rtl') {
        el.setAttribute('dir', 'ltr');
      }
    };

    // Set initial dir
    setDir();

    // Watch for changes
    const observer = new MutationObserver(setDir);
    observer.observe(el, {
      attributes: true,
      attributeFilter: ['dir'],
    });

    return () => observer.disconnect();
  }, []);

  return (
    <PlateElement
      {...props}
      // @ts-ignore
      attributes={{
        ...props.attributes,
        'data-ltr-element': true,
      }}
      className='ps-6'
    >
      <Button
        className={`${styles.toggleButton} absolute top-0 size-6 cursor-pointer select-none items-center justify-center rounded-md p-px text-muted-foreground transition-colors hover:bg-accent [&_svg]:size-4`}
        contentEditable={false}
        size='icon'
        variant='ghost'
        {...buttonProps}
      >
        <ChevronRight
          className={cn(
            open ? styles.toggleIconOpen : styles.toggleIcon,
            'transition-all duration-300'
          )}
        />
      </Button>
      {props.children}
    </PlateElement>
  );
}
