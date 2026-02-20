'use client';

import type * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import type {
  TElement,
  TTableCellElement,
  TTableElement,
  TTableRowElement,
} from 'platejs';
import type { PlateElementProps } from 'platejs/react';

import * as React from 'react';

import { useDraggable, useDropLine } from '@platejs/dnd';
import {
  BlockSelectionPlugin,
  useBlockSelected,
} from '@platejs/selection/react';
import { setCellBackground } from '@platejs/table';
import {
  TablePlugin,
  TableProvider,
  useTableBordersDropdownMenuContentState,
  useTableCellElement,
  useTableCellElementResizable,
  useTableElement,
  useTableMergeState,
} from '@platejs/table/react';
import { PopoverAnchor } from '@radix-ui/react-popover';
import { cva } from 'class-variance-authority';
import {
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  CombineIcon,
  EraserIcon,
  Grid2X2Icon,
  GripVertical,
  Maximize2Icon,
  Minimize2Icon,
  PaintBucketIcon,
  PlusIcon,
  SquareSplitHorizontalIcon,
  Trash2Icon,
} from 'lucide-react';
import { KEYS, PathApi } from 'platejs';
import {
  PlateElement,
  useComposedRef,
  useEditorPlugin,
  useEditorRef,
  useEditorSelector,
  useElement,
  useElementSelector,
  useFocusedLast,
  usePluginOption,
  useReadOnly,
  useRemoveNodeButton,
  useSelected,
  withHOC,
} from 'platejs/react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent } from '@/components/ui/popover';
import {
  Toolbar,
  ToolbarButton,
  ToolbarGroup,
  ToolbarMenuGroup,
} from '@/components/ui/toolbar';
import {
  DEFAULT_COLORS,
  useCustomColors,
} from '@/components/editor/hooks/use-custom-colors';
import styles from '@/components/editor/ui/editor-elements.module.css';
import ColumnDeleteIcon from '@/components/icons/column-delete';

import { blockSelectionVariants } from './block-selection';
import { ColorPickerContent } from './color-picker-content';
import { ColorDropdownMenuItems } from './font-color-toolbar-button';
import { ResizeHandle } from './resize-handle';
import {
  BorderAllIcon,
  BorderBottomIcon,
  BorderLeftIcon,
  BorderNoneIcon,
  BorderRightIcon,
  BorderTopIcon,
} from './table-icons';

export const TableElement = withHOC(
  TableProvider,
  function TableElement({
    children,
    ...props
  }: PlateElementProps<TTableElement>) {
    const readOnly = useReadOnly();
    const isSelectionAreaVisible = usePluginOption(
      BlockSelectionPlugin,
      'isSelectionAreaVisible'
    );
    const element = useElement<TTableElement>();

    const hasControls = !readOnly && !isSelectionAreaVisible;
    const {
      isSelectingCell,
      marginLeft,
      props: tableProps,
    } = useTableElement();

    const isSelectingTable = useBlockSelected(props.element.id as string);

    const content = (
      <PlateElement
        {...props}
        // @ts-ignore
        attributes={{
          ...props.attributes,
          'data-ltr-element': true,
        }}
        className={cn(
          'py-5',
          hasControls && '*:data-[slot=block-selection]:left-2',
          element.width !== 'full' && 'overflow-x-auto'
        )}
        style={{ paddingLeft: marginLeft }}
      >
        <div
          className={cn(
            'group/table relative',
            element.width === 'full' ? 'w-full' : 'w-fit'
          )}
        >
          <table
            className={cn(
              'me-0 table h-px table-fixed border-collapse',
              isSelectingCell && 'selection:bg-transparent',
              element.width === 'full' && 'w-full'
            )}
            {...tableProps}
          >
            <tbody className='min-w-full'>{children}</tbody>
          </table>

          {isSelectingTable && (
            <div className={blockSelectionVariants()} contentEditable={false} />
          )}
        </div>
      </PlateElement>
    );

    if (readOnly) {
      return content;
    }

    return <TableFloatingToolbar>{content}</TableFloatingToolbar>;
  }
);

