import type { Section } from '../types';

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

import { SECTIONS_QUERY_KEYS } from '../query-keys';

const Trash2Icon = memo(_Trash2Icon);

const DeleteAction = memo(
  ({ section, onSuccess }: { section: Section; onSuccess?: () => void }) => {
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const queryClient = useQueryClient();

    const handleConfirm = useCallback(async () => {
      if (!section.id) return;

      setLoading(true);

      try {
        const result = await mutate({
          href: `/api/dash/sections/${section.id}`,
          method: 'DELETE',
          onSuccess: () => {
            // Update sections list cache
            const existingList = queryClient.getQueryData<Section[]>(
              SECTIONS_QUERY_KEYS.list
            );

            if (existingList) {
              queryClient.setQueryData(
                SECTIONS_QUERY_KEYS.list,
                existingList.filter((item) => item.id !== section.id)
              );
            }

            // Remove detail cache
            queryClient.removeQueries({
              queryKey: SECTIONS_QUERY_KEYS.detail(section.id),
            });
          },
        });

        toast.success(result.message || 'تم حذف القسم بنجاح');
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
    }, [section, queryClient, onSuccess]);

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant='destructiveGhost'
                size='icon'
                aria-label='حذف القسم'
              >
                <Trash2Icon className='h-4 w-4' />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>
            <p className='text-sm'>حذف القسم</p>
          </TooltipContent>
        </Tooltip>

        <PopoverContent className='w-80'>
          <div className='space-y-4'>
            <div className='space-y-2'>
              <h4 className='font-medium leading-none'>تأكيد العملية</h4>
              <p className='text-sm text-muted-foreground'>
                سوف يتم حذف القسم <strong>{section.title}</strong>.
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

DeleteAction.displayName = 'SectionDeleteAction';

export { DeleteAction };
