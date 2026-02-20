import { useCallback, useState } from 'react';

import {
  DragEndEvent,
  DragStartEvent,
  KeyboardSensor,
  PointerActivationConstraint,
  PointerSensor,
  UniqueIdentifier,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';

export interface UseSortableListOptions<T> {
  /** Items array (controlled) */
  items: T[];
  /** Callback when items change (reorder or remove) */
  onItemsChange: (items: T[]) => void;
  /** Activation constraint for pointer sensors */
  activationConstraint?: PointerActivationConstraint;
  /** Function to get unique ID from item (for complex objects) */
  getId?: (item: T) => UniqueIdentifier;
}

export interface UseSortableListReturn<T> {
  /** Currently active/dragging item ID */
  activeId: UniqueIdentifier | null;
  /** Index of active item */
  activeIndex: number;
  /** The active item itself */
  activeItem: T | null;
  /** Sensors for DndContext */
  sensors: ReturnType<typeof useSensors>;
  /** Get index of item by ID */
  getIndex: (id: UniqueIdentifier) => number;
  /** Remove item by ID */
  removeItem: (id: UniqueIdentifier) => void;
  /** Handler for onDragStart */
  handleDragStart: (event: DragStartEvent) => void;
  /** Handler for onDragEnd */
  handleDragEnd: (event: DragEndEvent) => void;
  /** Handler for onDragCancel */
  handleDragCancel: () => void;
  /** Get ID from item */
  getId: (item: T) => UniqueIdentifier;
}

export function useSortableList<T = UniqueIdentifier>({
  items,
  onItemsChange,
  activationConstraint,
  getId: getIdProp,
}: UseSortableListOptions<T>): UseSortableListReturn<T> {
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);

  // Default getId for simple UniqueIdentifier arrays
  const getId = useCallback(
    (item: T): UniqueIdentifier => {
      if (getIdProp) return getIdProp(item);
      return item as UniqueIdentifier;
    },
    [getIdProp]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint }),
    useSensor(KeyboardSensor, {
      scrollBehavior: 'smooth',
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const getIndex = useCallback(
    (id: UniqueIdentifier) => items.findIndex((item) => getId(item) === id),
    [items, getId]
  );

  const activeIndex = activeId != null ? getIndex(activeId) : -1;
  const activeItem = activeIndex !== -1 ? items[activeIndex] : null;

  const handleDragStart = useCallback((event: DragStartEvent) => {
    if (!event.active) return;
    setActiveId(event.active.id);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { over } = event;
      setActiveId(null);

      if (over && activeIndex !== -1) {
        const overIndex = getIndex(over.id);
        if (activeIndex !== overIndex) {
          const newItems = arrayMove(items, activeIndex, overIndex);
          onItemsChange(newItems);
        }
      }
    },
    [activeIndex, getIndex, items, onItemsChange]
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
  }, []);

  const removeItem = useCallback(
    (id: UniqueIdentifier) => {
      const newItems = items.filter((item) => getId(item) !== id);
      onItemsChange(newItems);
    },
    [items, getId, onItemsChange]
  );

  return {
    activeId,
    activeIndex,
    activeItem,
    sensors,
    getIndex,
    removeItem,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
    getId,
  };
}
