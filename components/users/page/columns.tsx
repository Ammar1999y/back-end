import { type ColumnDef } from '@tanstack/react-table';

import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/data-table';
import { dateBetweenFilterFn } from '@/components/ui/data-table/utils/column-utils';
import { tableFormatDate } from '@/components/ui/date/utils';

import { User } from '../types';
import { TableActions } from './table-actions';

export const columns: ColumnDef<User>[] = [
  {
    accessorKey: 'name',
    id: 'name',
    meta: {
      label: 'الاسم',
      variant: 'text',
      placeholder: 'بحث...',
    },
    enableColumnFilter: true,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='الاسم' />
    ),
    cell: ({ row }) => (
      <p className='truncate ps-2 font-medium'>{row.getValue('name')}</p>
    ),
  },
  {
    accessorKey: 'email',
    id: 'email',
    meta: {
      label: 'البريد الإلكتروني',
      variant: 'text',
      placeholder: 'بحث...',
    },
    enableColumnFilter: true,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='البريد الإلكتروني' />
    ),
    cell: ({ row }) => (
      <p
        dir='ltr'
        className='bidi-isolate truncate ps-2 text-sm text-muted-foreground'
      >
        {row.getValue('email')}
      </p>
    ),
    size: 220,
  },
  {
    accessorKey: 'role',
    id: 'role',
    meta: {
      label: 'الصلاحية',
      variant: 'multiSelect',
      placeholder: 'اختر...',
    },
    // Neither filterable NOR sortable on the server: `role` is not a column on
    // `users`, it comes from the joined roles table. Both controls were always
    // discarded server-side, so leaving either enabled just renders a widget
    // that does nothing.
    enableColumnFilter: false,
    enableSorting: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='الصلاحية' />
    ),
    cell: ({ row }) => (
      <p className='truncate text-sm text-muted-foreground'>
        {row.getValue('role')}
      </p>
    ),
    size: 200,
  },
  {
    accessorKey: 'isActive',
    id: 'isActive',
    meta: {
      label: 'حالة المستخدم',
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
      <DataTableColumnHeader column={column} title='حالة المستخدم' />
    ),
    cell: ({ row }) => {
      const isActive = row.original.isActive;
      return (
        <Badge variant={isActive ? 'activeStatus' : 'inactiveStatus'}>
          {isActive ? 'نشط' : 'موقف'}
        </Badge>
      );
    },
    accessorFn: (originalRow: User) => (originalRow.isActive ? 'نشط' : 'موقف'),
    size: 220,
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
