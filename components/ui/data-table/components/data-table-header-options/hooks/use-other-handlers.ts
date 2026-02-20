import { useCallback } from 'react';

import { type Column } from '@tanstack/react-table';

import { useColumnVisibility } from '../../../store';

export const useOtherHandlers = (column: Column<any, any>) => {
  const handleHideColumn = useCallback(() => {
    if (!column.getCanHide()) return;
    const { columnVisibility, setColumnVisibility } =
      useColumnVisibility.getState();
    setColumnVisibility({
      ...columnVisibility,
      [column.id]: false,
    });
  }, [column]);

  const handleResetSize = useCallback(() => {
    if (!column.getCanResize()) return;
    column.resetSize();
  }, [column]);

  return {
    handleHideColumn,
    handleResetSize,
  };
};
