import { humanReadableNumber } from '@/utils';
import { type ColumnDef } from '@tanstack/react-table';

import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/data-table';
import { dateBetweenFilterFn } from '@/components/ui/data-table/utils/column-utils';
import { tableFormatDate } from '@/components/ui/date/utils';

import { Permission } from '../types';
import { TableActions } from './table-actions';

export const columns: ColumnDef<Permission>[] = [
  {
    accessorKey: 'roleName',
    id: 'roleName',
    meta: {
      label: 'اسم الصلاحية',
      variant: 'text',
      placeholder: 'بحث...',
    },
    enableColumnFilter: true,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='اسم الصلاحية' />
    ),
    cell: ({ row }) => (
      <p className='truncate text-right font-medium'>
        {row.getValue('roleName')}
      </p>
    ),
    size: 200,
  },
  {
    accessorKey: 'description',
    id: 'description',
    meta: {
      label: 'الوصف',
      variant: 'text',
      placeholder: 'بحث...',
    },
    enableColumnFilter: true,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='الوصف' />
    ),
    cell: ({ row }) => (
      <p className='truncate text-sm text-muted-foreground'>
        {row.getValue('description')}
      </p>
    ),
    size: 180,
  },
  {
    accessorKey: 'usersCount',
    id: 'usersCount',
    meta: {
      label: 'عدد المستخدمين',
      variant: 'range',
      placeholder: 'بحث...',
    },
    enableColumnFilter: true,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='عدد المستخدمين' />
    ),
    cell: ({ row }) => (
      <p
        dir='ltr'
        className='bidi-isolate num truncate ps-2 text-base font-normal text-muted-foreground'
      >
        {humanReadableNumber(row.getValue('usersCount'))}
      </p>
    ),
    size: 210,
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
    accessorFn: (originalRow: Permission) =>
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
      label: 'تاريخ التحديث',
      variant: 'date',
      placeholder: 'حدد تاريخ...',
    },
    filterFn: dateBetweenFilterFn,
    enableColumnFilter: true,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='تاريخ التحديث' />
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
