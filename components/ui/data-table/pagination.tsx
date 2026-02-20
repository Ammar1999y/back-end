/* eslint-disable react-hooks/exhaustive-deps */
import { memo, useCallback, useEffect, useMemo } from 'react';

import { type Table } from '@tanstack/react-table';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useShallow } from 'zustand/shallow';
import { cn, getPageNumbers } from '@/lib/utils';

import { useDataTableStore } from '@/utils/store/data-table-store';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { useColumnFilters, useGlobalFilter, useUpdateRows } from './store';

type DataTablePaginationProps<TData = any> = {
  table: Table<TData>;
  pageSizeOptions?: number[];
  className?: string;
};

const DataTablePagination = memo(
  ({
    table,
    pageSizeOptions = [5, 10, 25, 50],
    className,
  }: DataTablePaginationProps) => {
    const {
      page: currentPage,
      perPage,
      sort,
    } = useDataTableStore(
      useShallow((s) => ({
        page: s.page,
        perPage: s.perPage,
        sort: s.sort,
      }))
    );

    const reRender = useUpdateRows(useShallow((s) => s.reRender));
    const globalFilter = useGlobalFilter(useShallow((s) => s.globalFilter));
    const columnFilters = useColumnFilters(useShallow((s) => s.columnFilters));

    const totalPages = useMemo(() => {
      const pc = table.getPageCount();
      return Number.isFinite(pc) && pc > 0 ? pc : 1;
    }, [table.getPageCount(), reRender]);

    const pageNumbers = useMemo(
      () => getPageNumbers(currentPage, totalPages),
      [currentPage, totalPages]
    );

    // Reset pagination to page 1 when filters change
    useEffect(() => {
      if (currentPage !== 1) {
        useDataTableStore.getState().actions.setPage(1);
      }
    }, [globalFilter, columnFilters, sort]);

    // Ensure current currentPage doesn't exceed total pages
    useEffect(() => {
      if (currentPage > totalPages)
        useDataTableStore.getState().actions.setPage(totalPages);
    }, [currentPage, perPage, totalPages, reRender]);

    const handlePrev = useCallback(() => {
      if (table.getCanPreviousPage()) {
        useDataTableStore.getState().actions.setPage(currentPage - 1);
      }
    }, [table, currentPage, reRender]);

    const handleNext = useCallback(() => {
      if (table.getCanNextPage()) {
        useDataTableStore.getState().actions.setPage(currentPage + 1);
      }
    }, [table, currentPage, reRender]);

    const handleGoto = useCallback(
      (pageNumber: number) => {
        useDataTableStore
          .getState()
          .actions.setPage(Math.min(Math.max(1, pageNumber), totalPages));
      },
      [totalPages, reRender]
    );

    const handlePageSizeChange = useCallback(
      (value: string) => {
        const size = Number(value);
        const { setPage, setPerPage } = useDataTableStore.getState().actions;
        setPage(1);
        setPerPage(size);
      },
      [reRender]
    );

    return (
      <div
        className={cn(
          'flex items-center justify-between px-2 py-1 space-x-3',
          className
        )}
      >
        <div className='flex items-center space-x-2'>
          <Button
            size='icon'
            variant='ghost'
            className='size-8'
            onClick={handlePrev}
            disabled={!table.getCanPreviousPage()}
            aria-label='الصفحة السابقة'
          >
            <ChevronRightIcon size={16} aria-hidden='true' className='size-4' />
          </Button>

          {pageNumbers.map((pageNumber, i) =>
            pageNumber === '...' ? (
              <span
                key={`${pageNumber}-${i}`}
                className='px-1 text-sm text-muted-foreground'
              >
                ...
              </span>
            ) : (
              <Button
                key={`${pageNumber}-${i}`}
                size='icon'
                variant={currentPage === pageNumber ? 'none' : 'ghost'}
                className={cn(
                  currentPage === pageNumber &&
                    'border border-primary/70 bg-primary/30 font-medium',
                  'h-8 w-8'
                )}
                onClick={() => handleGoto(pageNumber as number)}
                aria-current={currentPage === pageNumber ? 'page' : undefined}
              >
                {pageNumber}
              </Button>
            )
          )}

          <Button
            size='icon'
            variant='ghost'
            className='size-8'
            onClick={handleNext}
            disabled={!table.getCanNextPage()}
            aria-label='الصفحة التالية'
          >
            <ChevronLeftIcon size={16} aria-hidden='true' className='size-4' />
          </Button>
        </div>

        <Select value={perPage.toString()} onValueChange={handlePageSizeChange}>
          <SelectTrigger className='w-32 border-border'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {pageSizeOptions.map((opt) => (
              <SelectItem key={opt} value={String(opt)}>
                {opt} / صفحة
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }
);
DataTablePagination.displayName = 'DataTablePagination';

export { DataTablePagination };
