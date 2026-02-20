import { useCallback } from 'react';

import { type Column } from '@tanstack/react-table';

import { useDataTableStore } from '@/utils/store/data-table-store';

export const useSortingHandlers = <TData>(column: Column<TData, unknown>) => {
  const handleSortAscending = useCallback(() => {
    if (!column.getCanSort()) return;
    useDataTableStore
      .getState()
      .actions.setSorting([{ id: column.id, desc: false }]);
  }, [column]);

  const handleSortDescending = useCallback(() => {
    if (!column.getCanSort()) return;
    useDataTableStore
      .getState()
      .actions.setSorting([{ id: column.id, desc: true }]);
  }, [column]);

  const handleClearSort = useCallback(() => {
    const { sort } = useDataTableStore.getState();
    useDataTableStore
      .getState()
      .actions.setSorting(sort.filter((s) => s.id !== column.id));
  }, [column.id]);

  const isSorted = useCallback(
    () => useDataTableStore.getState().sort.find((s) => s.id === column.id),
    [column.id]
  );

  return {
    handleSortAscending,
    handleSortDescending,
    handleClearSort,
    isSorted,
  };
};
