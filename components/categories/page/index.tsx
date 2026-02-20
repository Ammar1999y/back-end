import type { Category } from '../types';
import type { ExtendedColumnSort } from '@/types/data-table';
import type { TableState } from '@tanstack/react-table';

import dynamic from 'next/dynamic';
import { useMemo, useRef } from 'react';

import { useQueryData } from '@/utils/query';

import { DataTableContent } from '@/components/ui/data-table';
import Header from '@/components/ui/data-table/client-side-table/header';
import { useDataTable } from '@/components/ui/data-table/hooks/use-data-table';

import { CATEGORIES_QUERY_KEYS } from '../query-keys';
import { columns } from './columns';

const cta = {
  href: '/dash/projects/categories/new',
  label: 'إضافة تصنيف جديد',
};

const UrlSync = dynamic(
  () =>
    import('@/components/ui/data-table/filters/url-sync').then(
      (e) => e.UrlSync
    ),
  { ssr: false }
);

const STORAGE_KEY = 'categories-table';
const initialSorting: ExtendedColumnSort<Category>[] = [
  { id: 'createdAt', desc: true },
];

const queryParams = {
  queryKey: CATEGORIES_QUERY_KEYS.list,
  href: '/api/dash/projects/categories',
};

const CategoriesPage = () => {
  const { data, isLoading, error, refetch } =
    useQueryData<Category[]>(queryParams);

  const tableContainerRef = useRef<HTMLDivElement>(null);
  const initialState:
    | (Omit<Partial<TableState>, 'sorting'> & {
        sorting?: ExtendedColumnSort<Category>[];
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
    pageCount: 1,
    storageKey: STORAGE_KEY,
    tableContainerRef,
    initialState,
  });

  return (
    <>
      <UrlSync defaultSort={initialSorting} />

      <Header title='تصنيفات المشاريع' cta={cta} />

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

export { CategoriesPage };
