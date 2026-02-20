'use client';

import type { SortableItemContextValue } from './sortable-context';

import * as React from 'react';

import { type UniqueIdentifier } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';

import { useComposedRefs } from '@/components/ui/sortable/compose-refs';

import {
  getConditionalProps,
  ITEM_HANDLE_NAME,
  ITEM_NAME,
  SORTABLE_ERRORS,
} from './constants';
import {
  SortableContentContext,
  SortableItemContext,
  SortableOverlayContext,
  useSortableContext,
  useSortableItemContext,
} from './sortable-context';

// ============================================
// SortableItem
// ============================================

interface SortableItemProps extends React.ComponentProps<'div'> {
  value: UniqueIdentifier;
  asHandle?: boolean;
  asChild?: boolean;
  disabled?: boolean;
}

function SortableItem(props: SortableItemProps) {
  const {
    value,
    style,
    asHandle,
    asChild,
    disabled,
    className,
    ref,
    ...itemProps
  } = props;

  const inSortableContent = React.useContext(SortableContentContext);
  const inSortableOverlay = React.useContext(SortableOverlayContext);

  if (!inSortableContent && !inSortableOverlay) {
    console.error(SORTABLE_ERRORS[ITEM_NAME]);
    throw new Error(SORTABLE_ERRORS[ITEM_NAME]);
  }

  if (value === '') {
    console.error(SORTABLE_ERRORS.emptyValue);
    throw new Error(SORTABLE_ERRORS.emptyValue);
  }

  const context = useSortableContext(ITEM_NAME);
  const id = React.useId();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: value, disabled });

  const composedRef = useComposedRefs(ref, (node) => {
    if (disabled) return;
    setNodeRef(node);
    if (asHandle) setActivatorNodeRef(node);
  });

  const composedStyle = React.useMemo<React.CSSProperties>(
    () => ({
      transform: CSS.Translate.toString(transform),
      transition,
      ...style,
    }),
    [transform, transition, style]
  );

  const itemContext = React.useMemo<SortableItemContextValue>(
    () => ({
      id,
      attributes,
      listeners,
      setActivatorNodeRef,
      isDragging,
      disabled,
    }),
    [id, attributes, listeners, setActivatorNodeRef, isDragging, disabled]
  );

  const isHandle = asHandle === true && !disabled;
  const conditionalProps = getConditionalProps(isHandle, attributes, listeners);

  const ItemPrimitive = React.useMemo(
    () => (asChild ? Slot : 'div'),
    [asChild]
  );

  return (
    <SortableItemContext.Provider value={itemContext}>
      <ItemPrimitive
        id={id}
        data-disabled={disabled}
        data-dragging={isDragging ? '' : undefined}
        data-slot='sortable-item'
        {...itemProps}
        {...conditionalProps.attributes}
        {...conditionalProps.listeners}
        ref={composedRef}
        style={composedStyle}
        className={cn(
          'focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1',
          {
            'touch-none select-none': asHandle,
            'cursor-default': context.flatCursor,
            'data-dragging:cursor-grabbing': !context.flatCursor,
            'cursor-grab': !isDragging && asHandle && !context.flatCursor,
            'opacity-50': isDragging,
            'pointer-events-none opacity-50': disabled,
          },
          className
        )}
      />
    </SortableItemContext.Provider>
  );
}

// ============================================
// SortableItemHandle
// ============================================

interface SortableItemHandleProps extends React.ComponentProps<'button'> {
  asChild?: boolean;
}

function SortableItemHandle(props: SortableItemHandleProps) {
  const { asChild, disabled, className, ref, ...itemHandleProps } = props;

  const context = useSortableContext(ITEM_HANDLE_NAME);
  const itemContext = useSortableItemContext(ITEM_HANDLE_NAME);

  const isDisabled = disabled ?? itemContext.disabled;

  const composedRef = useComposedRefs(ref, (node) => {
    if (isDisabled) return;
    itemContext.setActivatorNodeRef(node);
  });

  const conditionalProps = getConditionalProps(
    !isDisabled,
    itemContext.attributes,
    itemContext.listeners
  );

  const HandlePrimitive = React.useMemo(
    () => (asChild ? Slot : 'button'),
    [asChild]
  );

  return (
    <HandlePrimitive
      type='button'
      aria-controls={itemContext.id}
      data-disabled={isDisabled}
      data-dragging={itemContext.isDragging ? '' : undefined}
      data-slot='sortable-item-handle'
      {...itemHandleProps}
      {...conditionalProps.attributes}
      {...conditionalProps.listeners}
      ref={composedRef}
      className={cn(
        'select-none disabled:pointer-events-none disabled:opacity-50',
        context.flatCursor
          ? 'cursor-default'
          : 'data-dragging:cursor-grabbing cursor-grab',
        className
      )}
      disabled={isDisabled}
    />
  );
}

export { SortableItem, SortableItemHandle };
export type { SortableItemProps, SortableItemHandleProps };
