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

interface DataTableIdentity {
  /** Which table the current state belongs to (`null` before the first mount). */
  tableKey: string | null;
}

interface DataTableActions {
  /**
   * Bind the store to one table and (re)load its state from the URL.
   *
   * The store is a module singleton, so it is created once per page LOAD, not
   * once per table. Client-side navigation from one table page to another kept
   * the previous table's filters, page and search: a users-only `email` filter
   * was then sent to the permissions endpoint (422 with the new strict column
   * specs), and a shared id like `isActive`/`createdAt` silently filtered the
   * next table instead. Called on mount with the table's identity; a different
   * identity resets to that URL's state.
   */
  initTable: (tableKey: string) => void;
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

export interface DataTableStore extends DataTableState, DataTableIdentity {
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

/**
 * This table page's own URL state. Exported so a consumer can use it on the
 * first render after a client-side navigation, while the singleton still holds
 * the previous table's state — without that, the first request of the new table
 * carries the old table's filters.
 */
export function readUrlDataTableState(): DataTableState {
  return parseUrlParams();
}

export const useDataTableStore = create<DataTableStore>((set, get) => ({
  ...parseUrlParams(),
  tableKey: null,

  actions: {
    initTable: (tableKey) => {
      if (get().tableKey === tableKey) return;
      set({ ...parseUrlParams(), tableKey });
    },
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
