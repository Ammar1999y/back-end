import { memo, useCallback, useId, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import {
  CheckIcon as _CheckIcon,
  ChevronDownIcon as _ChevronDownIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

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
import { FONTS_QUERY_KEYS } from '@/components/fonts/query-keys';

// Memoized icons
const CheckIcon = memo(_CheckIcon);
CheckIcon.displayName = 'CheckIcon';

const ChevronDownIcon = memo(_ChevronDownIcon);
ChevronDownIcon.displayName = 'ChevronDownIcon';

interface GoogleFontsResponse {
  data: string[];
}

interface FontComboboxProps {
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  languageName?: string;
}

const FontCombobox = memo(
  ({ value, onChange, disabled, languageName }: FontComboboxProps) => {
    const id = useId();
    const [open, setOpen] = useState(false);

    const handleSelect = useCallback(
      (fontName: string) => {
        const newValue = fontName === value ? null : fontName;
        onChange(newValue);
        setOpen(false);
      },
      [value, onChange]
    );

    return (
      <>
        <Label
          htmlFor={id}
          title={`نوع الخط${languageName ? ` (${languageName})` : ''}`}
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              id={id}
              variant='outline'
              role='combobox'
              aria-expanded={open}
              disabled={disabled}
              className='relative h-input w-full justify-between bg-input px-4 py-3 shadow-none hover:shadow-md dark:bg-input/30 dark:hover:bg-input/50'
            >
              <FontLabel selectedValue={value} />
              <ChevronDownIcon
                className='absolute left-3 top-1/2 size-4 shrink-0 -translate-y-1/2 text-muted-foreground/80'
                aria-hidden='true'
              />
            </Button>
          </PopoverTrigger>
          <PopoverContent className='w-[--radix-popper-anchor-width] p-0'>
            <Content
              selectedValue={value}
              onSelect={handleSelect}
              isOpen={open}
            />
          </PopoverContent>
        </Popover>
      </>
    );
  }
);

FontCombobox.displayName = 'FontCombobox';

interface FontLabelProps {
  selectedValue: string | null | undefined;
}

const FontLabel = memo(({ selectedValue }: FontLabelProps) => (
  <span className={cn('truncate', !selectedValue && 'text-muted-foreground')}>
    {selectedValue || 'اختر الخط'}
  </span>
));

FontLabel.displayName = 'FontLabel';

interface ContentProps {
  selectedValue: string | null | undefined;
  onSelect: (value: string) => void;
  isOpen: boolean;
}

const Content = memo(({ selectedValue, onSelect, isOpen }: ContentProps) => {
  const { data, isLoading } = useQuery<GoogleFontsResponse>({
    queryKey: FONTS_QUERY_KEYS.googleFonts,
    queryFn: async () => {
      const response = await fetch('/js/google-fonts.json');
      if (!response.ok) {
        throw new Error('Failed to fetch Google fonts');
      }
      return response.json();
    },
    enabled: isOpen,
    staleTime: Infinity, // Fonts list doesn't change often
  });

  const fonts = data?.data || [];

  return (
    <Command data-lenis-prevent>
      <CommandInput placeholder='ابحث عن الخط...' className='h-input' />
      <CommandList>
        {isLoading ? (
          <div className='flex h-20 items-center justify-center font-semibold'>
            جاري التحميل...
          </div>
        ) : (
          <>
            <CommandEmpty className='flex h-20 items-center justify-center font-semibold'>
              لا توجد نتائج
            </CommandEmpty>
            <CommandGroup>
              {fonts.map((font) => (
                <FontItem
                  key={font}
                  fontName={font}
                  isSelected={selectedValue === font}
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

Content.displayName = 'FontComboboxContent';

interface FontItemProps {
  fontName: string;
  isSelected: boolean;
  onSelect: (value: string) => void;
}

const FontItem = memo(({ fontName, isSelected, onSelect }: FontItemProps) => {
  const handleSelect = useCallback(() => {
    onSelect(fontName);
  }, [fontName, onSelect]);

  return (
    <CommandItem value={fontName} onSelect={handleSelect}>
      <span className='truncate'>{fontName}</span>
      <CheckIcon
        className={cn(
          'ms-auto size-4',
          isSelected ? 'opacity-100' : 'opacity-0'
        )}
      />
    </CommandItem>
  );
});

FontItem.displayName = 'FontItem';

export { FontCombobox };
