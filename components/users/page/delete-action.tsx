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

import { USERS_QUERY_KEYS } from '../query-keys';
import { User } from '../types';

const Trash2Icon = memo(_Trash2Icon);

const DeleteAction = memo(({ user }: { user: User }) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();

  const handleConfirm = useCallback(async () => {
    if (!user.id) return;

    setLoading(true);

    try {
      const result = await mutate({
        href: `/api/dash/users/${user.id}`,
        method: 'DELETE',
        onSuccess: () => {
          queryClient.removeQueries({
            queryKey: USERS_QUERY_KEYS.detail(user.id),
          });
          // The paginated list is keyed by page/sort/filters/search with a
          // `{ data, meta }` value, so filtering `getQueryData(list)` matched
          // nothing and the deleted row stayed on screen. Invalidating the
          // prefix refetches whichever page is actually mounted — which also
          // pulls in the row that moved up from the next page.
          queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEYS.list });
        },
      });

      toast.success(result.message || 'تم حذف المستخدم بنجاح');
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof CustomError ? error.message : 'حدث خطاء، اعد المحاوله'
      );
    } finally {
      setLoading(false);
    }
  }, [user, queryClient]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant='destructiveGhost'
              size='icon'
              aria-label='حذف المستخدم'
            >
              <Trash2Icon className='h-4 w-4' />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p className='text-sm'>حذف المستخدم</p>
        </TooltipContent>
      </Tooltip>

      <PopoverContent className='w-80'>
        <div className='space-y-4'>
          <div className='space-y-2'>
            <h4 className='font-medium leading-none'>تأكيد العملية</h4>
            <p className='text-sm text-muted-foreground'>
              سوف يتم حذف المستخدم <strong>{user.name}</strong>.
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
});

DeleteAction.displayName = 'DeleteAction';

export { DeleteAction };
