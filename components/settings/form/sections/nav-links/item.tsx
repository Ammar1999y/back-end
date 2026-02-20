import type { SettingsInput } from '@/utils/validation/settings';

import { memo, useCallback } from 'react';

import { GripVertical, Trash2 } from 'lucide-react';
import { useFormContext } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Label from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ErrorMessage } from '@/components/form/error-message';
import { SortableHandle } from '@/components/sortable';

import { KeyInput } from '../key-input';
import { SectionLinkCombobox } from './section-combobox';

interface NavLinkItemContentProps {
  showDragHandle?: boolean;
  index: number;
  onRemove?: (index: number) => void;
}

const NavLinkItemContent = memo(
  ({ showDragHandle = false, index, onRemove }: NavLinkItemContentProps) => {
    const handleDelete = useCallback(() => {
      onRemove?.(index);
    }, [onRemove, index]);

    return (
      <div className='rounded-lg border bg-card px-4 py-4 shadow-md'>
        <div className='flex flex-col gap-4'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-4'>
              <HeaderFooterSwitches index={index} />
              <Button
                variant='destructiveGhost'
                size='icon'
                onClick={handleDelete}
              >
                <Trash2 className='size-5' />
              </Button>
            </div>
            {showDragHandle && (
              <SortableHandle
                as={Button}
                variant='ghost'
                size='icon'
                className='cursor-grab active:cursor-grabbing'
              >
                <GripVertical className='h-5 w-5 text-muted-foreground' />
              </SortableHandle>
            )}
          </div>
          <NavLinkItemFields index={index} />
        </div>
      </div>
    );
  }
);

NavLinkItemContent.displayName = 'NavLinkItemContent';

export { NavLinkItemContent };

const HeaderFooterSwitches = memo(({ index }: { index: number }) => {
  const { watch, setValue } = useFormContext<SettingsInput>();

  const showInHeader = watch(`navLinks.${index}.showInHeader`);
  const showInFooter = watch(`navLinks.${index}.showInFooter`);

  const handleHeaderChange = useCallback(
    (checked: boolean) => {
      setValue(`navLinks.${index}.showInHeader`, checked);
    },
    [setValue, index]
  );

  const handleFooterChange = useCallback(
    (checked: boolean) => {
      setValue(`navLinks.${index}.showInFooter`, checked);
    },
    [setValue, index]
  );

  return (
    <div className='flex items-center gap-4'>
      <div className='flex items-center gap-2'>
        <Switch
          checked={showInHeader}
          onCheckedChange={handleHeaderChange}
          aria-label='إظهار في الهيدر'
        />
        <span className='text-sm text-muted-foreground'>الهيدر</span>
      </div>
      <div className='flex items-center gap-2'>
        <Switch
          checked={showInFooter}
          onCheckedChange={handleFooterChange}
          aria-label='إظهار في الفوتر'
        />
        <span className='text-sm text-muted-foreground'>الفوتر</span>
      </div>
    </div>
  );
});

HeaderFooterSwitches.displayName = 'HeaderFooterSwitches';

const NavLinkItemFields = memo(({ index }: { index: number }) => {
  const { register } = useFormContext<SettingsInput>();
  const inputDir = 'rtl';

  return (
    <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
      <div>
        <Label htmlFor={`navLinks.${index}.title`} title='العنوان' />
        <Input
          id={`navLinks.${index}.title`}
          dir={inputDir}
          placeholder=''
          {...register(`navLinks.${index}.title`)}
        />
        <ErrorMessage path={`navLinks.${index}.title`} />
      </div>

      <KeyInput name={`navLinks.${index}.key`} />
      <div className='md:col-span-2'>
        <Label htmlFor={`navLinks.${index}.link`} title='الرابط' />
        <SectionLinkCombobox index={index} />
        <ErrorMessage path={`navLinks.${index}.link`} />
      </div>
    </div>
  );
});

NavLinkItemFields.displayName = 'NavLinkItemFields';
