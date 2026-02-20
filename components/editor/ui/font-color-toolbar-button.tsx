'use client';

import type {
  DropdownMenuItemProps,
  DropdownMenuProps,
} from '@radix-ui/react-dropdown-menu';

import React from 'react';

import { EraserIcon, PlusIcon } from 'lucide-react';
import { useEditorRef, useEditorSelector } from 'platejs/react';
import { cn } from '@/lib/utils';

import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToolbarButton, ToolbarMenuGroup } from '@/components/ui/toolbar';
import {
  DEFAULT_COLORS,
  TColor,
  useCustomColors,
} from '@/components/editor/hooks/use-custom-colors';

import { ColorPickerContent } from './color-picker-content';

export function FontColorToolbarButton({
  children,
  nodeType,
  tooltip,
}: {
  nodeType: string;
  tooltip?: string;
} & DropdownMenuProps) {
  const editor = useEditorRef();

  const selectionDefined = useEditorSelector(
    (editor) => !!editor.selection,
    []
  );

  const color = useEditorSelector(
    (editor) => editor.api.mark(nodeType) as string,
    [nodeType]
  );

  const [selectedColor, setSelectedColor] = React.useState<string>();
  const [open, setOpen] = React.useState(false);
  const { customColors, addCustomColor, clearCustomColors } = useCustomColors();

  const onToggle = React.useCallback(
    (value = !open) => {
      setOpen(value);
    },
    [open, setOpen]
  );

  const updateColor = React.useCallback(
    (value: string) => {
      if (editor.selection) {
        setSelectedColor(value);

        editor.tf.select(editor.selection);
        editor.tf.focus();

        editor.tf.addMarks({ [nodeType]: value });
      }
    },
    [editor, nodeType]
  );

  const updateColorAndClose = React.useCallback(
    (value: string) => {
      updateColor(value);
      onToggle();
    },
    [onToggle, updateColor]
  );

  const clearColor = React.useCallback(() => {
    if (editor.selection) {
      editor.tf.select(editor.selection);
      editor.tf.focus();

      if (selectedColor) {
        editor.tf.removeMarks(nodeType);
      }

      onToggle();
    }
  }, [editor, selectedColor, onToggle, nodeType]);

  React.useEffect(() => {
    if (selectionDefined) {
      setSelectedColor(color);
    }
  }, [color, selectionDefined]);

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(value) => {
        setOpen(value);
      }}
      open={open}
    >
      <DropdownMenuTrigger asChild>
        <ToolbarButton pressed={open} tooltip={tooltip}>
          {children}
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent align='start'>
        <ColorPicker
          clearColor={clearColor}
          color={selectedColor || color}
          colors={DEFAULT_COLORS}
          customColors={customColors}
          updateColor={updateColorAndClose}
          addCustomColor={addCustomColor}
          clearCustomColors={clearCustomColors}
          onClose={() => setOpen(false)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PureColorPicker({
  className,
  clearColor,
  color,
  colors,
  customColors,
  updateColor,
  addCustomColor,
  clearCustomColors,
  onClose,
  ...props
}: React.ComponentProps<'div'> & {
  colors: TColor[];
  customColors: TColor[];
  clearColor: () => void;
  updateColor: (color: string) => void;
  addCustomColor: (color: string) => void;
  clearCustomColors: () => void;
  onClose: () => void;
  color?: string;
}) {
  const [pickerColor, setPickerColor] = React.useState(color || '#000000');

  const handleSaveCustomColor = React.useCallback(() => {
    addCustomColor(pickerColor);
    updateColor(pickerColor);
    onClose();
  }, [pickerColor, addCustomColor, updateColor, onClose]);

  return (
    <div className={cn('flex flex-col', className)} {...props}>
      {/* Action Buttons - First */}
      <ToolbarMenuGroup>
        <div className='flex flex-col gap-1 px-2'>
          {/* Add Custom Color Button with Nested Dropdown */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className='w-full justify-start gap-2'>
              <PlusIcon className='size-4' />
              <span>إضافة لون مخصص</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className='w-auto p-3' sideOffset={8}>
              <div className='flex flex-col gap-3'>
                <ColorPickerContent
                  value={pickerColor}
                  onChange={setPickerColor}
                />
                <div className='flex w-full gap-2'>
                  <Button
                    variant='outline'
                    size='sm'
                    className='flex-1'
                    onClick={(e) => {
                      e.preventDefault();
                      setPickerColor(color || '#000000');
                    }}
                  >
                    إلغاء
                  </Button>
                  <Button
                    size='sm'
                    className='flex-1'
                    onClick={handleSaveCustomColor}
                  >
                    حفظ واختيار
                  </Button>
                </div>
              </div>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {/* Clear Color Button */}
          {color && (
            <DropdownMenuItem
              className='w-full justify-start gap-2'
              onClick={clearColor}
            >
              <EraserIcon className='size-4' />
              <span>مسح اللون</span>
            </DropdownMenuItem>
          )}
        </div>
      </ToolbarMenuGroup>

      {/* Custom Colors */}
      {customColors.length > 0 && (
        <ToolbarMenuGroup label='ألوان مخصصة'>
          <div className='flex flex-col gap-2 px-2'>
            <ColorDropdownMenuItems
              color={color}
              colors={customColors}
              updateColor={updateColor}
            />
            <DropdownMenuItem
              className='justify-center text-xs text-muted-foreground hover:text-destructive'
              onClick={(e) => {
                e.preventDefault();
                clearCustomColors();
              }}
            >
              مسح الألوان المخصصة
            </DropdownMenuItem>
          </div>
        </ToolbarMenuGroup>
      )}

      {/* Default Colors - Last */}
      <ToolbarMenuGroup label='ألوان افتراضية'>
        <ColorDropdownMenuItems
          className='px-2'
          color={color}
          colors={colors}
          updateColor={updateColor}
        />
      </ToolbarMenuGroup>
    </div>
  );
}

const ColorPicker = React.memo(
  PureColorPicker,
  (prev, next) =>
    prev.color === next.color &&
    prev.colors === next.colors &&
    prev.customColors === next.customColors
);

function ColorDropdownMenuItem({
  className,
  isSelected,
  updateColor,
  value,
  ...props
}: {
  isBrightColor: boolean;
  isSelected: boolean;
  value: string;
  updateColor: (color: string) => void;
} & DropdownMenuItemProps) {
  // return name ? (
  //   <Tooltip>
  //     <TooltipTrigger>{content}</TooltipTrigger>
  //     <TooltipContent className='mb-1 capitalize'>{name}</TooltipContent>
  //   </Tooltip>
  // ) : (
  //   content
  // );
  return (
    <DropdownMenuItem
      className={cn(
        buttonVariants({
          size: 'icon',
          variant: 'outline',
        }),
        'my-1 flex size-6 items-center justify-center rounded-full border border-solid border-border p-0 transition-all hover:scale-125',
        // !isBrightColor && 'border-transparent',
        isSelected && 'border-2 border-primary',
        className
      )}
      onSelect={(e) => {
        e.preventDefault();
        updateColor(value);
      }}
      style={{ backgroundColor: value }}
      {...props}
    />
  );
}

export function ColorDropdownMenuItems({
  className,
  color,
  colors,
  updateColor,
  ...props
}: {
  colors: TColor[];
  updateColor: (color: string) => void;
  color?: string;
} & React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'grid grid-cols-[repeat(10,1fr)] place-items-center gap-x-1',
        className
      )}
      {...props}
    >
      {colors.map(({ isBrightColor, value }) => (
        <ColorDropdownMenuItem
          isBrightColor={isBrightColor}
          isSelected={color === value}
          key={value}
          updateColor={updateColor}
          value={value}
        />
      ))}
      {props.children}
    </div>
  );
}
