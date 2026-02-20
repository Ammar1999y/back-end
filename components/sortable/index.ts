// Hook
export { useSortableList } from './use-sortable-list';
export type {
  UseSortableListOptions,
  UseSortableListReturn,
} from './use-sortable-list';

// Components
export { SortableList } from './sortable-list';
export type { SortableListProps } from './sortable-list';

export { SimpleSortableItem, SortableHandle } from './sortable-item';
export type {
  SimpleSortableItemProps,
  SortableHandleProps,
} from './sortable-item';

// Re-export commonly used dnd-kit utilities
export { arrayMove } from '@dnd-kit/sortable';
export {
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
  rectSortingStrategy,
  rectSwappingStrategy,
} from '@dnd-kit/sortable';
export {
  restrictToVerticalAxis,
  restrictToHorizontalAxis,
  restrictToWindowEdges,
  restrictToParentElement,
  restrictToFirstScrollableAncestor,
} from '@dnd-kit/modifiers';
export { MeasuringStrategy } from '@dnd-kit/core';
export type { UniqueIdentifier } from '@dnd-kit/core';
