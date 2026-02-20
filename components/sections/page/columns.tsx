import { type ColumnDef } from '@tanstack/react-table';

import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/data-table';
import { dateBetweenFilterFn } from '@/components/ui/data-table/utils/column-utils';
import { tableFormatDate } from '@/components/ui/date/utils';

import { Section } from '../types';
import { TableActions } from './table-actions';

export const columns: ColumnDef<Section>[] = [
  {
    accessorKey: 'title',
    id: 'title',
    meta: {
      label: 'العنوان الرئيسي',
      variant: 'text',
      placeholder: 'بحث...',
    },
    enableColumnFilter: true,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='العنوان الرئيسي' />
    ),
    cell: ({ row }) => (
      <p className='truncate ps-2 font-medium'>{row.getValue('title')}</p>
    ),
    size: 200,
  },
  {
    accessorKey: 'subtitle',
    id: 'subtitle',
    meta: {
      label: 'العنوان الفرعي',
      variant: 'text',
      placeholder: 'بحث...',
    },
    enableColumnFilter: true,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='العنوان الفرعي' />
    ),
    cell: ({ row }) => (
      <p className='truncate ps-2 text-muted-foreground'>
        {row.getValue('subtitle')}
      </p>
    ),
    size: 200,
  },
  {
    accessorKey: 'isActive',
    id: 'isActive',
    meta: {
      label: 'الحالة',
      variant: 'multiSelect',
      placeholder: 'اختر...',
      options: [
        { label: 'نشط', value: 'true' },
        { label: 'موقف', value: 'false' },
      ],
    },
    filterFn: (row, columnId, filterValue) =>
      Array.isArray(filterValue) && filterValue.length > 0
        ? filterValue.includes(row.getValue(columnId))
        : row.getValue(columnId) === filterValue,
    enableColumnFilter: true,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='الحالة' />
    ),
    cell: ({ row }) => {
      const isActive = row.original.isActive;
      return (
        <Badge variant={isActive ? 'activeStatus' : 'inactiveStatus'}>
          {isActive ? 'نشط' : 'موقف'}
        </Badge>
      );
    },
    accessorFn: (originalRow: Section) =>
      originalRow.isActive ? 'نشط' : 'موقف',
  },
  {
    accessorKey: 'createdAt',
    id: 'createdAt',
    meta: {
      label: 'تاريخ الإنشاء',
      variant: 'date',
      placeholder: 'حدد تاريخ...',
    },
    filterFn: dateBetweenFilterFn,
    enableColumnFilter: true,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='تاريخ الإنشاء' />
    ),
    cell: ({ row }) => (
      <p
        dir='ltr'
        className='bidi-isolate num truncate ps-2 text-base font-normal text-muted-foreground'
      >
        {tableFormatDate(row.getValue('createdAt'))}
      </p>
    ),
    size: 180,
  },
  {
    accessorKey: 'updatedAt',
    id: 'updatedAt',
    meta: {
      label: 'آخر تحديث',
      variant: 'date',
      placeholder: 'حدد تاريخ...',
    },
    filterFn: dateBetweenFilterFn,
    enableColumnFilter: true,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='آخر تحديث' />
    ),
    cell: ({ row }) => (
      <p
        dir='ltr'
        className='bidi-isolate num truncate ps-2 text-base font-normal text-muted-foreground'
      >
        {tableFormatDate(row.getValue('updatedAt'))}
      </p>
    ),
    size: 180,
  },
  {
    id: 'actions',
    header: () => (
      <p className='w-full px-1 text-center font-semibold'>الإجراءات</p>
    ),
    meta: { label: 'الإجراءات' },
    enableHiding: false,
    enableSorting: false,
    enableColumnFilter: false,
    cell: ({ row }) => <TableActions original={row.original} />,
    size: 90,
    minSize: 90,
  },
];
