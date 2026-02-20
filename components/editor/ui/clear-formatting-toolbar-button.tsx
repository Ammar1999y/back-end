'use client';

import { RemoveFormattingIcon } from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorRef } from 'platejs/react';

import { ToolbarButton } from '@/components/ui/toolbar';

// Block types that should be converted to paragraph
const BLOCK_TYPES_TO_RESET = [
  ...KEYS.heading, // h1, h2, h3, h4, h5, h6
  KEYS.blockquote,
  KEYS.codeBlock,
  KEYS.callout,
] as const;

// Block-level properties to clear
const BLOCK_PROPS_TO_CLEAR = [
  'align',
  'dir',
  'lineHeight',
  'indent',
  'listStyleType', // for lists
] as const;

export function ClearFormattingToolbarButton() {
  const editor = useEditorRef();

  const handleClearFormatting = () => {
    // 1. Remove ALL text marks (bold, italic, underline, color, backgroundColor, etc.)
    editor.tf.removeMarks();

    // 2. Clear block-level formatting properties
    editor.tf.unsetNodes([...BLOCK_PROPS_TO_CLEAR], {
      match: (n) => 'type' in n,
    });

    // 3. Convert headings and special blocks back to paragraph
    editor.tf.setNodes(
      { type: KEYS.p },
      {
        match: (n) =>
          'type' in n &&
          BLOCK_TYPES_TO_RESET.includes((n as { type: string }).type as any),
      }
    );

    editor.tf.focus();
  };

  return (
    <ToolbarButton onClick={handleClearFormatting} tooltip='مسح التنسيق'>
      <RemoveFormattingIcon />
    </ToolbarButton>
  );
}
