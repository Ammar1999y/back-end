'use client';

import React from 'react';

import {
  closestCenter,
  defaultDropAnimationSideEffects,
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  DropAnimation,
  MeasuringConfiguration,
  Modifiers,
  UniqueIdentifier,
} from '@dnd-kit/core';
import {
  rectSortingStrategy,
  SortableContext,
  SortingStrategy,
} from '@dnd-kit/sortable';
import { createPortal } from 'react-dom';

const dropAnimationConfig: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: {
      active: {
        opacity: '0.5',
      },
    },
  }),
};

export interface SortableListProps {
  /** DndContext sensors */
  sensors: ReturnType<typeof import('@dnd-kit/core').useSensors>;
  /** Items array for SortableContext */
  items: UniqueIdentifier[];
  /** Sorting strategy */
  strategy?: SortingStrategy;
  /** Modifiers for drag behavior */
  modifiers?: Modifiers;
  /** Measuring configuration */
  measuring?: MeasuringConfiguration;
  /** Handler for drag start */
  onDragStart: (event: DragStartEvent) => void;
  /** Handler for drag end */
  onDragEnd: (event: DragEndEvent) => void;
  /** Handler for drag cancel */
  onDragCancel: () => void;
  /** Whether to use drag overlay */
  useDragOverlay?: boolean;
  /** Content for the drag overlay */
  overlay?: React.ReactNode;
  /** Children elements */
  children: React.ReactNode;
}

export function SortableList({
  sensors,
  items,
  strategy = rectSortingStrategy,
  modifiers,
  measuring,
  onDragStart,
  onDragEnd,
  onDragCancel,
  useDragOverlay = typeof document !== 'undefined',
  overlay,
  children,
}: SortableListProps) {
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
      measuring={measuring}
      modifiers={modifiers}
    >
      <SortableContext items={items} strategy={strategy}>
        {children}
      </SortableContext>
      {useDragOverlay
        ? createPortal(
            <DragOverlay dropAnimation={dropAnimationConfig}>
              {overlay}
            </DragOverlay>,
            document.body
          )
        : null}
    </DndContext>
  );
}
