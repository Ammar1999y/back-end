'use client';

import type { Alignment } from '@platejs/basic-styles';
import type { WithRequiredKey } from 'platejs';

import * as React from 'react';

import { TextAlignPlugin } from '@platejs/basic-styles/react';
import {
  FloatingMedia as FloatingMediaPrimitive,
  FloatingMediaStore,
  useFloatingMediaValue,
  useImagePreviewValue,
} from '@platejs/media/react';
import { cva } from 'class-variance-authority';
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  FlipHorizontal2Icon,
  FlipVertical2Icon,
  Link,
  Trash2Icon,
} from 'lucide-react';
import {
  useEditorPlugin,
  useEditorRef,
  useEditorSelector,
  useElement,
  useFocusedLast,
  useReadOnly,
  useRemoveNodeButton,
  useSelected,
} from 'platejs/react';

import { Button, buttonVariants } from '@/components/ui/button';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import { CaptionButton } from './caption';
import { MediaResizePopover } from './media-resize-popover';

const alignItems = [
  { icon: AlignRightIcon, value: 'right', label: 'يمين' },
  { icon: AlignCenterIcon, value: 'center', label: 'وسط' },
  { icon: AlignLeftIcon, value: 'left', label: 'يسار' },
] as const;

const inputVariants = cva(
  'flex h-7 w-full rounded-md border-none bg-transparent px-1.5 py-1 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-transparent md:text-sm'
);

export function MediaToolbar({
  children,
  plugin,
}: {
  children: React.ReactNode;
  plugin: WithRequiredKey;
}) {
  const { tf } = useEditorPlugin(TextAlignPlugin);

  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const selected = useSelected();
  const isFocusedLast = useFocusedLast();
  const selectionCollapsed = useEditorSelector(
    (editor) => !editor.api.isExpanded(),
    []
  );
  const isImagePreviewOpen = useImagePreviewValue('isOpen', editor.id);
  const open =
    isFocusedLast &&
    !readOnly &&
    selected &&
    selectionCollapsed &&
    !isImagePreviewOpen;
  const isEditing = useFloatingMediaValue('isEditing');

  React.useEffect(() => {
    if (!open && isEditing) {
      FloatingMediaStore.set('isEditing', false);
    }
  }, [open]);

  const element = useElement();
  const { props: buttonProps } = useRemoveNodeButton({ element });

  return (
    <Popover modal={false} open={open}>
      <PopoverAnchor>{children}</PopoverAnchor>

      <PopoverContent
        className='w-auto p-1'
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {isEditing ? (
          <div className='flex w-80 flex-col'>
            <div className='flex items-center'>
              <div className='flex items-center pe-1 ps-2 text-muted-foreground'>
                <Link className='size-4' />
              </div>

              <FloatingMediaPrimitive.UrlInput
                className={inputVariants()}
                options={{ plugin }}
                placeholder='الصق رابط الوسائط...'
              />
            </div>
          </div>
        ) : (
          <div className='box-content flex items-center'>
            <FloatingMediaPrimitive.EditButton
              className={buttonVariants({ size: 'sm', variant: 'ghost' })}
            >
              تعديل الرابط
            </FloatingMediaPrimitive.EditButton>

            <CaptionButton size='sm' variant='ghost'>
              تعليق
            </CaptionButton>

            <Separator className='mx-1 !h-6' orientation='vertical' />
            {alignItems.map(({ icon: Icon, value, label }) => (
              <Tooltip key={value}>
                <TooltipTrigger asChild>
                  <Button
                    className={
                      element.align === value ? 'bg-accent' : undefined
                    }
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      tf.textAlign.setNodes(value as Alignment);

                      editor.tf.focus();
                    }}
                    size='sm'
                    variant='ghost'
                  >
                    <Icon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            ))}

            <Separator className='mx-1 !h-6' orientation='vertical' />

            <MediaResizePopover />

            <Separator className='mx-1 !h-6' orientation='vertical' />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className={element.flipHorizontal ? 'bg-accent' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    editor.tf.setNodes(
                      { flipHorizontal: !element.flipHorizontal },
                      { at: editor.api.findPath(element) }
                    );
                    editor.tf.focus();
                  }}
                  size='sm'
                  variant='ghost'
                >
                  <FlipHorizontal2Icon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>قلب أفقي</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className={element.flipVertical ? 'bg-accent' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    editor.tf.setNodes(
                      { flipVertical: !element.flipVertical },
                      { at: editor.api.findPath(element) }
                    );
                    editor.tf.focus();
                  }}
                  size='sm'
                  variant='ghost'
                >
                  <FlipVertical2Icon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>قلب عمودي</TooltipContent>
            </Tooltip>

            <Separator className='mx-1 !h-6' orientation='vertical' />

            <Button size='sm' variant='ghost' {...buttonProps}>
              <Trash2Icon />
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
