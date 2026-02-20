import type { TCodeBlockElement } from 'platejs';
import type { SlateElementProps, SlateLeafProps } from 'platejs/static';

import { SlateElement, SlateLeaf } from 'platejs/static';

import styles from '@/components/editor/ui/editor-elements.module.css';

export function CodeBlockElementStatic(
  props: SlateElementProps<TCodeBlockElement>
) {
  return (
    <SlateElement className={styles.codeBlock} {...props}>
      <div className='relative rounded-md bg-muted/50'>
        <pre className='overflow-x-auto p-8 pe-4 font-mono text-sm leading-[normal] [tab-size:2] print:break-inside-avoid'>
          <code>{props.children}</code>
        </pre>
      </div>
    </SlateElement>
  );
}

export function CodeLineElementStatic(props: SlateElementProps) {
  return <SlateElement {...props} />;
}

export function CodeSyntaxLeafStatic(props: SlateLeafProps) {
  const tokenClassName = props.leaf.className as string;

  return <SlateLeaf className={tokenClassName} {...props} />;
}
