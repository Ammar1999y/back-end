import type { Project } from '../types';
import type { ExtendedColumnSort } from '@/types/data-table';
import type { TableState } from '@tanstack/react-table';

import dynamic from 'next/dynamic';
import { useMemo, useRef } from 'react';

import { useQueryData } from '@/utils/query';

import { DataTableContent } from '@/components/ui/data-table';
import Header from '@/components/ui/data-table/client-side-table/header';
import { useDataTable } from '@/components/ui/data-table/hooks/use-data-table';

import { PROJECTS_QUERY_KEYS } from '../query-keys';
import { columns } from './columns';

const cta = { href: '/dash/projects/new', label: 'إضافة مشروع جديد' };

const UrlSync = dynamic(
  () =>
    import('@/components/ui/data-table/filters/url-sync').then(
      (e) => e.UrlSync
    ),
  { ssr: false }
);

const STORAGE_KEY = 'projects-table';
const initialSorting: ExtendedColumnSort<Project>[] = [
  { id: 'createdAt', desc: true },
];

const queryParams = {
  queryKey: PROJECTS_QUERY_KEYS.list,
  href: '/api/dash/projects',
};

const ProjectsPage = () => {
  const { data, isLoading, error, refetch } =
    useQueryData<Project[]>(queryParams);

  const tableContainerRef = useRef<HTMLDivElement>(null);
  const initialState:
    | (Omit<Partial<TableState>, 'sorting'> & {
        sorting?: ExtendedColumnSort<Project>[];
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

      <Header title='المشاريع' cta={cta} />

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

export { ProjectsPage };
