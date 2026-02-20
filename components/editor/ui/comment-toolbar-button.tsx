'use client';

import { MessageSquareTextIcon } from 'lucide-react';
import { useEditorRef } from 'platejs/react';

import { ToolbarButton } from '@/components/ui/toolbar';
import { commentPlugin } from '@/components/editor/plugins/comment-kit';

export function CommentToolbarButton() {
  const editor = useEditorRef();

  return (
    <ToolbarButton
      data-plate-prevent-overlay
      onClick={() => {
        editor.getTransforms(commentPlugin).comment.setDraft();
      }}
      tooltip='تعليق'
    >
      <MessageSquareTextIcon />
    </ToolbarButton>
  );
}
