import type {
  CreateProjectInput,
  UpdateProjectInput,
} from '@/utils/validation/projects';

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { EntityID } from '@/types';
import { validID } from '@/utils';
import {
  CheckIcon as _CheckIcon,
  ChevronDownIcon as _ChevronDownIcon,
  PlusIcon as _PlusIcon,
} from 'lucide-react';
import { useController } from 'react-hook-form';
import { cn } from '@/lib/utils';

import { useQueryData } from '@/utils/query';

import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import Label from '@/components/ui/label';
import { Link } from '@/components/ui/link';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { CATEGORIES_QUERY_KEYS } from '@/components/categories/query-keys';

// Memoized icons
const CheckIcon = memo(_CheckIcon);
CheckIcon.displayName = 'CheckIcon';

const ChevronDownIcon = memo(_ChevronDownIcon);
ChevronDownIcon.displayName = 'ChevronDownIcon';

const PlusIcon = memo(_PlusIcon);
PlusIcon.displayName = 'PlusIcon';

interface CategoryOption {
  id: EntityID;
  title: string;
}

const CategoryCombobox = memo(() => {
  const id = useId();
  const { field } = useController<
    CreateProjectInput | UpdateProjectInput,
    'categoryId'
  >({
    name: 'categoryId',
  });

  const [open, setOpen] = useState(false);
  const [selectedValue, setSelectedValue] = useState<EntityID | null>(
    validID(field.value) || null
  );

  useEffect(() => {
    setSelectedValue(validID(field.value) || null);
  }, [field.value]);

  const handleSelect = useCallback(
    (categoryId: EntityID) => {
      const newValue = categoryId === selectedValue ? null : categoryId;
      setSelectedValue(newValue);
      field.onChange(newValue);
      setOpen(false);
    },
    [selectedValue, field]
  );

  return (
    <>
      <Label htmlFor={id} title='القسم' />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant='outline'
            role='combobox'
            aria-expanded={open}
            disabled={field.disabled}
            onBlur={field.onBlur}
            className='relative h-input w-full justify-between bg-input px-4 py-3 shadow-none hover:shadow-md dark:bg-input/30 dark:hover:bg-input/50'
          >
            <CategoryLabel selectedValue={selectedValue} />
            <ChevronDownIcon
              className='absolute left-3 top-1/2 size-4 shrink-0 -translate-y-1/2 text-muted-foreground/80'
              aria-hidden='true'
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent className='w-[--radix-popper-anchor-width] p-0'>
          <Content
            selectedValue={selectedValue}
            onSelect={handleSelect}
            isOpen={open}
          />
        </PopoverContent>
      </Popover>
    </>
  );
});

CategoryCombobox.displayName = 'CategoryCombobox';

interface CategoryLabelProps {
  selectedValue: EntityID | null;
}

const CategoryLabel = memo(({ selectedValue }: CategoryLabelProps) => {
  const { data: categories } = useQueryData<CategoryOption[]>({
    queryKey: CATEGORIES_QUERY_KEYS.list,
    href: '/api/dash/projects/categories',
  });

  const selectedCategory = useMemo(
    () => categories?.find((category) => category.id === selectedValue),
    [categories, selectedValue]
  );

  if (!selectedValue) {
    return <span className='text-muted-foreground'>اختر القسم</span>;
  }

  return (
    <span className='truncate'>{selectedCategory?.title || 'اختر القسم'}</span>
  );
});

CategoryLabel.displayName = 'CategoryLabel';

interface ContentProps {
  selectedValue: EntityID | null;
  onSelect: (value: EntityID) => void;
  isOpen: boolean;
}

const Content = memo(({ selectedValue, onSelect, isOpen }: ContentProps) => {
  const {
    data: categories,
    isLoading,
    isFetching,
    isPending,
    refetch,
  } = useQueryData<CategoryOption[]>({
    queryKey: CATEGORIES_QUERY_KEYS.list,
    href: '/api/dash/projects/categories',
  });

  const isRefetched = useRef(false);
  useEffect(() => {
    (async () => {
      if (
        isOpen &&
        !isLoading &&
        !isFetching &&
        !isPending &&
        !isRefetched.current
      ) {
        isRefetched.current = true;
        await refetch();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, refetch]);

  return (
    <Command data-lenis-prevent>
      <CommandInput placeholder='ابحث عن القسم...' className='h-input' />
      <CommandList>
        {isLoading ? (
          <div className='flex h-20 items-center justify-center font-semibold'>
            جاري التحميل...
          </div>
        ) : (
          <>
            <CommandEmpty className='flex h-20 items-center justify-center font-semibold'>
              لاتوجد نتائج
            </CommandEmpty>
            <CommandGroup>
              {categories?.map((category) => (
                <CategoryItem
                  key={category.id}
                  category={category}
                  isSelected={selectedValue === category.id}
                  onSelect={onSelect}
                />
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
      <AddNewButton />
    </Command>
  );
});

Content.displayName = 'CategoryComboboxContent';

interface CategoryItemProps {
  category: CategoryOption;
  isSelected: boolean;
  onSelect: (value: EntityID) => void;
}

const CategoryItem = memo(
  ({ category, isSelected, onSelect }: CategoryItemProps) => {
    const handleSelect = useCallback(() => {
      onSelect(category.id);
    }, [category.id, onSelect]);

    const checkIconClassName = useMemo(
      () => cn('ms-auto size-4', isSelected ? 'opacity-100' : 'opacity-0'),
      [isSelected]
    );

    return (
      <CommandItem value={category.title} onSelect={handleSelect}>
        <span className='truncate'>{category.title}</span>
        <CheckIcon className={checkIconClassName} />
      </CommandItem>
    );
  }
);

CategoryItem.displayName = 'CategoryItem';

const AddNewButton = memo(() => {
  return (
    <div className='border-t p-1'>
      <Link
        href='/dash/projects/categories/new'
        target='_blank'
        variant='ghost'
        className='w-full justify-start text-sm text-muted-foreground hover:text-foreground'
      >
        <PlusIcon className='size-4' />
        <span>إضافة قسم جديد</span>
      </Link>
    </div>
  );
});

AddNewButton.displayName = 'CategoryAddNewButton';

export default CategoryCombobox;
