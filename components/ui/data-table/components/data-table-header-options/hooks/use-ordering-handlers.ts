import { useCallback, useMemo } from 'react';

import { type Column } from '@tanstack/react-table';

import { useColumnOrder, useColumnPinning } from '../../../store';
import { type ColumnPosition, type OrderContext } from '../types';

export const useOrderingHandlers = (column: Column<any, any>) => {
  // Helper to get the relevant order array based on pin state
  const getOrderContext = useCallback((): OrderContext => {
    const { columnPinning, setColumnPinning } = useColumnPinning.getState();
    const { columnOrder, setColumnOrder } = useColumnOrder.getState();

    const pinnedIds = new Set([
      ...(columnPinning.left ?? []),
      ...(columnPinning.right ?? []),
    ]);
    const unpinnedOrder = columnOrder.filter((id) => !pinnedIds.has(id));

    // Helper to rebuild and sync columnOrder
    const rebuildColumnOrder = (
      left: string[],
      right: string[],
      unpinned: string[]
    ) => {
      setColumnOrder([...left, ...unpinned, ...right]);
    };

    // Pinned left: work with left array
    if (columnPinning.left?.includes(column.id)) {
      return {
        order: columnPinning.left,
        setOrder: (newLeftOrder: string[]) => {
          const newPinning = { ...columnPinning, left: newLeftOrder };
          setColumnPinning(newPinning);
          rebuildColumnOrder(
            newLeftOrder,
            columnPinning.right ?? [],
            unpinnedOrder
          );
        },
      };
    }

    // Pinned right: work with right array
    if (columnPinning.right?.includes(column.id)) {
      return {
        order: columnPinning.right,
        setOrder: (newRightOrder: string[]) => {
          const newPinning = { ...columnPinning, right: newRightOrder };
          setColumnPinning(newPinning);
          rebuildColumnOrder(
            columnPinning.left ?? [],
            newRightOrder,
            unpinnedOrder
          );
        },
      };
    }

    // Unpinned: work with unpinned portion
    return {
      order: unpinnedOrder,
      setOrder: (newUnpinnedOrder: string[]) => {
        rebuildColumnOrder(
          columnPinning.left ?? [],
          columnPinning.right ?? [],
          newUnpinnedOrder
        );
      },
    };
  }, [column.id]);

  const handleMoveRight = useCallback(() => {
    const { order, setOrder } = getOrderContext();
    const currentIndex = order.indexOf(column.id);
    if (currentIndex <= 0) return;
    const newOrder = [...order];
    [newOrder[currentIndex - 1], newOrder[currentIndex]] = [
      newOrder[currentIndex],
      newOrder[currentIndex - 1],
    ];
    setOrder(newOrder);
  }, [column.id, getOrderContext]);

  const handleMoveToFarRight = useCallback(() => {
    const { order, setOrder } = getOrderContext();
    const currentIndex = order.indexOf(column.id);
    if (currentIndex <= 0) return;
    const newOrder = order.filter((id) => id !== column.id);
    newOrder.unshift(column.id);
    setOrder(newOrder);
  }, [column.id, getOrderContext]);

  const handleMoveLeft = useCallback(() => {
    const { order, setOrder } = getOrderContext();
    const currentIndex = order.indexOf(column.id);
    if (currentIndex >= order.length - 1) return;
    const newOrder = [...order];
    [newOrder[currentIndex], newOrder[currentIndex + 1]] = [
      newOrder[currentIndex + 1],
      newOrder[currentIndex],
    ];
    setOrder(newOrder);
  }, [column.id, getOrderContext]);

  const handleMoveToFarLeft = useCallback(() => {
    const { order, setOrder } = getOrderContext();
    const currentIndex = order.indexOf(column.id);
    if (currentIndex >= order.length - 1) return;
    const newOrder = order.filter((id) => id !== column.id);
    newOrder.push(column.id);
    setOrder(newOrder);
  }, [column.id, getOrderContext]);

  const columnPosition: ColumnPosition = useMemo(() => {
    const { columnPinning } = useColumnPinning.getState();
    const { columnOrder } = useColumnOrder.getState();

    let order: string[];
    if (columnPinning.left?.includes(column.id)) {
      order = columnPinning.left;
    } else if (columnPinning.right?.includes(column.id)) {
      order = columnPinning.right;
    } else {
      // Filter out pinned columns for unpinned position calculation
      const pinnedIds = new Set([
        ...(columnPinning.left ?? []),
        ...(columnPinning.right ?? []),
      ]);
      order = columnOrder.filter((id) => !pinnedIds.has(id));
    }

    const currentIndex = order.indexOf(column.id);
    return {
      isFirst: currentIndex === 0,
      isLast: currentIndex === order.length - 1,
    };
  }, [column.id]);

  return {
    handleMoveRight,
    handleMoveToFarRight,
    handleMoveLeft,
    handleMoveToFarLeft,
    columnPosition,
  };
};
