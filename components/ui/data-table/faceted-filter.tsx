import type { Column } from '@tanstack/react-table';

import { memo, useMemo } from 'react';

import { Check, PlusCircle } from 'lucide-react';
import { useShallow } from 'zustand/shallow';
import { cn } from '@/lib/utils';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';

import { useColumnFilters } from './store';

type DataTableFacetedFilterProps<TData, TValue> = {
  column?: Column<TData, TValue>;
  title?: string;
  options: {
    label: string;
    value: string;
    icon?: React.ComponentType<{ className?: string }>;
  }[];
};

const DataTableFacetedFilter = memo<DataTableFacetedFilterProps<any, any>>(
  ({ column, title, options }) => {
    const selectedValues = useColumnFilters(
      useShallow((s) =>
        s.columnFilters.find((filter) => filter.id === column?.id)
      )
    );

    const selectedValuesArray = useMemo(
      () =>
        Array.isArray(selectedValues?.value)
          ? (selectedValues.value as string[])
          : [],
      [selectedValues]
    );

    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant='outline'
            size='sm'
            className='border-dashed border-border py-1.5 text-sm font-medium'
          >
            <PlusCircle className='size-4 opacity-70' />
            <span className='py-0.5'>{title}</span>
            {selectedValuesArray.length > 0 && (
              <>
                <Separator orientation='vertical' className='!h-[80%]' />
                <Badge
                  variant='secondary'
                  className='rounded-sm px-1 font-normal lg:hidden'
                >
                  {selectedValuesArray.length}
                </Badge>
                <div className='hidden space-x-1 lg:flex'>
                  {selectedValuesArray.length > 2 ? (
                    <Badge
                      variant='secondary'
                      className='rounded-sm px-1 font-normal'
                    >
                      {selectedValuesArray.length} محددة
                    </Badge>
                  ) : (
                    options
                      .filter((option) =>
                        selectedValuesArray.includes(option.value)
                      )
                      .map((option) => (
                        <Badge
                          variant='secondary'
                          key={option.value}
                          className='rounded-sm px-1 font-normal'
                        >
                          {option.label}
                        </Badge>
                      ))
                  )}
                </div>
              </>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className='w-52 p-0' align='start'>
          <Command>
            <CommandInput placeholder={title} />
            <CommandList>
              <CommandEmpty>لا توجد نتائج.</CommandEmpty>
              <CommandGroup>
                {options.map((option) => {
                  const isSelected = selectedValuesArray.includes(option.value);
                  return (
                    <CommandItem
                      key={option.value}
                      onSelect={() => {
                        if (!column?.id) return;
                        const newSelectedValues = [...selectedValuesArray];
                        if (isSelected) {
                          newSelectedValues.splice(
                            newSelectedValues.indexOf(option.value),
                            1
                          );
                        } else {
                          newSelectedValues.push(option.value);
                        }
                        if (!newSelectedValues?.length) {
                          useColumnFilters
                            .getState()
                            .removeColumnFilter(column.id);
                        } else
                          useColumnFilters
                            .getState()
                            .updateColumnFilter(
                              column.id,
                              newSelectedValues as string[]
                            );
                      }}
                    >
                      <div
                        className={cn(
                          'flex size-4 items-center justify-center rounded-sm border border-primary',
                          isSelected
                            ? 'bg-primary text-primary-foreground'
                            : 'opacity-50 [&_svg]:invisible'
                        )}
                      >
                        <Check className={cn('h-4 w-4 text-background')} />
                      </div>
                      {option.icon && (
                        <option.icon className='size-4 text-muted-foreground' />
                      )}
                      <span>{option.label}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              {selectedValuesArray.length > 0 && (
                <>
                  <CommandSeparator />
                  <CommandGroup>
                    <CommandItem
                      onSelect={() => {
                        if (column?.id) {
                          useColumnFilters
                            .getState()
                            .removeColumnFilter(column.id);
                        }
                      }}
                      className='justify-center text-center'
                    >
                      مسح الفلترة
                    </CommandItem>
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    );
  }
);

DataTableFacetedFilter.displayName = 'DataTableFacetedFilter';

export { DataTableFacetedFilter };
