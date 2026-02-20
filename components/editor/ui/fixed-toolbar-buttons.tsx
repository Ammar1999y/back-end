'use client';

import { useState } from 'react';

import {
  ArrowUpToLineIcon,
  BaselineIcon,
  BoldIcon,
  Code2Icon,
  ItalicIcon,
  PaintBucketIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorReadOnly } from 'platejs/react';

import { useKeyboardDetection } from '@/hooks/use-keyboard-detection';
import { ToolbarButton, ToolbarGroup } from '@/components/ui/toolbar';
import { mediaConfig, MediaType } from '@/components/editor/media-config';
import { AlignToolbarButton } from '@/components/editor/ui/align-toolbar-button';
import { DirToolbarButton } from '@/components/editor/ui/dir-toolbar-button';
import { EmojiToolbarButton } from '@/components/editor/ui/emoji-toolbar-button';

import { ClearFormattingToolbarButton } from './clear-formatting-toolbar-button';
import { ExportToolbarButton } from './export-toolbar-button';
import { FontColorToolbarButton } from './font-color-toolbar-button';
import { FontSizeToolbarButton } from './font-size-toolbar-button';
import { RedoToolbarButton, UndoToolbarButton } from './history-toolbar-button';
import { ImportToolbarButton } from './import-toolbar-button';
import {
  IndentToolbarButton,
  OutdentToolbarButton,
} from './indent-toolbar-button';
import { InsertToolbarButton } from './insert-toolbar-button';
import { LineHeightToolbarButton } from './line-height-toolbar-button';
import { LinkToolbarButton } from './link-toolbar-button';
import {
  BulletedListToolbarButton,
  NumberedListToolbarButton,
  TodoListToolbarButton,
} from './list-toolbar-button';
import { MarkToolbarButton } from './mark-toolbar-button';
import { MediaUploadDialog } from './media-upload-dialog';
import { ModeToolbarButton } from './mode-toolbar-button';
import { MoreToolbarButton } from './more-toolbar-button';
import { TableToolbarButton } from './table-toolbar-button';
import { TurnIntoToolbarButton } from './turn-into-toolbar-button';

export function FixedToolbarButtons() {
  const readOnly = useEditorReadOnly();
  const { formatShortcut } = useKeyboardDetection();

  return (
    <div className='flex w-full'>
      {!readOnly && (
        <>
          <ToolbarGroup>
            <UndoToolbarButton />
            <RedoToolbarButton />
          </ToolbarGroup>

          <ToolbarGroup>
            <ExportToolbarButton>
              <ArrowUpToLineIcon />
            </ExportToolbarButton>

            <ImportToolbarButton />
          </ToolbarGroup>

          <ToolbarGroup>
            <InsertToolbarButton />
            <TurnIntoToolbarButton />
            <FontSizeToolbarButton />
          </ToolbarGroup>

          <ToolbarGroup>
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
              tooltip={formatShortcut('يتوسطه خط', 'S')}
            >
              <StrikethroughIcon />
            </MarkToolbarButton>

            <MarkToolbarButton
              nodeType={KEYS.code}
              tooltip={formatShortcut('كود', 'E')}
            >
              <Code2Icon />
            </MarkToolbarButton>
          </ToolbarGroup>

          <ToolbarGroup>
            <FontColorToolbarButton nodeType={KEYS.color} tooltip='لون النص'>
              <BaselineIcon />
            </FontColorToolbarButton>
            <FontColorToolbarButton
              nodeType={KEYS.backgroundColor}
              tooltip='لون الخلفية'
            >
              <PaintBucketIcon />
            </FontColorToolbarButton>
          </ToolbarGroup>

          <ToolbarGroup>
            <AlignToolbarButton />
            <DirToolbarButton />
            <LineHeightToolbarButton />

            <IndentToolbarButton />
            <OutdentToolbarButton />

            <BulletedListToolbarButton />
            <NumberedListToolbarButton />
            <TodoListToolbarButton />
          </ToolbarGroup>

          <ToolbarGroup>
            <LinkToolbarButton />
            <MediaButtons />
            <TableToolbarButton />
            <EmojiToolbarButton />
          </ToolbarGroup>

          <ToolbarGroup>
            <MoreToolbarButton />
            <ClearFormattingToolbarButton />
          </ToolbarGroup>
        </>
      )}

      <div className='grow' />

      <ToolbarGroup>
        <ModeToolbarButton />
      </ToolbarGroup>
    </div>
  );
}

function MediaButtons() {
  const [dialogType, setDialogType] = useState<MediaType | null>(null);

  return (
    <>
      {Object.entries(mediaConfig).map(([type, config]) => {
        if (!config.enabled) return null;
        const Icon = config.icon;
        return (
          <ToolbarButton
            key={type}
            tooltip={config.label}
            onClick={() => setDialogType(type as MediaType)}
          >
            <Icon />
          </ToolbarButton>
        );
      })}

      {dialogType && (
        <MediaUploadDialog
          open={!!dialogType}
          onOpenChange={(open) => !open && setDialogType(null)}
          type={dialogType}
        />
      )}
    </>
  );
}
