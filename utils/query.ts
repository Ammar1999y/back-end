import type { PaginationMeta } from '@/utils/api-response';

import { EntityID } from '@/types';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useShallow } from 'zustand/shallow';

import { useDataTableStore } from '@/utils/store/data-table-store';

import { CustomError } from './error-class';

// Type for local storage query handlers
type LocalStorageQueryHandler<TData = any> = {
  getAll?: () => Promise<TData>;
  getById?: (id: EntityID) => Promise<TData>;
};

// Registry for local storage query handlers by endpoint pattern
const localStorageQueryHandlers = new Map<RegExp, LocalStorageQueryHandler>();

/**
 * Register a local storage query handler for a specific endpoint pattern
 */
export const registerLocalStorageQueryHandler = (
  pattern: RegExp,
  handler: LocalStorageQueryHandler
) => {
  localStorageQueryHandlers.set(pattern, handler);
};

export const useQueryData = <TData = unknown>({
  queryKey,
  href,
  enabled = true,
  requiredData = true,
}: {
  queryKey: (string | number | EntityID)[];
  href: string;
  enabled?: boolean;
  requiredData?: boolean | string | number | undefined | null;
}) =>
  useQuery<TData>({
    queryKey,
    queryFn: async () => {
      if (!requiredData)
        throw new CustomError('البيانات غير صحيحة، اعد المحاوله', 400);

      try {
        const response = await fetch(href);
        const result = await response.json();

        if (!response.ok || !result.success)
          throw new CustomError(
            result.message || 'لايوجد اتصال بالانترنت، اعد المحاولة',
            response.status
          );
        return result.data;
      } catch (error) {
        if (error instanceof CustomError) throw error;
        if (error instanceof TypeError)
          throw new CustomError('لايوجد اتصال بالانترنت، اعد المحاولة', 503);
        throw new CustomError('حدث خطأ غير متوقع', 500);
      }
    },
    enabled,
  });

// ─── Server-side data-table query ────────────────────────────────────

interface ServerDataTableResult<TData> {
  data: TData[];
  meta: PaginationMeta;
}
export const DEFAULT_META: PaginationMeta = {
  page: 1,
  perPage: 10,
  total: 0,
  pageCount: 1,
};
function buildDataTableUrl(
  baseHref: string,
  state: {
    page: number;
    perPage: number;
    sort: any[];
    filters: any[];
    joinOperator: string;
    search: string;
  }
): string {
  const params = new URLSearchParams();

  if (state.page !== DEFAULT_META.page) params.set('page', String(state.page));
  if (state.perPage !== DEFAULT_META.perPage)
    params.set('perPage', String(state.perPage));
  if (state.sort.length > 0) params.set('sort', JSON.stringify(state.sort));
  if (state.filters.length > 0)
    params.set('filters', JSON.stringify(state.filters));
  if (state.joinOperator !== 'and')
    params.set('joinOperator', state.joinOperator);
  if (state.search) params.set('search', state.search);

  const qs = params.toString();
  return qs ? `${baseHref}?${qs}` : baseHref;
}

/**
 * React Query hook for server-side data-table pages.
 * Reads page/perPage/sort/filters/search from the Zustand store,
 * appends them as query params, and returns { data[], meta }.
 */
export const useServerDataTable = <TData = unknown>({
  queryKey,
  href,
}: {
  queryKey: (string | number | EntityID)[];
  href: string;
}) => {
  const { page, perPage, sort, filters, joinOperator, search } =
    useDataTableStore(
      useShallow((s) => ({
        page: s.page,
        perPage: s.perPage,
        sort: s.sort,
        filters: s.filters,
        joinOperator: s.joinOperator,
        search: s.search,
      }))
    );

  const fullUrl = buildDataTableUrl(href, {
    page,
    perPage,
    sort,
    filters,
    joinOperator,
    search,
  });

  const query = useQuery<ServerDataTableResult<TData>>({
    queryKey: [...queryKey, page, perPage, sort, filters, joinOperator, search],
    queryFn: async () => {
      try {
        const response = await fetch(fullUrl);
        const result = await response.json();

        if (!response.ok || !result.success)
          throw new CustomError(
            result.message || 'لايوجد اتصال بالانترنت، اعد المحاولة',
            response.status
          );

        return {
          data: result.data ?? [],
          meta: result.meta ?? DEFAULT_META,
        };
      } catch (error) {
        if (error instanceof CustomError) throw error;
        if (error instanceof TypeError)
          throw new CustomError('لايوجد اتصال بالانترنت، اعد المحاولة', 503);
        throw new CustomError('حدث خطأ غير متوقع', 500);
      }
    },
    placeholderData: keepPreviousData,
  });

  return {
    data: query.data?.data,
    meta: query.data?.meta ?? DEFAULT_META,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
};
