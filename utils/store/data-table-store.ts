import type {
  ExtendedColumnFilter,
  ExtendedColumnSort,
  JoinOperator,
} from '@/types/data-table';

import { create } from 'zustand';

import {
  MAX_PAGE,
  MAX_PER_PAGE,
  parseFiltersState,
  parseSortingState,
} from '@/components/ui/data-table/utils/parsers';

import { positiveInt } from '..';

export const URL_KEYS = {
  page: 'page',
  perPage: 'perPage',
  sort: 'sort',
  filters: 'filters',
  joinOperator: 'joinOperator',
  search: 'search',
} as const;

interface DataTableState {
  page: number;
  perPage: number;
  sort: ExtendedColumnSort<any>[];
  filters: ExtendedColumnFilter<any>[];
  joinOperator: JoinOperator;
  search: string;
}

interface DataTableActions {
  setPage: (page: number) => void;
  setPerPage: (perPage: number) => void;
  setSorting: (sort: ExtendedColumnSort<any>[]) => void;
  setFilters: (
    filters:
      | ExtendedColumnFilter<any>[]
      | null
      | ((prev: ExtendedColumnFilter<any>[]) => ExtendedColumnFilter<any>[])
  ) => void;
  setJoinOperator: (joinOperator: JoinOperator) => void;
  setSearch: (search: string) => void;
}

export interface DataTableStore extends DataTableState {
  actions: DataTableActions;
}

function parseUrlParams(): DataTableState {
  if (typeof window === 'undefined') {
    return {
      page: 1,
      perPage: 10,
      sort: [],
      filters: [],
      joinOperator: 'and',
      search: '',
    };
  }

  const params = new URLSearchParams(window.location.search);

  const page = positiveInt(params.get(URL_KEYS.page), MAX_PAGE) || 1;
  const perPage = positiveInt(params.get(URL_KEYS.perPage), MAX_PER_PAGE) || 10;

  const sort = parseSortingState(params.get(URL_KEYS.sort));
  const filters = parseFiltersState(params.get(URL_KEYS.filters));
  const joinOperatorRaw = params.get(URL_KEYS.joinOperator);
  const joinOperator: JoinOperator = joinOperatorRaw === 'or' ? 'or' : 'and';

  const searchRaw = params.get(URL_KEYS.search);
  // If both filters and search exist in URL, prioritize filters and discard search
  const search = filters.length > 0 ? '' : (searchRaw ?? '');

  return { page, perPage, sort, filters, joinOperator, search };
}

export const useDataTableStore = create<DataTableStore>((set, get) => ({
  ...parseUrlParams(),

  actions: {
    setPage: (page) => set({ page }),
    setPerPage: (perPage) => set({ perPage }),
    setSorting: (sort) => set({ sort }),
    setFilters: (filtersOrUpdater) => {
      if (filtersOrUpdater === null) {
        set({ filters: [], page: 1 });
        return;
      }
      if (typeof filtersOrUpdater === 'function') {
        const newFilters = filtersOrUpdater(get().filters);
        set({
          filters: newFilters,
          search: newFilters.length > 0 ? '' : get().search,
          page: 1,
        });
        return;
      }
      set({
        filters: filtersOrUpdater,
        search: filtersOrUpdater.length > 0 ? '' : get().search,
        page: 1,
      });
    },
    setJoinOperator: (joinOperator) => set({ joinOperator }),
    setSearch: (search) => set({ search, filters: [], page: 1 }),
  },
}));
