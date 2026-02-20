'use client';

import React, { useMemo } from 'react';

import { UniqueIdentifier } from '@dnd-kit/core';
import { AnimateLayoutChanges, useSortable } from '@dnd-kit/sortable';
import { cn } from '@/lib/utils';

// ============================================
// Alternative: Simple wrapper with slot pattern
// ============================================

export interface SimpleSortableItemProps {
  /** Unique identifier for the item */
  id: UniqueIdentifier;
  /** Whether item is disabled */
  disabled?: boolean;
  /** Custom animate layout changes function */
  animateLayoutChanges?: AnimateLayoutChanges;
  /** Whether to use a separate drag handle */
  useHandle?: boolean;
  /** Children elements */
  children: React.ReactNode;
  /** Additional className */
  className?: string;
  /** Additional style */
  style?: React.CSSProperties;
  /** As which element to render */
  as?: React.ElementType;
}

export function SimpleSortableItem({
  id,
  disabled = false,
  animateLayoutChanges,
  useHandle = false,
  children,
  className,
  style,
  as: Component = 'div',
}: SimpleSortableItemProps) {
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
  } = useSortable({
    id,
    animateLayoutChanges,
    disabled,
  });

  const combinedStyle: React.CSSProperties = useMemo(
    () => ({
      transform: transform
        ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
        : undefined,
      transition,
      opacity: isDragging ? 0.5 : 1,
      cursor: disabled ? 'not-allowed' : useHandle ? 'default' : 'grab',
      ...style,
    }),
    [isDragging, transform, transition, disabled, useHandle, style]
  );

  return (
    <Component
      ref={setNodeRef}
      {...(!useHandle ? listeners : {})}
      {...attributes}
      className={cn('noSelect', className)}
      style={combinedStyle}
    >
      {useHandle ? (
        <SortableHandleContext.Provider
          value={{ ref: setActivatorNodeRef, listeners }}
        >
          {children}
        </SortableHandleContext.Provider>
      ) : (
        children
      )}
    </Component>
  );
}

// ============================================
// Handle context for SimpleSortableItem
// ============================================

interface SortableHandleContextValue {
  ref: (node: HTMLElement | null) => void;
  listeners: ReturnType<typeof useSortable>['listeners'];
}

const SortableHandleContext =
  React.createContext<SortableHandleContextValue | null>(null);

export interface SortableHandleProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  as?: React.ElementType;
  /** Additional props to pass to the component */
  [key: string]: unknown;
}

export function SortableHandle({
  children,
  className,
  style,
  as: Component = 'button',
  ...rest
}: SortableHandleProps) {
  const context = React.useContext(SortableHandleContext);

  return (
    <Component
      ref={context?.ref}
      {...context?.listeners}
      {...rest}
      className={className}
      style={{ cursor: 'grab', ...style }}
    >
      {children}
    </Component>
  );
}
