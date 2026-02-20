'use client';

import type { DropdownMenuProps } from '@radix-ui/react-dropdown-menu';
import type { TElement } from 'platejs';

import * as React from 'react';

import { DropdownMenuItemIndicator } from '@radix-ui/react-dropdown-menu';
import {
  CheckIcon,
  ChevronRightIcon,
  Columns3Icon,
  FileCodeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  Heading4Icon,
  Heading5Icon,
  Heading6Icon,
  ListIcon,
  ListOrderedIcon,
  PilcrowIcon,
  QuoteIcon,
  SquareIcon,
} from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorRef, useSelectionFragmentProp } from 'platejs/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToolbarButton, ToolbarMenuGroup } from '@/components/ui/toolbar';
import { getBlockType, setBlockType } from '@/components/editor/transforms';

export const turnIntoItems = [
  {
    icon: <PilcrowIcon />,
    keywords: ['paragraph'],
    label: 'نص',
    value: KEYS.p,
  },
  {
    icon: <Heading1Icon />,
    keywords: ['title', 'h1'],
    label: 'عنوان 1',
    value: 'h1',
  },
  {
    icon: <Heading2Icon />,
    keywords: ['subtitle', 'h2'],
    label: 'عنوان 2',
    value: 'h2',
  },
  {
    icon: <Heading3Icon />,
    keywords: ['subtitle', 'h3'],
    label: 'عنوان 3',
    value: 'h3',
  },
  {
    icon: <Heading4Icon />,
    keywords: ['subtitle', 'h4'],
    label: 'عنوان 4',
    value: 'h4',
  },
  {
    icon: <Heading5Icon />,
    keywords: ['subtitle', 'h5'],
    label: 'عنوان 5',
    value: 'h5',
  },
  {
    icon: <Heading6Icon />,
    keywords: ['subtitle', 'h6'],
    label: 'عنوان 6',
    value: 'h6',
  },
  {
    icon: <ListIcon />,
    keywords: ['unordered', 'ul', '-'],
    label: 'قائمة نقطية',
    value: KEYS.ul,
  },
  {
    icon: <ListOrderedIcon />,
    keywords: ['ordered', 'ol', '1'],
    label: 'قائمة مرقمة',
    value: KEYS.ol,
  },
  {
    icon: <SquareIcon />,
    keywords: ['checklist', 'task', 'checkbox', '[]'],
    label: 'قائمة مهام',
    value: KEYS.listTodo,
  },
  {
    icon: <ChevronRightIcon className='rtl:rotate-180' />,
    keywords: ['collapsible', 'expandable'],
    label: 'قائمة قابلة للطي',
    value: KEYS.toggle,
  },
  {
    icon: <FileCodeIcon />,
    keywords: ['```'],
    label: 'كود',
    value: KEYS.codeBlock,
  },
  {
    icon: <QuoteIcon />,
    keywords: ['citation', 'blockquote', '>'],
    label: 'اقتباس',
    value: KEYS.blockquote,
  },
  {
    icon: <Columns3Icon />,
    label: '3 أعمدة',
    value: 'action_three_columns',
  },
];

export function TurnIntoToolbarButton(props: DropdownMenuProps) {
  const editor = useEditorRef();
  const [open, setOpen] = React.useState(false);

  const value = useSelectionFragmentProp({
    defaultValue: KEYS.p,
    getProp: (node) => getBlockType(node as TElement),
  });
  const selectedItem = React.useMemo(
    () =>
      turnIntoItems.find((item) => item.value === (value ?? KEYS.p)) ??
      turnIntoItems[0],
    [value]
  );

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open} {...props}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton
          className='min-w-32'
          isDropdown
          pressed={open}
          tooltip='تحويل إلى'
        >
          {selectedItem.label}
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align='start'
        className='ignore-click-outside/toolbar min-w-0'
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          editor.tf.focus();
        }}
      >
        <ToolbarMenuGroup
          label='تحويل إلى'
          onValueChange={(type) => {
            setBlockType(editor, type);
          }}
          value={value}
        >
          {turnIntoItems.map(({ icon, label, value: itemValue }) => (
            <DropdownMenuRadioItem
              className='min-w-44 ps-2 [&>span:first-child]:hidden'
              key={itemValue}
              value={itemValue}
            >
              <span className='pointer-events-none absolute flex size-3.5 items-center justify-center ltr:right-2 rtl:left-2'>
                <DropdownMenuItemIndicator>
                  <CheckIcon />
                </DropdownMenuItemIndicator>
              </span>
              {icon}
              <span>{label}</span>
            </DropdownMenuRadioItem>
          ))}
        </ToolbarMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
