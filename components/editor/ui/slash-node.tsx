'use client';

import type { TComboboxInputElement } from 'platejs';
import type { PlateEditor, PlateElementProps } from 'platejs/react';
import type * as React from 'react';

import {
  CalendarIcon,
  ChevronRightIcon,
  Code2,
  Columns3Icon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  LightbulbIcon,
  ListIcon,
  ListOrdered,
  PilcrowIcon,
  Quote,
  RadicalIcon,
  Square,
  Table,
  TableOfContentsIcon,
} from 'lucide-react';
import { KEYS } from 'platejs';
import { PlateElement } from 'platejs/react';

import {
  insertBlock,
  insertInlineElement,
} from '@/components/editor/transforms';

import {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxEmpty,
  InlineComboboxGroup,
  InlineComboboxGroupLabel,
  InlineComboboxInput,
  InlineComboboxItem,
} from './inline-combobox';

type Group = {
  group: string;
  items: {
    icon: React.ReactNode;
    value: string;
    onSelect: (editor: PlateEditor, value: string) => void;
    className?: string;
    focusEditor?: boolean;
    keywords?: string[];
    label?: string;
  }[];
};

const groups: Group[] = [
  {
    group: 'العناصر الأساسية',
    items: [
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
        value: KEYS.h1,
      },
      {
        icon: <Heading2Icon />,
        keywords: ['subtitle', 'h2'],
        label: 'عنوان 2',
        value: KEYS.h2,
      },
      {
        icon: <Heading3Icon />,
        keywords: ['subtitle', 'h3'],
        label: 'عنوان 3',
        value: KEYS.h3,
      },
      {
        icon: <ListIcon />,
        keywords: ['unordered', 'ul', '-'],
        label: 'قائمة نقطية',
        value: KEYS.ul,
      },
      {
        icon: <ListOrdered />,
        keywords: ['ordered', 'ol', '1'],
        label: 'قائمة مرقمة',
        value: KEYS.ol,
      },
      {
        icon: <Square />,
        keywords: ['checklist', 'task', 'checkbox', '[]'],
        label: 'قائمة مهام',
        value: KEYS.listTodo,
      },
      {
        icon: <ChevronRightIcon className='rtl:rotate-180' />,
        keywords: ['collapsible', 'expandable'],
        label: 'قابل للطي',
        value: KEYS.toggle,
      },
      {
        icon: <Code2 />,
        keywords: ['```'],
        label: 'كود',
        value: KEYS.codeBlock,
      },
      {
        icon: <Table />,
        label: 'جدول',
        value: KEYS.table,
      },
      {
        icon: <Quote />,
        keywords: ['citation', 'blockquote', 'quote', '>'],
        label: 'اقتباس',
        value: KEYS.blockquote,
      },
      {
        description: 'Insert a highlighted block.',
        icon: <LightbulbIcon />,
        keywords: ['note'],
        label: 'ملاحظة',
        value: KEYS.callout,
      },
    ].map((item) => ({
      ...item,
      onSelect: (editor, value) => {
        insertBlock(editor, value, { upsert: true });
      },
    })),
  },
  {
    group: 'عناصر متقدمة',
    items: [
      {
        icon: <TableOfContentsIcon />,
        keywords: ['toc'],
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
        insertBlock(editor, value, { upsert: true });
      },
    })),
  },
  {
    group: 'عناصر مضمنة',
    items: [
      {
        focusEditor: true,
        icon: <CalendarIcon />,
        keywords: ['time'],
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

export function SlashInputElement(
  props: PlateElementProps<TComboboxInputElement>
) {
  const { editor, element } = props;

  return (
    <PlateElement
      {...props}
      as='span'
      // @ts-ignore
      attributes={{
        ...props.attributes,
        'data-ltr-element': true,
      }}
    >
      <InlineCombobox element={element} trigger='/'>
        <InlineComboboxInput />

        <InlineComboboxContent>
          <InlineComboboxEmpty>لا توجد نتائج</InlineComboboxEmpty>

          {groups.map(({ group, items }) => (
            <InlineComboboxGroup key={group}>
              <InlineComboboxGroupLabel>{group}</InlineComboboxGroupLabel>

              {items.map(
                ({ focusEditor, icon, keywords, label, value, onSelect }) => (
                  <InlineComboboxItem
                    focusEditor={focusEditor}
                    group={group}
                    key={value}
                    keywords={keywords}
                    label={label}
                    onClick={() => onSelect(editor, value)}
                    value={value}
                  >
                    <div className='me-2 text-muted-foreground'>{icon}</div>
                    {label ?? value}
                  </InlineComboboxItem>
                )
              )}
            </InlineComboboxGroup>
          ))}
        </InlineComboboxContent>
      </InlineCombobox>

      {props.children}
    </PlateElement>
  );
}
