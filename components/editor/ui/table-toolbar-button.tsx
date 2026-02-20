'use client';

import type { DropdownMenuProps } from '@radix-ui/react-dropdown-menu';

import * as React from 'react';

import { TablePlugin, useTableMergeState } from '@platejs/table/react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Combine,
  Grid3x3Icon,
  Table,
  Trash2Icon,
  Ungroup,
  XIcon,
} from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorPlugin, useEditorSelector } from 'platejs/react';
import { cn } from '@/lib/utils';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToolbarButton } from '@/components/ui/toolbar';

export function TableToolbarButton(props: DropdownMenuProps) {
  const tableSelected = useEditorSelector(
    (editor) => editor.api.some({ match: { type: KEYS.table } }),
    []
  );

  const { editor, tf } = useEditorPlugin(TablePlugin);
  const [open, setOpen] = React.useState(false);
  const mergeState = useTableMergeState();

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open} {...props}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton isDropdown pressed={open} tooltip='جدول'>
          <Table />
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent align='start' className='flex w-44 min-w-0 flex-col'>
        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className='gap-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-50'>
              <Grid3x3Icon className='size-4' />
              <span>جدول</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className='m-0 p-0'>
              <TablePicker />
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              className='gap-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-50'
              disabled={!tableSelected}
            >
              <div className='size-4' />
              <span>خلية</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem
                className='min-w-44'
                disabled={!mergeState.canMerge}
                onSelect={() => {
                  tf.table.merge();
                  editor.tf.focus();
                }}
              >
                <Combine />
                دمج الخلايا
              </DropdownMenuItem>
              <DropdownMenuItem
                className='min-w-44'
                disabled={!mergeState.canSplit}
                onSelect={() => {
                  tf.table.split();
                  editor.tf.focus();
                }}
              >
                <Ungroup />
                تقسيم الخلية
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              className='gap-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-50'
              disabled={!tableSelected}
            >
              <div className='size-4' />
              <span>صف</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem
                className='min-w-44'
                disabled={!tableSelected}
                onSelect={() => {
                  tf.insert.tableRow({ before: true });
                  editor.tf.focus();
                }}
              >
                <ArrowUp />
                إدراج صف قبل
              </DropdownMenuItem>
              <DropdownMenuItem
                className='min-w-44'
                disabled={!tableSelected}
                onSelect={() => {
                  tf.insert.tableRow();
                  editor.tf.focus();
                }}
              >
                <ArrowDown />
                إدراج صف بعد
              </DropdownMenuItem>
              <DropdownMenuItem
                className='min-w-44'
                disabled={!tableSelected}
                onSelect={() => {
                  tf.remove.tableRow();
                  editor.tf.focus();
                }}
              >
                <XIcon />
                حذف صف
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              className='gap-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-50'
              disabled={!tableSelected}
            >
              <div className='size-4' />
              <span>عمود</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem
                className='min-w-44'
                disabled={!tableSelected}
                onSelect={() => {
                  tf.insert.tableColumn({ before: true });
                  editor.tf.focus();
                }}
              >
                <ArrowLeft />
                إدراج عمود قبل
              </DropdownMenuItem>
              <DropdownMenuItem
                className='min-w-44'
                disabled={!tableSelected}
                onSelect={() => {
                  tf.insert.tableColumn();
                  editor.tf.focus();
                }}
              >
                <ArrowRight />
                إدراج عمود بعد
              </DropdownMenuItem>
              <DropdownMenuItem
                className='min-w-44'
                disabled={!tableSelected}
                onSelect={() => {
                  tf.remove.tableColumn();
                  editor.tf.focus();
                }}
              >
                <XIcon />
                حذف عمود
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuItem
            className='min-w-44'
            disabled={!tableSelected}
            onSelect={() => {
              tf.remove.table();
              editor.tf.focus();
            }}
          >
            <Trash2Icon />
            حذف جدول
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TablePicker() {
  const { editor, tf } = useEditorPlugin(TablePlugin);

  const [tablePicker, setTablePicker] = React.useState({
    grid: Array.from({ length: 8 }, () => Array.from({ length: 8 }).fill(0)),
    size: { colCount: 0, rowCount: 0 },
  });

  const onCellMove = (rowIndex: number, colIndex: number) => {
    const newGrid = [...tablePicker.grid];

    // eslint-disable-next-line unicorn/no-for-loop
    for (let i = 0; i < newGrid.length; i++) {
      for (let j = 0; j < newGrid[i].length; j++) {
        newGrid[i][j] =
          i >= 0 && i <= rowIndex && j >= 0 && j <= colIndex ? 1 : 0;
      }
    }

    setTablePicker({
      grid: newGrid,
      size: { colCount: colIndex + 1, rowCount: rowIndex + 1 },
    });
  };

  return (
    <div
      className='m-0 !flex flex-col p-0'
      onClick={() => {
        tf.insert.table(tablePicker.size, { select: true });
        editor.tf.focus();
      }}
      role='button'
    >
      <div className='grid size-32 grid-cols-8 gap-0.5 p-1'>
        {tablePicker.grid.map((rows, rowIndex) =>
          rows.map((value, columIndex) => (
            <div
              className={cn(
                'col-span-1 size-3 border border-solid bg-secondary',
                !!value && 'border-current'
              )}
              key={`(${rowIndex},${columIndex})`}
              onMouseMove={() => {
                onCellMove(rowIndex, columIndex);
              }}
            />
          ))
        )}
      </div>

      <div className='text-center text-xs text-current'>
        {tablePicker.size.rowCount} x {tablePicker.size.colCount}
      </div>
    </div>
  );
}
