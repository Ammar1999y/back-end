import type { SortableRootContextValue } from './constants';

import * as React from 'react';

import {
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from '@dnd-kit/core';

import {
  CONTENT_NAME,
  ITEM_HANDLE_NAME,
  ITEM_NAME,
  OVERLAY_NAME,
  ROOT_NAME,
  SORTABLE_ERRORS,
} from './constants';

// ============================================
// Root Context
// ============================================

export const SortableRootContext =
  React.createContext<SortableRootContextValue<unknown> | null>(null);
SortableRootContext.displayName = ROOT_NAME;

type SortableErrorKey =
  | typeof CONTENT_NAME
  | typeof ITEM_NAME
  | typeof ITEM_HANDLE_NAME
  | typeof OVERLAY_NAME;

export function useSortableContext(name: SortableErrorKey) {
  const context = React.useContext(SortableRootContext);
  if (!context) {
    console.error(SORTABLE_ERRORS[name]);
    throw new Error(SORTABLE_ERRORS[name]);
  }
  return context;
}

// ============================================
// Content Context
// ============================================

export const SortableContentContext = React.createContext<boolean>(false);
SortableContentContext.displayName = CONTENT_NAME;

// ============================================
// Item Context
// ============================================

export interface SortableItemContextValue {
  id: string;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners | undefined;
  setActivatorNodeRef: (node: HTMLElement | null) => void;
  isDragging?: boolean;
  disabled?: boolean;
}

export const SortableItemContext =
  React.createContext<SortableItemContextValue | null>(null);
SortableItemContext.displayName = ITEM_NAME;

export function useSortableItemContext(consumerName: SortableErrorKey) {
  const context = React.useContext(SortableItemContext);
  if (!context) {
    console.error(SORTABLE_ERRORS[consumerName]);
    throw new Error(SORTABLE_ERRORS[consumerName]);
  }
  return context;
}

// ============================================
// Overlay Context
// ============================================

export const SortableOverlayContext = React.createContext(false);
SortableOverlayContext.displayName = OVERLAY_NAME;
