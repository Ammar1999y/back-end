import { memo, useCallback } from 'react';

import { GripVertical, Trash2 } from 'lucide-react';
import { useFormContext } from 'react-hook-form';
import { ACCEPT_IMAGES } from '@/lib/constants';

import { MAX_IMAGE_SIZE } from '@/utils/images/config';

import { AutosizeTextarea } from '@/components/ui/auto-resize-textarea';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Label from '@/components/ui/label';
import StatusSwitch from '@/components/ui/switch-larg';
import { FileUpload } from '@/components/file-upload';
import { SortableHandle } from '@/components/sortable';

interface ItemContentProps {
  showDragHandle?: boolean;
  index: number;
  onRemove?: (index: number) => void;
}

const ItemContent = memo(
  ({ showDragHandle = false, index, onRemove }: ItemContentProps) => {
    const handleDelete = useCallback(() => {
      onRemove?.(index);
    }, [onRemove, index]);

    return (
      <div className='rounded-lg border bg-card px-4 py-4 shadow-md'>
        <div className='flex flex-col-reverse gap-x-4 gap-y-5 md2:flex-row'>
          <div className='flex-1'>
            <ItemFields index={index} />
          </div>
          <div className='flex flex-[.7] flex-col space-y-2'>
            <div className='flex items-center justify-between'>
              <div className='flex items-center pb-2 space-x-3'>
                <StatusSwitch
                  name={`items.${index}.isActive`}
                  ariaLabel='تبديل حالة العنصر'
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
ItemContent.displayName = 'ItemContent';

export { ItemContent };

const ItemFields = memo(({ index }: { index: number }) => {
  const { register } = useFormContext();
  // const activeLang = useTabsStore(useShallow((s) => s.activeLang));
  // const nativeLang = activeLang?.english;
  // const inputDir = activeLang?.dir || 'auto';
  // LANGUAGES-TODOS
  const nativeLang = null;
  const inputDir = 'rtl';

  return (
    <>
      <Label
        htmlFor={`items.${index}.title`}
        title={`العنوان${nativeLang ? ` (${nativeLang}) ` : ''}`}
      />
      <Input
        id={`items.${index}.title`}
        dir={inputDir}
        className='mb-4 placeholder:text-foreground'
        placeholder=''
        {...register(`items.${index}.title`)}
      />

      <Label
        htmlFor={`items.${index}.subtitle`}
        title={`العنوان الفرعي${nativeLang ? ` (${nativeLang}) ` : ''}`}
      />
      <Input
        id={`items.${index}.subtitle`}
        dir={inputDir}
        className='mb-4 placeholder:text-foreground'
        placeholder=''
        {...register(`items.${index}.subtitle`)}
      />

      <Label
        htmlFor={`items.${index}.description`}
        title={`الوصف${nativeLang ? ` (${nativeLang}) ` : ''}`}
      />
      <AutosizeTextarea
        id={`items.${index}.description`}
        className='px-3 py-3 placeholder:text-foreground'
        placeholder=''
        minRows={2}
        minHeight={50}
        maxRows={4}
        maxHeight={130}
        {...register(`items.${index}.description`)}
        dir={inputDir}
      />
    </>
  );
});
ItemFields.displayName = 'ItemFields';
