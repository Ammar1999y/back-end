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
} from 'lucide-react';
import { useController } from 'react-hook-form';
import { CUSTOM_ROLE_VALUE } from '@/lib/permissions/constants';
import { cn } from '@/lib/utils';

import { useQueryData } from '@/utils/query';
import { CreateUserFormData } from '@/utils/validation/auth';

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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

import { ROLES_QUERY_KEYS } from '../query-keys';

// Memoized icons
const CheckIcon = memo(_CheckIcon);
CheckIcon.displayName = 'CheckIcon';

const ChevronDownIcon = memo(_ChevronDownIcon);
ChevronDownIcon.displayName = 'ChevronDownIcon';

export interface RoleOption {
  id: EntityID;
  value: string;
  label: string;
}

const RoleInput = memo(() => {
  const id = useId();
  const { field } = useController<CreateUserFormData, 'roleId'>({
    name: 'roleId',
  });

  const [open, setOpen] = useState(false);
  const [selectedValue, setSelectedValue] = useState<
    EntityID | typeof CUSTOM_ROLE_VALUE | null
  >(field.value || null);

  useEffect(() => {
    setSelectedValue(field.value || null);
  }, [field.value]);

  const handleSelect = useCallback(
    (roleValue: EntityID | typeof CUSTOM_ROLE_VALUE) => {
      const newValue = roleValue === selectedValue ? null : roleValue;
      setSelectedValue(newValue);
      field.onChange(newValue);
      setOpen(false);
    },
    [selectedValue, field]
  );

  return (
    <>
      <Label htmlFor={id} title='الصلاحية' require />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant='outline'
            role='combobox'
            aria-expanded={open}
            disabled={field.disabled}
            onBlur={field.onBlur}
            className='relative h-input w-full justify-between bg-input px-4 py-1 shadow-none hover:shadow-md dark:bg-input/30 dark:hover:bg-input/50'
          >
            <RoleLabel selectedValue={selectedValue} />
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

RoleInput.displayName = 'RoleInput';

interface RoleLabelProps {
  selectedValue: EntityID | typeof CUSTOM_ROLE_VALUE | null;
}

const RoleLabel = memo(({ selectedValue }: RoleLabelProps) => {
  const { data: roles } = useQueryData<RoleOption[]>({
    queryKey: ROLES_QUERY_KEYS.list,
    href: '/api/dash/roles',
  });

  const selectedRole = useMemo(
    () => roles?.find((role) => role.value === selectedValue),
    [roles, selectedValue]
  );

  if (!selectedValue) {
    return <span className='text-muted-foreground'>اختر الصلاحية</span>;
  }

  return (
    <span className='truncate'>{selectedRole?.label || 'اختر الصلاحية'}</span>
  );
});

RoleLabel.displayName = 'RoleLabel';

interface ContentProps {
  selectedValue: EntityID | typeof CUSTOM_ROLE_VALUE | null;
  onSelect: (value: EntityID | typeof CUSTOM_ROLE_VALUE) => void;
  isOpen: boolean;
}

const Content = memo(({ selectedValue, onSelect, isOpen }: ContentProps) => {
  const {
    data: roles,
    isLoading,
    isFetching,
    isPending,
    refetch,
  } = useQueryData<RoleOption[]>({
    queryKey: ROLES_QUERY_KEYS.list,
    href: '/api/dash/roles',
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
  }, [isOpen, refetch]);

  return (
    <Command data-lenis-prevent>
      <CommandInput placeholder='ابحث عن الصلاحية...' className='h-input' />
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
              {roles?.map((role) => (
                <RoleItem
                  key={role.value}
                  role={role}
                  isSelected={selectedValue === role.value}
                  onSelect={onSelect}
                />
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
});

Content.displayName = 'RoleComboboxContent';

interface RoleItemProps {
  role: RoleOption;
  isSelected: boolean;
  onSelect: (value: EntityID | typeof CUSTOM_ROLE_VALUE) => void;
}

const RoleItem = memo(({ role, isSelected, onSelect }: RoleItemProps) => {
  const handleSelect = useCallback(() => {
    onSelect(
      role.value === CUSTOM_ROLE_VALUE ? CUSTOM_ROLE_VALUE : validID(role.value)
    );
  }, [role.value, onSelect]);

  const checkIconClassName = useMemo(
    () => cn('ms-auto size-4', isSelected ? 'opacity-100' : 'opacity-0'),
    [isSelected]
  );

  return (
    <CommandItem value={role.label} onSelect={handleSelect}>
      <span className='truncate'>{role.label}</span>
      <CheckIcon className={checkIconClassName} />
    </CommandItem>
  );
});

RoleItem.displayName = 'RoleItem';

export default RoleInput;
