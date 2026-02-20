import { memo } from 'react';

const PaginationSkeleton = memo(() => {
  return (
    <div className='flex h-10 animate-pulse items-center justify-between'>
      <div className='flex items-center justify-between space-x-4'>
        <div className='h-10 w-10 rounded bg-accent'></div>
        <div className='h-10 w-10 rounded bg-accent'></div>
        <div className='h-10 w-10 rounded bg-accent'></div>
        <div className='h-10 w-10 rounded bg-accent'></div>
        <div className='h-10 w-10 rounded bg-accent'></div>
      </div>
      <div className='h-10 w-24 rounded bg-accent'></div>
    </div>
  );
});

PaginationSkeleton.displayName = 'PaginationSkeleton';
export { PaginationSkeleton };
