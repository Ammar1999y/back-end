'use client';

import type { DropdownMenuProps } from '@radix-ui/react-dropdown-menu';

import * as React from 'react';

import { DropdownMenuItemIndicator } from '@radix-ui/react-dropdown-menu';
import { ArrowLeftRightIcon, CheckIcon } from 'lucide-react';
import { useEditorRef, useSelectionFragmentProp } from 'platejs/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToolbarButton } from '@/components/ui/toolbar';
import TextDirectionIcon from '@/components/icons/text-direction';

export type DirValue = 'auto' | 'ltr' | 'rtl';

const items: {
  icon: React.ReactElement;
  value: DirValue;
  label: string;
}[] = [
  {
    icon: <ArrowLeftRightIcon className='size-4' />,
    value: 'auto',
    label: 'تلقائي',
  },
  {
    icon: <TextDirectionIcon className='size-4 scale-x-[-1]' />,
    value: 'ltr',
    label: 'يسار لليمين',
  },
  {
    icon: <TextDirectionIcon className='size-4' />,
    value: 'rtl',
    label: 'يمين لليسار',
  },
];

export function DirToolbarButton(props: DropdownMenuProps) {
  const editor = useEditorRef();

  const value =
    (useSelectionFragmentProp({
      defaultValue: 'auto',
      getProp: (node) => (node as any).dir,
    }) as DirValue) ?? 'auto';

  const [open, setOpen] = React.useState(false);

  const IconValue = items.find((item) => item.value === value)?.icon ?? (
    <ArrowLeftRightIcon />
  );

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open} {...props}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton isDropdown pressed={open} tooltip='اتجاه النص'>
          {IconValue}
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent align='start' className='min-w-40'>
        <DropdownMenuRadioGroup
          onValueChange={(newValue) => {
            editor.tf.setNodes(
              { dir: newValue as DirValue },
              {
                match: (n) => 'type' in n,
              }
            );
            editor.tf.focus();
          }}
          value={value}
        >
          {items.map(({ icon: Icon, value: itemValue, label }) => (
            <DropdownMenuRadioItem
              className='gap-2 pe-4 ps-2 data-[state=checked]:bg-accent'
              key={itemValue}
              value={itemValue}
              showIcon={false}
            >
              <span className='pointer-events-none absolute flex size-3.5 items-center justify-center ltr:right-2 rtl:left-2'>
                <DropdownMenuItemIndicator>
                  <CheckIcon />
                </DropdownMenuItemIndicator>
              </span>
              {Icon}
              <span>{label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
