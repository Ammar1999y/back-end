import type { Category } from '../types';

import { memo, useCallback, useState } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { Trash2Icon as _Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';

import { CustomError } from '@/utils/error-class';
import { mutate } from '@/utils/mutation';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import { CATEGORIES_QUERY_KEYS } from '../query-keys';

const Trash2Icon = memo(_Trash2Icon);

const DeleteAction = memo(
  ({ category, onSuccess }: { category: Category; onSuccess?: () => void }) => {
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const queryClient = useQueryClient();

    const handleConfirm = useCallback(async () => {
      if (!category.id) return;

      setLoading(true);

      try {
        const result = await mutate({
          href: `/api/dash/projects/categories/${category.id}`,
          method: 'DELETE',
          onSuccess: () => {
            // Update list cache
            const existingList = queryClient.getQueryData<Category[]>(
              CATEGORIES_QUERY_KEYS.list
            );

            if (existingList) {
              queryClient.setQueryData(
                CATEGORIES_QUERY_KEYS.list,
                existingList.filter((item) => item.id !== category.id)
              );
            }

            // Remove detail cache
            if (category.id)
              queryClient.removeQueries({
                queryKey: CATEGORIES_QUERY_KEYS.detail(category.id),
              });
          },
        });

        toast.success(result.message || 'تم حذف التصنيف بنجاح');
        onSuccess?.();
        setOpen(false);
      } catch (error) {
        toast.error(
          error instanceof CustomError
            ? error.message
            : 'حدث خطاء، اعد المحاوله'
        );
      } finally {
        setLoading(false);
      }
    }, [category, queryClient, onSuccess]);

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant='destructiveGhost'
                size='icon'
                aria-label='حذف التصنيف'
              >
                <Trash2Icon className='h-4 w-4' />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>
            <p className='text-sm'>حذف التصنيف</p>
          </TooltipContent>
        </Tooltip>

        <PopoverContent className='w-80'>
          <div className='space-y-4'>
            <div className='space-y-2'>
              <h4 className='font-medium leading-none'>تأكيد العملية</h4>
              <p className='text-sm text-muted-foreground'>
                سوف يتم حذف التصنيف <strong>{category.title}</strong>.
                <br />
                هذا الإجراء لا يمكن التراجع عنه.
              </p>
            </div>
            <div className='flex items-center gap-2'>
              <Button
                variant='ghost'
                className='flex-1'
                onClick={() => setOpen(false)}
                disabled={loading}
              >
                إلغاء
              </Button>
              <Button
                className='flex-1'
                onClick={handleConfirm}
                disabled={loading}
                variant='destructive'
              >
                {loading ? 'جاري الحذف...' : 'حذف'}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    );
  }
);

DeleteAction.displayName = 'CategoryDeleteAction';

export { DeleteAction };
