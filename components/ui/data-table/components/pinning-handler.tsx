import type { Column } from '@tanstack/react-table';

import { memo, useEffect, useRef } from 'react';

import { useShallow } from 'zustand/shallow';

import { useColumnPinning, useColumnSizing } from '../store';

interface PinningHandlerProps<TData = any> {
  cellRef: React.RefObject<HTMLDivElement | null>;
  column: Column<TData>;
}

interface PinningState {
  isPinned: 'left' | 'right' | false;
  position?: number;
  isLastPinned?: boolean;
  isFirstPinned?: boolean;
}

const PinningHandler = memo(({ cellRef, column }: PinningHandlerProps) => {
  const columnPinning = useColumnPinning(useShallow((s) => s.columnPinning));
  const previousStateRef = useRef<PinningState>({ isPinned: false });
  const columnSizing = useColumnSizing(useShallow((s) => s.columnSizing));

  useEffect(() => {
    if (!cellRef.current) return;

    const isPinned = column.getIsPinned();
    const currentState: PinningState = {
      isPinned,
      position: isPinned
        ? isPinned === 'left'
          ? column.getStart('left')
          : column.getAfter('right')
        : undefined,
      isLastPinned: isPinned === 'left' && column.getIsLastColumn('left'),
      isFirstPinned: isPinned === 'right' && column.getIsFirstColumn('right'),
    };

    const element = cellRef.current;
    const prevState = previousStateRef.current;

    // Handle pinning state change
    if (currentState.isPinned !== prevState.isPinned) {
      if (currentState.isPinned) element.dataset.pinned = currentState.isPinned;
      else {
        // Element is now unpinned - clean everything
        delete element.dataset.pinned;
        delete element.dataset.isLastPinned;
        delete element.dataset.isFirstPinned;
        element.style.removeProperty('--pinned-position');
      }
    }

    // Update position if pinned and position changed
    if (currentState.isPinned && currentState.position !== prevState.position)
      element.style.setProperty(
        '--pinned-position',
        `${currentState.position}px`
      );

    // Update edge indicators
    if (currentState.isLastPinned !== prevState.isLastPinned) {
      if (currentState.isLastPinned) element.dataset.isLastPinned = 'true';
      else delete element.dataset.isLastPinned;
    }

    if (currentState.isFirstPinned !== prevState.isFirstPinned) {
      if (currentState.isFirstPinned) element.dataset.isFirstPinned = 'true';
      else delete element.dataset.isFirstPinned;
    }

    previousStateRef.current = currentState;
  }, [columnPinning, column, cellRef, columnSizing]);

  return null;
});

PinningHandler.displayName = 'PinningHandler';

export { PinningHandler };
