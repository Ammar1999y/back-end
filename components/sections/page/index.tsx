import type { Section } from '../types';
import type { ExtendedColumnSort } from '@/types/data-table';
import type { TableState } from '@tanstack/react-table';

import dynamic from 'next/dynamic';
import { useMemo, useRef } from 'react';

import { useQueryData } from '@/utils/query';

import { DataTableContent } from '@/components/ui/data-table';
import Header from '@/components/ui/data-table/client-side-table/header';
import { useDataTable } from '@/components/ui/data-table/hooks/use-data-table';

import { SECTIONS_QUERY_KEYS } from '../query-keys';
import { columns } from './columns';

const cta = { href: '/dash/sections/new', label: 'إضافة قسم جديد' };

const UrlSync = dynamic(
  () =>
    import('@/components/ui/data-table/filters/url-sync').then(
      (e) => e.UrlSync
    ),
  { ssr: false }
);

const STORAGE_KEY = 'sections-table';
const initialSorting: ExtendedColumnSort<Section>[] = [
  { id: 'createdAt', desc: true },
];

const queryParams = {
  queryKey: SECTIONS_QUERY_KEYS.list,
  href: '/api/dash/sections',
};

const SectionsPage = () => {
  const { data, isLoading, error, refetch } =
    useQueryData<Section[]>(queryParams);

  const tableContainerRef = useRef<HTMLDivElement>(null);
  const initialState:
    | (Omit<Partial<TableState>, 'sorting'> & {
        sorting?: ExtendedColumnSort<Section>[];
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

      <Header title='الأقسام' cta={cta} />

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

export { SectionsPage };
