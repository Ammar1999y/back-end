'use client';

import type { TElement } from 'platejs';

import * as React from 'react';

import { toUnitLess } from '@platejs/basic-styles';
import { FontSizePlugin } from '@platejs/basic-styles/react';
import { Minus, Plus } from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorPlugin, useEditorSelector } from 'platejs/react';
import { cn } from '@/lib/utils';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ToolbarButton } from '@/components/ui/toolbar';

const DEFAULT_FONT_SIZE = 'unset';
const UNSET_VALUE = 'unset';
const DEFAULT_LABEL = 'الافتراضي';

const isUnset = (value: string) => value === UNSET_VALUE;
const getDisplayLabel = (value: string) =>
  isUnset(value) ? DEFAULT_LABEL : value;

const FONT_SIZE_MAP = {
  h1: '36',
  h2: '24',
  h3: '20',
} as const;

const FONT_SIZES = [
  UNSET_VALUE,
  '8',
  '9',
  '10',
  '12',
  '14',
  '16',
  '18',
  '24',
  '30',
  '36',
  '48',
  '60',
  '72',
  '96',
] as const;

export function FontSizeToolbarButton() {
  const [inputValue, setInputValue] = React.useState(DEFAULT_FONT_SIZE);
  const [isFocused, setIsFocused] = React.useState(false);
  const { editor, tf } = useEditorPlugin(FontSizePlugin);

  const cursorFontSize = useEditorSelector((editor) => {
    const fontSize = editor.api.marks()?.[KEYS.fontSize];

    if (fontSize)
      return isUnset(fontSize as string)
        ? UNSET_VALUE
        : toUnitLess(fontSize as string);

    const [block] = editor.api.block<TElement>() || [];

    if (!block?.type) return DEFAULT_FONT_SIZE;

    return block.type in FONT_SIZE_MAP
      ? FONT_SIZE_MAP[block.type as keyof typeof FONT_SIZE_MAP]
      : DEFAULT_FONT_SIZE;
  }, []);

  const handleInputChange = () => {
    const newSize = toUnitLess(inputValue);

    if (
      Number.parseInt(newSize, 10) < 1 ||
      Number.parseInt(newSize, 10) > 100
    ) {
      editor.tf.focus();

      return;
    }
    if (newSize !== toUnitLess(cursorFontSize)) {
      tf.fontSize.addMark(`${newSize}px`);
    }

    editor.tf.focus();
  };

  const handleFontSizeChange = (delta: number) => {
    const newSize = Number(displayValue) + delta;
    tf.fontSize.addMark(`${newSize}px`);
    editor.tf.focus();
  };

  const displayValue = isFocused ? inputValue : getDisplayLabel(cursorFontSize);

  return (
    <div className='flex items-center gap-1 rounded-md border p-0'>
      <ToolbarButton
        onClick={() => handleFontSizeChange(-1)}
        tooltip='تصغير الخط'
      >
        <Minus />
      </ToolbarButton>

      <Popover modal={false} open={isFocused}>
        <PopoverTrigger asChild>
          <input
            className={cn(
              'h-full w-14 shrink-0 bg-transparent px-1 text-center text-sm hover:bg-muted',
              isUnset(cursorFontSize) && 'text-xs'
            )}
            data-plate-focus='true'
            onBlur={() => {
              setIsFocused(false);
              handleInputChange();
            }}
            onChange={(e) => setInputValue(e.target.value)}
            onFocus={() => {
              setIsFocused(true);
              setInputValue(toUnitLess(cursorFontSize));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleInputChange();
              }
            }}
            type='text'
            value={displayValue}
          />
        </PopoverTrigger>
        <PopoverContent
          className='w-16 px-px py-1'
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {FONT_SIZES.map((size) => (
            <button
              className={cn(
                'flex h-8 w-full items-center justify-center text-sm hover:bg-accent data-[highlighted=true]:bg-accent',
                isUnset(size) && 'text-xs'
              )}
              data-highlighted={size === cursorFontSize}
              key={size}
              onClick={() => {
                tf.fontSize.addMark(isUnset(size) ? size : `${size}px`);
                setIsFocused(false);
              }}
              type='button'
            >
              {getDisplayLabel(size)}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      <ToolbarButton
        onClick={() => handleFontSizeChange(1)}
        tooltip='تكبير الخط'
      >
        <Plus />
      </ToolbarButton>
    </div>
  );
}
