import { useCallback, useMemo } from 'react';

import { type Column } from '@tanstack/react-table';
import { useShallow } from 'zustand/shallow';

import { useColumnOrder, useColumnPinning } from '../../../store';

export const usePinningHandlers = (column: Column<any, any>) => {
  const isLeftPinning = useColumnPinning(
    useShallow((s) => s.columnPinning.left?.includes(column.id))
  );
  const isRightPinning = useColumnPinning(
    useShallow((s) => s.columnPinning.right?.includes(column.id))
  );

  const isPinned = useMemo(
    () => (isLeftPinning ? 'left' : isRightPinning ? 'right' : false),
    [isLeftPinning, isRightPinning]
  );

  // Helper to sync columnOrder after pinning changes
  const syncColumnOrder = useCallback(
    (newPinning: { left?: string[]; right?: string[] }) => {
      const { columnOrder, setColumnOrder } = useColumnOrder.getState();
      const pinnedIds = new Set([
        ...(newPinning.left ?? []),
        ...(newPinning.right ?? []),
      ]);
      // Preserve unpinned columns order
      const unpinned = columnOrder.filter((id) => !pinnedIds.has(id));
      // New order: left pinned + unpinned + right pinned
      const newColumnOrder = [
        ...(newPinning.left ?? []),
        ...unpinned,
        ...(newPinning.right ?? []),
      ];
      setColumnOrder(newColumnOrder);
    },
    []
  );

  const handlePinLeft = useCallback(() => {
    if (!column.getCanPin()) return;

    const { columnPinning, setColumnPinning } = useColumnPinning.getState();
    const newPinning = { ...columnPinning };
    // Remove from right if exists
    if (newPinning.right?.includes(column.id)) {
      newPinning.right = newPinning.right.filter((id) => id !== column.id);
    }
    // Add to left (push at end)
    if (!newPinning.left?.includes(column.id)) {
      newPinning.left = [...(newPinning.left ?? []), column.id];
    }
    setColumnPinning(newPinning);
    syncColumnOrder(newPinning);
  }, [column, syncColumnOrder]);

  const handlePinRight = useCallback(() => {
    if (!column.getCanPin()) return;

    const { columnPinning, setColumnPinning } = useColumnPinning.getState();
    const newPinning = { ...columnPinning };
    // Remove from left if exists
    if (newPinning.left?.includes(column.id)) {
      newPinning.left = newPinning.left.filter((id) => id !== column.id);
    }
    // Add to right (push at end)
    if (!newPinning.right?.includes(column.id)) {
      newPinning.right = [...(newPinning.right ?? []), column.id];
    }
    setColumnPinning(newPinning);
    syncColumnOrder(newPinning);
  }, [column, syncColumnOrder]);

  const handleUnpin = useCallback(() => {
    if (!column.getCanPin()) return;

    const { columnPinning, setColumnPinning } = useColumnPinning.getState();
    const newPinning = { ...columnPinning };
    if (newPinning.left?.includes(column.id)) {
      newPinning.left = newPinning.left.filter((id) => id !== column.id);
    }
    if (newPinning.right?.includes(column.id)) {
      newPinning.right = newPinning.right.filter((id) => id !== column.id);
    }
    setColumnPinning(newPinning);
    syncColumnOrder(newPinning);
  }, [column, syncColumnOrder]);

  return {
    isPinned,
    handlePinLeft,
    handlePinRight,
    handleUnpin,
  };
};
