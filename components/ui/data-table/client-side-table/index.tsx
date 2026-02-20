/* eslint-disable react-hooks/exhaustive-deps */
import type { ColumnDef, TableState } from '@tanstack/react-table';

import dynamic from 'next/dynamic';
import { memo, useMemo, useRef } from 'react';

import { EntityID } from '@/types';
import { ExtendedColumnSort } from '@/types/data-table';

import { useQueryData } from '@/utils/query';

import { DataTableContent } from '@/components/ui/data-table';

import { useDataTable } from '../hooks/use-data-table';
import Header from './header';

const UrlSync = dynamic(
  () =>
    import('@/components/ui/data-table/filters/url-sync').then(
      (e) => e.UrlSync
    ),
  { ssr: false }
);
const ClientSideTable = memo(
  ({
    columns,
    queryKey,
    href,
    title,
    cta,
    enabledQuery = true,
    STORAGE_KEY,
    initialSorting,
  }: {
    columns: ColumnDef<any>[];
    queryKey: (string | number | EntityID)[];
    href: string;
    title?: string;
    cta?: { href: string; label: string };
    enabledQuery?: boolean;
    STORAGE_KEY: string;
    initialSorting?: ExtendedColumnSort<any>[] | undefined;
    initialPin;
  }) => {
    const queryParams = useMemo(
      () => ({
        queryKey,
        href,
        enabled: !!enabledQuery,
      }),
      [enabledQuery]
    );

    const { data, isLoading, error, refetch } =
      useQueryData<any[]>(queryParams);

    const tableContainerRef = useRef<HTMLDivElement>(null);
    const initialState:
      | (Omit<Partial<TableState>, 'sorting'> & {
          sorting?: ExtendedColumnSort<any>[] | undefined;
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

        {!!title && <Header title={title} cta={cta} />}

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
  }
);

ClientSideTable.displayName = 'ClientSideTable';
export default ClientSideTable;
