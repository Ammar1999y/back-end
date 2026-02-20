import type { SlateElementProps } from 'platejs/static';

import { ChevronRight } from 'lucide-react';
import { SlateElement } from 'platejs/static';

import styles from '@/components/editor/ui/editor-elements.module.css';

export function ToggleElementStatic(props: SlateElementProps) {
  return (
    <SlateElement {...props} className='ps-6'>
      <div
        className={`${styles.toggleButton} absolute top-0 size-6 cursor-pointer select-none items-center justify-center rounded-md p-px text-muted-foreground transition-colors hover:bg-accent [&_svg]:size-4`}
        contentEditable={false}
      >
        <ChevronRight className={styles.toggleIcon} />
      </div>
      {props.children}
    </SlateElement>
  );
}
