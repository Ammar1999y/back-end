import { memo, useCallback, useState } from 'react';

import { useQueryClient } from '@tanstack/react-query';
import { RefreshCcw } from 'lucide-react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

const RefreshButton = memo(() => {
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();

  const onClick = useCallback(async () => {
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
    }, 2000);
    await queryClient.invalidateQueries();
  }, [queryClient]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size={'icon'}
          variant={'ghost'}
          tabIndex={loading ? -1 : 0}
          className={cn(loading && 'pointer-events-none opacity-70')}
          onClick={onClick}
          aria-label='تحديث بيانات الصفحة'
        >
          <RefreshCcw
            className={cn('size-4', loading && 'animate-spin-pulse')}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p className='text-sm'>تحديث بيانات الصفحة</p>
      </TooltipContent>
    </Tooltip>
  );
});

RefreshButton.displayName = 'RefreshButton';
export default RefreshButton;