function TableFloatingToolbar({
  children,
  ...props
}: React.ComponentProps<typeof PopoverContent>) {
  const { editor, tf } = useEditorPlugin(TablePlugin);
  const selected = useSelected();
  const element = useElement<TTableElement>();
  const { props: buttonProps } = useRemoveNodeButton({ element });
  const collapsedInside = useEditorSelector(
    (editor) => selected && editor.api.isCollapsed(),
    [selected]
  );
  const isFocusedLast = useFocusedLast();

  const { canMerge, canSplit } = useTableMergeState();

  return (
    <Popover
      modal={false}
      open={isFocusedLast && (canMerge || canSplit || collapsedInside)}
    >
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        asChild
        contentEditable={false}
        onOpenAutoFocus={(e) => e.preventDefault()}
        {...props}
      >
        <Toolbar
          className='flex w-auto max-w-[80vw] flex-row overflow-x-auto rounded-md border bg-popover p-1 shadow-md print:hidden'
          contentEditable={false}
        >
          <ToolbarGroup>
            {collapsedInside && (
              <ToolbarButton
                onClick={() => {
                  const newWidth = element.width === 'full' ? 'fit' : 'full';
                  editor.tf.setNodes(
                    { width: newWidth },
                    {
                      match: (n) =>
                        'type' in n && (n as any).type === KEYS.table,
                    }
                  );
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip={element.width === 'full' ? 'عرض مخصص' : 'عرض كامل'}
              >
                {element.width === 'full' ? (
                  <Minimize2Icon />
                ) : (
                  <Maximize2Icon />
                )}
              </ToolbarButton>
            )}
            <ColorDropdownMenu tooltip='لون الخلفية'>
              <PaintBucketIcon />
            </ColorDropdownMenu>
            {canMerge && (
              <ToolbarButton
                onClick={() => tf.table.merge()}
                onMouseDown={(e) => e.preventDefault()}
                tooltip='دمج الخلايا'
              >
                <CombineIcon />
              </ToolbarButton>
            )}
            {canSplit && (
              <ToolbarButton
                onClick={() => tf.table.split()}
                onMouseDown={(e) => e.preventDefault()}
                tooltip='تقسيم الخلية'
              >
                <SquareSplitHorizontalIcon />
              </ToolbarButton>
            )}

            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <ToolbarButton tooltip='حدود الخلية'>
                  <Grid2X2Icon />
                </ToolbarButton>
              </DropdownMenuTrigger>

              <DropdownMenuPortal>
                <TableBordersDropdownMenuContent />
              </DropdownMenuPortal>
            </DropdownMenu>

            {collapsedInside && (
              <ToolbarGroup>
                <ToolbarButton tooltip='حذف الجدول' {...buttonProps}>
                  <Trash2Icon />
                </ToolbarButton>
              </ToolbarGroup>
            )}
          </ToolbarGroup>

          {collapsedInside && (
            <ToolbarGroup>
              <ToolbarButton
                onClick={() => {
                  tf.insert.tableRow({ before: true });
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip='إدراج صف قبل'
              >
                <BetweenVerticalEnd />
              </ToolbarButton>
              <ToolbarButton
                onClick={() => {
                  tf.insert.tableRow();
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip='إدراج صف بعد'
              >
                <BetweenVerticalStart />
              </ToolbarButton>
              <ToolbarButton
                onClick={() => {
                  tf.remove.tableRow();
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip='حذف الصف'
              >
                <ColumnDeleteIcon className='-rotate-90 scale-x-[-1]' />
              </ToolbarButton>
            </ToolbarGroup>
          )}

          {collapsedInside && (
            <ToolbarGroup>
              <ToolbarButton
                onClick={() => {
                  tf.insert.tableColumn({ before: true });
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip='إدراج عمود قبل'
              >
                <BetweenHorizontalEnd />
              </ToolbarButton>
              <ToolbarButton
                onClick={() => {
                  tf.insert.tableColumn();
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip='إدراج عمود بعد'
              >
                <BetweenHorizontalStart />
              </ToolbarButton>
              <ToolbarButton
                onClick={() => {
                  tf.remove.tableColumn();
                }}
                onMouseDown={(e) => e.preventDefault()}
                tooltip='حذف العمود'
              >
                <ColumnDeleteIcon />
              </ToolbarButton>
            </ToolbarGroup>
          )}
        </Toolbar>
      </PopoverContent>
    </Popover>
  );
}

function TableBordersDropdownMenuContent(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Content>
) {
  const editor = useEditorRef();
  const {
    getOnSelectTableBorder,
    hasBottomBorder,
    hasLeftBorder,
    hasNoBorders,
    hasOuterBorders,
    hasRightBorder,
    hasTopBorder,
  } = useTableBordersDropdownMenuContentState();

  return (
    <DropdownMenuContent
      align='start'
      className='min-w-56'
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        editor.tf.focus();
      }}
      side='right'
      sideOffset={0}
      {...props}
    >
      <DropdownMenuGroup>
        <DropdownMenuCheckboxItem
          checked={hasTopBorder}
          onCheckedChange={getOnSelectTableBorder('top')}
        >
          <BorderTopIcon />
          <div>حد علوي</div>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={hasRightBorder}
          onCheckedChange={getOnSelectTableBorder('right')}
        >
          <BorderRightIcon />
          <div>حد أيمن</div>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={hasBottomBorder}
          onCheckedChange={getOnSelectTableBorder('bottom')}
        >
          <BorderBottomIcon />
          <div>حد سفلي</div>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={hasLeftBorder}
          onCheckedChange={getOnSelectTableBorder('left')}
        >
          <BorderLeftIcon />
          <div>حد أيسر</div>
        </DropdownMenuCheckboxItem>
      </DropdownMenuGroup>

      <DropdownMenuGroup>
        <DropdownMenuCheckboxItem
          checked={hasNoBorders}
          onCheckedChange={getOnSelectTableBorder('none')}
        >
          <BorderNoneIcon />
          <div>بلا حدود</div>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={hasOuterBorders}
          onCheckedChange={getOnSelectTableBorder('outer')}
        >
          <BorderAllIcon />
          <div>حدود خارجية</div>
        </DropdownMenuCheckboxItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  );
}

function ColorDropdownMenu({
  children,
  tooltip,
}: {
  children: React.ReactNode;
  tooltip: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [pickerColor, setPickerColor] = React.useState('#000000');

  const editor = useEditorRef();
  const selectedCells = usePluginOption(TablePlugin, 'selectedCells');
  const { customColors, addCustomColor, clearCustomColors } = useCustomColors();

  const onUpdateColor = React.useCallback(
    (color: string) => {
      setOpen(false);
      setCellBackground(editor, { color, selectedCells: selectedCells ?? [] });
    },
    [selectedCells, editor]
  );

  const handleSaveCustomColor = React.useCallback(() => {
    addCustomColor(pickerColor);
    onUpdateColor(pickerColor);
  }, [pickerColor, addCustomColor, onUpdateColor]);

  const onClearColor = React.useCallback(() => {
    setOpen(false);
    setCellBackground(editor, {
      color: null,
      selectedCells: selectedCells ?? [],
    });
  }, [selectedCells, editor]);

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton tooltip={tooltip}>{children}</ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent align='start'>
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
                        setPickerColor('#000000');
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
            <DropdownMenuItem
              className='w-full justify-start gap-2'
              onClick={onClearColor}
            >
              <EraserIcon className='size-4' />
              <span>مسح اللون</span>
            </DropdownMenuItem>
          </div>
        </ToolbarMenuGroup>

        {/* Custom Colors */}
        {customColors.length > 0 && (
          <ToolbarMenuGroup label='ألوان مخصصة'>
            <div className='flex flex-col gap-2 px-2'>
              <ColorDropdownMenuItems
                colors={customColors}
                updateColor={onUpdateColor}
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
            colors={DEFAULT_COLORS}
            updateColor={onUpdateColor}
          />
        </ToolbarMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TableRowElement({
  children,
  ...props
}: PlateElementProps<TTableRowElement>) {
  const { element } = props;
  const readOnly = useReadOnly();
  const selected = useSelected();
  const editor = useEditorRef();
  const isSelectionAreaVisible = usePluginOption(
    BlockSelectionPlugin,
    'isSelectionAreaVisible'
  );
  const hasControls = !readOnly && !isSelectionAreaVisible;

  const { isDragging, previewRef, handleRef } = useDraggable({
    element,
    type: element.type,
    canDropNode: ({ dragEntry, dropEntry }) =>
      PathApi.equals(
        PathApi.parent(dragEntry[1]),
        PathApi.parent(dropEntry[1])
      ),
    onDropHandler: (_, { dragItem }) => {
      const dragElement = (dragItem as { element: TElement }).element;

      if (dragElement) {
        editor.tf.select(dragElement);
      }
    },
  });

  return (
    <PlateElement
      {...props}
      as='tr'
      // @ts-ignore
      attributes={{
        ...props.attributes,
        'data-selected': selected ? 'true' : undefined,
        'data-ltr-element': true,
      }}
      className={cn('group/row', isDragging && 'opacity-50')}
      ref={useComposedRef(props.ref, previewRef)}
    >
      {hasControls && (
        <td className='w-0 select-none' contentEditable={false}>
          <RowDragHandle dragRef={handleRef} />
          <RowDropLine />
        </td>
      )}

      {children}
    </PlateElement>
  );
}

function RowDragHandle({ dragRef }: { dragRef: React.Ref<any> }) {
  const editor = useEditorRef();
  const element = useElement();

  return (
    <Button
      className={cn(
        'absolute left-0 top-1/2 z-[51] h-6 w-4 -translate-y-1/2 p-0 focus-visible:ring-0 focus-visible:ring-offset-0',
        'cursor-grab active:cursor-grabbing',
        `${styles.rowDragHandle} opacity-0 transition-opacity duration-100 group-hover/row:opacity-100`
      )}
      onClick={() => {
        editor.tf.select(element);
      }}
      ref={dragRef}
      variant='outline'
    >
      <GripVertical className='text-muted-foreground' />
    </Button>
  );
}

function RowDropLine() {
  const { dropLine } = useDropLine();

  if (!dropLine) return null;

  return (
    <div
      className={cn(
        'absolute inset-x-0 left-2 z-50 h-0.5 bg-primary/50',
        dropLine === 'top' ? '-top-px' : '-bottom-px'
      )}
    />
  );
}

export function TableCellElement({
  isHeader,
  ...props
}: PlateElementProps<TTableCellElement> & {
  isHeader?: boolean;
}) {
  const { api } = useEditorPlugin(TablePlugin);
  const readOnly = useReadOnly();
  const element = props.element;

  const tableId = useElementSelector(([node]) => node.id as string, [], {
    key: KEYS.table,
  });
  const rowId = useElementSelector(([node]) => node.id as string, [], {
    key: KEYS.tr,
  });
  const isSelectingTable = useBlockSelected(tableId);
  const isSelectingRow = useBlockSelected(rowId) || isSelectingTable;
  const isSelectionAreaVisible = usePluginOption(
    BlockSelectionPlugin,
    'isSelectionAreaVisible'
  );

  const { borders, colIndex, colSpan, minHeight, rowIndex, selected, width } =
    useTableCellElement();

  const { bottomProps, hiddenLeft, leftProps, rightProps } =
    useTableCellElementResizable({
      colIndex,
      colSpan,
      rowIndex,
    });

  return (
    <PlateElement
      {...props}
      as={isHeader ? 'th' : 'td'}
      // @ts-ignore
      attributes={{
        ...props.attributes,
        colSpan: api.table.getColSpan(element),
        'data-ltr-element': true,
        rowSpan: api.table.getRowSpan(element),
      }}
      className={cn(
        'h-full overflow-visible border-none bg-background p-0',
        element.background ? 'bg-[--cellBackground]' : 'bg-background',
        isHeader && 'text-left *:m-0',
        'before:size-full',
        selected && 'before:z-10 before:bg-primary/5',
        "before:absolute before:box-border before:select-none before:content-['']",
        borders.bottom?.size && 'before:border-b before:border-b-border',
        borders.right?.size && 'before:border-e before:border-e-border',
        borders.left?.size && 'before:border-s before:border-s-border',
        borders.top?.size && 'before:border-t before:border-t-border'
      )}
      style={
        {
          '--cellBackground': element.background,
          maxWidth: width || 240,
          minWidth: width || 120,
        } as React.CSSProperties
      }
    >
      <div
        className='relative z-20 box-border h-full px-3 py-2'
        style={{ minHeight }}
      >
        {props.children}
      </div>

      {!isSelectionAreaVisible && (
        <div
          className='group absolute top-0 size-full select-none'
          contentEditable={false}
          suppressContentEditableWarning={true}
        >
          {!readOnly && (
            <>
              <ResizeHandle
                {...rightProps}
                className='-right-1 -top-2 h-[calc(100%_+_8px)] w-2'
                data-col={colIndex}
              />
              <ResizeHandle {...bottomProps} className='-bottom-1 h-2' />
              {!hiddenLeft && (
                <ResizeHandle
                  {...leftProps}
                  className='-left-1 top-0 w-2'
                  data-resizer-left={colIndex === 0 ? 'true' : undefined}
                />
              )}

              <div
                className={cn(
                  'absolute top-0 z-30 hidden h-full w-1 bg-ring',
                  'right-[-1.5px]',
                  columnResizeVariants({ colIndex: colIndex as any })
                )}
              />
              {colIndex === 0 && (
                <div
                  className={cn(
                    'absolute top-0 z-30 h-full w-1 bg-ring',
                    'left-[-1.5px]',
                    'hidden animate-in fade-in group-has-[[data-resizer-left]:hover]/table:block group-has-[[data-resizer-left][data-resizing="true"]]/table:block'
                  )}
                />
              )}
            </>
          )}
        </div>
      )}

      {isSelectingRow && (
        <div className={blockSelectionVariants()} contentEditable={false} />
      )}
    </PlateElement>
  );
}

export function TableCellHeaderElement(
  props: React.ComponentProps<typeof TableCellElement>
) {
  return <TableCellElement {...props} isHeader />;
}

const columnResizeVariants = cva('fade-in hidden animate-in', {
  variants: {
    colIndex: {
      0: 'group-has-[[data-col="0"]:hover]/table:block group-has-[[data-col="0"][data-resizing="true"]]/table:block',
      1: 'group-has-[[data-col="1"]:hover]/table:block group-has-[[data-col="1"][data-resizing="true"]]/table:block',
      2: 'group-has-[[data-col="2"]:hover]/table:block group-has-[[data-col="2"][data-resizing="true"]]/table:block',
      3: 'group-has-[[data-col="3"]:hover]/table:block group-has-[[data-col="3"][data-resizing="true"]]/table:block',
      4: 'group-has-[[data-col="4"]:hover]/table:block group-has-[[data-col="4"][data-resizing="true"]]/table:block',
      5: 'group-has-[[data-col="5"]:hover]/table:block group-has-[[data-col="5"][data-resizing="true"]]/table:block',
      6: 'group-has-[[data-col="6"]:hover]/table:block group-has-[[data-col="6"][data-resizing="true"]]/table:block',
      7: 'group-has-[[data-col="7"]:hover]/table:block group-has-[[data-col="7"][data-resizing="true"]]/table:block',
      8: 'group-has-[[data-col="8"]:hover]/table:block group-has-[[data-col="8"][data-resizing="true"]]/table:block',
      9: 'group-has-[[data-col="9"]:hover]/table:block group-has-[[data-col="9"][data-resizing="true"]]/table:block',
      10: 'group-has-[[data-col="10"]:hover]/table:block group-has-[[data-col="10"][data-resizing="true"]]/table:block',
    },
  },
});
