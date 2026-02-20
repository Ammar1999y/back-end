import { memo, useCallback, useState } from 'react';

import { validID } from '@/utils';
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
import { RoleOption } from '@/components/users/form/role';
import { ROLES_QUERY_KEYS } from '@/components/users/query-keys';

import { PERMISSIONS_QUERY_KEYS } from '../query-keys';
import { Permission } from '../types';

const Trash2Icon = memo(_Trash2Icon);

const DeleteAction = memo(({ permission }: { permission: Permission }) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();

  const handleConfirm = useCallback(async () => {
    const id = validID(permission.id);
    if (!id) return;

    setLoading(true);

    try {
      await mutate({
        href: `/api/dash/permissions/${id}`,
        method: 'DELETE',
        onSuccess: () => {
          const existingList = queryClient.getQueryData<Permission[]>(
            PERMISSIONS_QUERY_KEYS.list
          );

          if (existingList) {
            queryClient.setQueryData(
              PERMISSIONS_QUERY_KEYS.list,
              existingList.filter((item) => item.id !== id)
            );
          }

          queryClient.removeQueries({
            queryKey: PERMISSIONS_QUERY_KEYS.detail(id),
          });

          // Update roles cache if permission was active
          if (permission.isActive) {
            const existingRoles = queryClient.getQueryData<RoleOption[]>(
              ROLES_QUERY_KEYS.list
            );

            if (existingRoles) {
              queryClient.setQueryData(
                ROLES_QUERY_KEYS.list,
                existingRoles.filter((r) => r.id !== id)
              );
            }
          }
        },
      });

      toast.success('تم حذف الصلاحية بنجاح');
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof CustomError ? error.message : 'حدث خطاء، اعد المحاوله'
      );
    } finally {
      setLoading(false);
    }
  }, [permission, queryClient]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant='ghost'
              size='sm'
              className='h-8 w-8 rounded-sm p-0 hover:bg-red-500/10 hover:text-red-600'
              aria-label='حذف الصلاحية'
            >
              <Trash2Icon className='h-4 w-4' />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p className='text-sm'>حذف الصلاحية</p>
        </TooltipContent>
      </Tooltip>

      <PopoverContent className='w-80'>
        <div className='space-y-4'>
          <div className='space-y-2'>
            <h4 className='font-medium leading-none'>تأكيد العملية</h4>
            <p className='text-sm text-muted-foreground'>
              سوف يتم حذف الصلاحية <strong>{permission.roleName}</strong>.
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
