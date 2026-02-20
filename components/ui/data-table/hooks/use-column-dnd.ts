import type {
  DragEndEvent,
  DragStartEvent,
  UniqueIdentifier,
} from '@dnd-kit/core';
import type { Table } from '@tanstack/react-table';

import { useCallback, useMemo, useState } from 'react';

import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';

import { useColumnOrder, useColumnPinning } from '../store';

function useColumnDnd<TData>(table: Table<TData>) {
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);

  // Get column order for calculating activeIndex
  const columnOrder = useColumnOrder((s) => s.columnOrder);
  const activeIndex = useMemo(
    () => (activeId != null ? columnOrder.indexOf(activeId as string) : -1),
    [activeId, columnOrder]
  );

  // Sensors with 10px distance activation
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: { x: 10 },
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Drag handlers
  const handleDragStart = useCallback(({ active }: DragStartEvent) => {
    setActiveId(active.id);
  }, []);

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
  }, []);

  const handleDragEnd = useCallback(
    ({ over }: DragEndEvent) => {
      if (!over || activeId == null) {
        setActiveId(null);
        return;
      }

      const activeColumnId = activeId as string;
      const overColumnId = over.id as string;

      if (activeColumnId === overColumnId) {
        setActiveId(null);
        return;
      }

      const { columnOrder, setColumnOrder } = useColumnOrder.getState();
      const { columnPinning, setColumnPinning } = useColumnPinning.getState();

      const leftPinned = new Set(columnPinning.left);
      const rightPinned = new Set(columnPinning.right);

      // Determine target zone based on over column
      const isOverLeftPinned = leftPinned.has(overColumnId);
      const isOverRightPinned = rightPinned.has(overColumnId);

      // Update columnOrder using arrayMove
      const activeIndexInOrder = columnOrder.indexOf(activeColumnId);
      const overIndexInOrder = columnOrder.indexOf(overColumnId);
      const newColumnOrder = arrayMove(
        columnOrder,
        activeIndexInOrder,
        overIndexInOrder
      );

      // Build new pinning sets
      const newLeftSet = new Set(leftPinned);
      const newRightSet = new Set(rightPinned);

      // Remove active from its current pinning
      newLeftSet.delete(activeColumnId);
      newRightSet.delete(activeColumnId);

      // Add to new zone if dropping on a pinned column
      if (isOverLeftPinned) {
        newLeftSet.add(activeColumnId);
      } else if (isOverRightPinned) {
        newRightSet.add(activeColumnId);
      }

      // Convert sets back to arrays, maintaining columnOrder order
      const newLeft = newColumnOrder.filter((id) => newLeftSet.has(id));
      const newRight = newColumnOrder.filter((id) => newRightSet.has(id));

      // Update both stores
      setColumnPinning({ left: newLeft, right: newRight });
      setColumnOrder(newColumnOrder);

      setActiveId(null);
    },
    [activeId]
  );

  // Get active header for DragOverlay
  const activeHeader = useMemo(() => {
    if (activeId == null) return null;
    const headerGroups = table.getHeaderGroups();
    for (const group of headerGroups) {
      const header = group.headers.find((h) => h.column.id === activeId);
      if (header) return header;
    }
    return null;
  }, [activeId, table]);

  return {
    activeId,
    activeIndex,
    activeHeader,
    sensors,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
  };
}

export { useColumnDnd };
