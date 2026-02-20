import { memo } from 'react';

import { Save } from 'lucide-react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Link } from '@/components/ui/link';

interface HeaderProps {
  title: string;
  cancelHref: string;
  loading?: boolean;
  containerClassName?: string;
}

const Header = memo(
  ({ title, loading = false, cancelHref, containerClassName }: HeaderProps) => {
    return (
      <div
        className={cn(
          'flex flex-col justify-between gap-y-2 border-b pb-5 xs2:flex-row xs2:items-center',
          containerClassName
        )}
      >
        <h1 className='text-lg font-bold md:text-xl lg:text-2xl'>{title}</h1>
        <div className='flex items-center self-end space-x-4'>
          <Link href={cancelHref} variant='ghost'>
            إلغاء
          </Link>
          <Button
            type='submit'
            disabled={loading}
            className='min-w-24 py-1.5 font-medium shadow-lg shadow-primary/15'
          >
            <Save className='h-4 w-4' />
            <span>{loading ? 'جاري الحفظ...' : 'حفظ'}</span>
          </Button>
        </div>
      </div>
    );
  }
);

Header.displayName = 'CityFormHeader';

export { Header };
