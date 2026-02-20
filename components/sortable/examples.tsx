'use client';

import { useMemo, useState } from 'react';

import {
  AnimateLayoutChanges,
  defaultAnimateLayoutChanges,
} from '@dnd-kit/sortable';

import {
  MeasuringStrategy,
  restrictToFirstScrollableAncestor,
  restrictToVerticalAxis,
  restrictToWindowEdges,
  SimpleSortableItem,
  SortableHandle,
  SortableList,
  useSortableList,
  verticalListSortingStrategy,
} from './index';

interface User {
  id: string;
  name: string;
  email: string;
}

const initialUsers: User[] = [
  { id: '1', name: 'أحمد', email: 'ahmed@example.com' },
  { id: '2', name: 'سارة', email: 'sara@example.com' },
  { id: '3', name: 'محمد', email: 'mohammed@example.com' },
  { id: '4', name: 'أحمد', email: 'ahmed@example.com' },
  { id: '5', name: 'سارة', email: 'sara@example.com' },
  { id: '6', name: 'محمد', email: 'mohammed@example.com' },
  { id: '7', name: 'أحمد', email: 'ahmed@example.com' },
  { id: '8', name: 'سارة', email: 'sara@example.com' },
  { id: '9', name: 'محمد', email: 'mohammed@example.com' },
  { id: '10', name: 'أحمد', email: 'ahmed@example.com' },
  { id: '11', name: 'سارة', email: 'sara@example.com' },
  { id: '12', name: 'محمد', email: 'mohammed@example.com' },
];

const measuring = { droppable: { strategy: MeasuringStrategy.Always } };
export function ComplexObjectExample() {
  const [users, setUsers] = useState<User[]>(initialUsers);

  const {
    activeItem,
    sensors,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
    removeItem,
    getId,
  } = useSortableList<User>({
    items: users,
    onItemsChange: setUsers,
    getId: (user) => user.id,
  });
  const modifiers = useMemo(
    () => [
      restrictToVerticalAxis,
      restrictToWindowEdges,
      restrictToFirstScrollableAncestor,
    ],
    []
  );
  const animateLayoutChanges = useMemo<AnimateLayoutChanges>(
    () => (args) => defaultAnimateLayoutChanges({ ...args, wasDragging: true }),
    []
  );

  const itemsIds = useMemo(() => users.map((u) => u.id), [users]);
  return (
    <SortableList
      items={itemsIds}
      sensors={sensors}
      modifiers={modifiers}
      measuring={measuring}
      strategy={verticalListSortingStrategy}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      overlay={
        activeItem ? (
          <UserCard
            onRemove={() => void 0}
            user={activeItem}
            dragging={true}
            dragOverlay
          />
        ) : null
      }
    >
      <div
        style={{
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}
      >
        {users.map((user) => (
          <SimpleSortableItem
            useHandle
            animateLayoutChanges={animateLayoutChanges}
            key={getId(user)}
            id={getId(user)}
          >
            <UserCard user={user} onRemove={() => removeItem(getId(user))} />
          </SimpleSortableItem>
        ))}
      </div>
    </SortableList>
  );
}

function UserCard({
  user,
  dragOverlay,
  onRemove,
}: {
  user: User;
  dragging?: boolean;
  dragOverlay?: boolean;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        padding: '16px',
        backgroundColor: '#f5f5f5',
        border: '1px solid #ddd',
        borderRadius: '4px',
        display: 'flex',
        alignItems: 'center',
        fontSize: '16px',
        cursor: dragOverlay ? 'grabbing' : undefined,
      }}
    >
      <SortableHandle
        style={{
          marginInlineEnd: '12px',
          padding: '4px 8px',
          backgroundColor: '#ddd',
          borderRadius: '4px',
          border: 'none',
          cursor: dragOverlay ? 'grabbing' : 'grab',
        }}
      >
        ☰
      </SortableHandle>
      <div className='flex-1'>
        <p>{user.name}</p>
        <p style={{ color: '#666', fontSize: '14px' }}>{user.email}</p>
      </div>
      <button
        onClick={onRemove}
        style={{
          padding: '4px 8px',
          backgroundColor: '#ff4444',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
        }}
      >
        ×
      </button>
    </div>
  );
}
