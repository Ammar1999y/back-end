'use client';

import type { DropdownMenuProps } from '@radix-ui/react-dropdown-menu';

import * as React from 'react';

import { LineHeightPlugin } from '@platejs/basic-styles/react';
import { DropdownMenuItemIndicator } from '@radix-ui/react-dropdown-menu';
import { CheckIcon, WrapText } from 'lucide-react';
import { useEditorRef, useSelectionFragmentProp } from 'platejs/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToolbarButton } from '@/components/ui/toolbar';

const UNSET_VALUE = 'unset';
const DEFAULT_LABEL = 'الافتراضي';

const isUnset = (value: string) => value === UNSET_VALUE;
const getDisplayLabel = (value: string) =>
  isUnset(value) ? DEFAULT_LABEL : value;

export function LineHeightToolbarButton(props: DropdownMenuProps) {
  const editor = useEditorRef();
  const { defaultNodeValue, validNodeValues: values = [] } =
    editor.getInjectProps(LineHeightPlugin);

  const value = useSelectionFragmentProp({
    defaultValue: defaultNodeValue,
    getProp: (node) => node.lineHeight,
  });

  const [open, setOpen] = React.useState(false);

  // const allValues = [UNSET_VALUE, ...values];

  // const handleValueChange = React.useCallback(
  //   (newValue: string) => {
  //     if (isUnset(newValue)) {
  //       editor.getTransforms(LineHeightPlugin).lineHeight.setNodes(undefined);
  //     } else {
  //       editor
  //         .getTransforms(LineHeightPlugin)
  //         .lineHeight.setNodes(Number(newValue));
  //     }
  //     editor.tf.focus();
  //   },
  //   [editor]
  // );

  // const currentValue = value ?? UNSET_VALUE;

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open} {...props}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton isDropdown pressed={open} tooltip='ارتفاع السطر'>
          <WrapText />
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent align='start' className='min-w-0'>
        <DropdownMenuRadioGroup
          onValueChange={(newValue) => {
            editor
              .getTransforms(LineHeightPlugin)
              .lineHeight.setNodes(Number(newValue));
            editor.tf.focus();
          }}
          value={value}
        >
          {values.map((value) => (
            <DropdownMenuRadioItem
              className='min-w-44 ps-2 [&>span:first-child]:hidden'
              key={value}
              value={value}
            >
              <span className='pointer-events-none absolute flex size-3.5 items-center justify-center ltr:right-2 rtl:left-2'>
                <DropdownMenuItemIndicator>
                  <CheckIcon />
                </DropdownMenuItemIndicator>
              </span>
              {getDisplayLabel(value)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
