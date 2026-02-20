import type { ContactInfoItem } from '@/types/settings';
import type { SettingsInput } from '@/utils/validation/settings';

import { memo, useCallback, useEffect, useMemo } from 'react';

import { generateUUIDv7 } from '@/utils';
import { DragEndEvent, MeasuringStrategy } from '@dnd-kit/core';
import { defaultAnimateLayoutChanges } from '@dnd-kit/sortable';
import { Plus } from 'lucide-react';
import { useFieldArray } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { useStore } from '@/components/smooth-height-container';
import {
  restrictToVerticalAxis,
  SimpleSortableItem,
  SortableList,
  useSortableList,
  verticalListSortingStrategy,
} from '@/components/sortable';

import { ContactInfoItemContent } from './item';

const measuring = { droppable: { strategy: MeasuringStrategy.Always } };

const modifiers = [restrictToVerticalAxis];

const animateLayoutChanges = (args: any) =>
  defaultAnimateLayoutChanges({ ...args, wasDragging: true });

const DEFAULT_ITEM: Omit<ContactInfoItem, 'id'> = {
  key: '',
  title: '',
  link: '',
  isActive: true,
  order: 0,
};

const ContactInfoSection = memo(() => {
  const { fields, append, remove, move } = useFieldArray<
    SettingsInput,
    'contactInfo',
    '$key'
  >({
    name: 'contactInfo',
    keyName: '$key',
  });

  const itemIds = useMemo(() => fields.map((f) => f.$key), [fields]);
  const {
    sensors,
    activeItem,
    handleDragStart,
    handleDragCancel,
    activeIndex,
  } = useSortableList<(typeof fields)[number]>({
    items: fields,
    onItemsChange: () => {},
    getId: (item) => item.$key,
  });

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      if (over && active.id !== over.id) {
        const oldIndex = fields.findIndex((item) => item.$key === active.id);
        const newIndex = fields.findIndex((item) => item.$key === over.id);
        move(oldIndex, newIndex);
      }
    },
    [fields, move]
  );

  const handleAddItem = useCallback(() => {
    append({ ...DEFAULT_ITEM, id: generateUUIDv7(), order: fields.length });
  }, [append, fields.length]);

  const handleRemoveItem = useCallback(
    (index: number) => {
      remove(index);
    },
    [remove]
  );

  useEffect(() => {
    const disableTimeout = setTimeout(() => {
      useStore.getState().setDisabled(true);
    }, 300);
    return () => {
      clearTimeout(disableTimeout);
      useStore.getState().setDisabled(false);
    };
  }, []);

  return (
    <div className='relative space-y-4'>
      <div className='flex items-center justify-between'>
        <Button onClick={handleAddItem}>
          <Plus className='h-4 w-4' />
          <span>إضافة بيانات تواصل</span>
        </Button>
      </div>

      {fields.length === 0 ? (
        <div className='rounded-lg border-2 border-dashed p-12 text-center'>
          <p>لا توجد بيانات تواصل بعد</p>
          <p className='mt-1 text-sm text-muted-foreground'>
            اضغط على &quot;إضافة بيانات تواصل&quot; للبدء
          </p>
        </div>
      ) : (
        <SortableList
          items={itemIds}
          sensors={sensors}
          modifiers={modifiers}
          measuring={measuring}
          strategy={verticalListSortingStrategy}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
          overlay={
            activeItem ? (
              <ContactInfoItemContent showDragHandle index={activeIndex} />
            ) : null
          }
        >
          <div className='pb-6 space-y-5'>
            {fields.map((field, index) => (
              <SimpleSortableItem
                key={field.$key}
                id={field.$key}
                useHandle
                className='rounded-md'
                animateLayoutChanges={animateLayoutChanges}
              >
                <ContactInfoItemContent
                  showDragHandle
                  index={index}
                  onRemove={handleRemoveItem}
                />
              </SimpleSortableItem>
            ))}
          </div>
        </SortableList>
      )}
    </div>
  );
});

ContactInfoSection.displayName = 'ContactInfoSection';

export { ContactInfoSection };
