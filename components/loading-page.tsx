import { memo } from 'react';

const LoadingPage = memo(() => {
  return (
    <div className='flex min-h-[400px] items-center justify-center py-20'>
      <div className='text-center'>
        <div className='mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-b-2 border-primary'></div>
        <p className='text-muted-foreground'>جاري تحميل البيانات...</p>
      </div>
    </div>
  );
});

LoadingPage.displayName = 'LoadingPage';
export default LoadingPage;
