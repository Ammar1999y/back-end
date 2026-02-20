'use client';

import {
  BoldIcon,
  Code2Icon,
  ItalicIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorReadOnly } from 'platejs/react';

import { useKeyboardDetection } from '@/hooks/use-keyboard-detection';
import { ToolbarGroup } from '@/components/ui/toolbar';

import { CommentToolbarButton } from './comment-toolbar-button';
import { LinkToolbarButton } from './link-toolbar-button';
import { MarkToolbarButton } from './mark-toolbar-button';
import { MoreToolbarButton } from './more-toolbar-button';
import { SuggestionToolbarButton } from './suggestion-toolbar-button';
import { TurnIntoToolbarButton } from './turn-into-toolbar-button';

export function FloatingToolbarButtons() {
  const readOnly = useEditorReadOnly();
  const { formatShortcut } = useKeyboardDetection();

  return (
    <>
      {!readOnly && (
        <ToolbarGroup>
          <TurnIntoToolbarButton />

          <MarkToolbarButton
            nodeType={KEYS.bold}
            tooltip={formatShortcut('عريض', 'B')}
          >
            <BoldIcon />
          </MarkToolbarButton>

          <MarkToolbarButton
            nodeType={KEYS.italic}
            tooltip={formatShortcut('مائل', 'I')}
          >
            <ItalicIcon />
          </MarkToolbarButton>

          <MarkToolbarButton
            nodeType={KEYS.underline}
            tooltip={formatShortcut('تحته خط', 'U')}
          >
            <UnderlineIcon />
          </MarkToolbarButton>

          <MarkToolbarButton
            nodeType={KEYS.strikethrough}
            tooltip={formatShortcut('يتوسطه خط', '⇧+M')}
          >
            <StrikethroughIcon />
          </MarkToolbarButton>

          <MarkToolbarButton
            nodeType={KEYS.code}
            tooltip={formatShortcut('كود', 'E')}
          >
            <Code2Icon />
          </MarkToolbarButton>

          <LinkToolbarButton />
        </ToolbarGroup>
      )}

      <ToolbarGroup>
        <CommentToolbarButton />
        <SuggestionToolbarButton />

        {!readOnly && <MoreToolbarButton />}
      </ToolbarGroup>
    </>
  );
}
