'use client';

import type { DropdownMenuProps } from '@radix-ui/react-dropdown-menu';

import * as React from 'react';

import { SuggestionPlugin } from '@platejs/suggestion/react';
import { DropdownMenuItemIndicator } from '@radix-ui/react-dropdown-menu';
import { CheckIcon, EyeIcon, PencilLineIcon, PenIcon } from 'lucide-react';
import { useEditorRef, usePlateState, usePluginOption } from 'platejs/react';
import { cn } from '@/lib/utils';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToolbarButton } from '@/components/ui/toolbar';
import styles from '@/components/editor/ui/editor-elements.module.css';

export function ModeToolbarButton(props: DropdownMenuProps) {
  const editor = useEditorRef();
  const [readOnly, setReadOnly] = usePlateState('readOnly');
  const [open, setOpen] = React.useState(false);

  const isSuggesting = usePluginOption(SuggestionPlugin, 'isSuggesting');

  let value = 'editing';

  if (readOnly) value = 'viewing';

  if (isSuggesting) value = 'suggestion';

  const item: Record<string, { icon: React.ReactNode; label: string }> = {
    editing: {
      icon: <PenIcon />,
      label: 'تحرير',
    },
    suggestion: {
      icon: <PencilLineIcon />,
      label: 'اقتراح',
    },
    viewing: {
      icon: <EyeIcon />,
      label: 'عرض',
    },
  };

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open} {...props}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton isDropdown pressed={open} tooltip='وضع التحرير'>
          {item[value].icon}
          <span className='hidden lg:inline'>{item[value].label}</span>
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent align='start' className='min-w-44'>
        <DropdownMenuRadioGroup
          onValueChange={(newValue) => {
            if (newValue === 'viewing') {
              setReadOnly(true);

              return;
            }
            setReadOnly(false);

            if (newValue === 'suggestion') {
              editor.setOption(SuggestionPlugin, 'isSuggesting', true);

              return;
            }
            editor.setOption(SuggestionPlugin, 'isSuggesting', false);

            if (newValue === 'editing') {
              editor.tf.focus();

              return;
            }
          }}
          value={value}
        >
          <DropdownMenuRadioItem
            className={cn(styles.dropdownMenuRadioItem, 'ps-2')}
            value='editing'
          >
            <Indicator />
            {item.editing.icon}
            {item.editing.label}
          </DropdownMenuRadioItem>

          <DropdownMenuRadioItem
            className={cn(styles.dropdownMenuRadioItem, 'ps-2')}
            value='viewing'
          >
            <Indicator />
            {item.viewing.icon}
            {item.viewing.label}
          </DropdownMenuRadioItem>

          <DropdownMenuRadioItem
            className={cn(styles.dropdownMenuRadioItem, 'ps-2')}
            value='suggestion'
          >
            <Indicator />
            {item.suggestion.icon}
            {item.suggestion.label}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Indicator() {
  return (
    <span className='pointer-events-none absolute flex size-3.5 items-center justify-center ltr:right-2 rtl:left-2'>
      <DropdownMenuItemIndicator>
        <CheckIcon />
      </DropdownMenuItemIndicator>
    </span>
  );
}
