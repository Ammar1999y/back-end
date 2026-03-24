import type { Permission } from '../types';
import type { ExtendedColumnSort } from '@/types/data-table';
import type { TableState } from '@tanstack/react-table';

import dynamic from 'next/dynamic';
import { useMemo, useRef } from 'react';

import { useServerDataTable } from '@/utils/query';

import { DataTableContent } from '@/components/ui/data-table';
import Header from '@/components/ui/data-table/client-side-table/header';
import { useDataTable } from '@/components/ui/data-table/hooks/use-data-table';

import { PERMISSIONS_QUERY_KEYS } from '../query-keys';
import { columns } from './columns';

const cta = { href: '/dash/permissions/new', label: 'إضافة صلاحية جديدة' };

const UrlSync = dynamic(
  () =>
    import('@/components/ui/data-table/filters/url-sync').then(
      (e) => e.UrlSync
    ),
  { ssr: false }
);

const STORAGE_KEY = 'permissions-table';
const initialSorting: ExtendedColumnSort<Permission>[] = [
  { id: 'createdAt', desc: true },
];

const queryParams = {
  queryKey: PERMISSIONS_QUERY_KEYS.list,
  href: '/api/dash/permissions',
};

const PermissionsPage = () => {
  const { data, meta, isLoading, error, refetch } =
    useServerDataTable<Permission>(queryParams);

  const tableContainerRef = useRef<HTMLDivElement>(null);
  const initialState:
    | (Omit<Partial<TableState>, 'sorting'> & {
        sorting?: ExtendedColumnSort<Permission>[];
      })
    | undefined = useMemo(
    () => ({
      sorting: initialSorting,
      columnPinning: {
        right: ['actions'],
      },
      columnVisibility: {},
      columnOrder: columns.map((col) => col.id!),
    }),
    []
  );
  const { table } = useDataTable({
    data: data || [],
    columns,
    pageCount: meta.pageCount,
    storageKey: STORAGE_KEY,
    tableContainerRef,
    initialState,
  });

  return (
    <>
      <UrlSync defaultSort={initialSorting} />

      <Header title={'إدارة الصلاحيات'} cta={cta} />

      <DataTableContent
        table={table}
        data={data}
        isLoading={isLoading}
        error={error}
        refetch={refetch}
        tableContainerRef={tableContainerRef}
        STORAGE_KEY={STORAGE_KEY}
      />
    </>
  );
};

export default PermissionsPage;
