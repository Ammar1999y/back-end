import type { SettingsInput } from '@/utils/validation/settings';

import { memo, useCallback } from 'react';

import { GripVertical, Trash2 } from 'lucide-react';
import { useFormContext } from 'react-hook-form';
import { ACCEPT_IMAGES } from '@/lib/constants';

import { MAX_IMAGE_SIZE } from '@/utils/images/config';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Label from '@/components/ui/label';
import StatusSwitch from '@/components/ui/switch-larg';
import { FileUpload } from '@/components/file-upload';
import { ErrorMessage } from '@/components/form/error-message';
import { SortableHandle } from '@/components/sortable';

import { KeyInput } from '../key-input';

interface SocialAccountItemContentProps {
  showDragHandle?: boolean;
  index: number;
  onRemove?: (index: number) => void;
}

const SocialAccountItemContent = memo(
  ({
    showDragHandle = false,
    index,
    onRemove,
  }: SocialAccountItemContentProps) => {
    const handleDelete = useCallback(() => {
      onRemove?.(index);
    }, [onRemove, index]);

    return (
      <div className='rounded-lg border bg-card px-4 py-4 shadow-md'>
        <div className='flex flex-col-reverse gap-x-4 gap-y-5 md2:flex-row'>
          <div className='flex-1'>
            <SocialAccountItemFields index={index} />
          </div>
          <div className='flex flex-[.7] flex-col space-y-2'>
            <div className='flex items-center justify-between'>
              <div className='flex items-center pb-2 space-x-3'>
                <StatusSwitch
                  name={`socialAccounts.${index}.isActive`}
                  ariaLabel='تبديل حالة الحساب'
                />
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
            <FileUpload
              maxFiles={1}
              maxSizeMB={MAX_IMAGE_SIZE}
              accept={ACCEPT_IMAGES}
              dropzoneText='اسحب وافلت الصورة هنا،'
              className='flex max-h-52 flex-1'
              dropzoneTextClassName='text-sm'
              dropzoneHelperText={`اقصى حجم للصورة ${MAX_IMAGE_SIZE}MB`}
            />
          </div>
        </div>
      </div>
    );
  }
);

SocialAccountItemContent.displayName = 'SocialAccountItemContent';

export { SocialAccountItemContent };

const SocialAccountItemFields = memo(({ index }: { index: number }) => {
  const { register } = useFormContext<SettingsInput>();

  return (
    <>
      <Label htmlFor={`socialAccounts.${index}.title`} title='العنوان' />
      <Input
        id={`socialAccounts.${index}.title`}
        dir={'auto'}
        placeholder=''
        {...register(`socialAccounts.${index}.title`)}
      />
      <ErrorMessage path={`socialAccounts.${index}.title`} />

      <KeyInput name={`socialAccounts.${index}.key`} className='mt-4' />

      <Label
        htmlFor={`socialAccounts.${index}.link`}
        title='الرابط'
        className='mt-4'
      />
      <Input
        id={`socialAccounts.${index}.link`}
        dir='ltr'
        className='placeholder:!text-left'
        placeholder='https://'
        {...register(`socialAccounts.${index}.link`)}
      />
      <ErrorMessage path={`socialAccounts.${index}.link`} />
    </>
  );
});

SocialAccountItemFields.displayName = 'SocialAccountItemFields';
