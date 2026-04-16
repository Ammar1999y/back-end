import type { ExtendedColumnSort } from '@/types/data-table';
import type {
  PaginationState,
  Table,
  TableOptions,
  TableState,
} from '@tanstack/react-table';
import type { RefObject } from 'react';

import { useEffect, useMemo } from 'react';

import {
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useShallow } from 'zustand/shallow';

import { useDataTableStore } from '@/utils/store/data-table-store';

import useIsomorphicLayoutEffect from '@/hooks/use-layout-effect';

import {
  useColumnOrder,
  useColumnPinning,
  useColumnSizing,
  useColumnVisibility,
  useTableData,
  useUpdateRows,
} from '../store';
import { useTablePersistence } from './use-table-persistence';

const saveRowCheck = <TData>(table: Table<TData>) => {
  try {
    return table.getRowModel().rows;
  } catch {
    return undefined;
  }
};

interface UseDataTableProps<TData>
  extends
    Omit<
      TableOptions<TData>,
      | 'state'
      | 'pageCount'
      | 'getCoreRowModel'
      | 'manualFiltering'
      | 'manualPagination'
      | 'manualSorting'
      | 'initialState'
    >,
    Required<Pick<TableOptions<TData>, 'pageCount'>> {
  initialState?: Omit<Partial<TableState>, 'sorting'> & {
    sorting?: ExtendedColumnSort<TData>[];
  };
  storageKey: string;
  tableContainerRef: RefObject<HTMLDivElement | null>;
}

export function useDataTable<TData>(props: UseDataTableProps<TData>) {
  const {
    columns,
    pageCount,
    storageKey,
    data,
    tableContainerRef,
    ...tableProps
  } = props;

  const columnVisibility = useColumnVisibility((s) => s.columnVisibility);
  const columnPinning = useColumnPinning((s) => s.columnPinning);
  const columnOrder = useColumnOrder((s) => s.columnOrder);

  const persistenceDefaults = useMemo(
    () => ({
      columnPinning: tableProps.initialState?.columnPinning,
      columnOrder: tableProps.initialState?.columnOrder,
    }),
    [tableProps.initialState]
  );
  useTablePersistence('', [storageKey], persistenceDefaults);

  const {
    page,
    perPage,
    sort: sorting,
  } = useDataTableStore(
    useShallow((s) => ({
      page: s.page,
      perPage: s.perPage,
      sort: s.sort,
    }))
  );

  useEffect(() => {
    setTimeout(() => {
      const sort = useDataTableStore.getState().sort;
      const initialSort = props.initialState?.sorting;
      if (sort.length === 0 && initialSort && initialSort.length > 0) {
        useDataTableStore
          .getState()
          .actions.setSorting(initialSort as ExtendedColumnSort<any>[]);
      }
    }, 50);
  }, []);

  const pagination: PaginationState = useMemo(
    () => ({
      pageIndex: page - 1,
      pageSize: perPage,
    }),
    [page, perPage]
  );

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable<TData>({
    data,
    ...tableProps,
    columns,
    pageCount,
    state: {
      pagination,
      sorting,
      columnVisibility,
      columnPinning,
      columnOrder,
    },
    defaultColumn: {
      minSize: 170,
      maxSize: 800,
      ...tableProps.defaultColumn,
      enableColumnFilter: false,
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    columnResizeDirection: 'rtl',
    enableSortingRemoval: false,
    enableColumnPinning: true,
  });

  // First mount - restore TanStack columnSizing from localStorage
  useIsomorphicLayoutEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (!stored) return;

      const persisted = JSON.parse(stored);
      if (!persisted.columnSizing) return;

      const tanstackSizing: Record<string, number> = {};
      for (const [key, value] of Object.entries(persisted.columnSizing)) {
        if (key.startsWith('columnId-')) {
          tanstackSizing[key.replace('columnId-', '')] = value as number;
        }
      }

      table.setColumnSizing(tanstackSizing);
    } catch {}
  }, [storageKey]);

  // Set CSS variables and Zustand store from table headers
  useIsomorphicLayoutEffect(() => {
    const headers = table.getFlatHeaders();
    const storeSizing: Record<string, number> = {};
    for (const header of headers) {
      const headerSize = header.getSize();
      const columnSize = header.column.getSize();
      storeSizing[`headerId-${header.id}`] = headerSize;
      storeSizing[`columnId-${header.column.id}`] = columnSize;
      if (tableContainerRef.current) {
        tableContainerRef.current.style.setProperty(
          `--header-${header.id}-size`,
          `${headerSize}`
        );
        tableContainerRef.current.style.setProperty(
          `--col-${header.column.id}-size`,
          `${columnSize}`
        );
      }
    }
    useColumnSizing.getState().setColumnSizing(storeSizing);
    useColumnSizing.getState().setTotalSize(table.getTotalSize());
    const tableElement = document.querySelector('.totalSizeTable');
    if (tableElement)
      (tableElement as HTMLElement).style.width = `${table.getTotalSize()}px`;
  }, [
    table.getState().columnSizingInfo,
    table.getState().columnSizing,
    table.getTotalSize(),
  ]);

  // refresh components related to data
  useEffect(() => {
    useTableData.getState().setReRender();
    if (data) useTableData.getState().setData(data as any[]);
  }, [data]);

  // refresh components related to rows
  const rows = useMemo(() => saveRowCheck(table), [table.getRowModel]);

  useEffect(() => {
    if ((data as TData[])?.length) useUpdateRows.getState().setReRender();
  }, [rows, data]);

  return useMemo(() => ({ table }), [table]);
}
