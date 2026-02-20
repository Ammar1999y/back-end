import type { ExtendedColumnSort } from '@/types/data-table';

import { memo, useEffect, useMemo, useRef } from 'react';

import { useShallow } from 'zustand/shallow';

import { URL_KEYS, useDataTableStore } from '@/utils/store/data-table-store';

function isSortEqual(
  a: ExtendedColumnSort<any>[],
  b: ExtendedColumnSort<any>[]
): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, i) => item.id === b[i]!.id && item.desc === b[i]!.desc);
}

interface UrlSyncProps {
  defaultSort?: ExtendedColumnSort<any>[];
}

const DEBOUNCE_MS = 300;
const UrlSync = memo(({ defaultSort }: UrlSyncProps) => {
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

  const stableDefaultSort = useMemo(() => defaultSort ?? [], [defaultSort]);

  const isFirstRender = useRef(true);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    // Skip URL update on first render (state was initialized from URL)
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      const params = new URLSearchParams();

      if (page !== 1) params.set(URL_KEYS.page, String(page));
      if (perPage !== 10) params.set(URL_KEYS.perPage, String(perPage));

      const isDefaultSort =
        stableDefaultSort.length > 0 && isSortEqual(sort, stableDefaultSort);
      if (sort.length > 0 && !isDefaultSort)
        params.set(URL_KEYS.sort, JSON.stringify(sort));

      if (filters.length > 0)
        params.set(URL_KEYS.filters, JSON.stringify(filters));
      if (joinOperator !== 'and')
        params.set(URL_KEYS.joinOperator, joinOperator);
      if (search) params.set(URL_KEYS.search, search);

      const searchStr = params.toString();
      const newUrl = searchStr
        ? `${window.location.pathname}?${searchStr}`
        : window.location.pathname;

      history.replaceState(null, '', newUrl);
    }, DEBOUNCE_MS);

    return () => clearTimeout(timeoutRef.current);
  }, [page, perPage, sort, filters, joinOperator, search, stableDefaultSort]);

  return null;
});
UrlSync.displayName = 'UrlSync';

export { UrlSync };
