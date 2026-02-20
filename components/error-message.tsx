import { memo } from 'react';

import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';

interface ErrorMessageProps {
  error: Error | null;
  refetch: () => void;
  className?: string;
}

const ErrorMessage = memo(
  ({ error, refetch, className }: ErrorMessageProps) => {
    return (
      <div
        className={cn(
          'animate-fade-in rounded-lg border border-red-600/20 bg-red-600/5 py-8 text-center text-red-600',
          className
        )}
      >
        <p className='font-medium'>
          {error?.message || 'حدث خطأ في جلب البيانات'}
        </p>
        <Button
          variant={'none'}
          onClick={() => refetch()}
          className='mx-auto mt-6 flex items-center justify-center border border-red-600 space-x-2 hover:bg-red-300/10'
        >
          <RefreshCw className='h-4 w-4' />
          <span className='underline-offset-2 hover:no-underline'>
            اعد المحاولة
          </span>
        </Button>
      </div>
    );
  }
);

ErrorMessage.displayName = 'ErrorMessage';

export default ErrorMessage;
