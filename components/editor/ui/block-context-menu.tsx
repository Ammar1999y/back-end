'use client';

import * as React from 'react';

import {
  BLOCK_CONTEXT_MENU_ID,
  BlockMenuPlugin,
  BlockSelectionPlugin,
} from '@platejs/selection/react';
import {
  AlignCenterIcon,
  AlignJustifyIcon,
  AlignLeftIcon,
  AlignRightIcon,
  CopyIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  IndentDecreaseIcon,
  IndentIncreaseIcon,
  PilcrowIcon,
  QuoteIcon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorPlugin, usePlateState, usePluginOption } from 'platejs/react';

import { useIsTouchDevice } from '@/hooks/use-is-touch-device';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

export function BlockContextMenu({ children }: { children: React.ReactNode }) {
  const { api, editor } = useEditorPlugin(BlockMenuPlugin);
  const isTouch = useIsTouchDevice();
  const [readOnly] = usePlateState('readOnly');
  const openId = usePluginOption(BlockMenuPlugin, 'openId');
  const isOpen = openId === BLOCK_CONTEXT_MENU_ID;

  const handleTurnInto = React.useCallback(
    (type: string) => {
      editor
        .getApi(BlockSelectionPlugin)
        .blockSelection.getNodes()
        .forEach(([node, path]) => {
          if (node[KEYS.listType]) {
            editor.tf.unsetNodes([KEYS.listType, 'indent'], {
              at: path,
            });
          }

          editor.tf.toggleBlock(type, { at: path });
        });
    },
    [editor]
  );

  const handleAlign = React.useCallback(
    (align: 'center' | 'left' | 'right') => {
      editor
        .getTransforms(BlockSelectionPlugin)
        .blockSelection.setNodes({ align });
    },
    [editor]
  );

  if (isTouch) {
    return children;
  }

  return (
    <ContextMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) {
          api.blockMenu.hide();
        }
      }}
    >
      <ContextMenuTrigger
        asChild
        onContextMenu={(event) => {
          const dataset = (event.target as HTMLElement).dataset;
          const disabled =
            dataset?.slateEditor === 'true' ||
            readOnly ||
            dataset?.plateOpenContextMenu === 'false';

          if (disabled) return event.preventDefault();

          setTimeout(() => {
            api.blockMenu.show(BLOCK_CONTEXT_MENU_ID, {
              x: event.clientX,
              y: event.clientY,
            });
          }, 0);
        }}
      >
        <div className='w-full [&>div]:!ring-0'>{children}</div>
      </ContextMenuTrigger>
      {isOpen && (
        <ContextMenuContent
          className='w-52'
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            editor.getApi(BlockSelectionPlugin).blockSelection.focus();
          }}
        >
          <ContextMenuGroup>
            <ContextMenuItem
              onClick={() => {
                editor
                  .getTransforms(BlockSelectionPlugin)
                  .blockSelection.removeNodes();
                editor.tf.focus();
              }}
            >
              <Trash2Icon />
              حذف
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                editor
                  .getTransforms(BlockSelectionPlugin)
                  .blockSelection.duplicate();
              }}
            >
              <CopyIcon />
              تكرار
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <RefreshCwIcon />
                تحويل إلى
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className='w-40'>
                <ContextMenuItem onClick={() => handleTurnInto(KEYS.p)}>
                  <PilcrowIcon />
                  فقرة
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleTurnInto(KEYS.h1)}>
                  <Heading1Icon />
                  عنوان 1
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleTurnInto(KEYS.h2)}>
                  <Heading2Icon />
                  عنوان 2
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleTurnInto(KEYS.h3)}>
                  <Heading3Icon />
                  عنوان 3
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => handleTurnInto(KEYS.blockquote)}
                >
                  <QuoteIcon />
                  اقتباس
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          </ContextMenuGroup>

          <ContextMenuGroup>
            <ContextMenuItem
              onClick={() =>
                editor
                  .getTransforms(BlockSelectionPlugin)
                  .blockSelection.setIndent(1)
              }
            >
              <IndentIncreaseIcon />
              زيادة المسافة
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() =>
                editor
                  .getTransforms(BlockSelectionPlugin)
                  .blockSelection.setIndent(-1)
              }
            >
              <IndentDecreaseIcon />
              تقليل المسافة
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <AlignJustifyIcon />
                محاذاة
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className='w-40'>
                <ContextMenuItem onClick={() => handleAlign('left')}>
                  <AlignLeftIcon />
                  يسار
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleAlign('center')}>
                  <AlignCenterIcon />
                  وسط
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleAlign('right')}>
                  <AlignRightIcon />
                  يمين
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          </ContextMenuGroup>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}
