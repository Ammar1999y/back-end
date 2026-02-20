'use client';

import type { DropdownMenuProps } from '@radix-ui/react-dropdown-menu';
import type { PlateEditor } from 'platejs/react';

import * as React from 'react';

import {
  CalendarIcon,
  ChevronRightIcon,
  Columns3Icon,
  FileCodeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  Link2Icon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  PilcrowIcon,
  PlusIcon,
  QuoteIcon,
  RadicalIcon,
  SquareIcon,
  TableIcon,
  TableOfContentsIcon,
} from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorRef } from 'platejs/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToolbarButton, ToolbarMenuGroup } from '@/components/ui/toolbar';
import {
  insertBlock,
  insertInlineElement,
} from '@/components/editor/transforms';

type Group = {
  group: string;
  items: Item[];
};

type Item = {
  icon: React.ReactNode;
  value: string;
  onSelect: (editor: PlateEditor, value: string) => void;
  focusEditor?: boolean;
  label?: string;
};

const groups: Group[] = [
  {
    group: 'العناصر الأساسية',
    items: [
      {
        icon: <PilcrowIcon />,
        label: 'فقرة',
        value: KEYS.p,
      },
      {
        icon: <Heading1Icon />,
        label: 'عنوان 1',
        value: 'h1',
      },
      {
        icon: <Heading2Icon />,
        label: 'عنوان 2',
        value: 'h2',
      },
      {
        icon: <Heading3Icon />,
        label: 'عنوان 3',
        value: 'h3',
      },
      {
        icon: <TableIcon />,
        label: 'جدول',
        value: KEYS.table,
      },
      {
        icon: <FileCodeIcon />,
        label: 'كود',
        value: KEYS.codeBlock,
      },
      {
        icon: <QuoteIcon />,
        label: 'اقتباس',
        value: KEYS.blockquote,
      },
      {
        icon: <MinusIcon />,
        label: 'فاصل',
        value: KEYS.hr,
      },
    ].map((item) => ({
      ...item,
      onSelect: (editor, value) => {
        insertBlock(editor, value);
      },
    })),
  },
  {
    group: 'القوائم',
    items: [
      {
        icon: <ListIcon />,
        label: 'قائمة نقطية',
        value: KEYS.ul,
      },
      {
        icon: <ListOrderedIcon />,
        label: 'قائمة مرقمة',
        value: KEYS.ol,
      },
      {
        icon: <SquareIcon />,
        label: 'قائمة مهام',
        value: KEYS.listTodo,
      },
      {
        icon: <ChevronRightIcon className='rtl:rotate-180' />,
        label: 'قائمة قابلة للطي',
        value: KEYS.toggle,
      },
    ].map((item) => ({
      ...item,
      onSelect: (editor, value) => {
        insertBlock(editor, value);
      },
    })),
  },
  {
    group: 'عناصر متقدمة',
    items: [
      {
        icon: <TableOfContentsIcon />,
        label: 'جدول المحتويات',
        value: KEYS.toc,
      },
      {
        icon: <Columns3Icon />,
        label: '3 أعمدة',
        value: 'action_three_columns',
      },
      {
        focusEditor: false,
        icon: <RadicalIcon />,
        label: 'معادلة',
        value: KEYS.equation,
      },
    ].map((item) => ({
      ...item,
      onSelect: (editor, value) => {
        insertBlock(editor, value);
      },
    })),
  },
  {
    group: 'عناصر مضمنة',
    items: [
      {
        icon: <Link2Icon />,
        label: 'رابط',
        value: KEYS.link,
      },
      {
        focusEditor: true,
        icon: <CalendarIcon />,
        label: 'تاريخ',
        value: KEYS.date,
      },
      {
        focusEditor: false,
        icon: <RadicalIcon />,
        label: 'معادلة مضمنة',
        value: KEYS.inlineEquation,
      },
    ].map((item) => ({
      ...item,
      onSelect: (editor, value) => {
        insertInlineElement(editor, value);
      },
    })),
  },
];

export function InsertToolbarButton(props: DropdownMenuProps) {
  const editor = useEditorRef();
  const [open, setOpen] = React.useState(false);

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open} {...props}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton isDropdown pressed={open} tooltip='إدراج'>
          <PlusIcon />
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align='start'
        className='flex max-h-[500px] min-w-0 flex-col overflow-y-auto'
      >
        {groups.map(({ group, items: nestedItems }) => (
          <ToolbarMenuGroup key={group} label={group}>
            {nestedItems.map(({ icon, label, value, onSelect }) => (
              <DropdownMenuItem
                className='min-w-44'
                key={value}
                onSelect={() => {
                  onSelect(editor, value);
                  editor.tf.focus();
                }}
              >
                {icon}
                {label}
              </DropdownMenuItem>
            ))}
          </ToolbarMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
